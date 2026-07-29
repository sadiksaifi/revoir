import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ReviewJobV1 } from "@revoir/contracts";
import {
  QueueReviewRunner,
  classifyReviewFailure,
  renderReviewFailureComment,
  type ManualReviewResult,
  type ManualReviewService,
  type OperationalFailureState,
  type OperationalFailureStore,
  type QueueClient,
  type ReviewFailureReporter,
  type RevoirConfiguration,
} from "cli";

import { createWebhookRelay, type RelayEnvironment } from "../src/index.js";

const WEBHOOK_SECRET = "pipeline-webhook-secret";
const silentFailureReporter: ReviewFailureReporter = {
  async report() {},
};

function memoryFailureStore(
  states: Map<string, OperationalFailureState> = new Map(),
  saves: OperationalFailureState[] = [],
): OperationalFailureStore {
  return {
    async load(deliveryId) {
      return states.get(deliveryId) ?? { committedFailures: 0 };
    },
    async save(deliveryId, state) {
      saves.push(state);
      states.set(deliveryId, state);
    },
    async clear(deliveryId) {
      states.delete(deliveryId);
    },
  };
}

const configuration: RevoirConfiguration = {
  version: 2,
  model: { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
  github: {
    userId: 42,
    appId: 7,
    privateKey: "unused by fake review service",
    installations: [
      {
        id: 8,
        repositories: [{ id: 99, owner: "owner", name: "repository" }],
      },
    ],
  },
  cloudflare: {
    accountId: "account-id",
    queueId: "queue-id",
    apiToken: "queue-token",
  },
  timeouts: {
    reviewMs: 1_200_000,
    shellCommandMs: 120_000,
  },
  paths: {
    cacheDir: "/tmp/cache",
    stateDir: "/tmp/state",
    dataDir: "/tmp/data",
  },
};

async function fixture(): Promise<string> {
  return readFile(join(import.meta.dirname, "fixtures/pull-request.synchronize.json"), "utf8");
}

async function enqueueSignedWebhook(deliveryId: string): Promise<ReviewJobV1[]> {
  const queued: ReviewJobV1[] = [];
  const environment: RelayEnvironment = {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_USER_ID: "42",
    GITHUB_REPOSITORIES: JSON.stringify([{ id: 99, owner: "owner", name: "repository" }]),
    REVIEW_QUEUE: {
      async send(job) {
        queued.push(job);
      },
    },
  };
  const body = await fixture();
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const response = await createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z")).fetch(
    new Request("https://relay.example/github/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Delivery": deliveryId,
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body,
    }),
    environment,
  );
  assert.equal(response.status, 202);
  assert.equal(queued.length, 1);
  return queued;
}

describe("webhook-to-review pipeline", () => {
  for (const outcome of ["clean", "findings"] as const) {
    it(`acknowledges a signed webhook after a ${outcome} review settlement`, async () => {
      const queued = await enqueueSignedWebhook(`pipeline-${outcome}`);
      const acknowledged: string[] = [];
      const queue: QueueClient = {
        async pullOne() {
          const job = queued.shift();
          return job === undefined
            ? undefined
            : {
                leaseId: `lease-${outcome}`,
                attempt: 1,
                body: job,
              };
        },
        async acknowledge(leaseId) {
          acknowledged.push(leaseId);
        },
        async retry() {
          assert.fail("A completed review must not be retried.");
        },
      };
      const reviews: Array<{ url: string; expectedHeadSha: string | undefined }> = [];
      const reviewService: ManualReviewService = {
        async review(reference, options): Promise<ManualReviewResult> {
          reviews.push({
            url: reference.url,
            expectedHeadSha: options?.expectedHeadSha,
          });
          return outcome === "clean"
            ? {
                status: "clean",
                reviewedSha: "2".repeat(40),
                currentSha: "2".repeat(40),
              }
            : {
                status: "findings",
                reviewedSha: "2".repeat(40),
                currentSha: "2".repeat(40),
                publishedFindings: 1,
                rejectedFindings: 0,
                diagnostics: [],
              };
        },
      };

      assert.equal(
        await new QueueReviewRunner(
          configuration,
          queue,
          reviewService,
          silentFailureReporter,
          memoryFailureStore(),
        ).consumeOne(),
        "settled",
      );
      assert.deepEqual(reviews, [
        {
          url: "https://github.com/owner/repository/pull/17",
          expectedHeadSha: "2".repeat(40),
        },
      ]);
      assert.deepEqual(acknowledged, [`lease-${outcome}`]);
      assert.equal(queued.length, 0);
    });
  }

  it("acknowledges a signed webhook when the queued head is stale", async () => {
    const queued = await enqueueSignedWebhook("pipeline-stale");
    const acknowledged: string[] = [];
    const queue: QueueClient = {
      async pullOne() {
        const job = queued.shift();
        return job === undefined ? undefined : { leaseId: "lease-stale", attempt: 1, body: job };
      },
      async acknowledge(leaseId) {
        acknowledged.push(leaseId);
      },
      async retry() {
        assert.fail("A stale review must not be retried.");
      },
    };
    const reviews: Array<{ url: string; expectedHeadSha: string | undefined }> = [];
    const reviewService: ManualReviewService = {
      async review(reference, options) {
        reviews.push({
          url: reference.url,
          expectedHeadSha: options?.expectedHeadSha,
        });
        return {
          status: "stale",
          reviewedSha: "2".repeat(40),
          currentSha: "3".repeat(40),
        };
      },
    };

    assert.equal(
      await new QueueReviewRunner(
        configuration,
        queue,
        reviewService,
        silentFailureReporter,
        memoryFailureStore(),
      ).consumeOne(),
      "settled",
    );
    assert.deepEqual(reviews, [
      {
        url: "https://github.com/owner/repository/pull/17",
        expectedHeadSha: "2".repeat(40),
      },
    ]);
    assert.deepEqual(acknowledged, ["lease-stale"]);
    assert.equal(queued.length, 0);
  });

  it("retries a signed webhook after an operational review failure", async () => {
    const queued = await enqueueSignedWebhook("pipeline-operational-failure");
    const acknowledged: string[] = [];
    const retried: string[] = [];
    const queue: QueueClient = {
      async pullOne() {
        const job = queued.shift();
        return job === undefined
          ? undefined
          : {
              leaseId: "lease-operational-failure",
              attempt: 1,
              body: job,
            };
      },
      async acknowledge(leaseId) {
        acknowledged.push(leaseId);
      },
      async retry(leaseId) {
        retried.push(leaseId);
      },
    };
    const reviews: Array<{ url: string; expectedHeadSha: string | undefined }> = [];
    const reviewService: ManualReviewService = {
      async review(reference, options) {
        reviews.push({
          url: reference.url,
          expectedHeadSha: options?.expectedHeadSha,
        });
        throw new Error("temporary GitHub failure");
      },
    };

    assert.equal(
      await new QueueReviewRunner(
        configuration,
        queue,
        reviewService,
        silentFailureReporter,
        memoryFailureStore(),
      ).consumeOne(),
      "settled",
    );
    assert.deepEqual(reviews, [
      {
        url: "https://github.com/owner/repository/pull/17",
        expectedHeadSha: "2".repeat(40),
      },
    ]);
    assert.deepEqual(acknowledged, []);
    assert.deepEqual(retried, ["lease-operational-failure"]);
    assert.equal(queued.length, 0);
  });

  it("shares durable state across two failed leases and a successful third lease", async () => {
    const [job] = await enqueueSignedWebhook("pipeline-two-failures-success");
    assert.ok(job);
    const deliveries = [1, 2, 3].map((attempt) => ({
      leaseId: `lease-${attempt}`,
      attempt,
      body: job,
    }));
    const acknowledged: string[] = [];
    const retried: Array<{ leaseId: string; delaySeconds: number }> = [];
    const queue: QueueClient = {
      async pullOne() {
        return deliveries.shift();
      },
      async acknowledge(leaseId) {
        acknowledged.push(leaseId);
      },
      async retry(leaseId, delaySeconds) {
        retried.push({ leaseId, delaySeconds });
      },
    };
    let reviewAttempts = 0;
    const reviews: ManualReviewService = {
      async review() {
        reviewAttempts += 1;
        if (reviewAttempts < 3) {
          throw new Error("temporary Pi failure");
        }
        return {
          status: "clean",
          reviewedSha: job.pullRequest.headSha,
          currentSha: job.pullRequest.headSha,
        };
      },
    };
    const reported: number[] = [];
    const reporter: ReviewFailureReporter = {
      async report(_reference, _error, attempt) {
        reported.push(attempt);
      },
    };
    const states = new Map<string, OperationalFailureState>();
    const saves: OperationalFailureState[] = [];
    const runner = new QueueReviewRunner(
      configuration,
      queue,
      reviews,
      reporter,
      memoryFailureStore(states, saves),
    );

    await runner.consumeOne();
    await runner.consumeOne();
    await runner.consumeOne();

    assert.equal(reviewAttempts, 3);
    assert.deepEqual(reported, [1, 2]);
    assert.deepEqual(retried, [
      { leaseId: "lease-1", delaySeconds: 30 },
      { leaseId: "lease-2", delaySeconds: 120 },
    ]);
    assert.deepEqual(acknowledged, ["lease-3"]);
    assert.deepEqual(
      saves
        .filter((state) => state.reservation !== undefined)
        .map((state) => state.reservation?.slot),
      [1, 2, 3],
    );
    assert.equal(states.size, 0);
  });

  it("shares durable state across three failures and terminal settlement", async () => {
    const [job] = await enqueueSignedWebhook("pipeline-three-failures-terminal");
    assert.ok(job);
    const deliveries = [1, 2, 3].map((attempt) => ({
      leaseId: `terminal-lease-${attempt}`,
      attempt,
      body: job,
    }));
    const acknowledged: string[] = [];
    const retried: Array<{ leaseId: string; delaySeconds: number }> = [];
    const queue: QueueClient = {
      async pullOne() {
        return deliveries.shift();
      },
      async acknowledge(leaseId) {
        acknowledged.push(leaseId);
      },
      async retry(leaseId, delaySeconds) {
        retried.push({ leaseId, delaySeconds });
      },
    };
    let reviewAttempts = 0;
    const reviews: ManualReviewService = {
      async review() {
        reviewAttempts += 1;
        throw new Error("temporary Pi failure");
      },
    };
    const reported: Array<{ attempt: number; body: string }> = [];
    const reporter: ReviewFailureReporter = {
      async report(reference, error, attempt, totalAttempts) {
        reported.push({
          attempt,
          body: renderReviewFailureComment(
            classifyReviewFailure(error),
            attempt,
            totalAttempts,
            reference,
          ),
        });
      },
    };
    const states = new Map<string, OperationalFailureState>();
    const saves: OperationalFailureState[] = [];
    const runner = new QueueReviewRunner(
      configuration,
      queue,
      reviews,
      reporter,
      memoryFailureStore(states, saves),
    );

    await runner.consumeOne();
    await runner.consumeOne();
    await runner.consumeOne();

    assert.equal(reviewAttempts, 3);
    assert.deepEqual(
      reported.map(({ attempt }) => attempt),
      [1, 2, 3],
    );
    assert.match(
      reported[2]!.body,
      /revoir review https:\/\/github\.com\/owner\/repository\/pull\/17/u,
    );
    assert.deepEqual(retried, [
      { leaseId: "terminal-lease-1", delaySeconds: 30 },
      { leaseId: "terminal-lease-2", delaySeconds: 120 },
    ]);
    assert.deepEqual(acknowledged, ["terminal-lease-3"]);
    assert.deepEqual(
      saves
        .filter((state) => state.reservation !== undefined)
        .map((state) => state.reservation?.slot),
      [1, 2, 3],
    );
    assert.equal(states.size, 0);
  });

  it("re-reports idempotently and re-acknowledges after terminal ACK loss", async () => {
    const [job] = await enqueueSignedWebhook("pipeline-terminal-ack-loss");
    assert.ok(job);
    const deliveries = [1, 2, 3, 4].map((attempt) => ({
      leaseId: `ack-loss-lease-${attempt}`,
      attempt,
      body: job,
    }));
    const acknowledged: string[] = [];
    const retried: Array<{ leaseId: string; delaySeconds: number }> = [];
    const queue: QueueClient = {
      async pullOne() {
        return deliveries.shift();
      },
      async acknowledge(leaseId) {
        acknowledged.push(leaseId);
        if (leaseId === "ack-loss-lease-3") {
          throw new Error("ACK response was lost");
        }
      },
      async retry(leaseId, delaySeconds) {
        retried.push({ leaseId, delaySeconds });
      },
    };
    let reviewAttempts = 0;
    const reviews: ManualReviewService = {
      async review() {
        reviewAttempts += 1;
        throw new Error("temporary Pi failure");
      },
    };
    const terminalBodies: string[] = [];
    const reportedAttempts: number[] = [];
    const reporter: ReviewFailureReporter = {
      async report(reference, error, attempt, totalAttempts) {
        reportedAttempts.push(attempt);
        if (attempt === 3) {
          terminalBodies.push(
            renderReviewFailureComment(
              classifyReviewFailure(error),
              attempt,
              totalAttempts,
              reference,
            ),
          );
        }
      },
    };
    const states = new Map<string, OperationalFailureState>();
    const runner = new QueueReviewRunner(
      configuration,
      queue,
      reviews,
      reporter,
      memoryFailureStore(states),
    );

    await runner.consumeOne();
    await runner.consumeOne();
    await assert.rejects(runner.consumeOne(), /ACK response was lost/u);
    assert.deepEqual(states.get(job.deliveryId), {
      committedFailures: 3,
      terminalCategory: "pi",
    });
    await runner.consumeOne();

    assert.equal(reviewAttempts, 3);
    assert.deepEqual(reportedAttempts, [1, 2, 3, 3]);
    assert.equal(terminalBodies.length, 2);
    assert.equal(terminalBodies[0], terminalBodies[1]);
    assert.deepEqual(retried, [
      { leaseId: "ack-loss-lease-1", delaySeconds: 30 },
      { leaseId: "ack-loss-lease-2", delaySeconds: 120 },
    ]);
    assert.deepEqual(acknowledged, ["ack-loss-lease-3", "ack-loss-lease-4"]);
    assert.equal(states.size, 0);
  });
});
