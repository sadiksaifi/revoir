import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createEmptyPolicy, withRepository } from "../src/config/policy.js";
import type { RevoirConfiguration } from "../src/config/schema.js";
import { createDefaultDiagnosticGateway } from "../src/diagnostics.js";
import { EMBEDDED_RELAY_SHA256 } from "../src/generated/relay-artifact.js";
import { GitHubManifestFlow } from "../src/setup/github-manifest.js";
import {
  ChildProcessSetupRunner,
  DefaultSetupPlatform,
  type ProcessResult,
  SetupProcessError,
  type SetupProcessRunner,
} from "../src/setup/platform.js";
import { createTestConfiguration } from "./helpers.js";

class FakeProcess implements SetupProcessRunner {
  readonly calls: {
    command: string;
    arguments: readonly string[];
    environment?: Readonly<Record<string, string>>;
    input?: string;
    timeoutMs?: number;
  }[] = [];
  readonly #handle: (
    command: string,
    arguments_: readonly string[],
  ) => Promise<ProcessResult> | ProcessResult;

  constructor(
    handle: (
      command: string,
      arguments_: readonly string[],
    ) => Promise<ProcessResult> | ProcessResult,
  ) {
    this.#handle = handle;
  }

  async run(
    command: string,
    arguments_: readonly string[],
    options: {
      environment?: Readonly<Record<string, string>>;
      input?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<ProcessResult> {
    this.calls.push({
      command,
      arguments: arguments_,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return this.#handle(command, arguments_);
  }
}

function platform(input: {
  browserOpen?: (url: string) => Promise<void>;
  confirmGitHubAppWebhook?: (url: string) => Promise<boolean>;
  createPiRuntime?: ConstructorParameters<typeof DefaultSetupPlatform>[0]["createPiRuntime"];
  diagnostics?: DefaultSetupPlatform["runDiagnostics"];
  process: SetupProcessRunner;
  fetch?: typeof fetch;
  now?: () => number;
  opened?: string[];
  sleep?: (milliseconds: number) => Promise<void>;
  selectCloudflareAccount?: (accounts: readonly { id: string; name: string }[]) => Promise<string>;
  shellCommandMs?: number;
}) {
  return new DefaultSetupPlatform({
    confirmGitHubAppWebhook: input.confirmGitHubAppWebhook ?? (async () => true),
    process: input.process,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
    ...(input.selectCloudflareAccount === undefined
      ? {}
      : { selectCloudflareAccount: input.selectCloudflareAccount }),
    ...(input.shellCommandMs === undefined ? {} : { shellCommandMs: input.shellCommandMs }),
    browser: {
      open:
        input.browserOpen ??
        (async (url) => {
          input.opened?.push(url);
        }),
    },
    ...(input.createPiRuntime === undefined ? {} : { createPiRuntime: input.createPiRuntime }),
    diagnostics: input.diagnostics ?? (async () => {}),
    async installService() {},
    async secretPrompt() {
      return "runtime-token";
    },
  });
}

const RESOURCES = {
  accountId: "a".repeat(32),
  kvNamespaceId: "kv-immutable-id",
  queueId: "queue-immutable-id",
  queueName: "revoir-review-jobs",
  workerName: "revoir-relay",
} as const;
const SETUP_ID = "0123456789abcdef";

describe("default greenfield setup platform", () => {
  it("terminates a child process at its configured timeout", async () => {
    const runner = new ChildProcessSetupRunner() as SetupProcessRunner & {
      run(
        command: string,
        arguments_: readonly string[],
        options: { timeoutMs: number },
      ): Promise<ProcessResult>;
    };

    await assert.rejects(
      Promise.race([
        runner.run(process.execPath, ["-e", "setTimeout(() => {}, 200)"], {
          timeoutMs: 20,
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("child process ignored its timeout")), 100);
        }),
      ]),
      (error) => error instanceof Error && !/ignored its timeout/u.test(error.message),
    );
  });

  it("preserves captured output when a noninteractive child process fails", async () => {
    const runner = new ChildProcessSetupRunner();

    await assert.rejects(
      runner.run(process.execPath, [
        "-e",
        'process.stdout.write("captured stdout"); process.stderr.write("captured stderr"); process.exit(7)',
      ]),
      (error) => {
        assert.ok(error instanceof SetupProcessError);
        assert.equal(error.message, `${process.execPath} failed with status 7.`);
        assert.equal(error.stdout, "captured stdout");
        assert.equal(error.stderr, "captured stderr");
        return true;
      },
    );
  });

  it("bounds generated GitHub App names for long machine hostnames", async () => {
    let appName: string | undefined;
    const manifest = new GitHubManifestFlow({ async open() {} });
    manifest.create = async (input) => {
      appName = input.appName;
      return {
        appId: 7,
        appSlug: "revoir-test",
        privateKey: "private-key",
        webhookSecret: "webhook-secret",
      };
    };
    const setup = new DefaultSetupPlatform({
      browser: { async open() {} },
      diagnostics: async () => {},
      hostname: () => "personal-development-machine-with-a-long-hostname",
      installService: async () => {},
      manifest,
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      secretPrompt: async () => "runtime-token",
    });

    await setup.createGitHubApp({
      relayUrl: "https://relay.example.workers.dev/github/webhook",
      state: "0123456789abcdef",
      async persistConversionCode() {},
      persist: async () => {},
    });

    assert.equal(appName, "Revoir personal-developme 01234567");
    assert.equal(appName.length, 34);
  });

  it("bounds noninteractive GitHub authentication probes with the setup shell timeout", async () => {
    const process = new FakeProcess((_command, arguments_) => ({
      stdout:
        arguments_.join(" ") === "api user" ? JSON.stringify({ id: 42, login: "test-user" }) : "",
      stderr: "",
    }));
    const setup = platform({ process, shellCommandMs: 123 });

    assert.deepEqual(await setup.ensureGitHubAuthentication(), { userId: 42, login: "test-user" });
    assert.deepEqual(
      process.calls.map(({ arguments: arguments_, timeoutMs }) => ({
        command: arguments_.join(" "),
        timeoutMs,
      })),
      [
        { command: "auth status", timeoutMs: 123 },
        { command: "api user", timeoutMs: 123 },
      ],
    );
  });

  it("handles a rejected OAuth browser handoff while login is still active", async () => {
    const browserFailure = new Error("browser unavailable");
    let authenticationChecks = 0;
    let loginFinished = false;
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      browserOpen: async () => {
        throw browserFailure;
      },
      createPiRuntime: async () => ({
        getModel() {
          return { reasoning: true };
        },
        async checkAuth() {
          authenticationChecks += 1;
          return authenticationChecks === 1 ? undefined : { type: "oauth" };
        },
        async login(_provider, _method, callbacks) {
          callbacks.notify({ type: "auth_url", url: "https://example.com/oauth" });
          await new Promise((resolve) => setTimeout(resolve, 10));
          loginFinished = true;
        },
      }),
    });

    await assert.rejects(
      setup.ensurePiAuthentication("openai-codex/gpt-5.6-sol", "high"),
      browserFailure,
    );
    assert.equal(loginFinished, true);
  });

  it("authenticates Wrangler and creates KV, Queue, and its HTTP pull consumer", async () => {
    const accountId = "a".repeat(32);
    const otherAccountId = "b".repeat(32);
    const process = new FakeProcess((_command, arguments_) => {
      const joined = arguments_.join(" ");
      if (joined === "whoami --json") {
        return {
          stdout: JSON.stringify({
            loggedIn: true,
            accounts: [
              { id: otherAccountId, name: "Other" },
              { id: accountId, name: "Personal" },
            ],
          }),
          stderr: "",
        };
      }
      if (joined.startsWith("kv namespace create")) {
        return { stdout: '{"id":"kv-immutable-id"}', stderr: "" };
      }
      if (joined === "kv namespace list") return { stdout: "[]", stderr: "" };
      if (joined.startsWith("queues info")) {
        return { stdout: "Queue ID: queue-immutable-id\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const setup = platform({
      process,
      async selectCloudflareAccount(accounts) {
        assert.deepEqual(accounts, [
          { id: otherAccountId, name: "Other" },
          { id: accountId, name: "Personal" },
        ]);
        return accountId;
      },
    });

    assert.deepEqual(await setup.ensureWranglerAuthentication(), { accountId });
    const partials: unknown[] = [];
    assert.deepEqual(
      await setup.ensureCloudflareResources(accountId, SETUP_ID, undefined, async (resources) => {
        partials.push(structuredClone(resources));
      }),
      {
        ...RESOURCES,
        queueName: `revoir-review-jobs-${SETUP_ID}`,
        workerName: `revoir-relay-${SETUP_ID}`,
      },
    );
    assert.equal(partials.length, 2);
    assert.equal(
      process.calls
        .filter(({ command }) => command === "wrangler")
        .every(
          ({ arguments: arguments_, environment }) =>
            arguments_.join(" ") === "whoami --json" ||
            environment?.CLOUDFLARE_ACCOUNT_ID === accountId,
        ),
      true,
    );
    assert.equal(
      process.calls.some(({ arguments: arguments_ }) =>
        arguments_.join(" ").startsWith(`queues consumer http add revoir-review-jobs-${SETUP_ID}`),
      ),
      true,
    );
  });

  it("bounds both noninteractive Wrangler authentication probes with the setup shell timeout", async () => {
    let probes = 0;
    const process = new FakeProcess((_command, arguments_) => {
      if (arguments_.join(" ") === "whoami --json") {
        probes += 1;
        if (probes === 1) throw new Error("not authenticated");
        return {
          stdout: JSON.stringify({
            loggedIn: true,
            accounts: [{ id: RESOURCES.accountId, name: "Personal" }],
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const setup = platform({ process, shellCommandMs: 123 });

    assert.deepEqual(await setup.ensureWranglerAuthentication(), {
      accountId: RESOURCES.accountId,
    });
    assert.deepEqual(
      process.calls.map(({ arguments: arguments_, timeoutMs }) => ({
        command: arguments_.join(" "),
        timeoutMs,
      })),
      [
        { command: "whoami --json", timeoutMs: 123 },
        { command: "login", timeoutMs: undefined },
        { command: "whoami --json", timeoutMs: 123 },
      ],
    );
  });

  it("recovers its deterministic KV after a post-create checkpoint interruption", async () => {
    let kvCreated = false;
    let kvCreates = 0;
    let queueCreated = false;
    const process = new FakeProcess((_command, arguments_) => {
      const joined = arguments_.join(" ");
      if (joined === "kv namespace list") {
        return {
          stdout: kvCreated
            ? JSON.stringify([{ id: "kv-immutable-id", title: `revoir-policy-${SETUP_ID}` }])
            : "[]",
          stderr: "",
        };
      }
      if (joined.startsWith("kv namespace create")) {
        kvCreated = true;
        kvCreates += 1;
        return { stdout: '{"id":"kv-immutable-id"}', stderr: "" };
      }
      if (joined.startsWith("queues info")) {
        if (!queueCreated) throw new Error("queue not found");
        return { stdout: "Queue ID: queue-immutable-id\nHTTP Pull Consumer", stderr: "" };
      }
      if (joined.startsWith("queues create")) {
        queueCreated = true;
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const setup = platform({ process });

    await assert.rejects(
      setup.ensureCloudflareResources("a".repeat(32), SETUP_ID, undefined, async () => {
        throw new Error("checkpoint interrupted");
      }),
      /checkpoint interrupted/u,
    );
    const recovered = await setup.ensureCloudflareResources(
      "a".repeat(32),
      SETUP_ID,
      undefined,
      async () => {},
    );

    assert.equal(recovered.kvNamespaceId, "kv-immutable-id");
    assert.equal(kvCreates, 1);
  });

  it("deploys the embedded relay and installs its GitHub-generated webhook secret", async () => {
    let generatedConfiguration: Record<string, unknown> | undefined;
    const process = new FakeProcess(async (_command, arguments_) => {
      const configIndex = arguments_.indexOf("--config");
      if (arguments_[0] === "deploy" && configIndex >= 0 && generatedConfiguration === undefined) {
        generatedConfiguration = JSON.parse(
          await readFile(arguments_[configIndex + 1]!, "utf8"),
        ) as Record<string, unknown>;
      }
      return arguments_[0] === "deploy"
        ? { stdout: "Published https://revoir-relay.example.workers.dev", stderr: "" }
        : { stdout: "", stderr: "" };
    });
    const setup = platform({ process });

    assert.equal(
      await setup.deployRelay(RESOURCES),
      "https://revoir-relay.example.workers.dev/github/webhook",
    );
    await setup.configureRelaySecret(RESOURCES, "webhook-secret");
    assert.equal(generatedConfiguration?.account_id, RESOURCES.accountId);
    assert.equal(generatedConfiguration?.workers_dev, true);
    assert.deepEqual(generatedConfiguration?.kv_namespaces, [
      { binding: "POLICY_KV", id: "kv-immutable-id" },
    ]);
    assert.deepEqual(generatedConfiguration?.queues, {
      producers: [{ binding: "REVIEW_QUEUE", queue: "revoir-review-jobs" }],
    });
    assert.equal(JSON.stringify(generatedConfiguration).includes("webhook-secret"), false);
    assert.equal(
      process.calls.filter(({ arguments: arguments_ }) => arguments_[0] === "deploy").length,
      2,
    );
    assert.equal(
      process.calls.find(({ arguments: arguments_ }) => arguments_[0] === "secret")?.input,
      "webhook-secret\n",
    );
    assert.equal(
      process.calls.every(
        ({ environment }) => environment?.CLOUDFLARE_ACCOUNT_ID === RESOURCES.accountId,
      ),
      true,
    );
  });

  it("opens exact workers.dev onboarding and resumes relay deployment on rerun", async () => {
    const opened: string[] = [];
    let deployments = 0;
    const onboardingUrl = `https://dash.cloudflare.com/${RESOURCES.accountId}/workers/onboarding`;
    const process = new FakeProcess((_command, arguments_) => {
      if (arguments_[0] !== "deploy") return { stdout: "", stderr: "" };
      deployments += 1;
      if (deployments === 1) {
        throw Object.assign(new Error("wrangler failed with status 1."), {
          stdout: "",
          stderr: `You need to register a workers.dev subdomain before publishing to workers.dev.\n${onboardingUrl}`,
        });
      }
      return { stdout: "Published https://revoir-relay.example.workers.dev", stderr: "" };
    });
    const setup = platform({ process, opened, shellCommandMs: 123 });

    await assert.rejects(
      setup.deployRelay(RESOURCES),
      /workers\.dev onboarding is required.*rerun "revoir setup"/u,
    );
    assert.deepEqual(opened, [onboardingUrl]);
    assert.equal(
      await setup.deployRelay(RESOURCES),
      "https://revoir-relay.example.workers.dev/github/webhook",
    );
    assert.equal(deployments, 2);
    assert.equal(
      process.calls.every(({ timeoutMs }) => timeoutMs === 123),
      true,
    );
  });

  it("recognizes only the expected signed relay artifact and immutable bindings as current", async () => {
    const requests: Request[] = [];
    let deployedQueue: string = RESOURCES.queueName;
    const process = new FakeProcess((_command, arguments_) => {
      if (arguments_[0] === "deployments") {
        return {
          stdout: JSON.stringify({
            versions: [{ version_id: "worker-version-id", percentage: 100 }],
          }),
          stderr: "",
        };
      }
      assert.deepEqual(arguments_, [
        "versions",
        "view",
        "worker-version-id",
        "--name",
        RESOURCES.workerName,
        "--json",
      ]);
      return {
        stdout: JSON.stringify({
          resources: {
            bindings: [
              { name: "POLICY_KV", type: "kv_namespace", namespace_id: RESOURCES.kvNamespaceId },
              { name: "REVIEW_QUEUE", type: "queue", queue_name: deployedQueue },
              {
                name: "REVOIR_RELAY_VERSION",
                type: "plain_text",
                text: EMBEDDED_RELAY_SHA256,
              },
              { name: "GITHUB_WEBHOOK_SECRET", type: "secret_text" },
            ],
          },
        }),
        stderr: "",
      };
    });
    const setup = platform({
      process,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const body = await request.clone().text();
        assert.equal(body, "{}");
        assert.equal(
          request.headers.get("X-Hub-Signature-256"),
          `sha256=${createHmac("sha256", "webhook-secret").update(body).digest("hex")}`,
        );
        return new Response("Accepted", {
          status: 202,
          headers: { "X-Revoir-Relay-Version": EMBEDDED_RELAY_SHA256 },
        });
      },
      shellCommandMs: 123,
    });

    const deployed = {
      ...RESOURCES,
      relayUrl: "https://revoir-relay.example.workers.dev/github/webhook",
    };
    assert.equal(await setup.relayIsCurrent(deployed, "webhook-secret"), true);
    deployedQueue = "different-queue";
    assert.equal(await setup.relayIsCurrent(deployed, "webhook-secret"), false);
    assert.deepEqual(
      process.calls.map(({ arguments: arguments_ }) => arguments_),
      [
        ["deployments", "status", "--name", RESOURCES.workerName, "--json"],
        ["versions", "view", "worker-version-id", "--name", RESOURCES.workerName, "--json"],
        ["deployments", "status", "--name", RESOURCES.workerName, "--json"],
        ["versions", "view", "worker-version-id", "--name", RESOURCES.workerName, "--json"],
      ],
    );
    assert.equal(
      process.calls.every(
        ({ environment, timeoutMs }) =>
          environment?.CLOUDFLARE_ACCOUNT_ID === RESOURCES.accountId && timeoutMs === 123,
      ),
      true,
    );
    assert.deepEqual(
      requests.map((request) => [request.url, request.method, request.signal.aborted]),
      [[deployed.relayUrl, "POST", false]],
    );
  });

  it("treats a missing setup-owned Worker as relay drift", async () => {
    const setup = platform({
      process: new FakeProcess(() => {
        throw new SetupProcessError("wrangler", "status 1", {
          stdout: "",
          stderr: `Worker ${RESOURCES.workerName} was not found`,
        });
      }),
    });

    assert.equal(
      await setup.relayIsCurrent(
        {
          ...RESOURCES,
          relayUrl: "https://revoir-relay.example.workers.dev/github/webhook",
        },
        "webhook-secret",
      ),
      false,
    );
  });

  it("bounds noninteractive Wrangler deployment with the setup shell timeout", async () => {
    const process = new FakeProcess(() => ({
      stdout: "Published https://revoir-relay.example.workers.dev",
      stderr: "",
    }));
    const setup = platform({ process, shellCommandMs: 123 });

    await setup.deployRelay(RESOURCES);

    assert.equal(process.calls[0]?.timeoutMs, 123);
    assert.equal(process.calls[0]?.environment?.CLOUDFLARE_ACCOUNT_ID, RESOURCES.accountId);
  });

  it("uses the runtime token for final setup diagnostics policy reads", async () => {
    const configuration = createTestConfiguration({
      cacheDir: "/tmp/revoir-test-cache",
      stateDir: "/tmp/revoir-test-state",
      dataDir: "/tmp/revoir-test-data",
    });
    let authorization: string | null | undefined;
    const gateway = createDefaultDiagnosticGateway(async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify(configuration.policy));
    });
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      async diagnostics(current, policy) {
        await gateway.checkPolicy(current.cloudflare, policy);
      },
    });

    await setup.runDiagnostics(configuration, configuration.policy);
    assert.equal(authorization, `Bearer ${configuration.cloudflare.apiToken}`);
  });

  it("validates the runtime token and reconciles the existing App without creating resources", async () => {
    const opened: string[] = [];
    const requests: { url: string; method: string }[] = [];
    const configuration = createTestConfiguration({
      cacheDir: "/tmp/revoir-test-cache",
      stateDir: "/tmp/revoir-test-state",
      dataDir: "/tmp/revoir-test-data",
    });
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = input.toString();
      requests.push({ url, method: init?.method ?? "GET" });
      if (url === "https://api.github.com/app") {
        return Response.json({
          id: configuration.github.appId,
          slug: configuration.github.appSlug,
          events: ["issue_comment", "pull_request"],
          permissions: {
            actions: "read",
            checks: "write",
            contents: "read",
            issues: "write",
            metadata: "read",
            pull_requests: "write",
          },
        });
      }
      return Response.json({ success: true });
    };
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      fetch: fetchImplementation,
      opened,
    });

    await setup.validateRuntimeApiToken(RESOURCES, "runtime-token");
    await setup.reconcileGitHubApp(configuration as RevoirConfiguration, createEmptyPolicy(42));
    assert.deepEqual(opened, [`https://github.com/settings/apps/${configuration.github.appSlug}`]);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET", "POST", "GET", "GET", "PATCH"],
    );
    assert.match(requests[0]!.url, /accounts\/a{32}\/queues\/queue-immutable-id$/u);
    assert.match(requests[1]!.url, /\/messages\/ack$/u);
    assert.match(requests[2]!.url, /accounts\/a{32}\/storage\/kv\/namespaces\/kv-immutable-id$/u);
    assert.equal(requests[4]!.url, "https://api.github.com/app/hook/config");
  });

  it("accepts a renamed App by immutable id and uses its live slug for settings", async () => {
    const configuration = createTestConfiguration({
      cacheDir: "/tmp/revoir-test-cache",
      stateDir: "/tmp/revoir-test-state",
      dataDir: "/tmp/revoir-test-data",
    });
    const opened: string[] = [];
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      opened,
      fetch: async (input) => {
        if (input.toString() === "https://api.github.com/app") {
          return Response.json({
            id: configuration.github.appId,
            slug: "revoir-renamed",
            events: ["issue_comment", "pull_request"],
            permissions: {
              actions: "read",
              checks: "write",
              contents: "read",
              issues: "write",
              metadata: "read",
              pull_requests: "write",
            },
          });
        }
        return Response.json({});
      },
    });

    const identity = await setup.reconcileGitHubApp(configuration, createEmptyPolicy(42));

    assert.deepEqual(identity, {
      appId: configuration.github.appId,
      appSlug: "revoir-renamed",
    });
    assert.deepEqual(opened, ["https://github.com/settings/apps/revoir-renamed"]);
  });

  it("aborts stalled GitHub and Cloudflare setup requests at the shell deadline", async () => {
    const configuration = createTestConfiguration({
      cacheDir: "/tmp/revoir-test-cache",
      stateDir: "/tmp/revoir-test-state",
      dataDir: "/tmp/revoir-test-data",
    });
    const operations = [
      {
        name: "GitHub reconciliation",
        run: (setup: DefaultSetupPlatform) =>
          setup.reconcileGitHubApp(configuration, createEmptyPolicy(42)),
      },
      {
        name: "Cloudflare Queue validation",
        run: (setup: DefaultSetupPlatform) =>
          setup.validateRuntimeApiToken(RESOURCES, "runtime-token"),
      },
    ];

    for (const operation of operations) {
      let requestAborted = false;
      const setup = platform({
        process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
        shellCommandMs: 5,
        fetch: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                requestAborted = true;
                reject(init.signal?.reason);
              },
              { once: true },
            );
          }),
      });

      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        Promise.race([
          operation.run(setup),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`${operation.name} ignored its deadline`)), 100);
          }),
        ]),
        (error) => error instanceof DOMException && error.name === "TimeoutError",
      );
      assert.equal(requestAborted, true, operation.name);
    }
  });

  it("requires browser-confirmed GitHub App webhook activation before completing reconciliation", async () => {
    const configuration = createTestConfiguration({
      cacheDir: "/tmp/revoir-test-cache",
      stateDir: "/tmp/revoir-test-state",
      dataDir: "/tmp/revoir-test-data",
    });
    let confirmationUrl: string | undefined;
    let hookUpdated = false;
    const opened: string[] = [];
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      async confirmGitHubAppWebhook(url) {
        confirmationUrl = url;
        return true;
      },
      opened,
      fetch: async (input, init) => {
        if (input.toString() === "https://api.github.com/app") {
          return Response.json({
            id: configuration.github.appId,
            slug: configuration.github.appSlug,
            events: ["issue_comment", "pull_request"],
            permissions: {
              actions: "read",
              checks: "write",
              contents: "read",
              issues: "write",
              metadata: "read",
              pull_requests: "write",
            },
          });
        }
        assert.equal(
          confirmationUrl,
          `https://github.com/settings/apps/${configuration.github.appSlug}`,
        );
        assert.equal(init?.method, "PATCH");
        hookUpdated = true;
        return Response.json({});
      },
    });

    await setup.reconcileGitHubApp(configuration, createEmptyPolicy(42));

    assert.equal(hookUpdated, true);
    assert.deepEqual(opened, [`https://github.com/settings/apps/${configuration.github.appSlug}`]);
  });

  it("does not report reconciliation success before GitHub App webhook activation is confirmed", async () => {
    const configuration = createTestConfiguration({
      cacheDir: "/tmp/revoir-test-cache",
      stateDir: "/tmp/revoir-test-state",
      dataDir: "/tmp/revoir-test-data",
    });
    let hookUpdated = false;
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      confirmGitHubAppWebhook: async () => false,
      fetch: async (input) => {
        if (input.toString() !== "https://api.github.com/app") {
          hookUpdated = true;
        }
        return Response.json({
          id: configuration.github.appId,
          slug: configuration.github.appSlug,
          events: ["issue_comment", "pull_request"],
          permissions: {
            actions: "read",
            checks: "write",
            contents: "read",
            issues: "write",
            metadata: "read",
            pull_requests: "write",
          },
        });
      },
    });

    await assert.rejects(
      setup.reconcileGitHubApp(configuration, createEmptyPolicy(42)),
      /webhook activation was not confirmed/u,
    );
    assert.equal(hookUpdated, false);
  });

  it("opens a least-privilege runtime token template scoped to the configured account", async () => {
    const opened: string[] = [];
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      opened,
    });

    assert.equal(await setup.requestRuntimeApiToken(RESOURCES), "runtime-token");
    assert.equal(opened.length, 1);
    const tokenTemplate = new URL(opened[0]!);
    assert.equal(
      tokenTemplate.origin + tokenTemplate.pathname,
      "https://dash.cloudflare.com/profile/api-tokens",
    );
    assert.deepEqual(JSON.parse(tokenTemplate.searchParams.get("permissionGroupKeys") ?? ""), [
      { key: "queues", type: "edit" },
      { key: "workers_kv_storage", type: "read" },
    ]);
    assert.equal(tokenTemplate.searchParams.get("accountId"), RESOURCES.accountId);
    assert.equal(tokenTemplate.searchParams.get("zoneId"), "all");
    assert.equal(tokenTemplate.searchParams.get("name"), "Revoir Runtime");
  });

  it("rejects a runtime token that cannot read the configured KV namespace", async () => {
    const token = "sensitive-runtime-token";
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      fetch: async (input) => {
        if (input.toString().includes("/storage/kv/namespaces/")) {
          return new Response(`unsafe response ${token}`, { status: 403 });
        }
        return Response.json({ success: true });
      },
    });

    await assert.rejects(setup.validateRuntimeApiToken(RESOURCES, token), (error) => {
      assert.match((error as Error).message, /Queues > Edit/u);
      assert.match((error as Error).message, /Workers KV Storage > Read/u);
      assert.doesNotMatch((error as Error).message, /sensitive-runtime-token|unsafe response/u);
      return true;
    });
  });

  it("waits for the exact KV policy while stale and malformed reads remain unauthorized", async () => {
    const expected = createEmptyPolicy(42);
    const stale = withRepository(expected, 8, {
      id: 99,
      owner: "owner",
      name: "repository",
    });
    const reads = [JSON.stringify(stale), "not-json", JSON.stringify(expected)];
    let now = 0;
    const sleeps: number[] = [];
    const setup = platform({
      process: new FakeProcess(() => ({
        stdout: reads.shift() ?? JSON.stringify(expected),
        stderr: "",
      })),
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await setup.verifyCloudPolicy(RESOURCES, expected);
    assert.deepEqual(sleeps.slice(0, 2), [1_000, 1_000]);
    assert.equal(sleeps.length, 60);
  });

  it("revalidates a current KV policy after the propagation window", async () => {
    const expected = createEmptyPolicy(42);
    let now = 0;
    let reads = 0;
    const sleeps: number[] = [];
    const setup = platform({
      process: new FakeProcess(() => {
        reads += 1;
        return { stdout: JSON.stringify(expected), stderr: "" };
      }),
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await setup.verifyCloudPolicy(RESOURCES, expected);
    assert.equal(now, 60_000);
    assert.equal(reads, 61);
    assert.equal(sleeps.length, 60);
  });

  it("retries transient Wrangler failures while verifying KV propagation", async () => {
    const expected = createEmptyPolicy(42);
    let now = 0;
    let reads = 0;
    const setup = platform({
      process: new FakeProcess(() => {
        reads += 1;
        if (reads === 1) throw new Error("transient Wrangler failure");
        return { stdout: JSON.stringify(expected), stderr: "" };
      }),
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await setup.verifyCloudPolicy(RESOURCES, expected);

    assert.equal(now, 60_000);
    assert.equal(reads, 61);
  });

  it("fails closed when the KV policy misses the propagation deadline", async () => {
    let now = 0;
    let reads = 0;
    const setup = platform({
      process: new FakeProcess(() => {
        reads += 1;
        return { stdout: "not-json", stderr: "" };
      }),
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await assert.rejects(
      setup.verifyCloudPolicy(RESOURCES, createEmptyPolicy(42)),
      /activation deadline/u,
    );
    assert.equal(reads, 65);
  });

  it("opens the exact App permission page when approval-required drift is detected", async () => {
    const opened: string[] = [];
    const configuration = createTestConfiguration({
      cacheDir: "/tmp/revoir-test-cache",
      stateDir: "/tmp/revoir-test-state",
      dataDir: "/tmp/revoir-test-data",
    });
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      opened,
      fetch: async () =>
        Response.json({
          id: configuration.github.appId,
          slug: configuration.github.appSlug,
          events: ["pull_request"],
          permissions: { metadata: "read" },
        }),
    });

    await assert.rejects(
      setup.reconcileGitHubApp(configuration, configuration.policy),
      /permissions or events require approval/u,
    );
    assert.deepEqual(opened, [
      `https://github.com/settings/apps/${configuration.github.appSlug}/permissions`,
    ]);
  });

  it("rejects unexpected App permissions and events instead of silently widening authority", async () => {
    const opened: string[] = [];
    const configuration = createTestConfiguration({
      cacheDir: "/tmp/revoir-test-cache",
      stateDir: "/tmp/revoir-test-state",
      dataDir: "/tmp/revoir-test-data",
    });
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      opened,
      fetch: async () =>
        Response.json({
          id: configuration.github.appId,
          slug: configuration.github.appSlug,
          events: ["issue_comment", "pull_request", "push"],
          permissions: {
            actions: "read",
            checks: "write",
            contents: "read",
            issues: "write",
            metadata: "read",
            pull_requests: "write",
            administration: "read",
          },
        }),
    });

    await assert.rejects(
      setup.reconcileGitHubApp(configuration, configuration.policy),
      /permissions or events require approval/u,
    );
    assert.deepEqual(opened, [
      `https://github.com/settings/apps/${configuration.github.appSlug}/permissions`,
    ]);
  });

  it("opens the exact installation page while a repository permission change awaits approval", async () => {
    const opened: string[] = [];
    const configuration = createTestConfiguration({
      cacheDir: "/tmp/revoir-test-cache",
      stateDir: "/tmp/revoir-test-state",
      dataDir: "/tmp/revoir-test-data",
    });
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      opened,
      fetch: async (input, init) => {
        const url = input.toString();
        if (url === "https://api.github.com/app") {
          return Response.json({
            id: configuration.github.appId,
            slug: configuration.github.appSlug,
            events: ["issue_comment", "pull_request"],
            permissions: {
              actions: "read",
              checks: "write",
              contents: "read",
              issues: "write",
              metadata: "read",
              pull_requests: "write",
            },
          });
        }
        if (init?.method === "POST") {
          return Response.json({ permissions: { metadata: "read" } });
        }
        return Response.json({ id: 8, account: { login: "owner" }, target_type: "User" });
      },
    });
    const policy = withRepository(createEmptyPolicy(42), 8, {
      id: 99,
      owner: "owner",
      name: "repository",
    });

    await assert.rejects(
      setup.reconcileGitHubApp(configuration, policy),
      /installation 8 requires permission approval/u,
    );
    assert.deepEqual(opened, ["https://github.com/settings/installations/8"]);
  });

  it("opens the organization installation approval page from validated installation metadata", async () => {
    const opened: string[] = [];
    const configuration = createTestConfiguration({
      cacheDir: "/tmp/revoir-test-cache",
      stateDir: "/tmp/revoir-test-state",
      dataDir: "/tmp/revoir-test-data",
    });
    const setup = platform({
      process: new FakeProcess(() => ({ stdout: "", stderr: "" })),
      opened,
      fetch: async (input, init) => {
        const url = input.toString();
        if (url === "https://api.github.com/app") {
          return Response.json({
            id: configuration.github.appId,
            slug: configuration.github.appSlug,
            events: ["issue_comment", "pull_request"],
            permissions: {
              actions: "read",
              checks: "write",
              contents: "read",
              issues: "write",
              metadata: "read",
              pull_requests: "write",
            },
          });
        }
        if (init?.method !== "POST") {
          return Response.json({
            id: 8,
            account: { login: "revoir-org" },
            target_type: "Organization",
          });
        }
        return Response.json({ permissions: { metadata: "read" } });
      },
    });
    const policy = withRepository(createEmptyPolicy(42), 8, {
      id: 99,
      owner: "revoir-org",
      name: "repository",
    });

    await assert.rejects(
      setup.reconcileGitHubApp(configuration, policy),
      /installation 8 requires permission approval/u,
    );
    assert.deepEqual(opened, [
      "https://github.com/organizations/revoir-org/settings/installations/8",
    ]);
  });
});
