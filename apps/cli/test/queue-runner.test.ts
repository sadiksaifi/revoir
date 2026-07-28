import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createConfiguration } from "../src/config/schema.js";
import type { QueueDelivery } from "../src/queue/client.js";
import {
  QueueReviewRunner,
  type OperationalFailureState,
  type OperationalFailureStore,
  type QueueClient,
} from "../src/queue/runner.js";
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

function emptyFailureState(): OperationalFailureState {
  return {
    failures: 0,
    terminalReport: { status: "not-required" },
  };
}

async function settleWithin<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), 100);
    }),
  ]);
}

class MemoryOperationalFailureStore implements OperationalFailureStore {
  readonly failures = new Map<string, OperationalFailureState>();

  async load(deliveryId: string): Promise<OperationalFailureState> {
    return this.failures.get(deliveryId) ?? emptyFailureState();
  }

  async save(deliveryId: string, state: OperationalFailureState): Promise<void> {
    this.failures.set(deliveryId, state);
  }

  async clear(deliveryId: string): Promise<void> {
    this.failures.delete(deliveryId);
  }
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
    const runner = new QueueReviewRunner(
      configuration(),
      queue,
      reviewService,
      silentFailureReporter,
      new MemoryOperationalFailureStore(),
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

    await new QueueReviewRunner(
      configuration(),
      queue,
      reviewService,
      silentFailureReporter,
      new MemoryOperationalFailureStore(),
    ).run(controller.signal);

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
    const runner = new QueueReviewRunner(
      configuration(),
      queue,
      reviews,
      reporter,
      new MemoryOperationalFailureStore(),
    );

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
    const runner = new QueueReviewRunner(
      configuration(),
      queue,
      reviews,
      reporter,
      new MemoryOperationalFailureStore(),
    );

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
      new MemoryOperationalFailureStore(),
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
    const consumption = new QueueReviewRunner(
      configuration(),
      queue,
      reviews,
      reporter,
      new MemoryOperationalFailureStore(),
    ).consumeOne(controller.signal);
    await started;
    controller.abort(cancellation);

    await assert.rejects(consumption, cancellation);
  });

  it("does not let transport redeliveries consume the operational failure budget", async () => {
    const controller = new AbortController();
    const cancellation = new Error("daemon stopped");
    const deliveries = [
      delivery("cancelled-lease", reviewJob(), 7),
      delivery("successful-lease", reviewJob(), 8),
    ];
    const acknowledgements: string[] = [];
    const queue: QueueClient = {
      async pullOne() {
        return deliveries.shift();
      },
      async acknowledge(leaseId) {
        acknowledgements.push(leaseId);
      },
      async retry() {
        assert.fail("Cancellation and success must not retry the queue message.");
      },
    };
    let reviewAttempts = 0;
    const reviews: ManualReviewService = {
      async review(_reference, options) {
        reviewAttempts += 1;
        if (reviewAttempts === 1) {
          controller.abort(cancellation);
          throw cancellation;
        }
        assert.equal(options?.signal, undefined);
        return {
          status: "clean",
          reviewedSha: "2".repeat(40),
          currentSha: "2".repeat(40),
        };
      },
    };
    const failures = new MemoryOperationalFailureStore();
    const runner = new QueueReviewRunner(
      configuration(),
      queue,
      reviews,
      silentFailureReporter,
      failures,
    );

    await assert.rejects(runner.consumeOne(controller.signal), cancellation);
    assert.equal(failures.failures.size, 0);
    assert.equal(await runner.consumeOne(), "settled");

    assert.equal(reviewAttempts, 2);
    assert.deepEqual(acknowledgements, ["successful-lease"]);
    assert.equal(failures.failures.size, 0);
  });

  it("preserves two failures across cancellation and clears them after later success", async () => {
    const controller = new AbortController();
    const cancellation = new Error("daemon stopped");
    const deliveries = [
      delivery("failure-1", reviewJob(), 1),
      delivery("failure-2", reviewJob(), 2),
      delivery("cancelled", reviewJob(), 3),
      delivery("success", reviewJob(), 4),
    ];
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
        if (reviewAttempts <= 2) {
          throw new Error("temporary provider failure");
        }
        if (reviewAttempts === 3) {
          controller.abort(cancellation);
          throw cancellation;
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
    const failures = new MemoryOperationalFailureStore();
    const runner = new QueueReviewRunner(configuration(), queue, reviews, reporter, failures);

    await runner.consumeOne();
    await runner.consumeOne();
    await assert.rejects(runner.consumeOne(controller.signal), cancellation);
    assert.equal(failures.failures.get(reviewJob().deliveryId)?.failures, 2);
    await runner.consumeOne();

    assert.deepEqual(reportedAttempts, [1, 2]);
    assert.deepEqual(retries, [
      { leaseId: "failure-1", delaySeconds: 30 },
      { leaseId: "failure-2", delaySeconds: 120 },
    ]);
    assert.deepEqual(acknowledgements, ["success"]);
    assert.equal(failures.failures.size, 0);
  });

  it("re-acknowledges a terminal failure after ack loss without another review", async () => {
    const deliveries = [
      delivery("failure-1", reviewJob(), 2),
      delivery("failure-2", reviewJob(), 4),
      delivery("failure-3", reviewJob(), 6),
      delivery("terminal-redelivery", reviewJob(), 7),
    ];
    const acknowledgements: string[] = [];
    const retries: Array<{ leaseId: string; delaySeconds: number }> = [];
    const queue: QueueClient = {
      async pullOne() {
        return deliveries.shift();
      },
      async acknowledge(leaseId) {
        acknowledgements.push(leaseId);
        if (leaseId === "failure-3") {
          throw new Error("ack response was lost");
        }
      },
      async retry(leaseId, delaySeconds) {
        retries.push({ leaseId, delaySeconds });
      },
    };
    let reviewAttempts = 0;
    const reviews: ManualReviewService = {
      async review() {
        reviewAttempts += 1;
        throw new Error("temporary provider failure");
      },
    };
    const reportedAttempts: number[] = [];
    const reporter: ReviewFailureReporter = {
      async report(_reference, _error, attempt) {
        reportedAttempts.push(attempt);
      },
    };
    const failures = new MemoryOperationalFailureStore();
    const runner = new QueueReviewRunner(configuration(), queue, reviews, reporter, failures);

    await runner.consumeOne();
    await runner.consumeOne();
    await assert.rejects(() => runner.consumeOne(), /ack response was lost/u);
    assert.deepEqual(failures.failures.get(reviewJob().deliveryId), {
      failures: 3,
      terminalReport: {
        status: "confirmed",
        attempts: 1,
        category: "unknown",
      },
    });
    await runner.consumeOne();

    assert.equal(reviewAttempts, 3);
    assert.deepEqual(reportedAttempts, [1, 2, 3]);
    assert.deepEqual(retries, [
      { leaseId: "failure-1", delaySeconds: 30 },
      { leaseId: "failure-2", delaySeconds: 120 },
    ]);
    assert.deepEqual(acknowledgements, ["failure-3", "terminal-redelivery"]);
    assert.equal(failures.failures.size, 0);
  });

  it("publishes a pending terminal failure after a crash before acknowledging it", async () => {
    const acknowledgements: string[] = [];
    const queue: QueueClient = {
      async pullOne() {
        return delivery("terminal-redelivery", reviewJob(), 7);
      },
      async acknowledge(leaseId) {
        acknowledgements.push(leaseId);
      },
      async retry() {
        assert.fail("A successful terminal report must be acknowledged.");
      },
    };
    let reviews = 0;
    const reviewService: ManualReviewService = {
      async review() {
        reviews += 1;
        throw new Error("A terminal redelivery must not rerun the review.");
      },
    };
    const reportedAttempts: number[] = [];
    const reporter: ReviewFailureReporter = {
      async report(_reference, _error, attempt) {
        reportedAttempts.push(attempt);
      },
    };
    const failures = new MemoryOperationalFailureStore();
    failures.failures.set(reviewJob().deliveryId, {
      failures: 3,
      terminalReport: {
        status: "pending",
        attempts: 0,
        category: "pi",
      },
    });

    assert.equal(
      await new QueueReviewRunner(
        configuration(),
        queue,
        reviewService,
        reporter,
        failures,
      ).consumeOne(),
      "settled",
    );

    assert.equal(reviews, 0);
    assert.deepEqual(reportedAttempts, [3]);
    assert.deepEqual(acknowledgements, ["terminal-redelivery"]);
    assert.equal(failures.failures.size, 0);
  });

  it("preserves a pending terminal report when cancellation follows its durable save", async () => {
    const controller = new AbortController();
    const cancellation = new Error("daemon stopped after terminal save");
    const deliveries = [
      delivery("cancelled-terminal", reviewJob(), 3),
      delivery("terminal-redelivery", reviewJob(), 4),
    ];
    const acknowledgements: string[] = [];
    const queue: QueueClient = {
      async pullOne() {
        return deliveries.shift();
      },
      async acknowledge(leaseId) {
        acknowledgements.push(leaseId);
      },
      async retry() {
        assert.fail("Cancellation must leave the lease, and successful redelivery must ACK.");
      },
    };
    let reviews = 0;
    const reviewService: ManualReviewService = {
      async review() {
        reviews += 1;
        throw new Error("temporary Pi failure");
      },
    };
    const reportedAttempts: number[] = [];
    const reporter: ReviewFailureReporter = {
      async report(_reference, _error, attempt) {
        reportedAttempts.push(attempt);
      },
    };
    const failures = new MemoryOperationalFailureStore();
    failures.failures.set(reviewJob().deliveryId, {
      failures: 2,
      terminalReport: { status: "not-required" },
    });
    const save = failures.save.bind(failures);
    failures.save = async (deliveryId, state) => {
      await save(deliveryId, state);
      if (
        state.failures === 3 &&
        state.terminalReport.status === "publishing" &&
        state.terminalReport.attempts === 1
      ) {
        controller.abort(cancellation);
      }
    };
    const runner = new QueueReviewRunner(configuration(), queue, reviewService, reporter, failures);

    await assert.rejects(runner.consumeOne(controller.signal), cancellation);
    assert.deepEqual(failures.failures.get(reviewJob().deliveryId), {
      failures: 3,
      terminalReport: {
        status: "publishing",
        attempts: 1,
        category: "pi",
      },
    });
    assert.deepEqual(acknowledgements, []);
    assert.deepEqual(reportedAttempts, []);

    assert.equal(
      await new QueueReviewRunner(
        configuration(),
        queue,
        reviewService,
        reporter,
        failures,
      ).consumeOne(),
      "settled",
    );
    assert.equal(reviews, 1);
    assert.deepEqual(reportedAttempts, [3]);
    assert.deepEqual(acknowledgements, ["terminal-redelivery"]);
  });

  it("retries a rejected terminal report without rerunning the review", async () => {
    const deliveries = [
      delivery("rejected-report", reviewJob(), 4),
      delivery("successful-report", reviewJob(), 5),
    ];
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
        assert.fail("Terminal report redelivery must not rerun Pi.");
      },
    };
    let reports = 0;
    const reporter: ReviewFailureReporter = {
      async report() {
        reports += 1;
        if (reports === 1) {
          throw new Error("GitHub unavailable");
        }
      },
    };
    const failures = new MemoryOperationalFailureStore();
    failures.failures.set(reviewJob().deliveryId, {
      failures: 3,
      terminalReport: {
        status: "pending",
        attempts: 0,
        category: "github",
      },
    });
    const runner = new QueueReviewRunner(configuration(), queue, reviews, reporter, failures);

    await runner.consumeOne();
    assert.deepEqual(failures.failures.get(reviewJob().deliveryId), {
      failures: 3,
      terminalReport: {
        status: "pending",
        attempts: 1,
        category: "github",
      },
    });
    await runner.consumeOne();

    assert.equal(reports, 2);
    assert.deepEqual(retries, [{ leaseId: "rejected-report", delaySeconds: 120 }]);
    assert.deepEqual(acknowledgements, ["successful-report"]);
    assert.equal(failures.failures.size, 0);
  });

  it("bounds a timed-out terminal report and retries it on redelivery", async () => {
    const deliveries = [
      delivery("timed-out-report", reviewJob(), 4),
      delivery("successful-report", reviewJob(), 5),
    ];
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
        assert.fail("Terminal report redelivery must not rerun Pi.");
      },
    };
    let reports = 0;
    let stalledSignal: AbortSignal | undefined;
    const reporter: ReviewFailureReporter = {
      async report(_reference, _error, _attempt, _totalAttempts, signal) {
        reports += 1;
        if (reports === 1) {
          stalledSignal = signal;
          return new Promise<void>(() => {});
        }
      },
    };
    const failures = new MemoryOperationalFailureStore();
    failures.failures.set(reviewJob().deliveryId, {
      failures: 3,
      terminalReport: {
        status: "pending",
        attempts: 0,
        category: "github",
      },
    });
    const runner = new QueueReviewRunner(
      configuration({ shellCommandMs: 5 }),
      queue,
      reviews,
      reporter,
      failures,
    );

    assert.equal(
      await settleWithin(runner.consumeOne(), "terminal failure reporting did not time out"),
      "settled",
    );
    assert.equal(stalledSignal?.aborted, true);
    await runner.consumeOne();

    assert.equal(reports, 2);
    assert.deepEqual(retries, [{ leaseId: "timed-out-report", delaySeconds: 120 }]);
    assert.deepEqual(acknowledgements, ["successful-report"]);
  });

  it("caps terminal report retries during a provider outage", async () => {
    const deliveries = [1, 2, 3].map((attempt) =>
      delivery(`terminal-report-${attempt}`, reviewJob(), attempt + 3),
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
        assert.fail("Terminal report retries must not rerun Pi.");
      },
    };
    let reports = 0;
    const reporter: ReviewFailureReporter = {
      async report() {
        reports += 1;
        throw new Error("GitHub unavailable");
      },
    };
    const failures = new MemoryOperationalFailureStore();
    failures.failures.set(reviewJob().deliveryId, {
      failures: 3,
      terminalReport: {
        status: "pending",
        attempts: 0,
        category: "github",
      },
    });
    const runner = new QueueReviewRunner(configuration(), queue, reviews, reporter, failures);

    await runner.consumeOne();
    await runner.consumeOne();
    await runner.consumeOne();

    assert.equal(reports, 3);
    assert.deepEqual(retries, [
      { leaseId: "terminal-report-1", delaySeconds: 120 },
      { leaseId: "terminal-report-2", delaySeconds: 120 },
    ]);
    assert.deepEqual(acknowledgements, ["terminal-report-3"]);
    assert.equal(failures.failures.size, 0);
  });

  it("bounds a non-settling state load and respects daemon cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("daemon stopped during state load");
    const deliveries = [
      delivery("load-timeout", reviewJob(), 1),
      delivery("load-cancelled", reviewJob(), 2),
    ];
    const retries: string[] = [];
    const queue: QueueClient = {
      async pullOne() {
        return deliveries.shift();
      },
      async acknowledge() {
        assert.fail("A first load timeout must retry, and cancellation must not settle.");
      },
      async retry(leaseId) {
        retries.push(leaseId);
      },
    };
    const reviews: ManualReviewService = {
      async review() {
        assert.fail("Unknown durable state must fail closed.");
      },
    };
    let reports = 0;
    const reporter: ReviewFailureReporter = {
      async report() {
        reports += 1;
      },
    };
    let loads = 0;
    let secondLoadStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      secondLoadStarted = resolve;
    });
    const failures: OperationalFailureStore = {
      async load(_deliveryId, signal) {
        loads += 1;
        if (loads === 2) {
          secondLoadStarted?.();
        }
        assert.ok(signal);
        return new Promise<OperationalFailureState>(() => {});
      },
      async save() {
        assert.fail("Review did not run.");
      },
      async clear() {},
    };
    const runner = new QueueReviewRunner(
      configuration({ shellCommandMs: 5 }),
      queue,
      reviews,
      reporter,
      failures,
    );

    assert.equal(await settleWithin(runner.consumeOne(), "state load did not time out"), "settled");
    const cancelledConsumption = runner.consumeOne(controller.signal);
    await secondStarted;
    controller.abort(cancellation);
    await assert.rejects(cancelledConsumption, cancellation);

    assert.deepEqual(retries, ["load-timeout"]);
    assert.equal(reports, 1);
  });

  it("bounds a non-settling state save and prevents an extra review on redelivery", async () => {
    const deliveries = [
      delivery("save-timeout", reviewJob(), 1),
      delivery("save-redelivery", reviewJob(), 3),
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
    let reviews = 0;
    const reviewService: ManualReviewService = {
      async review() {
        reviews += 1;
        throw new Error("temporary Pi failure");
      },
    };
    let reports = 0;
    const reporter: ReviewFailureReporter = {
      async report() {
        reports += 1;
      },
    };
    const failures: OperationalFailureStore = {
      async load() {
        return emptyFailureState();
      },
      async save(_deliveryId, _state, signal) {
        assert.ok(signal);
        return new Promise<void>(() => {});
      },
      async clear() {},
    };
    const runner = new QueueReviewRunner(
      configuration({ shellCommandMs: 5 }),
      queue,
      reviewService,
      reporter,
      failures,
    );

    assert.equal(await settleWithin(runner.consumeOne(), "state save did not time out"), "settled");
    assert.equal(
      await settleWithin(runner.consumeOne(), "pending state save blocked redelivery"),
      "settled",
    );

    assert.equal(reviews, 1);
    assert.equal(reports, 2);
    assert.deepEqual(retries, ["save-timeout"]);
    assert.deepEqual(acknowledgements, ["save-redelivery"]);
  });

  it("propagates daemon cancellation from a non-settling state save", async () => {
    const controller = new AbortController();
    const cancellation = new Error("daemon stopped during state save");
    const queue: QueueClient = {
      async pullOne() {
        return delivery("save-cancelled", reviewJob());
      },
      async acknowledge() {
        assert.fail("Cancellation must not ACK.");
      },
      async retry() {
        assert.fail("Cancellation must not retry.");
      },
    };
    const reviews: ManualReviewService = {
      async review() {
        throw new Error("temporary Pi failure");
      },
    };
    let saveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const failures: OperationalFailureStore = {
      async load() {
        return emptyFailureState();
      },
      async save() {
        saveStarted?.();
        return new Promise<void>(() => {});
      },
      async clear() {},
    };
    const reporter: ReviewFailureReporter = {
      async report() {
        assert.fail("Cancellation during state save is not an operational attempt.");
      },
    };
    const consumption = new QueueReviewRunner(
      configuration(),
      queue,
      reviews,
      reporter,
      failures,
    ).consumeOne(controller.signal);
    await started;
    controller.abort(cancellation);

    await assert.rejects(consumption, cancellation);
  });

  it("observes a state save that rejects after its deadline", async () => {
    let rejectSave: ((error: Error) => void) | undefined;
    const lateSave = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    const queue: QueueClient = {
      async pullOne() {
        return delivery("late-save-rejection", reviewJob());
      },
      async acknowledge() {
        assert.fail("The first failure must retry.");
      },
      async retry() {},
    };
    const reviews: ManualReviewService = {
      async review() {
        throw new Error("temporary Pi failure");
      },
    };
    const failures: OperationalFailureStore = {
      async load() {
        return emptyFailureState();
      },
      async save() {
        return lateSave;
      },
      async clear() {},
    };
    const runner = new QueueReviewRunner(
      configuration({ shellCommandMs: 5 }),
      queue,
      reviews,
      silentFailureReporter,
      failures,
    );

    await settleWithin(runner.consumeOne(), "late state save did not time out");
    let unhandled: unknown;
    function captureUnhandled(error: unknown): void {
      unhandled = error;
    }
    process.once("unhandledRejection", captureUnhandled);
    rejectSave?.(new Error("late state storage rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    process.removeListener("unhandledRejection", captureUnhandled);

    assert.equal(unhandled, undefined);
  });

  it("bounds state cleanup after settlement and removes a late save mutation", async () => {
    let releaseSave: (() => void) | undefined;
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const states = new Map<string, OperationalFailureState>();
    let clears = 0;
    const failures: OperationalFailureStore = {
      async load(deliveryId) {
        return states.get(deliveryId) ?? emptyFailureState();
      },
      async save(deliveryId, state) {
        await saveReleased;
        states.set(deliveryId, state);
      },
      async clear(deliveryId) {
        clears += 1;
        states.delete(deliveryId);
      },
    };
    const acknowledgements: string[] = [];
    const queue: QueueClient = {
      async pullOne() {
        return delivery("late-save-terminal", reviewJob(), 3);
      },
      async acknowledge(leaseId) {
        acknowledgements.push(leaseId);
      },
      async retry() {
        assert.fail("A terminal transport fallback must ACK.");
      },
    };
    const reviews: ManualReviewService = {
      async review() {
        throw new Error("temporary Pi failure");
      },
    };
    const runner = new QueueReviewRunner(
      configuration({ shellCommandMs: 5 }),
      queue,
      reviews,
      silentFailureReporter,
      failures,
    );

    assert.equal(
      await settleWithin(runner.consumeOne(), "late state save blocked terminal settlement"),
      "settled",
    );
    assert.deepEqual(acknowledgements, ["late-save-terminal"]);
    assert.equal(states.size, 0);

    releaseSave?.();
    for (let index = 0; index < 10; index += 1) {
      if (states.size === 0 && clears >= 2) {
        break;
      }
      // Allow the observed late save and its compensating clear to settle.
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(states.size, 0);
    assert.equal(clears, 2);
  });

  it("bounds a non-settling clear and observes daemon cancellation after ACK", async () => {
    const controller = new AbortController();
    const deliveries = [
      delivery("clear-timeout", reviewJob()),
      delivery("clear-cancelled", reviewJob()),
    ];
    const acknowledgements: string[] = [];
    const queue: QueueClient = {
      async pullOne() {
        return deliveries.shift();
      },
      async acknowledge(leaseId) {
        acknowledgements.push(leaseId);
      },
      async retry() {
        assert.fail("Successful reviews must ACK.");
      },
    };
    const reviews: ManualReviewService = {
      async review() {
        return {
          status: "clean",
          reviewedSha: "2".repeat(40),
          currentSha: "2".repeat(40),
        };
      },
    };
    let clears = 0;
    let secondClearStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      secondClearStarted = resolve;
    });
    const failures: OperationalFailureStore = {
      async load() {
        return emptyFailureState();
      },
      async save() {},
      async clear(_deliveryId, signal) {
        clears += 1;
        assert.ok(signal);
        if (clears === 2) {
          secondClearStarted?.();
        }
        return new Promise<void>(() => {});
      },
    };
    const runner = new QueueReviewRunner(
      configuration({ shellCommandMs: 5 }),
      queue,
      reviews,
      silentFailureReporter,
      failures,
    );

    assert.equal(
      await settleWithin(runner.consumeOne(), "state clear did not time out"),
      "settled",
    );
    const cancelledConsumption = runner.consumeOne(controller.signal);
    await secondStarted;
    controller.abort(new Error("daemon stopped during state clear"));
    assert.equal(
      await settleWithin(cancelledConsumption, "cancelled state clear blocked the runner"),
      "settled",
    );

    assert.deepEqual(acknowledgements, ["clear-timeout", "clear-cancelled"]);
  });

  it("uses transport attempts only as a bounded fallback when failure state cannot load", async () => {
    const deliveries = [
      delivery("state-retry", reviewJob(), 2),
      delivery("state-terminal", reviewJob(), 7),
    ];
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
        assert.fail("Unreadable failure state must fail closed before review execution.");
      },
    };
    const reportedAttempts: number[] = [];
    const reporter: ReviewFailureReporter = {
      async report(_reference, _error, attempt) {
        reportedAttempts.push(attempt);
      },
    };
    let clears = 0;
    const failures: OperationalFailureStore = {
      async load() {
        throw new Error("state unavailable");
      },
      async save() {
        assert.fail("Review execution did not produce a failure to save.");
      },
      async clear() {
        clears += 1;
      },
    };
    const runner = new QueueReviewRunner(configuration(), queue, reviews, reporter, failures);

    await runner.consumeOne();
    await runner.consumeOne();

    assert.deepEqual(reportedAttempts, [2, 3]);
    assert.deepEqual(retries, [{ leaseId: "state-retry", delaySeconds: 120 }]);
    assert.deepEqual(acknowledgements, ["state-terminal"]);
    assert.equal(clears, 1);
  });

  it("bounds retries with transport attempts when a new failure count cannot persist", async () => {
    const deliveries = [
      delivery("state-save-retry", reviewJob(), 1),
      delivery("state-save-terminal", reviewJob(), 5),
    ];
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
        throw new Error("temporary provider failure");
      },
    };
    const reportedAttempts: number[] = [];
    const reporter: ReviewFailureReporter = {
      async report(_reference, error, attempt) {
        assert.match((error as Error).message, /cannot persist/u);
        reportedAttempts.push(attempt);
      },
    };
    let clears = 0;
    const failures: OperationalFailureStore = {
      async load() {
        return {
          failures: 0,
          terminalReport: { status: "not-required" },
        };
      },
      async save() {
        throw new Error("cannot persist failure count");
      },
      async clear() {
        clears += 1;
      },
    };
    const runner = new QueueReviewRunner(configuration(), queue, reviews, reporter, failures);

    await runner.consumeOne();
    await runner.consumeOne();

    assert.deepEqual(reportedAttempts, [1, 3]);
    assert.deepEqual(retries, [{ leaseId: "state-save-retry", delaySeconds: 30 }]);
    assert.deepEqual(acknowledgements, ["state-save-terminal"]);
    assert.equal(clears, 1);
  });
});
