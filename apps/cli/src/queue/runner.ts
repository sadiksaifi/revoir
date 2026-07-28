import { parseReviewJob, ReviewJobSchemaError, type ReviewJobV1 } from "@revoir/contracts";

import type { RevoirConfiguration } from "../config/schema.js";
import {
  GitHubReviewFailureReporter,
  type ReviewFailureReporter,
} from "../review/failure-reporter.js";
import { classifyReviewFailure, reviewFailureForCategory } from "../review/failure.js";
import {
  createDefaultManualReviewService,
  type ManualReviewService,
} from "../review/orchestrator.js";
import { PullRequestEligibilityError, type PullRequestReference } from "../review/pull-request.js";
import { CloudflareQueueClient, type QueueDelivery } from "./client.js";
import {
  FileOperationalFailureStore,
  type OperationalFailureState,
  type OperationalFailureStore,
} from "./failure-store.js";

export type { OperationalFailureState, OperationalFailureStore } from "./failure-store.js";

const IDLE_POLL_DELAY_MS = 1_000;
const MAX_OPERATIONAL_ATTEMPTS = 3;
const MAX_TERMINAL_REPORT_ATTEMPTS = 3;
const OPERATIONAL_RETRY_DELAYS_SECONDS = [30, 120] as const;

export interface QueueClient {
  pullOne(signal?: AbortSignal): Promise<QueueDelivery | undefined>;
  acknowledge(leaseId: string, signal?: AbortSignal): Promise<void>;
  retry(leaseId: string, delaySeconds: number, signal?: AbortSignal): Promise<void>;
}

export type QueueConsumption = "idle" | "settled";

export interface QueueRunService {
  run(signal?: AbortSignal): Promise<void>;
}

function locallyEligible(job: ReviewJobV1, configuration: RevoirConfiguration["github"]): boolean {
  if (
    job.installationId !== configuration.installationId ||
    job.pullRequest.authorId !== configuration.userId ||
    job.pullRequest.senderId !== configuration.userId
  ) {
    return false;
  }
  return configuration.repositories.some(
    (repository) =>
      repository.id === job.repository.id &&
      repository.owner.toLowerCase() === job.repository.owner.toLowerCase() &&
      repository.name.toLowerCase() === job.repository.name.toLowerCase(),
  );
}

function referenceFor(job: ReviewJobV1): PullRequestReference {
  const { owner, name } = job.repository;
  const number = job.pullRequest.number;
  return {
    owner,
    repository: name,
    number,
    url: `https://github.com/${owner}/${name}/pull/${number}`,
  };
}

function waitForNextPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(done, IDLE_POLL_DELAY_MS);
    function done(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Queue runner was cancelled.");
  }
}

function fallbackOperationalAttempt(transportAttempt: number, minimumAttempt = 1): number {
  return Math.min(MAX_OPERATIONAL_ATTEMPTS, Math.max(transportAttempt, minimumAttempt));
}

class StoreOperationTimeoutError extends Error {
  constructor(operation: string) {
    super(`Operational review failure state ${operation} timed out.`);
    this.name = "TimeoutError";
  }
}

function waitForStoreOperation<T>(
  operation: Promise<T>,
  operationName: string,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    function finish(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    }
    function onAbort(): void {
      finish(() => {
        if (callerSignal?.aborted === true) {
          reject(
            callerSignal.reason instanceof Error
              ? callerSignal.reason
              : new Error("Queue runner was cancelled."),
          );
        } else {
          reject(new StoreOperationTimeoutError(operationName));
        }
      });
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

type FailureReportResult = "reported" | "rejected" | "timed-out";

export class QueueReviewRunner implements QueueRunService {
  readonly #configuration: RevoirConfiguration;
  readonly #failures: ReviewFailureReporter;
  readonly #operationalFailures: OperationalFailureStore;
  readonly #pendingSaves = new Map<string, Promise<void>>();
  readonly #queue: QueueClient;
  readonly #reviews: ManualReviewService;

  constructor(
    configuration: RevoirConfiguration,
    queue: QueueClient,
    reviews: ManualReviewService,
    failures: ReviewFailureReporter = new GitHubReviewFailureReporter(configuration.github),
    operationalFailures: OperationalFailureStore = new FileOperationalFailureStore(
      configuration.paths.stateDir,
    ),
  ) {
    this.#configuration = configuration;
    this.#queue = queue;
    this.#reviews = reviews;
    this.#failures = failures;
    this.#operationalFailures = operationalFailures;
  }

  async consumeOne(signal?: AbortSignal): Promise<QueueConsumption> {
    const delivery = await this.#queue.pullOne(signal);
    if (delivery === undefined) {
      return "idle";
    }

    let job: ReviewJobV1;
    try {
      job = parseReviewJob(delivery.body);
    } catch (error) {
      if (!(error instanceof ReviewJobSchemaError)) {
        throw error;
      }
      await this.#queue.acknowledge(delivery.leaseId, signal);
      return "settled";
    }

    if (!locallyEligible(job, this.#configuration.github)) {
      await this.#queue.acknowledge(delivery.leaseId, signal);
      await this.#clearFailureState(job.deliveryId, signal);
      return "settled";
    }

    let operationalState: OperationalFailureState;
    try {
      operationalState = await this.#loadFailureState(job.deliveryId, signal);
      throwIfCancelled(signal);
    } catch (error) {
      throwIfCancelled(signal);
      const fallbackAttempt = fallbackOperationalAttempt(delivery.attempt);
      await this.#reportFailure(referenceFor(job), error, fallbackAttempt, signal);
      throwIfCancelled(signal);
      if (fallbackAttempt >= MAX_OPERATIONAL_ATTEMPTS) {
        await this.#queue.acknowledge(delivery.leaseId, signal);
        await this.#clearFailureState(job.deliveryId, signal);
      } else {
        await this.#queue.retry(
          delivery.leaseId,
          OPERATIONAL_RETRY_DELAYS_SECONDS[fallbackAttempt - 1]!,
          signal,
        );
      }
      return "settled";
    }

    if (operationalState.failures >= MAX_OPERATIONAL_ATTEMPTS) {
      return this.#settleTerminalFailure(delivery, job, operationalState, signal);
    }

    try {
      await this.#reviews.review(referenceFor(job), {
        expectedHeadSha: job.pullRequest.headSha,
        ...(signal === undefined ? {} : { signal }),
      });
      throwIfCancelled(signal);
      await this.#queue.acknowledge(delivery.leaseId, signal);
      await this.#clearFailureState(job.deliveryId, signal);
    } catch (error) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : error;
      }
      if (error instanceof PullRequestEligibilityError) {
        await this.#queue.acknowledge(delivery.leaseId, signal);
        await this.#clearFailureState(job.deliveryId, signal);
      } else {
        const nextFailure = operationalState.failures + 1;
        const failure = classifyReviewFailure(error);
        const nextState: OperationalFailureState =
          nextFailure >= MAX_OPERATIONAL_ATTEMPTS
            ? {
                failures: nextFailure,
                terminalReport: {
                  status: "pending",
                  attempts: 0,
                  category: failure.category,
                },
              }
            : {
                failures: nextFailure,
                terminalReport: { status: "not-required" },
              };
        try {
          await this.#saveFailureState(job.deliveryId, nextState, signal);
          throwIfCancelled(signal);
        } catch (stateError) {
          throwIfCancelled(signal);
          const fallbackAttempt = fallbackOperationalAttempt(delivery.attempt, nextFailure);
          await this.#reportFailure(referenceFor(job), stateError, fallbackAttempt, signal);
          throwIfCancelled(signal);
          if (fallbackAttempt >= MAX_OPERATIONAL_ATTEMPTS) {
            await this.#queue.acknowledge(delivery.leaseId, signal);
            await this.#clearFailureState(job.deliveryId, signal);
          } else {
            await this.#queue.retry(
              delivery.leaseId,
              OPERATIONAL_RETRY_DELAYS_SECONDS[fallbackAttempt - 1]!,
              signal,
            );
          }
          return "settled";
        }
        if (nextFailure >= MAX_OPERATIONAL_ATTEMPTS) {
          return this.#settleTerminalFailure(delivery, job, nextState, signal);
        }
        await this.#reportFailure(referenceFor(job), failure, nextFailure, signal);
        throwIfCancelled(signal);
        await this.#queue.retry(
          delivery.leaseId,
          OPERATIONAL_RETRY_DELAYS_SECONDS[nextFailure - 1]!,
          signal,
        );
      }
    }
    return "settled";
  }

  async #loadFailureState(
    deliveryId: string,
    signal?: AbortSignal,
  ): Promise<OperationalFailureState> {
    const pendingSave = this.#pendingSaves.get(deliveryId);
    if (pendingSave !== undefined) {
      await this.#boundStoreOperation(pendingSave, "save", signal);
    }
    const { operation, operationSignal } = this.#startStoreOperation(
      (storeSignal) => this.#operationalFailures.load(deliveryId, storeSignal),
      signal,
    );
    return waitForStoreOperation(operation, "load", operationSignal, signal);
  }

  async #saveFailureState(
    deliveryId: string,
    state: OperationalFailureState,
    signal?: AbortSignal,
  ): Promise<void> {
    const { operation, operationSignal } = this.#startStoreOperation(
      (storeSignal) => this.#operationalFailures.save(deliveryId, state, storeSignal),
      signal,
    );
    this.#pendingSaves.set(deliveryId, operation);
    void operation.then(
      () => {
        if (this.#pendingSaves.get(deliveryId) === operation) {
          this.#pendingSaves.delete(deliveryId);
        }
      },
      () => {
        if (this.#pendingSaves.get(deliveryId) === operation) {
          this.#pendingSaves.delete(deliveryId);
        }
      },
    );
    await waitForStoreOperation(operation, "save", operationSignal, signal);
  }

  #startStoreOperation<T>(
    run: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): {
    operation: Promise<T>;
    operationSignal: AbortSignal;
  } {
    const timeoutSignal = AbortSignal.timeout(this.#configuration.timeouts.shellCommandMs);
    const operationSignal =
      callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]);
    const operation = Promise.resolve().then(() => run(operationSignal));
    return { operation, operationSignal };
  }

  async #boundStoreOperation<T>(
    operation: Promise<T>,
    operationName: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.#configuration.timeouts.shellCommandMs);
    const operationSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    return waitForStoreOperation(operation, operationName, operationSignal, signal);
  }

  async #clearFailureState(deliveryId: string, signal?: AbortSignal): Promise<void> {
    // Queue settlement has already been confirmed. A stale local file must not resurrect
    // or loop a message that is no longer leased.
    const pendingSave = this.#pendingSaves.get(deliveryId);
    await this.#clearFailureStateNow(deliveryId, signal);
    if (pendingSave !== undefined) {
      void pendingSave.then(
        () => this.#clearFailureStateNow(deliveryId),
        () => this.#clearFailureStateNow(deliveryId),
      );
    }
  }

  async #clearFailureStateNow(deliveryId: string, signal?: AbortSignal): Promise<void> {
    const { operation, operationSignal } = this.#startStoreOperation(
      (storeSignal) => this.#operationalFailures.clear(deliveryId, storeSignal),
      signal,
    );
    await waitForStoreOperation(operation, "clear", operationSignal, signal).catch(() => {});
  }

  async #settleTerminalFailure(
    delivery: QueueDelivery,
    job: ReviewJobV1,
    state: OperationalFailureState,
    signal?: AbortSignal,
  ): Promise<QueueConsumption> {
    const terminal = state.terminalReport;
    if (terminal.status === "confirmed" || terminal.status === "exhausted") {
      await this.#queue.acknowledge(delivery.leaseId, signal);
      await this.#clearFailureState(job.deliveryId, signal);
      return "settled";
    }
    if (terminal.status !== "pending" && terminal.status !== "publishing") {
      throw new Error("Terminal operational review failure state is invalid.");
    }

    const reportingAttempt =
      terminal.status === "publishing" ? terminal.attempts : terminal.attempts + 1;
    if (terminal.status === "pending") {
      await this.#saveFailureState(
        job.deliveryId,
        {
          failures: MAX_OPERATIONAL_ATTEMPTS,
          terminalReport: {
            status: "publishing",
            attempts: reportingAttempt,
            category: terminal.category,
          },
        },
        signal,
      );
      throwIfCancelled(signal);
    }
    const reportResult = await this.#reportFailure(
      referenceFor(job),
      reviewFailureForCategory(terminal.category),
      MAX_OPERATIONAL_ATTEMPTS,
      signal,
    );
    throwIfCancelled(signal);

    if (reportResult === "reported") {
      await this.#saveFailureState(
        job.deliveryId,
        {
          failures: MAX_OPERATIONAL_ATTEMPTS,
          terminalReport: {
            status: "confirmed",
            attempts: reportingAttempt,
            category: terminal.category,
          },
        },
        signal,
      );
      throwIfCancelled(signal);
      await this.#queue.acknowledge(delivery.leaseId, signal);
      await this.#clearFailureState(job.deliveryId, signal);
    } else if (reportingAttempt >= MAX_TERMINAL_REPORT_ATTEMPTS) {
      await this.#saveFailureState(
        job.deliveryId,
        {
          failures: MAX_OPERATIONAL_ATTEMPTS,
          terminalReport: {
            status: "exhausted",
            attempts: reportingAttempt,
            category: terminal.category,
          },
        },
        signal,
      );
      throwIfCancelled(signal);
      await this.#queue.acknowledge(delivery.leaseId, signal);
      await this.#clearFailureState(job.deliveryId, signal);
    } else {
      await this.#saveFailureState(
        job.deliveryId,
        {
          failures: MAX_OPERATIONAL_ATTEMPTS,
          terminalReport: {
            status: "pending",
            attempts: reportingAttempt,
            category: terminal.category,
          },
        },
        signal,
      );
      throwIfCancelled(signal);
      await this.#queue.retry(delivery.leaseId, OPERATIONAL_RETRY_DELAYS_SECONDS.at(-1)!, signal);
    }
    return "settled";
  }

  async #reportFailure(
    reference: PullRequestReference,
    failure: unknown,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<FailureReportResult> {
    const timeoutSignal = AbortSignal.timeout(this.#configuration.timeouts.shellCommandMs);
    const reportingSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    const report = Promise.resolve().then(() =>
      this.#failures.report(reference, failure, attempt, MAX_OPERATIONAL_ATTEMPTS, reportingSignal),
    );
    // The report promise is joined when the provider cooperates and safely observed if it
    // ignores cancellation. Queue settlement cannot be held indefinitely by that provider.
    const result = await new Promise<"reported" | "rejected" | "aborted">((resolve) => {
      let settled = false;
      function finish(value: "reported" | "rejected" | "aborted"): void {
        if (settled) {
          return;
        }
        settled = true;
        reportingSignal.removeEventListener("abort", onAbort);
        resolve(value);
      }
      function onAbort(): void {
        finish("aborted");
      }
      reportingSignal.addEventListener("abort", onAbort, { once: true });
      void report.then(
        () => finish("reported"),
        () => finish("rejected"),
      );
      if (reportingSignal.aborted) {
        onAbort();
      }
    });
    throwIfCancelled(signal);
    return result === "aborted" ? "timed-out" : result;
  }

  async run(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted === true) {
        return;
      }
      // Pull and settlement are deliberately serialized to keep one review in flight.
      // eslint-disable-next-line no-await-in-loop
      const result = await this.consumeOne(signal);
      if (result === "idle") {
        // eslint-disable-next-line no-await-in-loop
        await waitForNextPoll(signal);
      }
    }
  }
}

export function createDefaultQueueRunService(configuration: RevoirConfiguration): QueueRunService {
  return new QueueReviewRunner(
    configuration,
    new CloudflareQueueClient(configuration.cloudflare, configuration.timeouts.reviewMs),
    createDefaultManualReviewService(configuration),
    new GitHubReviewFailureReporter(configuration.github),
    new FileOperationalFailureStore(configuration.paths.stateDir),
  );
}
