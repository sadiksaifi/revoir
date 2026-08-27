import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEmptyPolicy, withRepository, type RevoirPolicy } from "../src/config/policy.js";
import type { RevoirConfiguration } from "../src/config/schema.js";
import type { SetupCheckpoint, SetupStage } from "../src/config/setup-checkpoint.js";
import {
  EndToEndSetup,
  SetupStageError,
  type SetupPlatform,
  type SetupStateStore,
} from "../src/setup/orchestrator.js";
import { TEST_PRIVATE_KEY } from "./helpers.js";

class MemorySetupState implements SetupStateStore {
  checkpoint: SetupCheckpoint | undefined;
  finalConfiguration: RevoirConfiguration | undefined;
  finalPolicy: RevoirPolicy | undefined;
  writes = 0;
  writeFailures = 0;

  async load() {
    return this.checkpoint === undefined ? undefined : structuredClone(this.checkpoint);
  }

  async loadFinal() {
    return this.finalConfiguration === undefined || this.finalPolicy === undefined
      ? undefined
      : {
          configuration: structuredClone(this.finalConfiguration),
          policy: structuredClone(this.finalPolicy),
        };
  }

  async write(checkpoint: SetupCheckpoint) {
    this.writes += 1;
    if (this.writeFailures > 0) {
      this.writeFailures -= 1;
      throw new Error("simulated checkpoint write failure");
    }
    this.checkpoint = structuredClone(checkpoint);
  }

  async remove() {
    this.checkpoint = undefined;
  }

  async writeFinal(configuration: RevoirConfiguration, policy: RevoirPolicy) {
    this.finalConfiguration = structuredClone(configuration);
    this.finalPolicy = structuredClone(policy);
  }
}

function platform(
  state: MemorySetupState,
  failOnce?: SetupStage,
): SetupPlatform & { calls: SetupStage[] } {
  const calls: SetupStage[] = [];
  let failed = false;
  const stage = async <T>(name: SetupStage, value: T): Promise<T> => {
    calls.push(name);
    if (!failed && failOnce === name) {
      failed = true;
      throw new Error(`interrupted ${name}`);
    }
    return value;
  };
  return {
    calls,
    async ensureGitHubAuthentication() {
      if (state.checkpoint !== undefined) {
        assert.match(state.checkpoint.secrets.githubWebhookSecret ?? "", /^[0-9a-f]{64}$/u);
      }
      return stage("prerequisites", { userId: 42, login: "test-user" });
    },
    async ensureWranglerAuthentication() {
      return { accountId: "account" };
    },
    async ensurePiAuthentication() {},
    async ensureCloudflareResources(_accountId, _setupId, _existing, persist) {
      const resources = await stage("cloudflare-resources", {
        accountId: "account",
        kvNamespaceId: "kv",
        queueId: "queue",
        queueName: "revoir-review-jobs",
        workerName: "revoir-relay",
      });
      await persist(resources);
      return resources;
    },
    async deployRelay() {
      return stage("relay-deployed", "https://revoir-relay.example.workers.dev/github/webhook");
    },
    async createGitHubApp(input) {
      const app = await stage("github-app", {
        appId: 7,
        appSlug: "revoir-test",
        privateKey: TEST_PRIVATE_KEY,
      });
      await input.persist(app);
      return app;
    },
    async reconcileGitHubApp() {},
    async requestQueueApiToken() {
      return stage("queue-token", "queue-token-secret");
    },
    async validateQueueApiToken() {},
    async putCloudPolicy() {
      await stage("local-state", undefined);
    },
    async getCloudPolicy() {
      return state.finalPolicy ?? createEmptyPolicy(42);
    },
    async verifyCloudPolicy() {},
    async installService() {
      await stage("service-installed", undefined);
    },
    async runDiagnostics() {
      await stage("diagnostics", undefined);
    },
  };
}

function setup(state: MemorySetupState, setupPlatform: SetupPlatform) {
  return new EndToEndSetup({
    platform: setupPlatform,
    state,
    defaults: {
      model: { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
      timeouts: { reviewMs: 1_200_000, shellCommandMs: 120_000 },
      paths: { cacheDir: "/cache", stateDir: "/state", dataDir: "/data" },
    },
  });
}

describe("greenfield end-to-end setup", () => {
  it("persists one-time credentials, an empty policy, and completes through service health", async () => {
    const state = new MemorySetupState();
    const setupPlatform = platform(state);

    const result = await setup(state, setupPlatform).run();

    assert.equal(result.resumed, false);
    assert.deepEqual(result.policy, {
      version: 1,
      revision: 0,
      userId: 42,
      installations: [],
    });
    assert.equal(state.finalConfiguration?.github.privateKey, TEST_PRIVATE_KEY);
    assert.equal(state.finalConfiguration?.github.webhookSecret.length, 64);
    assert.equal(state.finalConfiguration?.cloudflare.apiToken, "queue-token-secret");
    assert.equal(state.checkpoint, undefined);
    assert.deepEqual(setupPlatform.calls, [
      "prerequisites",
      "cloudflare-resources",
      "relay-deployed",
      "github-app",
      "queue-token",
      "local-state",
      "service-installed",
      "diagnostics",
    ]);
  });

  it("preserves created resources after interruption and resumes without duplicating stages", async () => {
    const state = new MemorySetupState();
    const firstPlatform = platform(state, "github-app");
    await assert.rejects(setup(state, firstPlatform).run(), (error) => {
      assert.ok(error instanceof SetupStageError);
      assert.equal(error.stage, "github-app");
      assert.match(error.message, /KV=kv, Queue=queue, Worker=revoir-relay/u);
      return true;
    });
    assert.deepEqual(state.checkpoint?.completedStages, [
      "prerequisites",
      "cloudflare-resources",
      "relay-deployed",
    ]);
    const webhookSecret = state.checkpoint?.secrets.githubWebhookSecret;

    const resumedPlatform = platform(state);
    const result = await setup(state, resumedPlatform).run();

    assert.equal(result.resumed, true);
    assert.equal(result.configuration.github.webhookSecret, webhookSecret);
    assert.deepEqual(resumedPlatform.calls, [
      "prerequisites",
      "github-app",
      "queue-token",
      "local-state",
      "service-installed",
      "diagnostics",
    ]);
  });

  it("resumes after an interruption at every persisted stage boundary", async () => {
    const stages: SetupStage[] = [
      "prerequisites",
      "cloudflare-resources",
      "relay-deployed",
      "github-app",
      "queue-token",
      "local-state",
      "service-installed",
      "diagnostics",
    ];
    for (const interruptedStage of stages) {
      const state = new MemorySetupState();
      // Each iteration owns only in-memory fakes and deliberately serializes checkpoint assertions.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(setup(state, platform(state, interruptedStage)).run(), SetupStageError);
      const alreadyCompleted = new Set(state.checkpoint?.completedStages ?? []);
      const resumedPlatform = platform(state);
      // eslint-disable-next-line no-await-in-loop
      await setup(state, resumedPlatform).run();
      assert.equal(
        resumedPlatform.calls.some(
          (stage) => stage !== "prerequisites" && alreadyCompleted.has(stage),
        ),
        false,
        `${interruptedStage} resume repeated an already completed stage`,
      );
    }
  });

  it("retries the one-time App-key checkpoint before completing manifest conversion", async () => {
    const state = new MemorySetupState();
    const setupPlatform = platform(state);
    let appCreations = 0;
    setupPlatform.createGitHubApp = async (input) => {
      appCreations += 1;
      const app = { appId: 7, appSlug: "revoir-test", privateKey: TEST_PRIVATE_KEY };
      state.writeFailures = 1;
      await input.persist(app);
      return app;
    };

    await setup(state, setupPlatform).run();

    assert.equal(appCreations, 1);
    assert.equal(state.finalConfiguration?.github.privateKey, TEST_PRIVATE_KEY);
  });

  it("reconciles its completed installation without creating another App or cloud resources", async () => {
    const state = new MemorySetupState();
    await setup(state, platform(state)).run();
    const reconciliation = platform(state);

    const result = await setup(state, reconciliation).run();

    assert.equal(result.resumed, true);
    assert.deepEqual(reconciliation.calls, [
      "prerequisites",
      "relay-deployed",
      "local-state",
      "service-installed",
      "diagnostics",
    ]);
  });

  it("repairs completed-installation drift only by revoking trust", async () => {
    const state = new MemorySetupState();
    await setup(state, platform(state)).run();
    state.finalPolicy = withRepository(state.finalPolicy!, 8, {
      id: 99,
      owner: "owner",
      name: "locally-present",
    });
    const reconciliation = platform(state);
    reconciliation.getCloudPolicy = async () => createEmptyPolicy(42);

    const result = await setup(state, reconciliation).run();

    assert.deepEqual(result.policy, createEmptyPolicy(42));
    assert.deepEqual(state.finalPolicy, createEmptyPolicy(42));
  });
});
