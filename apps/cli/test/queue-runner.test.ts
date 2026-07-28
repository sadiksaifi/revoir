import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createConfiguration } from "../src/config/schema.js";
import type { QueueDelivery } from "../src/queue/client.js";
import { QueueReviewRunner, type QueueClient } from "../src/queue/runner.js";
import type { ManualReviewService } from "../src/review/orchestrator.js";
import { PullRequestEligibilityError } from "../src/review/pull-request.js";
import { TEST_PRIVATE_KEY } from "./helpers.js";

function configuration() {
  return createConfiguration({
    github: {
      userId: 42,
      appId: 7,
      installationId: 8,
      privateKey: TEST_PRIVATE_KEY,
      repositories: [{ id: 99, owner: "owner", name: "repository" }],
    },
    cloudflare: {
      accountId: "account-id",
      queueId: "queue-id",
      apiToken: "queue-token",
    },
    paths: {
      cacheDir: "/tmp/cache",
      stateDir: "/tmp/state",
      dataDir: "/tmp/data",
    },
  });
}

function reviewJob(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    deliveryId: "2f5f7475-33ee-4f91-9b68-0f8af72f6640",
    installationId: 8,
    repository: { id: 99, owner: "owner", name: "repository" },
    pullRequest: {
      number: 17,
      authorId: 42,
      senderId: 42,
      baseRepositoryId: 99,
      headRepositoryId: 99,
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
    },
    action: "synchronize",
    enqueuedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function delivery(leaseId: string, body: unknown): QueueDelivery {
  return { leaseId, body };
}

describe("automatic queue review runner", () => {
  it("acknowledges terminal jobs and retries only operational review failures", async () => {
    const deliveries = [
      delivery("malformed", { version: 2 }),
      delivery("wrong-installation", reviewJob({ installationId: 9 })),
      delivery("clean", reviewJob()),
      delivery("findings", reviewJob()),
      delivery("ineligible", reviewJob()),
      delivery("transient", reviewJob()),
    ];
    const acknowledgements: string[] = [];
    const retries: string[] = [];
    const queue: QueueClient = {
      async pullOne() {
        return deliveries.shift();
      },
      async acknowledge(leaseId) {
        acknowledgements.push(leaseId);
      },
      async retry(leaseId) {
        retries.push(leaseId);
      },
    };
    const references: Array<{ url: string; expectedHeadSha: string | undefined }> = [];
    let reviews = 0;
    const reviewService: ManualReviewService = {
      async review(reference, options) {
        reviews += 1;
        references.push({
          url: reference.url,
          expectedHeadSha: options?.expectedHeadSha,
        });
        if (reviews === 1) {
          return {
            status: "clean",
            reviewedSha: "2".repeat(40),
            currentSha: "2".repeat(40),
          };
        }
        if (reviews === 2) {
          return {
            status: "findings",
            reviewedSha: "2".repeat(40),
            currentSha: "2".repeat(40),
            publishedFindings: 1,
            rejectedFindings: 0,
            diagnostics: [],
          };
        }
        if (reviews === 3) {
          throw new PullRequestEligibilityError("Pull request is no longer eligible.");
        }
        throw new Error("temporary GitHub failure");
      },
    };
    const runner = new QueueReviewRunner(configuration(), queue, reviewService);

    while (deliveries.length > 0) {
      // Each call verifies the settlement of exactly one leased delivery.
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await runner.consumeOne(), "settled");
    }

    assert.deepEqual(acknowledgements, [
      "malformed",
      "wrong-installation",
      "clean",
      "findings",
      "ineligible",
    ]);
    assert.deepEqual(retries, ["transient"]);
    assert.deepEqual(references, [
      {
        url: "https://github.com/owner/repository/pull/17",
        expectedHeadSha: "2".repeat(40),
      },
      {
        url: "https://github.com/owner/repository/pull/17",
        expectedHeadSha: "2".repeat(40),
      },
      {
        url: "https://github.com/owner/repository/pull/17",
        expectedHeadSha: "2".repeat(40),
      },
      {
        url: "https://github.com/owner/repository/pull/17",
        expectedHeadSha: "2".repeat(40),
      },
    ]);
  });

  it("pulls and settles at most one review at a time", async () => {
    const controller = new AbortController();
    let pulls = 0;
    let activeReviews = 0;
    let maximumActiveReviews = 0;
    const queue: QueueClient = {
      async pullOne() {
        pulls += 1;
        if (pulls <= 2) {
          return delivery(`lease-${pulls}`, reviewJob());
        }
        controller.abort();
        return undefined;
      },
      async acknowledge() {},
      async retry() {},
    };
    const reviewService: ManualReviewService = {
      async review() {
        activeReviews += 1;
        maximumActiveReviews = Math.max(maximumActiveReviews, activeReviews);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeReviews -= 1;
        return {
          status: "clean",
          reviewedSha: "2".repeat(40),
          currentSha: "2".repeat(40),
        };
      },
    };

    await new QueueReviewRunner(configuration(), queue, reviewService).run(controller.signal);

    assert.equal(pulls, 3);
    assert.equal(maximumActiveReviews, 1);
  });

  it("cancels active review work, settles its lease, and logs shutdown before returning", async () => {
    const controller = new AbortController();
    let delivered = false;
    const retries: string[] = [];
    const events: Array<{ event: string; data: Readonly<Record<string, unknown>> }> = [];
    const queue: QueueClient = {
      async pullOne() {
        if (delivered) {
          return undefined;
        }
        delivered = true;
        return delivery("shutdown-lease", reviewJob());
      },
      async acknowledge() {},
      async retry(leaseId) {
        retries.push(leaseId);
      },
    };
    const reviewService: ManualReviewService = {
      async review(_reference, options) {
        controller.abort(new Error("SIGTERM requested graceful shutdown"));
        assert.equal(options?.signal?.aborted, true);
        throw options?.signal?.reason;
      },
    };
    const logger = {
      async write(event: string, data: Readonly<Record<string, unknown>> = {}) {
        events.push({ event, data });
      },
    };

    await new QueueReviewRunner(configuration(), queue, reviewService, logger).run(
      controller.signal,
    );

    assert.deepEqual(retries, ["shutdown-lease"]);
    assert.deepEqual(
      events.map(({ event }) => event),
      ["queue_review_started", "queue_review_retried"],
    );
    assert.equal(events[1]?.data["deliveryId"], reviewJob().deliveryId);
  });
});
