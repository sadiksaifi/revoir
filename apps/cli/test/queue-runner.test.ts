import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createConfiguration } from "../src/config/schema.js";
import type { QueueDelivery } from "../src/queue/client.js";
import { QueueReviewRunner, type QueueClient } from "../src/queue/runner.js";
import type { ReviewFailureReporter } from "../src/review/failure-reporter.js";
import type { ManualReviewService } from "../src/review/orchestrator.js";
import { PullRequestEligibilityError } from "../src/review/pull-request.js";
import { TEST_PRIVATE_KEY } from "./helpers.js";

function configuration(timeouts?: { reviewMs?: number; shellCommandMs?: number }) {
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
    ...(timeouts === undefined ? {} : { timeouts }),
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

function delivery(leaseId: string, body: unknown, attempt = 1): QueueDelivery {
  return { leaseId, attempt, body };
}

const silentFailureReporter: ReviewFailureReporter = {
  async report() {},
};

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
    const runner = new QueueReviewRunner(
      configuration(),
      queue,
      reviewService,
      silentFailureReporter,
    );

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

  it("retries two operational failures with increasing delay and acknowledges the third", async () => {
    const deliveries = [1, 2, 3].map((attempt) =>
      delivery(`lease-${attempt}`, reviewJob(), attempt),
    );
    const acknowledgements: string[] = [];
    const retries: Array<{ leaseId: string; delaySeconds: number }> = [];
    const queue: QueueClient = {
      async pullOne() {
        return deliveries.shift();
      },
      async acknowledge(leaseId) {
        acknowledgements.push(leaseId);
      },
      async retry(leaseId, delaySeconds) {
        retries.push({ leaseId, delaySeconds });
      },
    };
    const reviews: ManualReviewService = {
      async review() {
        throw new Error("temporary Pi failure");
      },
    };
    const reportedAttempts: number[] = [];
    const reporter: ReviewFailureReporter = {
      async report(_reference, _error, attempt) {
        reportedAttempts.push(attempt);
      },
    };
    const runner = new QueueReviewRunner(configuration(), queue, reviews, reporter);

    await runner.consumeOne();
    await runner.consumeOne();
    await runner.consumeOne();

    assert.deepEqual(retries, [
      { leaseId: "lease-1", delaySeconds: 30 },
      { leaseId: "lease-2", delaySeconds: 120 },
    ]);
    assert.deepEqual(acknowledgements, ["lease-3"]);
    assert.deepEqual(reportedAttempts, [1, 2, 3]);
  });

  it("acknowledges a successful third attempt after two reported operational failures", async () => {
    const deliveries = [1, 2, 3].map((attempt) =>
      delivery(`lease-${attempt}`, reviewJob(), attempt),
    );
    const acknowledgements: string[] = [];
    const retries: Array<{ leaseId: string; delaySeconds: number }> = [];
    const queue: QueueClient = {
      async pullOne() {
        return deliveries.shift();
      },
      async acknowledge(leaseId) {
        acknowledgements.push(leaseId);
      },
      async retry(leaseId, delaySeconds) {
        retries.push({ leaseId, delaySeconds });
      },
    };
    let reviewAttempts = 0;
    const reviews: ManualReviewService = {
      async review() {
        reviewAttempts += 1;
        if (reviewAttempts < 3) {
          throw new Error("temporary provider failure");
        }
        return {
          status: "clean",
          reviewedSha: "2".repeat(40),
          currentSha: "2".repeat(40),
        };
      },
    };
    const reportedAttempts: number[] = [];
    const reporter: ReviewFailureReporter = {
      async report(_reference, _error, attempt) {
        reportedAttempts.push(attempt);
      },
    };
    const runner = new QueueReviewRunner(configuration(), queue, reviews, reporter);

    await runner.consumeOne();
    await runner.consumeOne();
    await runner.consumeOne();

    assert.deepEqual(retries, [
      { leaseId: "lease-1", delaySeconds: 30 },
      { leaseId: "lease-2", delaySeconds: 120 },
    ]);
    assert.deepEqual(acknowledgements, ["lease-3"]);
    assert.deepEqual(reportedAttempts, [1, 2]);
  });

  it("bounds a stalled failure report before retrying the queue lease", async () => {
    let reportingSignal: AbortSignal | undefined;
    let markReportingStarted: (() => void) | undefined;
    const reportingStarted = new Promise<void>((resolve) => {
      markReportingStarted = resolve;
    });
    const retries: Array<{ leaseId: string; delaySeconds: number }> = [];
    const queue: QueueClient = {
      async pullOne() {
        return delivery("lease-stalled-report", reviewJob());
      },
      async acknowledge() {
        assert.fail("The first operational failure must be retried.");
      },
      async retry(leaseId, delaySeconds) {
        retries.push({ leaseId, delaySeconds });
      },
    };
    const reviews: ManualReviewService = {
      async review() {
        throw new Error("temporary provider failure");
      },
    };
    const reporter: ReviewFailureReporter = {
      async report(_reference, _error, _attempt, _totalAttempts, signal) {
        reportingSignal = signal;
        markReportingStarted?.();
        return new Promise<void>(() => {});
      },
    };
    const consumption = new QueueReviewRunner(
      configuration({ shellCommandMs: 5 }),
      queue,
      reviews,
      reporter,
    ).consumeOne();
    await reportingStarted;

    assert.equal(
      await Promise.race([
        consumption,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("failure reporting blocked queue settlement")), 100);
        }),
      ]),
      "settled",
    );
    assert.equal(reportingSignal?.aborted, true);
    assert.deepEqual(retries, [{ leaseId: "lease-stalled-report", delaySeconds: 30 }]);
  });

  it("propagates daemon cancellation without settling or reporting the active queue lease", async () => {
    const controller = new AbortController();
    const cancellation = new Error("daemon stopped");
    let reviewStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      reviewStarted = resolve;
    });
    const queue: QueueClient = {
      async pullOne() {
        return delivery("lease-cancelled", reviewJob());
      },
      async acknowledge() {
        assert.fail("Cancellation must leave the active lease for visibility-timeout redelivery.");
      },
      async retry() {
        assert.fail("Cancellation must not consume an operational retry.");
      },
    };
    const reviews: ManualReviewService = {
      async review(_reference, options) {
        assert.equal(options?.signal, controller.signal);
        reviewStarted?.();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    };
    const reporter: ReviewFailureReporter = {
      async report() {
        assert.fail("Daemon cancellation is not an operational review failure.");
      },
    };
    const consumption = new QueueReviewRunner(configuration(), queue, reviews, reporter).consumeOne(
      controller.signal,
    );
    await started;
    controller.abort(cancellation);

    await assert.rejects(consumption, cancellation);
  });
});
