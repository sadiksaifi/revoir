import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createEmptyPolicy, withRepository } from "../src/config/policy.js";
import type { RevoirConfiguration } from "../src/config/schema.js";
import {
  DefaultSetupPlatform,
  type ProcessResult,
  type SetupProcessRunner,
} from "../src/setup/platform.js";
import { createTestConfiguration } from "./helpers.js";

class FakeProcess implements SetupProcessRunner {
  readonly calls: { command: string; arguments: readonly string[]; input?: string }[] = [];
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
    options: { input?: string } = {},
  ): Promise<ProcessResult> {
    this.calls.push({
      command,
      arguments: arguments_,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    return this.#handle(command, arguments_);
  }
}

function platform(input: { process: SetupProcessRunner; fetch?: typeof fetch; opened?: string[] }) {
  return new DefaultSetupPlatform({
    process: input.process,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    browser: {
      async open(url) {
        input.opened?.push(url);
      },
    },
    async diagnostics() {},
    async installService() {},
    async secretPrompt() {
      return "queue-token";
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
  it("authenticates Wrangler and creates KV, Queue, and its HTTP pull consumer", async () => {
    const accountId = "a".repeat(32);
    const process = new FakeProcess((_command, arguments_) => {
      const joined = arguments_.join(" ");
      if (joined === "whoami") return { stdout: `Account ID: ${accountId}\n`, stderr: "" };
      if (joined.startsWith("kv namespace create")) {
        return { stdout: '{"id":"kv-immutable-id"}', stderr: "" };
      }
      if (joined === "kv namespace list") return { stdout: "[]", stderr: "" };
      if (joined.startsWith("queues info")) {
        return { stdout: "Queue ID: queue-immutable-id\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const setup = platform({ process });

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
      process.calls.some(({ arguments: arguments_ }) =>
        arguments_.join(" ").startsWith(`queues consumer http add revoir-review-jobs-${SETUP_ID}`),
      ),
      true,
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

  it("deploys the embedded relay with only KV, Queue, and webhook-secret bindings", async () => {
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
      await setup.deployRelay(RESOURCES, "webhook-secret"),
      "https://revoir-relay.example.workers.dev/github/webhook",
    );
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
  });

  it("validates the Queue token and reconciles the existing App without creating resources", async () => {
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

    await setup.validateQueueApiToken(RESOURCES, "queue-token");
    await setup.reconcileGitHubApp(configuration as RevoirConfiguration, createEmptyPolicy(42));
    assert.deepEqual(opened, []);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET", "POST", "GET", "PATCH"],
    );
    assert.match(requests[0]!.url, /accounts\/a{32}\/queues\/queue-immutable-id$/u);
    assert.match(requests[1]!.url, /\/messages\/ack$/u);
    assert.equal(requests[3]!.url, "https://api.github.com/app/hook/config");
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
      fetch: async (input) => {
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
        return Response.json({ permissions: { metadata: "read" } });
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
});
