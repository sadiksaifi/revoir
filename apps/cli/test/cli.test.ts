import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, it } from "node:test";

import { CLI_VERSION, createBrowserOpener, runCli, type CliIo } from "../src/cli.js";
import { resolveApplicationPaths } from "../src/config/paths.js";
import { writePolicy } from "../src/config/policy.js";
import { writeConfiguration } from "../src/config/store.js";
import { createDefaultDiagnosticGateway, type DiagnosticGateway } from "../src/diagnostics.js";
import type { QueueRunService } from "../src/queue/runner.js";
import type { ReviewCancellationStore } from "../src/review/cancellation-store.js";
import { FindingContractError, validateModelReviewOutput } from "../src/review/findings.js";
import type { ManualReviewService } from "../src/review/orchestrator.js";
import { PullRequestEligibilityError } from "../src/review/pull-request.js";
import type { ServiceLogger } from "../src/service/logging.js";
import type { ServiceManager, ServiceStatus } from "../src/service/manager.js";
import { createTestConfiguration, passingGateway, TEST_PRIVATE_KEY } from "./helpers.js";

class CapturingWritable extends Writable {
  output = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output += chunk.toString();
    callback();
  }
}

const temporaryDirectories: string[] = [];

async function createIo(): Promise<{
  root: string;
  io: CliIo;
  stdout: CapturingWritable;
  stderr: CapturingWritable;
}> {
  const root = await mkdtemp(join(tmpdir(), "revoir-cli-test-"));
  temporaryDirectories.push(root);
  const stdout = new CapturingWritable();
  const stderr = new CapturingWritable();
  return {
    root,
    stdout,
    stderr,
    io: {
      stdin: Readable.from([]),
      stdout,
      stderr,
      environment: {
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_DATA_HOME: join(root, "data"),
      },
      userHome: root,
      cwd: root,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeCredentials(root: string): Promise<{
  privateKeyFile: string;
  tokenFile: string;
}> {
  const secrets = join(root, "secrets");
  await mkdir(secrets, { recursive: true });
  const privateKeyFile = join(secrets, "github.pem");
  const tokenFile = join(secrets, "cloudflare-token");
  await Promise.all([
    writeFile(privateKeyFile, TEST_PRIVATE_KEY),
    writeFile(tokenFile, "cli-cloudflare-secret"),
  ]);
  const paths = resolveApplicationPaths(
    {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_DATA_HOME: join(root, "data"),
    },
    root,
  );
  const configuration = createTestConfiguration(paths, { apiToken: "cli-cloudflare-secret" });
  const { policy, ...staticConfiguration } = configuration;
  await Promise.all([
    writeConfiguration(paths.configFile, staticConfiguration),
    writePolicy(paths.policyFile, policy),
  ]);
  return { privateKeyFile, tokenFile };
}

function setupArguments(_privateKeyFile: string, _tokenFile: string): string[] {
  return ["diagnose"];
}

describe("CLI", () => {
  it("bounds browser handoffs with the configured shell deadline", async () => {
    let receivedTimeout: number | undefined;
    const browser = createBrowserOpener(
      {
        async run(_command, _arguments, options) {
          receivedTimeout = options?.timeoutMs;
          return { stdout: "", stderr: "" };
        },
      },
      123,
    );

    await browser.open("https://github.com/apps/revoir");

    assert.equal(receivedTimeout, 123);
  });

  it("provides help and version without reading configuration", async () => {
    const { io, stdout } = await createIo();
    io.environment = { XDG_CONFIG_HOME: "invalid-relative-path" };

    assert.equal(await runCli(["--help"], { io }), 0);
    assert.match(stdout.output, /revoir setup/u);

    stdout.output = "";
    assert.equal(await runCli(["--version"], { io }), 0);
    assert.equal(stdout.output, `revoir ${CLI_VERSION}\n`);

    stdout.output = "";
    assert.equal(await runCli(["setup", "--help"], { io }), 0);
    assert.match(stdout.output, /Provision and reconcile/u);

    stdout.output = "";
    assert.equal(await runCli(["review", "cancel", "--help"], { io }), 0);
    assert.match(stdout.output, /revoir review cancel <GitHub PR URL>/u);
  });

  it("keeps normal diagnostics concise and adds redacted stack detail in verbose mode", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";
    stderr.output = "";

    const diagnosticError = new Error("rejected cli-cloudflare-secret");
    diagnosticError.stack =
      "Error: rejected cli-cloudflare-secret\n    at cloudflareDiagnostic (diagnostic-origin.ts:42:7)";
    const failingGateway: DiagnosticGateway = {
      ...passingGateway(),
      async checkCloudflare() {
        throw diagnosticError;
      },
    };

    assert.equal(await runCli(["diagnose"], { io, gateway: failingGateway }), 1);
    assert.match(stdout.output, /rejected \[REDACTED\]/u);
    assert.doesNotMatch(stdout.output, /diagnostic-origin/u);
    assert.doesNotMatch(stdout.output + stderr.output, /cli-cloudflare-secret/u);

    stdout.output = "";
    assert.equal(await runCli(["diagnose", "--verbose"], { io, gateway: failingGateway }), 1);
    assert.match(stdout.output, /Diagnostics failed/u);
    assert.match(stdout.output, /diagnostic-origin\.ts:42:7/u);
    assert.match(stdout.output, /\[REDACTED\]/u);
    assert.doesNotMatch(stdout.output + stderr.output, /cli-cloudflare-secret/u);

    stdout.output = "";
    assert.equal(await runCli(["diagnose", "--json"], { io, gateway: failingGateway }), 1);
    assert.doesNotMatch(stdout.output, /diagnostic-origin/u);

    stdout.output = "";
    assert.equal(
      await runCli(["diagnose", "--json", "--verbose"], { io, gateway: failingGateway }),
      1,
    );
    assert.match(stdout.output, /diagnostic-origin\.ts:42:7/u);
    assert.doesNotMatch(stdout.output + stderr.output, /cli-cloudflare-secret/u);
  });

  it("reports the Queues write requirement for a read-only Cloudflare token", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";
    stderr.output = "";

    const cloudflareGateway = createDefaultDiagnosticGateway(async (url) => {
      if (url.endsWith("/messages/ack")) {
        return {
          ok: false,
          status: 403,
          async json() {
            return { success: false };
          },
        };
      }
      const body = url.endsWith("/consumers")
        ? {
            success: true,
            result: [{ consumer_id: "consumer", type: "http_pull" }],
          }
        : {
            success: true,
            result: {
              queue_id: "queue",
              queue_name: "review-jobs",
              settings: { delivery_paused: false },
            },
          };
      return {
        ok: true,
        status: 200,
        async json() {
          return body;
        },
      };
    });
    const readOnlyGateway: DiagnosticGateway = {
      ...passingGateway(),
      checkCloudflare: cloudflareGateway.checkCloudflare,
    };

    assert.equal(await runCli(["diagnose"], { io, gateway: readOnlyGateway }), 1);
    assert.match(stdout.output, /Queues Read and Queues Write.*rerun diagnostics/u);
    assert.doesNotMatch(stdout.output + stderr.output, /cli-cloudflare-secret/u);
  });

  it("reads standalone diagnostic policy with the configured Cloudflare token", async () => {
    const { root, io } = await createIo();
    await writeCredentials(root);
    const paths = resolveApplicationPaths(io.environment, root);
    const configuration = createTestConfiguration(paths, {
      apiToken: "cli-cloudflare-secret",
    });
    let request: { url: string; authorization: string | null } | undefined;
    const policyGateway = createDefaultDiagnosticGateway(async (input, init) => {
      request = {
        url: input.toString(),
        authorization: new Headers(init?.headers).get("Authorization"),
      };
      return new Response(JSON.stringify(configuration.policy));
    });

    assert.equal(
      await runCli(["diagnose"], {
        io,
        gateway: { ...passingGateway(), checkPolicy: policyGateway.checkPolicy },
      }),
      0,
    );
    assert.match(
      request?.url ?? "",
      new RegExp(`/accounts/${configuration.cloudflare.accountId}/storage/kv/namespaces/`),
    );
    assert.equal(request?.authorization, `Bearer ${configuration.cloudflare.apiToken}`);
  });

  it("returns actionable errors for invalid input and missing configuration", async () => {
    const { io, stderr } = await createIo();
    assert.equal(
      await runCli(["setup", "--non-interactive"], {
        io,
        gateway: passingGateway(),
      }),
      2,
    );
    assert.match(stderr.output, /Setup is interactive/u);

    stderr.output = "";
    assert.equal(await runCli(["diagnose"], { io, gateway: passingGateway() }), 2);
    assert.match(stderr.output, /Configuration file directory .* is not available/u);
  });

  it("dispatches repository add, remove, and list without manual immutable ids", async () => {
    const { root, io, stdout } = await createIo();
    await writeCredentials(root);
    const calls: string[] = [];
    const repository = { id: 99, owner: "Owner", name: "repository" };
    const repositoryManager = {
      async add(reference: { owner: string; name: string }) {
        calls.push(`add:${reference.owner}/${reference.name}`);
        return { status: "authorized" as const, repository, installationId: 8 };
      },
      async remove(
        reference: { owner: string; name: string },
        options: { keepGitHubAccess?: boolean },
      ) {
        calls.push(
          `remove:${reference.owner}/${reference.name}:${String(options.keepGitHubAccess)}`,
        );
        return { status: "removed" as const, repository };
      },
      async list() {
        calls.push("list");
        return [
          {
            repository,
            installationId: 8,
            status: "authorized" as const,
            local: true,
            cloud: true,
            github: true,
          },
        ];
      },
    };

    assert.equal(
      await runCli(["repository", "add", "Owner/repository"], {
        io,
        repositoryManager,
      }),
      0,
    );
    assert.match(stdout.output, /Owner\/repository is authorized/u);
    stdout.output = "";
    assert.equal(
      await runCli(["repository", "remove", "Owner/repository", "--keep-github-access"], {
        io,
        repositoryManager,
      }),
      0,
    );
    stdout.output = "";
    assert.equal(await runCli(["repository", "list"], { io, repositoryManager }), 0);
    assert.match(
      stdout.output,
      /Owner\/repository\tauthorized\tlocal=true cloud=true github=true/u,
    );
    assert.deepEqual(calls, ["add:Owner/repository", "remove:Owner/repository:true", "list"]);
  });

  it("dispatches canonical manual reviews and reports clean and stale results", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";

    const calls: string[] = [];
    const cleanService: ManualReviewService = {
      async review(reference) {
        calls.push(reference.url);
        return {
          status: "clean",
          reviewedSha: "2".repeat(40),
          currentSha: "2".repeat(40),
        };
      },
    };
    assert.equal(
      await runCli(["review", "https://github.com/owner/repository/pull/17"], {
        io,
        reviewService: cleanService,
      }),
      0,
    );
    assert.deepEqual(calls, ["https://github.com/owner/repository/pull/17"]);
    assert.match(stdout.output, /Clean review completed/u);

    stdout.output = "";
    stderr.output = "";
    const findingsService: ManualReviewService = {
      async review() {
        return {
          status: "findings",
          reviewedSha: "2".repeat(40),
          currentSha: "2".repeat(40),
          publishedFindings: 2,
          rejectedFindings: 1,
          diagnostics: [
            {
              index: 2,
              code: "invalid",
              message: "findings[2].priority must be supported.",
            },
          ],
        };
      },
    };
    assert.equal(
      await runCli(["review", "https://github.com/owner/repository/pull/17"], {
        io,
        reviewService: findingsService,
      }),
      0,
    );
    assert.match(stdout.output, /Published 2 findings/u);
    assert.match(stderr.output, /rejected 1 invalid or duplicate model finding/u);
    assert.match(stderr.output, /priority must be supported/u);

    stdout.output = "";
    stderr.output = "";
    const staleService: ManualReviewService = {
      async review() {
        return {
          status: "stale",
          reviewedSha: "2".repeat(40),
          currentSha: "3".repeat(40),
        };
      },
    };
    assert.equal(
      await runCli(["review", "https://github.com/owner/repository/pull/17"], {
        io,
        reviewService: staleService,
      }),
      0,
    );
    assert.match(stdout.output, /Review discarded/u);
    assert.match(stdout.output, new RegExp("3".repeat(40), "u"));

    stderr.output = "";
    assert.equal(
      await runCli(["review", "https://github.com/owner/repository/pull/17?diff=split"], {
        io,
        reviewService: cleanService,
      }),
      2,
    );
    assert.match(stderr.output, /canonical form/u);
    assert.equal(calls.length, 1);
  });

  it("records idempotent targeted cancellation only for locally authorized repositories", async () => {
    const { root, io, stdout, stderr } = await createIo();
    await writeCredentials(root);
    const recorded: string[] = [];
    const cancellationStore: ReviewCancellationStore = {
      async read() {
        return undefined;
      },
      async record(reference) {
        recorded.push(reference.url);
        return { cancelledAt: "2026-09-04T10:00:00.000Z" };
      },
    };
    const url = "https://github.com/owner/repository/pull/17";

    assert.equal(await runCli(["review", "cancel", url], { io, cancellationStore }), 0);
    assert.equal(await runCli(["review", "cancel", url], { io, cancellationStore }), 0);
    const customConfigFile = join(root, "custom", "revoir.json");
    const customConfiguration = createTestConfiguration(
      {
        cacheDir: join(root, "custom-cache"),
        stateDir: join(root, "custom-state"),
        dataDir: join(root, "custom-data"),
      },
      { apiToken: "custom-cloudflare-secret" },
    );
    const { policy: customPolicy, ...customStaticConfiguration } = customConfiguration;
    await writeConfiguration(customConfigFile, customStaticConfiguration);
    await writePolicy(`${customConfigFile}.policy.json`, customPolicy);
    assert.equal(
      await runCli(["review", "cancel", url, "--config", customConfigFile], {
        io,
        cancellationStore,
      }),
      0,
    );
    assert.deepEqual(recorded, [url, url, url]);
    assert.equal(
      stdout.output,
      `Cancellation recorded for ${url}.\nCancellation recorded for ${url}.\nCancellation recorded for ${url}.\n`,
    );

    assert.equal(await runCli(["review", "cancel", url, "--json"], { io, cancellationStore }), 2);
    assert.equal(
      await runCli(["review", "cancel", url, "--unsupported"], { io, cancellationStore }),
      2,
    );
    assert.match(stderr.output, /--json is not supported|requires exactly one canonical/u);

    stderr.output = "";
    assert.equal(
      await runCli(["review", "cancel", "https://github.com/other/repository/pull/17"], {
        io,
        cancellationStore,
      }),
      2,
    );
    assert.match(stderr.output, /not in the configured repository allowlist/u);
  });

  it("runs the authenticated pull consumer without accepting review inputs", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";

    let runs = 0;
    const runService: QueueRunService = {
      async run() {
        runs += 1;
      },
    };
    assert.equal(await runCli(["run"], { io, runService }), 0);
    assert.equal(runs, 1);
    assert.equal(stdout.output, "");

    assert.equal(await runCli(["run", "unexpected"], { io, runService }), 2);
    assert.match(stderr.output, /does not accept positional arguments/u);
    assert.equal(runs, 1);

    stderr.output = "";
    assert.equal(await runCli(["run", "--json"], { io, runService }), 2);
    assert.match(stderr.output, /--json is not supported/u);
    assert.equal(runs, 1);
  });

  it("dispatches idempotent service lifecycle commands and renders actionable status", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";

    const calls: string[] = [];
    let status: ServiceStatus = {
      state: "healthy",
      detail: "LaunchAgent is healthy with process 321.",
      pid: 321,
    };
    const serviceManager: ServiceManager = {
      async install() {
        calls.push("install");
      },
      async start() {
        calls.push("start");
      },
      async stop() {
        calls.push("stop");
      },
      async status() {
        calls.push("status");
        return status;
      },
      async uninstall() {
        calls.push("uninstall");
      },
    };

    assert.equal(await runCli(["install"], { io, serviceManager }), 0);
    assert.equal(await runCli(["start"], { io, serviceManager }), 0);
    assert.equal(await runCli(["status"], { io, serviceManager }), 0);
    assert.match(stdout.output, /Service healthy: LaunchAgent is healthy with process 321/u);
    assert.equal(await runCli(["stop"], { io, serviceManager }), 0);
    assert.equal(await runCli(["uninstall"], { io, serviceManager }), 0);
    assert.deepEqual(calls, ["install", "start", "status", "stop", "uninstall"]);

    stdout.output = "";
    status = {
      state: "failed",
      detail: 'LaunchAgent failed with exit code 78. Inspect "revoir logs".',
    };
    assert.equal(await runCli(["status"], { io, serviceManager }), 1);
    assert.match(stdout.output, /Service failed: LaunchAgent failed with exit code 78/u);

    assert.equal(await runCli(["install", "unexpected"], { io, serviceManager }), 2);
    assert.match(stderr.output, /install does not accept positional arguments/u);

    stderr.output = "";
    await chmod(resolveApplicationPaths(io.environment, root).configFile, 0o644);
    assert.equal(await runCli(["install"], { io, serviceManager }), 2);
    assert.match(stderr.output, /unsafe mode 0644.*chmod 600/u);
    assert.deepEqual(calls, ["install", "start", "status", "stop", "uninstall", "status"]);
  });

  it("prints structured XDG service logs without requiring configuration", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const logsDirectory = join(root, "state", "revoir", "logs");
    await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(logsDirectory, "service.jsonl"),
      '{"timestamp":"2026-07-29T08:00:00.000Z","event":"daemon_started","data":{}}\n',
      { mode: 0o600 },
    );

    assert.equal(await runCli(["logs"], { io }), 0);
    assert.match(stdout.output, /"event":"daemon_started"/u);
    assert.equal(stderr.output, "");

    assert.equal(await runCli(["logs", "unexpected"], { io }), 2);
    assert.match(stderr.output, /logs does not accept positional arguments/u);
  });

  it("redacts pull-consumer failures", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";
    const failed: QueueRunService = {
      async run() {
        throw new Error("Cloudflare rejected cli-cloudflare-secret");
      },
    };

    assert.equal(await runCli(["run"], { io, runService: failed }), 1);
    assert.match(stderr.output, /\[REDACTED\]/u);
    assert.doesNotMatch(stderr.output, /cli-cloudflare-secret/u);
  });

  it("passes shutdown into the daemon and flushes structured lifecycle logs before exit", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";
    const controller = new AbortController();
    const operations: string[] = [];
    const logger: ServiceLogger = {
      async write(event) {
        operations.push(`log:${event}`);
      },
      async flush() {
        operations.push("flush");
      },
      async close() {
        operations.push("close");
      },
    };
    const runService: QueueRunService = {
      async run(signal) {
        operations.push("run");
        assert.equal(signal, controller.signal);
        controller.abort(new Error("SIGTERM requested graceful shutdown"));
      },
    };

    assert.equal(
      await runCli(["run"], {
        io,
        runService,
        serviceLogger: logger,
        shutdownSignal: controller.signal,
      }),
      0,
    );
    assert.deepEqual(operations, [
      "log:daemon_started",
      "run",
      "log:daemon_stopped",
      "flush",
      "close",
    ]);
    assert.equal(stdout.output, "");
    assert.equal(stderr.output, "");
  });

  it("classifies eligibility rejection separately and redacts review failures", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";
    stderr.output = "";

    const rejected: ManualReviewService = {
      async review() {
        throw new PullRequestEligibilityError("Draft pull requests are not eligible.");
      },
    };
    assert.equal(
      await runCli(["review", "https://github.com/owner/repository/pull/17"], {
        io,
        reviewService: rejected,
      }),
      2,
    );
    assert.match(stderr.output, /not eligible/u);

    stderr.output = "";
    const failed: ManualReviewService = {
      async review() {
        throw new Error("remote rejected cli-cloudflare-secret");
      },
    };
    assert.equal(
      await runCli(["review", "https://github.com/owner/repository/pull/17"], {
        io,
        reviewService: failed,
      }),
      1,
    );
    assert.match(stderr.output, /\[REDACTED\]/u);
    assert.doesNotMatch(stderr.output, /cli-cloudflare-secret/u);
  });

  it("prints redacted per-candidate reasons when Pi returns only invalid findings", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";
    stderr.output = "";

    const allInvalid: ManualReviewService = {
      async review() {
        throw new FindingContractError("Pi returned no publishable findings (2 rejected).", [
          {
            index: 0,
            code: "invalid",
            message: "findings[0].priority must be one of P0, P1, P2, or P3.",
          },
          {
            index: 1,
            code: "invalid",
            message: "findings[1].evidence contained cli-cloudflare-secret.",
          },
        ]);
      },
    };

    assert.equal(
      await runCli(["review", "https://github.com/owner/repository/pull/17"], {
        io,
        reviewService: allInvalid,
      }),
      1,
    );
    assert.match(stderr.output, /no publishable findings/u);
    assert.match(stderr.output, /#1: findings\[0\]\.priority must be one of P0, P1, P2, or P3/u);
    assert.match(stderr.output, /#2: findings\[1\]\.evidence contained \[REDACTED\]/u);
    assert.doesNotMatch(stderr.output, /cli-cloudflare-secret/u);
    assert.equal(stdout.output, "");
  });

  it("never prints model-controlled contract versions or field names", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";
    stderr.output = "";

    const sourceSecret = "PRIVATE_SOURCE_TOKEN";
    const outputs: readonly [string, RegExp][] = [
      [`{"version":"${sourceSecret}","findings":[]}`, /expected version 2/u],
      [
        JSON.stringify({
          version: 2,
          findings: [
            {
              priority: "P1",
              path: "source.ts",
              range: null,
              defectKind: "correctness",
              impactKind: "incorrect-result",
              fixAction: "guard",
              reason: "The changed path produces an incorrect result.",
              anchor: "source.ts",
              [sourceSecret]: "echo",
            },
          ],
        }),
        /findings\[0\] contains an unknown field/u,
      ],
    ];

    for (const [value, safeReason] of outputs) {
      const allInvalid: ManualReviewService = {
        async review() {
          await validateModelReviewOutput(value, { checkout: root, diff: "" });
          throw new Error("Expected model output to be rejected.");
        },
      };

      // Keep each source-bearing rejection isolated so every CLI rendering path is checked.
      // eslint-disable-next-line no-await-in-loop
      const exitCode = await runCli(["review", "https://github.com/owner/repository/pull/17"], {
        io,
        reviewService: allInvalid,
      });
      assert.equal(exitCode, 1);
      assert.match(stderr.output, /Rejected model findings/u);
      assert.match(stderr.output, safeReason);
      assert.doesNotMatch(stderr.output, new RegExp(sourceSecret, "u"));
      stderr.output = "";
    }
    assert.equal(stdout.output, "");
  });

  it("prints only static diagnostics for unknown model semantic values", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";
    stderr.output = "";

    const modelDefectKind = "PRIVATE_SOURCE_TOKEN";
    const allInvalid: ManualReviewService = {
      async review() {
        await validateModelReviewOutput(
          JSON.stringify({
            version: 2,
            findings: [
              {
                priority: "P1",
                path: "source.ts",
                range: null,
                defectKind: modelDefectKind,
                impactKind: "incorrect-result",
                fixAction: "guard",
                reason: "The changed path produces an incorrect result.",
                anchor: "source.ts",
              },
            ],
          }),
          { checkout: root, diff: "" },
        );
        throw new Error("Expected unknown semantic value to be rejected.");
      },
    };

    assert.equal(
      await runCli(["review", "https://github.com/owner/repository/pull/17"], {
        io,
        reviewService: allInvalid,
      }),
      1,
    );
    assert.match(stderr.output, /defectKind must be a supported defect kind/u);
    assert.doesNotMatch(stderr.output, new RegExp(modelDefectKind, "u"));
    assert.doesNotMatch(stderr.output, /PRIVATE_SOURCE_TOKEN/u);
    assert.equal(stdout.output, "");
  });

  it("does not print malformed model anchor source text", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";
    stderr.output = "";

    const modelAnchor = "PRIVATE_IMPACT\nSOURCE";
    const allInvalid: ManualReviewService = {
      async review() {
        await validateModelReviewOutput(
          JSON.stringify({
            version: 2,
            findings: [
              {
                priority: "P1",
                path: "source.ts",
                range: null,
                defectKind: "correctness",
                impactKind: "incorrect-result",
                fixAction: "guard",
                reason: "The changed path produces an incorrect result.",
                anchor: modelAnchor,
              },
            ],
          }),
          { checkout: root, diff: "" },
        );
        throw new Error("Expected malformed anchor to be rejected.");
      },
    };

    assert.equal(
      await runCli(["review", "https://github.com/owner/repository/pull/17"], {
        io,
        reviewService: allInvalid,
      }),
      1,
    );
    assert.match(stderr.output, /anchor must be a single line/u);
    assert.doesNotMatch(stderr.output, /PRIVATE_IMPACT/u);
    assert.equal(stdout.output, "");
  });
});
