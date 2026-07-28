import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ReviewJobV1 } from "@revoir/contracts";
import {
  QueueReviewRunner,
  type ManualReviewResult,
  type ManualReviewService,
  type QueueClient,
  type RevoirConfiguration,
} from "cli";

import { createWebhookRelay, type RelayEnvironment } from "../src/index.js";

const WEBHOOK_SECRET = "pipeline-webhook-secret";

const configuration: RevoirConfiguration = {
  version: 1,
  model: { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
  github: {
    userId: 42,
    appId: 7,
    installationId: 8,
    privateKey: "unused by fake review service",
    repositories: [{ id: 99, owner: "owner", name: "repository" }],
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
        await new QueueReviewRunner(configuration, queue, reviewService).consumeOne(),
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
        return job === undefined ? undefined : { leaseId: "lease-stale", body: job };
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
      await new QueueReviewRunner(configuration, queue, reviewService).consumeOne(),
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
      await new QueueReviewRunner(configuration, queue, reviewService).consumeOne(),
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
});
