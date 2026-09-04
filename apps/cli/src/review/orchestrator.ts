import type { ReviewJobAction } from "@revoir/contracts";

import {
  isCallerCancellation,
  isTargetedReviewCancellation,
  TargetedReviewCancellationError,
} from "../cancellation.js";
import type { RevoirPolicy } from "../config/policy.js";
import type { RevoirConfiguration } from "../config/schema.js";
import { FileReviewCancellationStore, type ReviewCancellationStore } from "./cancellation-store.js";
import type { FindingDiagnostic } from "./findings.js";
import {
  GitHubAppReviewGateway,
  PendingReviewUncertainError,
  ReviewSubmissionUncertainError,
  type GitHubReviewCheck,
  type GitHubReviewCheckCompletion,
  type GitHubReviewGateway,
  type GitHubReviewSession,
} from "./github.js";
import { FileReviewLock, type ReviewLock } from "./lock.js";
import { PiReviewEngine, type ReviewEngine } from "./pi.js";
import { createReviewPublication } from "./publication.js";
import { assertPullRequestEligible, type PullRequestReference } from "./pull-request.js";
import { planFindingReconciliation } from "./reconciliation.js";
import { createTerminalHandle, type TerminalHandle } from "./terminal-handle.js";
import {
  GitWorkspacePreparer,
  WorkspacePreparationError,
  type WorkspacePreparer,
} from "./workspace.js";

export type ManualReviewResult =
  | {
      status: "clean" | "stale";
      reviewedSha: string;
      currentSha: string;
    }
  | {
      status: "findings";
      reviewedSha: string;
      currentSha: string;
      publishedFindings: number;
      rejectedFindings: number;
      diagnostics: readonly FindingDiagnostic[];
    };

export interface ManualReviewOptions {
  automaticAction?: ReviewJobAction;
  expectedHeadSha?: string;
  legacyAutomatic?: true;
  requestedCommentId?: number;
  signal?: AbortSignal;
  triggeredAt?: string;
}

export interface ManualReviewService {
  review(
    reference: PullRequestReference,
    options?: ManualReviewOptions,
  ): Promise<ManualReviewResult>;
}

export class ReviewTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Review exceeded the configured timeout of ${timeoutMs}ms.`);
    this.name = "ReviewTimeoutError";
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Review was cancelled.");
  }
}

function waitForCancellationPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 500);
    timeout.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class ReviewDeadline {
  readonly error: ReviewTimeoutError;
  readonly signal: AbortSignal;
  readonly #abortController = new AbortController();
  readonly #expiration: Promise<never>;
  readonly #timeout: ReturnType<typeof setTimeout>;

  constructor(timeoutMs: number) {
    this.error = new ReviewTimeoutError(timeoutMs);
    this.signal = this.#abortController.signal;
    let expire!: (reason: Error) => void;
    this.#expiration = new Promise<never>((_resolve, reject) => {
      expire = reject;
    });
    this.#timeout = setTimeout(() => {
      this.#abortController.abort(this.error);
      expire(this.error);
    }, timeoutMs);
    void this.#expiration.catch(() => {});
  }

  wait<T>(operation: Promise<T>): Promise<T> {
    void operation.catch(() => {});
    return Promise.race([operation, this.#expiration]);
  }

  dispose(): void {
    clearTimeout(this.#timeout);
  }
}

function containsError(value: unknown, target: Error): boolean {
  if (value === target) {
    return true;
  }
  return (
    value instanceof AggregateError &&
    value.errors.some((candidate: unknown) => containsError(candidate, target))
  );
}

function combineFailures(
  primary: unknown,
  additional: readonly unknown[],
  message: string,
): unknown {
  const unique: Error[] = [];
  for (const failure of additional) {
    const error = asError(failure);
    if (!containsError(primary, error) && !unique.includes(error)) {
      unique.push(error);
    }
  }
  if (unique.length === 0) {
    return primary;
  }
  const primaryErrors =
    primary instanceof AggregateError
      ? primary.errors.map((failure: unknown) => asError(failure))
      : [asError(primary)];
  return new AggregateError([...primaryErrors, ...unique], message);
}

function terminalBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.min(50, 2 ** Math.min(attempt, 5)));
  });
}

const MAX_TERMINAL_ATTEMPTS = 3;

async function completeTerminal(operation: TerminalHandle): Promise<Error[]> {
  const failures: Error[] = [];
  for (let attempt = 1; attempt <= MAX_TERMINAL_ATTEMPTS; attempt += 1) {
    try {
      // Terminal attempts must remain serialized.
      // eslint-disable-next-line no-await-in-loop
      await operation();
      return failures;
    } catch (error) {
      if (failures.length === 0) {
        failures.push(asError(error));
      }
      if (attempt === MAX_TERMINAL_ATTEMPTS) {
        return failures;
      }
      // Transient cleanup remains recoverable without holding the process lock forever.
      // eslint-disable-next-line no-await-in-loop
      await terminalBackoff(attempt);
    }
  }
  return failures;
}

async function completePendingReview(operation: TerminalHandle): Promise<Error[]> {
  const failures: Error[] = [];
  for (let attempt = 1; attempt <= MAX_TERMINAL_ATTEMPTS; attempt += 1) {
    try {
      // Pending-review attempts remain serialized, but typed uncertainty is terminal.
      // eslint-disable-next-line no-await-in-loop
      await operation();
      return failures;
    } catch (error) {
      const failure = asError(error);
      if (failure instanceof PendingReviewUncertainError) {
        return [failure];
      }
      if (failures.length === 0) {
        failures.push(failure);
      }
      if (attempt === MAX_TERMINAL_ATTEMPTS) {
        return failures;
      }
      // eslint-disable-next-line no-await-in-loop
      await terminalBackoff(attempt);
    }
  }
  return failures;
}

async function completeReviewCheck(operation: TerminalHandle): Promise<Error[]> {
  let failure: Error | undefined;
  for (let attempt = 1; attempt <= MAX_TERMINAL_ATTEMPTS; attempt += 1) {
    try {
      // Check-run completion is idempotent, so a confirmed retry settles earlier ambiguity.
      // eslint-disable-next-line no-await-in-loop
      await operation();
      return [];
    } catch (error) {
      failure ??= asError(error);
      if (attempt < MAX_TERMINAL_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await terminalBackoff(attempt);
      }
    }
  }
  return failure === undefined ? [] : [failure];
}

function throwCleanupFailures(failures: readonly Error[], message: string): void {
  if (failures.length === 1 && failures[0] instanceof PendingReviewUncertainError) {
    throw failures[0];
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
}

function reviewCheckCompletion(
  result: ManualReviewResult | undefined,
  failure: unknown,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
): GitHubReviewCheckCompletion {
  if (failure !== undefined) {
    if (signal.reason instanceof ReviewTimeoutError) {
      return {
        conclusion: "timed_out",
        title: "Review timed out",
        summary: "Revoir exceeded its configured review timeout before it could finish.",
      };
    }
    if (isTargetedReviewCancellation(failure)) {
      return {
        conclusion: "cancelled",
        title: "Review cancelled",
        summary: "An authorized cancellation request stopped this review.",
      };
    }
    if (isCallerCancellation(failure, callerSignal)) {
      return {
        conclusion: "cancelled",
        title: "Review cancelled",
        summary: "The Revoir process stopped before this review could finish.",
      };
    }
    return {
      conclusion: "failure",
      title: "Review failed",
      summary:
        "Revoir could not complete this review. See the failure comment or service logs for details.",
    };
  }
  if (result?.status === "stale") {
    return {
      conclusion: "cancelled",
      title: "Review superseded",
      summary: `The pull request head changed from ${result.reviewedSha.slice(0, 7)} to ${result.currentSha.slice(0, 7)} before the review completed.`,
    };
  }
  if (result?.status === "findings") {
    const findingLabel = result.publishedFindings === 1 ? "finding" : "findings";
    return {
      conclusion: "success",
      title: "Review completed with findings",
      summary: `Revoir completed the review and published ${result.publishedFindings} new ${findingLabel}. Review threads contain the details.`,
    };
  }
  return {
    conclusion: "success",
    title: "Review completed",
    summary: "Revoir completed the review and found no actionable issues.",
  };
}

export class CleanReviewOrchestrator implements ManualReviewService {
  readonly #configuration: RevoirConfiguration;
  readonly #cancellations: ReviewCancellationStore;
  readonly #finalizations = new Set<Promise<unknown>>();
  readonly #github: GitHubReviewGateway;
  readonly #lock: ReviewLock;
  readonly #loadPolicy: (signal?: AbortSignal) => Promise<RevoirPolicy>;
  readonly #reviewEngine: ReviewEngine;
  readonly #workspaces: WorkspacePreparer;

  constructor(
    configuration: RevoirConfiguration,
    dependencies: {
      github: GitHubReviewGateway;
      cancellations?: ReviewCancellationStore;
      lock: ReviewLock;
      loadPolicy: (signal?: AbortSignal) => Promise<RevoirPolicy>;
      reviewEngine: ReviewEngine;
      workspaces: WorkspacePreparer;
    },
  ) {
    this.#configuration = configuration;
    this.#cancellations =
      dependencies.cancellations ?? new FileReviewCancellationStore(configuration.paths.stateDir);
    this.#github = dependencies.github;
    this.#lock = dependencies.lock;
    this.#loadPolicy = dependencies.loadPolicy;
    this.#reviewEngine = dependencies.reviewEngine;
    this.#workspaces = dependencies.workspaces;
  }

  async review(
    reference: PullRequestReference,
    options?: ManualReviewOptions,
  ): Promise<ManualReviewResult> {
    const deadline = new ReviewDeadline(this.#configuration.timeouts.reviewMs);
    const monitorStop = new AbortController();
    const monitorFailure = new AbortController();
    const initialSignal = AbortSignal.any([
      deadline.signal,
      ...(options?.signal === undefined ? [] : [options.signal]),
    ]);
    let initialCancellation: Awaited<ReturnType<ReviewCancellationStore["read"]>>;
    try {
      initialCancellation = await deadline.wait(this.#cancellations.read(reference, initialSignal));
    } catch (error) {
      deadline.dispose();
      throw error;
    }
    const triggeredAt = options?.triggeredAt ?? new Date().toISOString();
    const boundary = {
      triggeredAt,
      ...(options?.triggeredAt === undefined ? { localTriggeredAt: triggeredAt } : {}),
      ...(options?.automaticAction === undefined
        ? {}
        : { automaticAction: options.automaticAction }),
      ...(options?.expectedHeadSha === undefined
        ? {}
        : { expectedHeadSha: options.expectedHeadSha }),
      ...(options?.legacyAutomatic === true ? { legacyAutomatic: true as const } : {}),
      ...(initialCancellation === undefined
        ? {}
        : { localCancelledAt: initialCancellation.cancelledAt }),
      ...(options?.requestedCommentId === undefined
        ? {}
        : { requestedCommentId: options.requestedCommentId }),
    };
    const monitorPromises: Promise<unknown>[] = [];
    const monitorLifetimeSignal = AbortSignal.any([
      monitorStop.signal,
      deadline.signal,
      ...(options?.signal === undefined ? [] : [options.signal]),
    ]);
    this.#startMonitor(
      this.#monitorLocalCancellation(
        reference,
        initialCancellation?.cancelledAt,
        monitorLifetimeSignal,
      ),
      monitorStop,
      monitorFailure,
      monitorPromises,
    );
    const reviewSignal = AbortSignal.any([
      deadline.signal,
      monitorFailure.signal,
      ...(options?.signal === undefined ? [] : [options.signal]),
    ]);
    let acquisition: ReturnType<ReviewLock["acquire"]> | undefined;
    let lease: Awaited<ReturnType<ReviewLock["acquire"]>>;
    let policy: RevoirPolicy;
    let github: GitHubReviewSession;
    try {
      policy = await deadline.wait(this.#loadPolicy(reviewSignal));
      github = await deadline.wait(
        this.#github.authenticate(this.#configuration.github, policy, reference, reviewSignal),
      );
      if (github.monitorCancellation !== undefined) {
        this.#startMonitor(
          github.monitorCancellation(reference, boundary, monitorLifetimeSignal),
          monitorStop,
          monitorFailure,
          monitorPromises,
        );
      }
      throwIfAborted(reviewSignal);
      acquisition = this.#lock.acquire(reviewSignal);
      lease = await deadline.wait(acquisition);
    } catch (error) {
      if (error === deadline.error && acquisition !== undefined) {
        this.#retainFinalization(
          acquisition.then(async (lateLease) => {
            await completeTerminal(createTerminalHandle(lateLease.release));
          }),
        );
      }
      monitorStop.abort();
      await Promise.allSettled(monitorPromises);
      deadline.dispose();
      throw error;
    }

    const finalization = this.#retainFinalization(
      this.#finalizeReview(reference, options, reviewSignal, lease, monitorStop, monitorPromises),
    );
    try {
      return await deadline.wait(finalization);
    } finally {
      deadline.dispose();
    }
  }

  #startMonitor(
    operation: Promise<never>,
    stop: AbortController,
    failure: AbortController,
    operations: Promise<unknown>[],
  ): void {
    const monitored = operation.catch((error: unknown) => {
      const expectedStop = stop.signal.aborted && error === stop.signal.reason;
      if (!expectedStop && !failure.signal.aborted) {
        failure.abort(error);
      }
      throw error;
    });
    void monitored.catch(() => {});
    operations.push(monitored);
  }

  async #monitorLocalCancellation(
    reference: PullRequestReference,
    initialCancelledAt: string | undefined,
    signal: AbortSignal,
  ): Promise<never> {
    for (;;) {
      signal.throwIfAborted();
      // Cancellation state is intentionally sampled serially.
      // eslint-disable-next-line no-await-in-loop
      const marker = await this.#cancellations.read(reference, signal);
      if (marker !== undefined && marker.cancelledAt !== initialCancelledAt) {
        throw new TargetedReviewCancellationError();
      }
      // eslint-disable-next-line no-await-in-loop
      await waitForCancellationPoll(signal);
    }
  }

  #retainFinalization<T>(finalization: Promise<T>): Promise<T> {
    this.#finalizations.add(finalization);
    void finalization.then(
      () => {
        this.#finalizations.delete(finalization);
      },
      () => {
        this.#finalizations.delete(finalization);
      },
    );
    return finalization;
  }

  async #finalizeReview(
    reference: PullRequestReference,
    options: ManualReviewOptions | undefined,
    signal: AbortSignal,
    lease: Awaited<ReturnType<ReviewLock["acquire"]>>,
    monitorStop: AbortController,
    monitorPromises: Promise<unknown>[],
  ): Promise<ManualReviewResult> {
    let result: ManualReviewResult | undefined;
    let failure: unknown;
    try {
      const policy = await this.#loadPolicy(signal);
      const github = await this.#github.authenticate(
        this.#configuration.github,
        policy,
        reference,
        signal,
      );
      result = await this.#reviewWithLease(
        reference,
        options,
        policy,
        github,
        signal,
        monitorStop,
        monitorPromises,
      );
    } catch (error) {
      failure = error;
    }

    monitorStop.abort();
    await Promise.allSettled(monitorPromises);
    const releaseFailures = await completeTerminal(createTerminalHandle(lease.release));
    if (failure !== undefined) {
      throw combineFailures(
        failure,
        releaseFailures,
        "Review failed and the process lock could not be released cleanly.",
      );
    }
    if (releaseFailures.length > 0) {
      throw new AggregateError(releaseFailures, "The process lock required release retries.");
    }
    if (result === undefined) {
      throw new Error("Review ended without a result.");
    }
    return result;
  }

  async #reviewWithLease(
    reference: PullRequestReference,
    options: ManualReviewOptions | undefined,
    policy: RevoirPolicy,
    github: GitHubReviewSession,
    signal: AbortSignal,
    monitorStop: AbortController,
    monitorPromises: Promise<unknown>[],
  ): Promise<ManualReviewResult> {
    const terminalSignal = new AbortController().signal;
    let workspaceCleanup: TerminalHandle | undefined;
    let activeReaction: TerminalHandle | undefined;
    let pendingReviewCleanup: TerminalHandle | undefined;
    let reviewCheck: GitHubReviewCheck | undefined;
    let result: ManualReviewResult | undefined;
    let failure: unknown;
    const stopCancellationMonitoring = async (): Promise<void> => {
      monitorStop.abort();
      await Promise.allSettled(monitorPromises);
      throwIfAborted(signal);
    };

    try {
      throwIfAborted(signal);
      const pullRequest = await github.getPullRequest(reference, signal);
      assertPullRequestEligible(reference, pullRequest, policy);
      throwIfAborted(signal);

      if (
        options?.expectedHeadSha !== undefined &&
        options.expectedHeadSha !== pullRequest.headSha
      ) {
        return {
          status: "stale",
          reviewedSha: options.expectedHeadSha,
          currentSha: pullRequest.headSha,
        };
      }

      const startingSha = await github.getHeadSha(reference, signal);
      throwIfAborted(signal);
      if (startingSha !== pullRequest.headSha) {
        result = {
          status: "stale",
          reviewedSha: pullRequest.headSha,
          currentSha: startingSha,
        };
      } else {
        reviewCheck = await github.startReviewCheck(reference, pullRequest.headSha, signal);
        throwIfAborted(signal);
        await github.removeOwnCompletionReaction(reference, signal);
        throwIfAborted(signal);
        activeReaction = createTerminalHandle(() =>
          github.removeOwnReaction(reference, "eyes", terminalSignal),
        );
        const reactionId = await github.addReaction(reference, "eyes", signal);
        activeReaction = createTerminalHandle(() =>
          github.deleteReaction(reference, reactionId, terminalSignal),
        );
        throwIfAborted(signal);

        let workspace;
        try {
          workspace = await this.#workspaces.prepare(
            reference,
            pullRequest,
            github.installationToken,
            signal,
          );
        } catch (error) {
          if (error instanceof WorkspacePreparationError) {
            workspaceCleanup = createTerminalHandle(error.cleanup);
          }
          throw error;
        }
        workspaceCleanup = createTerminalHandle(workspace.cleanup);
        throwIfAborted(signal);
        const preReviewSha = await github.getHeadSha(reference, signal);
        throwIfAborted(signal);
        if (preReviewSha !== pullRequest.headSha) {
          result = {
            status: "stale",
            reviewedSha: pullRequest.headSha,
            currentSha: preReviewSha,
          };
        } else {
          const evidence = await github.getReviewEvidence(reference, pullRequest.headSha, signal);
          throwIfAborted(signal);
          const engineResult = (await this.#reviewEngine.review(
            { reference, pullRequest, workspace, evidence },
            signal,
          )) ?? {
            findings: [],
            diagnostics: [],
          };
          throwIfAborted(signal);

          const workspaceFailures = await completeTerminal(workspaceCleanup);
          workspaceCleanup = undefined;
          if (workspaceFailures.length > 0) {
            throw new AggregateError(workspaceFailures, "Workspace cleanup required retries.");
          }
          const reactionFailures = await completeTerminal(activeReaction);
          activeReaction = undefined;
          if (reactionFailures.length > 0) {
            throw new AggregateError(reactionFailures, "Reaction cleanup required retries.");
          }

          const currentSha = await github.getHeadSha(reference, signal);
          throwIfAborted(signal);
          if (currentSha !== pullRequest.headSha) {
            result = {
              status: "stale",
              reviewedSha: pullRequest.headSha,
              currentSha,
            };
          } else {
            await github.removeOwnPendingReview(reference, signal);
            throwIfAborted(signal);
            const priorReviewState = await github.getPriorReviewState(reference, signal);
            throwIfAborted(signal);
            const reconciliation = planFindingReconciliation(
              engineResult.findings,
              priorReviewState,
            );
            const preResolutionSha = await github.getHeadSha(reference, signal);
            throwIfAborted(signal);
            let postReconciliationSha = preResolutionSha;
            if (
              preResolutionSha === pullRequest.headSha &&
              reconciliation.obsoleteThreadIds.length > 0
            ) {
              const resolution = await github.resolveReviewThreads(
                reference,
                reconciliation.obsoleteThreadIds,
                pullRequest.headSha,
                signal,
              );
              throwIfAborted(signal);
              postReconciliationSha =
                resolution.status === "stale"
                  ? resolution.currentSha
                  : await github.getHeadSha(reference, signal);
            }
            throwIfAborted(signal);
            if (postReconciliationSha !== pullRequest.headSha) {
              result = {
                status: "stale",
                reviewedSha: pullRequest.headSha,
                currentSha: postReconciliationSha,
              };
            } else {
              const shouldPublishReview =
                reconciliation.netNewFindings.length > 0 || reconciliation.bodyStateChanged;
              if (shouldPublishReview) {
                const publication = createReviewPublication(
                  pullRequest.headSha,
                  reconciliation.netNewFindings,
                  reconciliation.currentBodyFindings,
                );
                pendingReviewCleanup = createTerminalHandle(() =>
                  github.removeOwnPendingReview(reference, terminalSignal),
                );
                const pendingReview = await github.createPendingReview(
                  reference,
                  publication,
                  signal,
                );
                pendingReviewCleanup = createTerminalHandle(() =>
                  pendingReview.delete(terminalSignal),
                );
                throwIfAborted(signal);
                const postDraftSha = await github.getHeadSha(reference, signal);
                throwIfAborted(signal);
                if (postDraftSha === pullRequest.headSha) {
                  try {
                    await stopCancellationMonitoring();
                    await pendingReview.submit(signal, terminalSignal);
                  } catch (error) {
                    if (error instanceof ReviewSubmissionUncertainError) {
                      // Deleting after an ambiguous submit can target a review GitHub already
                      // published. A later run reconciles any draft that actually remained.
                      pendingReviewCleanup = undefined;
                    }
                    throw error;
                  }
                  pendingReviewCleanup = undefined;
                } else {
                  const pendingReviewFailures = await completePendingReview(pendingReviewCleanup);
                  pendingReviewCleanup = undefined;
                  throwCleanupFailures(
                    pendingReviewFailures,
                    "Pending review cleanup required retries.",
                  );
                  result = {
                    status: "stale",
                    reviewedSha: pullRequest.headSha,
                    currentSha: postDraftSha,
                  };
                }
              }
              if (result === undefined && engineResult.findings.length > 0) {
                result = {
                  status: "findings",
                  reviewedSha: pullRequest.headSha,
                  currentSha: postReconciliationSha,
                  publishedFindings: reconciliation.netNewFindings.length,
                  rejectedFindings: engineResult.diagnostics.length,
                  diagnostics: engineResult.diagnostics,
                };
              } else if (result === undefined) {
                await stopCancellationMonitoring();
                activeReaction = createTerminalHandle(() =>
                  github.removeOwnReaction(reference, "+1", terminalSignal),
                );
                const completionReactionId = await github.addReaction(reference, "+1", signal);
                activeReaction = createTerminalHandle(() =>
                  github.deleteReaction(reference, completionReactionId, terminalSignal),
                );
                throwIfAborted(signal);
                const postCompletionSha = await github.getHeadSha(reference, signal);
                throwIfAborted(signal);
                if (postCompletionSha === pullRequest.headSha) {
                  activeReaction = undefined;
                  result = {
                    status: "clean",
                    reviewedSha: pullRequest.headSha,
                    currentSha: postCompletionSha,
                  };
                } else {
                  const completionCleanupFailures = await completeTerminal(activeReaction);
                  activeReaction = undefined;
                  if (completionCleanupFailures.length > 0) {
                    throw new AggregateError(
                      completionCleanupFailures,
                      "Completion reaction cleanup required retries.",
                    );
                  }
                  result = {
                    status: "stale",
                    reviewedSha: pullRequest.headSha,
                    currentSha: postCompletionSha,
                  };
                }
              }
            }
          }
        }
      }
      if (result?.status === "clean" || result?.status === "findings") {
        await github.removeOwnFailureComment(reference, signal);
        throwIfAborted(signal);
      }
    } catch (error) {
      failure = error;
    }

    const cleanupFailures: Error[] = [];
    if (workspaceCleanup !== undefined) {
      cleanupFailures.push(...(await completeTerminal(workspaceCleanup)));
      workspaceCleanup = undefined;
    }
    if (pendingReviewCleanup !== undefined) {
      cleanupFailures.push(...(await completePendingReview(pendingReviewCleanup)));
      pendingReviewCleanup = undefined;
    }
    if (activeReaction !== undefined) {
      cleanupFailures.push(...(await completeTerminal(activeReaction)));
      activeReaction = undefined;
    }

    monitorStop.abort();
    await Promise.allSettled(monitorPromises);
    if (failure === undefined) {
      try {
        throwIfAborted(signal);
      } catch (error) {
        failure = error;
      }
    }

    let terminalFailure = failure;
    if (terminalFailure !== undefined) {
      terminalFailure = combineFailures(
        terminalFailure,
        cleanupFailures,
        "Review failed and cleanup also encountered errors.",
      );
    } else {
      try {
        throwCleanupFailures(cleanupFailures, "Review cleanup failed.");
      } catch (error) {
        terminalFailure = error;
      }
    }
    if (terminalFailure === undefined && result === undefined) {
      terminalFailure = new Error("Review ended without a result.");
    }

    if (reviewCheck !== undefined) {
      const check = reviewCheck;
      reviewCheck = undefined;
      const completion = reviewCheckCompletion(result, terminalFailure, signal, options?.signal);
      const checkFailures = await completeReviewCheck(
        createTerminalHandle(() => check.complete(completion, terminalSignal)),
      );
      if (checkFailures.length > 0) {
        terminalFailure =
          terminalFailure === undefined
            ? new AggregateError(checkFailures, "Review check completion failed.")
            : combineFailures(
                terminalFailure,
                checkFailures,
                "Review failed and its check run could not be completed.",
              );
      }
    }

    if (terminalFailure !== undefined) {
      throw terminalFailure;
    }
    if (result === undefined) {
      throw new Error("Review ended without a result.");
    }
    return result;
  }
}

export function createDefaultManualReviewService(
  configuration: RevoirConfiguration,
  loadPolicy: (signal?: AbortSignal) => Promise<RevoirPolicy>,
): ManualReviewService {
  return new CleanReviewOrchestrator(configuration, {
    github: new GitHubAppReviewGateway(),
    lock: new FileReviewLock(configuration.paths.stateDir),
    loadPolicy,
    reviewEngine: new PiReviewEngine(
      configuration.model,
      undefined,
      configuration.timeouts.shellCommandMs,
    ),
    workspaces: new GitWorkspacePreparer(
      configuration.paths.cacheDir,
      configuration.timeouts.shellCommandMs,
    ),
  });
}
