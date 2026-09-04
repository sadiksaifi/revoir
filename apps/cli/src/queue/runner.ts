import { randomUUID } from "node:crypto";

import { parseReviewQueueJob, ReviewJobSchemaError, type ReviewQueueJob } from "@revoir/contracts";

import { isCallerCancellation, isOnlyTargetedReviewCancellation } from "../cancellation.js";
import { CloudflarePolicyReadError } from "../cloudflare-policy.js";
import type { RevoirPolicy } from "../config/policy.js";
import type { RevoirConfiguration } from "../config/schema.js";
import {
  GitHubReviewFailureReporter,
  type ReviewFailureReporter,
} from "../review/failure-reporter.js";
import {
  classifyReviewFailure,
  reviewFailureForCategory,
  type ReviewFailureCategory,
} from "../review/failure.js";
import {
  createDefaultManualReviewService,
  type ManualReviewService,
} from "../review/orchestrator.js";
import { PullRequestEligibilityError, type PullRequestReference } from "../review/pull-request.js";
import { CloudflareQueueClient, type QueueDelivery } from "./client.js";
import {
  FileOperationalFailureStore,
  type OperationalAttemptSlot,
  type OperationalFailureCount,
  type OperationalFailureState,
  type OperationalFailureStore,
} from "./failure-store.js";
import {
  FileReviewRequestCompletionStore,
  type ReviewRequestCompletionStore,
  type ReviewRequestIdentity,
} from "./request-completion-store.js";

export type { OperationalFailureState, OperationalFailureStore } from "./failure-store.js";

const IDLE_POLL_DELAY_MS = 1_000;
const MAX_OPERATIONAL_ATTEMPTS = 3;
const OPERATIONAL_RETRY_DELAYS_SECONDS = [30, 120] as const;
const MAX_POLICY_PREFLIGHT_DELIVERIES = 3;
const POLICY_PREFLIGHT_RETRY_DELAYS_SECONDS = [30, 120] as const;

export interface QueueClient {
  pullOne(signal?: AbortSignal): Promise<QueueDelivery | undefined>;
  acknowledge(leaseId: string, signal?: AbortSignal): Promise<void>;
  retry(leaseId: string, delaySeconds: number, signal?: AbortSignal): Promise<void>;
}

export type QueueConsumption = "idle" | "settled";

export interface QueueRunService {
  run(signal?: AbortSignal): Promise<void>;
}

export interface QueueRunLogger {
  write(event: string, data?: Readonly<Record<string, unknown>>): Promise<void>;
}

const NOOP_LOGGER: QueueRunLogger = {
  async write() {},
};

type LocalEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "unknown_installation"
        | "repository_not_allowed_for_installation"
        | "author_or_sender_not_allowed";
    };

function localEligibility(job: ReviewQueueJob, policy: RevoirPolicy): LocalEligibility {
  const installation = policy.installations.find(
    (candidate) => candidate.id === job.installationId,
  );
  if (installation === undefined) {
    return { eligible: false, reason: "unknown_installation" };
  }
  const repositoryAllowed = installation.repositories.some(
    (repository) =>
      repository.id === job.repository.id &&
      repository.owner.toLowerCase() === job.repository.owner.toLowerCase() &&
      repository.name.toLowerCase() === job.repository.name.toLowerCase(),
  );
  if (!repositoryAllowed) {
    return { eligible: false, reason: "repository_not_allowed_for_installation" };
  }
  const senderId = job.trigger.senderId;
  if (
    senderId !== policy.userId ||
    (job.trigger.kind === "automatic" && job.trigger.authorId !== policy.userId)
  ) {
    return { eligible: false, reason: "author_or_sender_not_allowed" };
  }
  return { eligible: true };
}

function referenceFor(job: ReviewQueueJob): PullRequestReference {
  const { owner, name } = job.repository;
  const number = job.pullRequest.number;
  return {
    owner,
    repository: name,
    number,
    url: `https://github.com/${owner}/${name}/pull/${number}`,
  };
}

function requestIdentity(job: ReviewQueueJob): ReviewRequestIdentity | undefined {
  return job.trigger.kind === "requested"
    ? { repositoryId: job.repository.id, commentId: job.trigger.commentId }
    : undefined;
}

function requestKey(identity: ReviewRequestIdentity): string {
  return `${identity.repositoryId}:${identity.commentId}`;
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

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Queue runner was cancelled.");
  }
}

function effectiveAttempt(state: OperationalFailureState): number {
  return state.reservation?.slot ?? state.committedFailures;
}

function committedState(
  failures: OperationalFailureCount,
  category: ReviewFailureCategory = "unknown",
): OperationalFailureState {
  return failures === MAX_OPERATIONAL_ATTEMPTS
    ? { committedFailures: failures, terminalCategory: category }
    : { committedFailures: failures };
}

function statesEqual(left: OperationalFailureState, right: OperationalFailureState): boolean {
  return (
    left.committedFailures === right.committedFailures &&
    left.reviewCompleted === right.reviewCompleted &&
    left.terminalCategory === right.terminalCategory &&
    left.reservation?.slot === right.reservation?.slot &&
    left.reservation?.ownerToken === right.reservation?.ownerToken &&
    left.reservation?.transportAttempt === right.reservation?.transportAttempt
  );
}

function moreConservativeState(
  left: OperationalFailureState,
  right: OperationalFailureState,
): OperationalFailureState {
  if (left.reviewCompleted === true || right.reviewCompleted === true) {
    return left.reviewCompleted === true ? left : right;
  }
  const leftAttempt = effectiveAttempt(left);
  const rightAttempt = effectiveAttempt(right);
  if (leftAttempt !== rightAttempt) {
    return leftAttempt > rightAttempt ? left : right;
  }
  if (left.committedFailures !== right.committedFailures) {
    return left.committedFailures > right.committedFailures ? left : right;
  }
  if (left.terminalCategory !== "unknown" && right.terminalCategory === "unknown") {
    return left;
  }
  return right;
}

function consumeReservation(state: OperationalFailureState): OperationalFailureState {
  if (state.reviewCompleted === true || state.reservation === undefined) {
    return state;
  }
  return committedState(state.reservation.slot, state.terminalCategory);
}

class StoreOperationTimeoutError extends Error {
  constructor(operation: string) {
    super(`Operational review failure state ${operation} timed out.`);
    this.name = "TimeoutError";
  }
}

interface StoreOperationRecord<T> {
  readonly operation: Promise<T>;
  readonly operationSignal: AbortSignal;
  readonly slotOnFailure: OperationalAttemptSlot;
  counted: boolean;
  reported: boolean;
}

class StoreOperationFailure extends Error {
  readonly operationRecord: StoreOperationRecord<unknown>;

  constructor(record: StoreOperationRecord<unknown>, cause: unknown) {
    super("Operational review failure state is unavailable.", { cause });
    this.name = "StoreOperationFailure";
    this.operationRecord = record;
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

export class QueueReviewRunner implements QueueRunService {
  readonly #configuration: RevoirConfiguration;
  readonly #failures: ReviewFailureReporter;
  readonly #knownStates = new Map<string, OperationalFailureState>();
  // If the store is completely unavailable across a process restart, this floor
  // cannot be recovered. Durable reservations cover every operation that reached
  // the store; transport delivery attempts are intentionally audit-only.
  readonly #outageFloors = new Map<string, OperationalFailureCount>();
  readonly #operationalFailures: OperationalFailureStore;
  readonly #requestCompletions: ReviewRequestCompletionStore;
  readonly #knownCompletedRequests = new Set<string>();
  readonly #ownerToken = randomUUID();
  readonly #pendingLoads = new Map<string, StoreOperationRecord<OperationalFailureState>>();
  readonly #pendingSaves = new Map<string, Set<StoreOperationRecord<void>>>();
  readonly #pendingStoreSettlements = new Map<string, StoreOperationRecord<unknown>>();
  readonly #queue: QueueClient;
  readonly #reviews: ManualReviewService;
  readonly #logger: QueueRunLogger;
  readonly #loadPolicy: (signal?: AbortSignal) => Promise<RevoirPolicy>;
  #serializedConsumption: Promise<void> = Promise.resolve();

  constructor(
    configuration: RevoirConfiguration,
    queue: QueueClient,
    reviews: ManualReviewService,
    failures?: ReviewFailureReporter,
    operationalFailures: OperationalFailureStore = new FileOperationalFailureStore(
      configuration.paths.stateDir,
    ),
    logger: QueueRunLogger = NOOP_LOGGER,
    requestCompletions: ReviewRequestCompletionStore = new FileReviewRequestCompletionStore(
      configuration.paths.stateDir,
    ),
    loadPolicy?: (signal?: AbortSignal) => Promise<RevoirPolicy>,
  ) {
    this.#configuration = configuration;
    this.#queue = queue;
    this.#reviews = reviews;
    this.#operationalFailures = operationalFailures;
    this.#logger = logger;
    this.#requestCompletions = requestCompletions;
    this.#loadPolicy =
      loadPolicy ??
      (async () => {
        const testPolicy = (configuration as RevoirConfiguration & { policy?: RevoirPolicy })
          .policy;
        if (testPolicy === undefined) {
          throw new Error("Local repository policy is unavailable.");
        }
        return testPolicy;
      });
    this.#failures =
      failures ?? new GitHubReviewFailureReporter(configuration.github, this.#loadPolicy);
  }

  consumeOne(signal?: AbortSignal): Promise<QueueConsumption> {
    const consumption = this.#serializedConsumption.then(() => this.#consumeOne(signal));
    this.#serializedConsumption = consumption.then(
      () => {},
      () => {},
    );
    return consumption;
  }

  async #consumeOne(signal?: AbortSignal): Promise<QueueConsumption> {
    throwIfCancelled(signal);
    const delivery = await this.#queue.pullOne(signal);
    if (delivery === undefined) {
      return "idle";
    }

    let job: ReviewQueueJob;
    try {
      job = parseReviewQueueJob(delivery.body);
    } catch (error) {
      if (!(error instanceof ReviewJobSchemaError)) {
        throw error;
      }
      await this.#queue.acknowledge(delivery.leaseId, signal);
      return "settled";
    }

    let policy: RevoirPolicy;
    try {
      policy = await this.#loadPolicy(signal);
    } catch (error) {
      throwIfCancelled(signal);
      return this.#settlePolicyLoadFailure(delivery, job, error, signal);
    }
    const eligibility = localEligibility(job, policy);
    if (!eligibility.eligible) {
      await this.#queue.acknowledge(delivery.leaseId, signal);
      await this.#clearFailureState(job.deliveryId);
      await this.#logger.write("queue_review_skipped", {
        deliveryId: job.deliveryId,
        reason: eligibility.reason,
      });
      return "settled";
    }

    const requestedReview = requestIdentity(job);
    if (requestedReview !== undefined) {
      const completedRequestKey = requestKey(requestedReview);
      if (this.#knownCompletedRequests.has(completedRequestKey)) {
        return this.#settleCompletedRequest(delivery, job, requestedReview, true, signal);
      }
      if (await this.#hasRequestCompletion(requestedReview, signal)) {
        return this.#settleCompletedRequest(delivery, job, requestedReview, false, signal);
      }
    }

    let loadedFailureState: OperationalFailureState;
    try {
      loadedFailureState = await this.#loadPersistedFailureState(job.deliveryId, signal);
      throwIfCancelled(signal);
    } catch (error) {
      throwIfCancelled(signal);
      return this.#settleStoreFailure(delivery, job, error, signal);
    }
    if (loadedFailureState.reviewCompleted === true) {
      if (requestedReview !== undefined) {
        return this.#settleCompletedRequest(delivery, job, requestedReview, true, signal);
      }
      await this.#queue.acknowledge(delivery.leaseId, signal);
      await this.#clearFailureState(job.deliveryId);
      await this.#logger.write("queue_review_cancelled", {
        deliveryId: job.deliveryId,
        repository: `${job.repository.owner}/${job.repository.name}`,
        pullRequest: job.pullRequest.number,
      });
      return "settled";
    }

    const pendingSettlement = this.#pendingStoreSettlements.get(job.deliveryId);
    if (pendingSettlement !== undefined) {
      return this.#settleStoreFailure(delivery, job, pendingSettlement, signal);
    }

    let operationalState: OperationalFailureState;
    try {
      operationalState = await this.#loadFailureState(job.deliveryId, signal, loadedFailureState);
      throwIfCancelled(signal);
    } catch (error) {
      throwIfCancelled(signal);
      return this.#settleStoreFailure(delivery, job, error, signal);
    }

    if (operationalState.committedFailures === MAX_OPERATIONAL_ATTEMPTS) {
      return this.#settleTerminalFailure(
        delivery,
        job,
        operationalState.terminalCategory ?? "unknown",
        signal,
      );
    }

    const slot = (operationalState.committedFailures + 1) as OperationalAttemptSlot;
    const reservation = {
      slot,
      ownerToken: `${this.#ownerToken}:${randomUUID()}`,
      transportAttempt: delivery.attempt,
    };
    const reservedState: OperationalFailureState = {
      committedFailures: operationalState.committedFailures,
      reservation,
      ...(slot === MAX_OPERATIONAL_ATTEMPTS ? { terminalCategory: "unknown" as const } : {}),
    };
    try {
      await this.#saveFailureState(job.deliveryId, reservedState, slot, signal);
      throwIfCancelled(signal);
    } catch (error) {
      if (isCallerCancellation(error, signal)) {
        await this.#rollbackReservation(job.deliveryId, reservation);
        throw signal?.reason instanceof Error ? signal.reason : error;
      }
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : error;
      }
      return this.#settleStoreFailure(delivery, job, error, signal);
    }

    const metadata = {
      deliveryId: job.deliveryId,
      repository: `${job.repository.owner}/${job.repository.name}`,
      pullRequest: job.pullRequest.number,
      trigger: job.trigger.kind === "automatic" ? job.trigger.action : job.trigger.source,
      ...(job.trigger.kind === "automatic"
        ? { headSha: job.trigger.headSha, action: job.trigger.action }
        : { commentId: job.trigger.commentId }),
    };
    const startedAt = Date.now();
    await this.#logger.write("queue_review_started", metadata);

    let result: Awaited<ReturnType<ManualReviewService["review"]>>;
    try {
      result = await this.#reviews.review(referenceFor(job), {
        ...(job.trigger.kind === "automatic" ? { expectedHeadSha: job.trigger.headSha } : {}),
        ...(job.trigger.kind === "requested" ? { requestedCommentId: job.trigger.commentId } : {}),
        triggeredAt: job.version === 2 ? job.triggeredAt : job.enqueuedAt,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (isOnlyTargetedReviewCancellation(error)) {
        if (signal?.aborted === true) {
          await this.#rollbackReservation(job.deliveryId, reservation);
          throw signal.reason instanceof Error ? signal.reason : error;
        }
        if (requestedReview !== undefined) {
          this.#knownCompletedRequests.add(requestKey(requestedReview));
          await this.#markRequestCompletion(requestedReview);
        } else {
          await this.#saveFailureState(
            job.deliveryId,
            {
              committedFailures: operationalState.committedFailures,
              reviewCompleted: true,
            },
            slot,
          );
        }
        await this.#queue.acknowledge(delivery.leaseId, signal);
        await this.#clearFailureState(job.deliveryId);
        await this.#logger.write("queue_review_cancelled", {
          ...metadata,
          durationMs: Date.now() - startedAt,
        });
        return "settled";
      }
      if (isCallerCancellation(error, signal)) {
        await this.#rollbackReservation(job.deliveryId, reservation);
        throw signal?.reason instanceof Error ? signal.reason : error;
      }
      if (error instanceof PullRequestEligibilityError) {
        if (signal?.aborted === true) {
          throw signal.reason instanceof Error ? signal.reason : error;
        }
        await this.#queue.acknowledge(delivery.leaseId, signal);
        await this.#clearFailureState(job.deliveryId);
        await this.#logger.write("queue_review_rejected", {
          ...metadata,
          durationMs: Date.now() - startedAt,
          error,
        });
      } else {
        const failure = classifyReviewFailure(error);
        const nextState = committedState(slot, failure.category);
        try {
          await this.#saveFailureState(
            job.deliveryId,
            nextState,
            slot,
            signal?.aborted === true ? undefined : signal,
          );
        } catch (stateError) {
          if (signal?.aborted === true) {
            throw signal.reason instanceof Error ? signal.reason : stateError;
          }
          return this.#settleStoreFailure(delivery, job, stateError, signal);
        }
        if (signal?.aborted === true) {
          throw signal.reason instanceof Error ? signal.reason : error;
        }
        if (slot >= MAX_OPERATIONAL_ATTEMPTS) {
          return this.#settleTerminalFailure(delivery, job, failure.category, signal);
        }
        await this.#reportFailure(referenceFor(job), failure, slot, signal);
        throwIfCancelled(signal);
        await this.#queue.retry(
          delivery.leaseId,
          OPERATIONAL_RETRY_DELAYS_SECONDS[slot - 1]!,
          signal,
        );
        await this.#logger.write("queue_review_retried", {
          ...metadata,
          durationMs: Date.now() - startedAt,
          error,
        });
      }
      return "settled";
    }

    // The review completed. From this point onward even caller cancellation cannot
    // safely cause another attempt, so persist an explicit post-review fence first.
    if (requestedReview !== undefined) {
      this.#knownCompletedRequests.add(requestKey(requestedReview));
      await this.#saveFailureState(
        job.deliveryId,
        {
          committedFailures: operationalState.committedFailures,
          reviewCompleted: true,
        },
        slot,
      );
      await this.#markRequestCompletion(requestedReview);
    } else {
      throwIfCancelled(signal);
    }
    await this.#queue.acknowledge(delivery.leaseId, signal);
    await this.#clearFailureState(job.deliveryId);
    await this.#logger.write("queue_review_settled", {
      ...metadata,
      outcome: result.status,
      durationMs: Date.now() - startedAt,
    });
    return "settled";
  }

  async #settleCompletedRequest(
    delivery: QueueDelivery,
    job: ReviewQueueJob,
    request: ReviewRequestIdentity,
    persistCompletion: boolean,
    signal?: AbortSignal,
  ): Promise<QueueConsumption> {
    this.#knownCompletedRequests.add(requestKey(request));
    if (persistCompletion) {
      // A successful review has already crossed the point where caller cancellation
      // can safely cause another attempt. Complete this durable write independently;
      // the pre-review reservation remains as the restart fence until it succeeds.
      await this.#markRequestCompletion(request);
    }
    await this.#queue.acknowledge(delivery.leaseId, signal);
    await this.#clearFailureState(job.deliveryId);
    await this.#logger.write("queue_review_skipped", {
      deliveryId: job.deliveryId,
      reason: "completed_request",
      commentId: request.commentId,
    });
    return "settled";
  }

  async #markRequestCompletion(request: ReviewRequestIdentity): Promise<void> {
    const { operation, operationSignal } = this.#startStoreOperation((storeSignal) =>
      this.#requestCompletions.mark(request, storeSignal),
    );
    await waitForStoreOperation(operation, "request completion", operationSignal);
  }

  async #hasRequestCompletion(
    request: ReviewRequestIdentity,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { operation, operationSignal } = this.#startStoreOperation(
      (storeSignal) => this.#requestCompletions.has(request, storeSignal),
      signal,
    );
    return waitForStoreOperation(operation, "request completion lookup", operationSignal, signal);
  }

  async #loadFailureState(
    deliveryId: string,
    signal?: AbortSignal,
    persistedState?: OperationalFailureState,
  ): Promise<OperationalFailureState> {
    const loaded = persistedState ?? (await this.#loadPersistedFailureState(deliveryId, signal));
    const known = this.#knownStates.get(deliveryId);
    const outageFloor = this.#outageFloors.get(deliveryId) ?? 0;
    const loadedCommitted = consumeReservation(loaded);
    const knownCommitted = known === undefined ? undefined : consumeReservation(known);
    const reconciledFailures = Math.max(
      outageFloor,
      loadedCommitted.committedFailures,
      knownCommitted?.committedFailures ?? 0,
    ) as OperationalFailureCount;
    const terminalCategory =
      reconciledFailures === MAX_OPERATIONAL_ATTEMPTS
        ? outageFloor === MAX_OPERATIONAL_ATTEMPTS
          ? "filesystem"
          : this.#strongestTerminalCategory(loadedCommitted, knownCommitted)
        : undefined;
    const conservative = committedState(reconciledFailures, terminalCategory ?? "unknown");
    this.#rememberState(deliveryId, conservative);
    if (outageFloor > 0 || !statesEqual(loaded, conservative)) {
      await this.#saveFailureState(
        deliveryId,
        conservative,
        this.#nextFailureSlot(deliveryId, reconciledFailures),
        signal,
      );
    }
    if (outageFloor > 0 && reconciledFailures >= outageFloor) {
      this.#outageFloors.delete(deliveryId);
    }
    return conservative;
  }

  async #loadPersistedFailureState(
    deliveryId: string,
    signal?: AbortSignal,
  ): Promise<OperationalFailureState> {
    const pendingSaves = this.#pendingSaves.get(deliveryId);
    if (pendingSaves !== undefined) {
      for (const pendingSave of pendingSaves) {
        // Saves are joined before loading so a late completion cannot overwrite
        // a reconciled state with an older reservation or committed count.
        // eslint-disable-next-line no-await-in-loop
        await this.#waitRecordedStoreOperation(pendingSave, "save", signal);
      }
    }

    let loadRecord = this.#pendingLoads.get(deliveryId);
    if (loadRecord === undefined) {
      loadRecord = this.#startRecordedStoreOperation(
        (storeSignal) => this.#operationalFailures.load(deliveryId, storeSignal),
        this.#nextFailureSlot(deliveryId),
        signal,
      );
      this.#pendingLoads.set(deliveryId, loadRecord);
      void loadRecord.operation.then(
        () => {
          if (this.#pendingLoads.get(deliveryId) === loadRecord) {
            this.#pendingLoads.delete(deliveryId);
          }
        },
        () => {
          if (this.#pendingLoads.get(deliveryId) === loadRecord) {
            this.#pendingLoads.delete(deliveryId);
          }
        },
      );
    }
    let loaded: OperationalFailureState;
    try {
      loaded = await this.#waitRecordedStoreOperation(loadRecord, "load", signal);
    } catch (error) {
      if (
        isCallerCancellation(error, signal) &&
        this.#pendingLoads.get(deliveryId) === loadRecord
      ) {
        this.#pendingLoads.delete(deliveryId);
      }
      throw error;
    }
    return loaded;
  }

  async #saveFailureState(
    deliveryId: string,
    state: OperationalFailureState,
    slotOnFailure: OperationalAttemptSlot,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#rememberState(deliveryId, state);
    const record = this.#startRecordedStoreOperation(
      (storeSignal) => this.#operationalFailures.save(deliveryId, state, storeSignal),
      slotOnFailure,
      signal,
    );
    this.#trackPendingSave(deliveryId, record);
    await this.#waitRecordedStoreOperation(record, "save", signal);
  }

  #strongestTerminalCategory(
    loaded: OperationalFailureState,
    known?: OperationalFailureState,
  ): ReviewFailureCategory {
    if (loaded.terminalCategory !== undefined && loaded.terminalCategory !== "unknown") {
      return loaded.terminalCategory;
    }
    if (known?.terminalCategory !== undefined && known.terminalCategory !== "unknown") {
      return known.terminalCategory;
    }
    return loaded.terminalCategory ?? known?.terminalCategory ?? "unknown";
  }

  #nextFailureSlot(
    deliveryId: string,
    observedFailures: OperationalFailureCount = 0,
  ): OperationalAttemptSlot {
    const known = this.#knownStates.get(deliveryId);
    const floor = Math.max(
      observedFailures,
      this.#outageFloors.get(deliveryId) ?? 0,
      known === undefined ? 0 : effectiveAttempt(known),
    );
    return Math.min(MAX_OPERATIONAL_ATTEMPTS, floor + 1) as OperationalAttemptSlot;
  }

  #rememberState(deliveryId: string, state: OperationalFailureState): void {
    const known = this.#knownStates.get(deliveryId);
    if (known === undefined) {
      this.#knownStates.set(deliveryId, state);
      return;
    }
    this.#knownStates.set(deliveryId, moreConservativeState(known, state));
  }

  async #rollbackReservation(
    deliveryId: string,
    reservation: NonNullable<OperationalFailureState["reservation"]>,
  ): Promise<boolean> {
    try {
      const pendingSaves = this.#pendingSaves.get(deliveryId);
      if (pendingSaves !== undefined) {
        for (const pendingSave of pendingSaves) {
          try {
            // Cancellation rollback is compensating work, so its store failures
            // are not reported during the cancelled delivery.
            // eslint-disable-next-line no-await-in-loop
            await this.#boundStoreOperation(pendingSave.operation, "save");
          } catch {
            if (this.#pendingSaves.get(deliveryId)?.has(pendingSave) === true) {
              return false;
            }
          }
        }
      }
      const { operation: load, operationSignal: loadSignal } = this.#startStoreOperation(
        (storeSignal) => this.#operationalFailures.load(deliveryId, storeSignal),
      );
      const loaded = await waitForStoreOperation(load, "load", loadSignal);
      if (
        loaded.reservation !== undefined &&
        loaded.reservation.ownerToken !== reservation.ownerToken
      ) {
        this.#rememberState(deliveryId, consumeReservation(loaded));
        return false;
      }
      if (
        loaded.committedFailures >= reservation.slot ||
        (loaded.reservation !== undefined && loaded.reservation.slot > reservation.slot)
      ) {
        this.#rememberState(deliveryId, consumeReservation(loaded));
        return false;
      }
      if (
        loaded.reservation !== undefined &&
        loaded.reservation.ownerToken === reservation.ownerToken
      ) {
        const rolledBack: OperationalFailureState = {
          committedFailures: loaded.committedFailures,
        };
        await this.#saveRollbackState(deliveryId, rolledBack);
      }
      const known = this.#knownStates.get(deliveryId);
      if (
        known?.reservation?.ownerToken === reservation.ownerToken &&
        effectiveAttempt(known) === reservation.slot
      ) {
        this.#knownStates.set(deliveryId, {
          committedFailures: known.committedFailures,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  async #saveRollbackState(deliveryId: string, state: OperationalFailureState): Promise<void> {
    const record = this.#startRecordedStoreOperation(
      (storeSignal) => this.#operationalFailures.save(deliveryId, state, storeSignal),
      this.#nextFailureSlot(deliveryId),
    );
    this.#trackPendingSave(deliveryId, record);
    await waitForStoreOperation(record.operation, "rollback", record.operationSignal);
  }

  #trackPendingSave(deliveryId: string, record: StoreOperationRecord<void>): void {
    const pending = this.#pendingSaves.get(deliveryId) ?? new Set();
    pending.add(record);
    this.#pendingSaves.set(deliveryId, pending);
    void record.operation.then(
      () => {
        pending.delete(record);
        if (pending.size === 0 && this.#pendingSaves.get(deliveryId) === pending) {
          this.#pendingSaves.delete(deliveryId);
        }
      },
      () => {
        pending.delete(record);
        if (pending.size === 0 && this.#pendingSaves.get(deliveryId) === pending) {
          this.#pendingSaves.delete(deliveryId);
        }
      },
    );
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

  #startRecordedStoreOperation<T>(
    run: (signal: AbortSignal) => Promise<T>,
    slotOnFailure: OperationalAttemptSlot,
    callerSignal?: AbortSignal,
  ): StoreOperationRecord<T> {
    const { operation, operationSignal } = this.#startStoreOperation(run, callerSignal);
    const record: StoreOperationRecord<T> = {
      operation,
      operationSignal,
      slotOnFailure,
      counted: false,
      reported: false,
    };
    return record;
  }

  async #waitRecordedStoreOperation<T>(
    record: StoreOperationRecord<T>,
    operationName: string,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.#configuration.timeouts.shellCommandMs);
    const waitSignal =
      callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]);
    try {
      return await waitForStoreOperation(record.operation, operationName, waitSignal, callerSignal);
    } catch (error) {
      if (isCallerCancellation(error, callerSignal)) {
        throw callerSignal?.reason instanceof Error ? callerSignal.reason : error;
      }
      throw new StoreOperationFailure(record, error);
    }
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

  async #clearFailureState(deliveryId: string): Promise<void> {
    // Queue settlement has already been confirmed. A stale local file must not resurrect
    // or loop a message that is no longer leased.
    const pendingSaves = [...(this.#pendingSaves.get(deliveryId) ?? [])];
    await this.#clearFailureStateNow(deliveryId);
    this.#knownStates.delete(deliveryId);
    this.#outageFloors.delete(deliveryId);
    this.#pendingLoads.delete(deliveryId);
    this.#pendingStoreSettlements.delete(deliveryId);
    for (const pendingSave of pendingSaves) {
      void pendingSave.operation.then(
        () => this.#clearFailureStateNow(deliveryId),
        () => this.#clearFailureStateNow(deliveryId),
      );
    }
  }

  async #clearFailureStateNow(deliveryId: string): Promise<void> {
    const { operation, operationSignal } = this.#startStoreOperation((storeSignal) =>
      this.#operationalFailures.clear(deliveryId, storeSignal),
    );
    await waitForStoreOperation(operation, "clear", operationSignal).catch(() => {});
  }

  async #settleTerminalFailure(
    delivery: QueueDelivery,
    job: ReviewQueueJob,
    category: ReviewFailureCategory,
    signal?: AbortSignal,
  ): Promise<QueueConsumption> {
    await this.#reportFailure(
      referenceFor(job),
      reviewFailureForCategory(category),
      MAX_OPERATIONAL_ATTEMPTS,
      signal,
    );
    throwIfCancelled(signal);
    await this.#queue.acknowledge(delivery.leaseId, signal);
    await this.#clearFailureState(job.deliveryId);
    return "settled";
  }

  async #settlePolicyLoadFailure(
    delivery: QueueDelivery,
    job: ReviewQueueJob,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<QueueConsumption> {
    const attempt = Math.max(1, delivery.attempt);
    const knownFailure = error instanceof CloudflarePolicyReadError ? error : undefined;
    const reason = knownFailure?.reason ?? "policy_unavailable";
    const failureMetadata = {
      deliveryId: job.deliveryId,
      attempt,
      reason,
      retryable: knownFailure?.retryable ?? false,
      ...(knownFailure?.status === undefined ? {} : { status: knownFailure.status }),
    };
    if (knownFailure?.retryable === true && attempt < MAX_POLICY_PREFLIGHT_DELIVERIES) {
      const delaySeconds = POLICY_PREFLIGHT_RETRY_DELAYS_SECONDS[attempt - 1]!;
      await this.#queue.retry(delivery.leaseId, delaySeconds, signal);
      await this.#logger.write("queue_review_deferred", {
        deliveryId: job.deliveryId,
        attempt,
        delaySeconds,
        reason,
        ...(knownFailure.status === undefined ? {} : { status: knownFailure.status }),
      });
      return "settled";
    }

    await this.#logger.write("queue_review_abandoned", failureMetadata);
    await this.#queue.acknowledge(delivery.leaseId, signal);
    await this.#clearFailureState(job.deliveryId);
    return "settled";
  }

  async #settleStoreFailure(
    delivery: QueueDelivery,
    job: ReviewQueueJob,
    failure: unknown,
    signal?: AbortSignal,
  ): Promise<QueueConsumption> {
    const record =
      failure instanceof StoreOperationFailure
        ? failure.operationRecord
        : this.#isStoreOperationRecord(failure)
          ? failure
          : undefined;
    if (record === undefined) {
      throw failure;
    }

    if (!record.counted) {
      record.counted = true;
      const floor = Math.max(
        this.#outageFloors.get(job.deliveryId) ?? 0,
        record.slotOnFailure,
      ) as OperationalFailureCount;
      this.#outageFloors.set(job.deliveryId, floor);
      this.#rememberState(
        job.deliveryId,
        committedState(floor, floor === MAX_OPERATIONAL_ATTEMPTS ? "filesystem" : "unknown"),
      );
    }
    const attempt = record.slotOnFailure;
    this.#pendingStoreSettlements.set(job.deliveryId, record);
    if (!record.reported) {
      record.reported = true;
      await this.#reportFailure(
        referenceFor(job),
        reviewFailureForCategory("filesystem"),
        attempt,
        signal,
      );
    }
    throwIfCancelled(signal);
    if (attempt >= MAX_OPERATIONAL_ATTEMPTS) {
      await this.#queue.acknowledge(delivery.leaseId, signal);
      await this.#clearFailureState(job.deliveryId);
    } else {
      await this.#queue.retry(
        delivery.leaseId,
        OPERATIONAL_RETRY_DELAYS_SECONDS[attempt - 1]!,
        signal,
      );
      if (this.#pendingStoreSettlements.get(job.deliveryId) === record) {
        this.#pendingStoreSettlements.delete(job.deliveryId);
      }
    }
    return "settled";
  }

  #isStoreOperationRecord(value: unknown): value is StoreOperationRecord<unknown> {
    return (
      typeof value === "object" &&
      value !== null &&
      "operation" in value &&
      "slotOnFailure" in value &&
      "counted" in value &&
      "reported" in value
    );
  }

  async #reportFailure(
    reference: PullRequestReference,
    failure: unknown,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(this.#configuration.timeouts.shellCommandMs);
    const reportingSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    const report = Promise.resolve().then(() =>
      this.#failures.report(reference, failure, attempt, MAX_OPERATIONAL_ATTEMPTS, reportingSignal),
    );
    // The report promise is joined when the provider cooperates and safely observed if it
    // ignores cancellation. Queue settlement cannot be held indefinitely by that provider.
    await new Promise<void>((resolve) => {
      let settled = false;
      function finish(): void {
        if (settled) {
          return;
        }
        settled = true;
        reportingSignal.removeEventListener("abort", onAbort);
        resolve();
      }
      function onAbort(): void {
        finish();
      }
      reportingSignal.addEventListener("abort", onAbort, { once: true });
      void report.then(
        () => finish(),
        () => finish(),
      );
      if (reportingSignal.aborted) {
        onAbort();
      }
    });
    throwIfCancelled(signal);
  }

  async run(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (aborted(signal)) {
        return;
      }
      // Pull and settlement are deliberately serialized to keep one review in flight.
      let result: QueueConsumption;
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await this.consumeOne(signal);
      } catch (error) {
        if (aborted(signal)) {
          return;
        }
        throw error;
      }
      if (result === "idle") {
        // eslint-disable-next-line no-await-in-loop
        await waitForNextPoll(signal);
      }
    }
  }
}

export function createDefaultQueueRunService(
  configuration: RevoirConfiguration,
  loadPolicy: (signal?: AbortSignal) => Promise<RevoirPolicy>,
  logger: QueueRunLogger = NOOP_LOGGER,
): QueueRunService {
  return new QueueReviewRunner(
    configuration,
    new CloudflareQueueClient(configuration.cloudflare, configuration.timeouts.reviewMs),
    createDefaultManualReviewService(configuration, loadPolicy),
    new GitHubReviewFailureReporter(configuration.github, loadPolicy),
    new FileOperationalFailureStore(configuration.paths.stateDir),
    logger,
    new FileReviewRequestCompletionStore(configuration.paths.stateDir),
    loadPolicy,
  );
}
