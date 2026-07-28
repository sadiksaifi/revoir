import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, it } from "node:test";

import { CLI_VERSION, runCli, type CliIo } from "../src/cli.js";
import { resolveApplicationPaths } from "../src/config/paths.js";
import { loadConfiguration } from "../src/config/store.js";
import { createDefaultDiagnosticGateway, type DiagnosticGateway } from "../src/diagnostics.js";
import { FindingContractError, validateModelReviewOutput } from "../src/review/findings.js";
import type { ManualReviewService } from "../src/review/orchestrator.js";
import { PullRequestEligibilityError } from "../src/review/pull-request.js";
import { passingGateway, TEST_PRIVATE_KEY } from "./helpers.js";

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
  return { privateKeyFile, tokenFile };
}

function setupArguments(privateKeyFile: string, tokenFile: string): string[] {
  return [
    "setup",
    "--non-interactive",
    "--github-user-id",
    "42",
    "--github-app-id",
    "7",
    "--github-installation-id",
    "8",
    "--github-private-key-file",
    privateKeyFile,
    "--repository",
    "99:owner/repository",
    "--cloudflare-account-id",
    "account",
    "--cloudflare-queue-id",
    "queue",
    "--cloudflare-api-token-file",
    tokenFile,
  ];
}

describe("CLI", () => {
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
    assert.match(stdout.output, /Setup options:/u);
  });

  it("runs non-interactive setup, persists protected config, and diagnoses it", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);

    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    assert.match(stdout.output, /Configuration written/u);
    assert.match(stdout.output, /Diagnostics passed \(6\/6\)/u);
    assert.doesNotMatch(stdout.output + stderr.output, /cli-cloudflare-secret/u);

    const paths = resolveApplicationPaths(io.environment, root);
    const configuration = await loadConfiguration(paths.configFile);
    assert.equal(configuration.github.userId, 42);

    stdout.output = "";
    assert.equal(
      await runCli(["diagnose", "--json"], {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    const report = JSON.parse(stdout.output) as {
      ok: boolean;
      checks: unknown[];
    };
    assert.equal(report.ok, true);
    assert.equal(report.checks.length, 6);
  });

  it("refuses an unsafe existing configuration parent without changing its mode", async () => {
    const { root, io, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    const configDirectory = join(root, "shared-config");
    const configFile = join(configDirectory, "revoir.json");
    await mkdir(configDirectory);
    await chmod(configDirectory, 0o755);

    assert.equal(
      await runCli([...setupArguments(privateKeyFile, tokenFile), "--config", configFile], {
        io,
        gateway: passingGateway(),
      }),
      2,
    );
    assert.match(stderr.output, /Configuration directory .* has unsafe mode 0755/u);
    assert.match(stderr.output, /choose a dedicated private directory/u);
    assert.equal((await lstat(configDirectory)).mode & 0o777, 0o755);
  });

  it("supports interactive setup through the same validation path", async () => {
    const { root, io } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    const answers = [
      "",
      "",
      "42",
      "7",
      "8",
      privateKeyFile,
      "99:owner/repository",
      "account",
      "queue",
      tokenFile,
      "",
      "",
    ];

    assert.equal(
      await runCli(["setup"], {
        io,
        gateway: passingGateway(),
        prompt: async () => answers.shift() ?? "",
      }),
      0,
    );
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

  it("returns actionable errors for invalid input and missing configuration", async () => {
    const { io, stderr } = await createIo();
    assert.equal(
      await runCli(["setup", "--non-interactive"], {
        io,
        gateway: passingGateway(),
      }),
      2,
    );
    assert.match(stderr.output, /Missing required setup option/u);

    stderr.output = "";
    assert.equal(await runCli(["diagnose"], { io, gateway: passingGateway() }), 2);
    assert.match(stderr.output, /Run "revoir setup" first/u);
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
      [`{"version":"${sourceSecret}","findings":[]}`, /expected version 1/u],
      [
        JSON.stringify({
          version: 1,
          findings: [
            {
              priority: "P1",
              title: "Unknown field",
              path: "source.ts",
              range: null,
              issue: "The candidate has an unsupported shape.",
              impact: "The finding cannot be validated.",
              evidence: "The candidate includes a field outside the contract.",
              fixDirection: "Remove the unsupported field.",
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
});
