import type { RevoirConfiguration } from "../config/schema.js";
import type { FindingDiagnostic } from "./findings.js";
import {
  GitHubAppReviewGateway,
  PendingReviewUncertainError,
  ReviewSubmissionUncertainError,
  type GitHubReviewGateway,
} from "./github.js";
import { FileReviewLock, type ReviewLock } from "./lock.js";
import { PiReviewEngine, type ReviewEngine } from "./pi.js";
import { createReviewPublication } from "./publication.js";
import { assertPullRequestEligible, type PullRequestReference } from "./pull-request.js";
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

export interface ManualReviewService {
  review(reference: PullRequestReference): Promise<ManualReviewResult>;
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

async function completeTerminal(operation: TerminalHandle): Promise<Error[]> {
  const failures: Error[] = [];
  let attempts = 0;
  for (;;) {
    try {
      // Terminal attempts must remain serialized.
      // eslint-disable-next-line no-await-in-loop
      await operation();
      return failures;
    } catch (error) {
      if (failures.length === 0) {
        failures.push(asError(error));
      }
      attempts += 1;
      // Terminal work remains serialized and retryable until its side effect is confirmed.
      // eslint-disable-next-line no-await-in-loop
      await terminalBackoff(attempts);
    }
  }
}

async function completePendingReview(operation: TerminalHandle): Promise<Error[]> {
  const failures: Error[] = [];
  let attempts = 0;
  for (;;) {
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
      attempts += 1;
      // eslint-disable-next-line no-await-in-loop
      await terminalBackoff(attempts);
    }
  }
}

function throwCleanupFailures(failures: readonly Error[], message: string): void {
  if (failures.length === 1 && failures[0] instanceof PendingReviewUncertainError) {
    throw failures[0];
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
}

export class CleanReviewOrchestrator implements ManualReviewService {
  readonly #configuration: RevoirConfiguration;
  readonly #finalizations = new Set<Promise<unknown>>();
  readonly #github: GitHubReviewGateway;
  readonly #lock: ReviewLock;
  readonly #reviewEngine: ReviewEngine;
  readonly #workspaces: WorkspacePreparer;

  constructor(
    configuration: RevoirConfiguration,
    dependencies: {
      github: GitHubReviewGateway;
      lock: ReviewLock;
      reviewEngine: ReviewEngine;
      workspaces: WorkspacePreparer;
    },
  ) {
    this.#configuration = configuration;
    this.#github = dependencies.github;
    this.#lock = dependencies.lock;
    this.#reviewEngine = dependencies.reviewEngine;
    this.#workspaces = dependencies.workspaces;
  }

  async review(reference: PullRequestReference): Promise<ManualReviewResult> {
    const deadline = new ReviewDeadline(this.#configuration.timeouts.reviewMs);
    const acquisition = this.#lock.acquire(deadline.signal);
    let lease: Awaited<ReturnType<ReviewLock["acquire"]>>;
    try {
      lease = await deadline.wait(acquisition);
      throwIfAborted(deadline.signal);
    } catch (error) {
      if (error === deadline.error) {
        this.#retainFinalization(
          acquisition.then(async (lateLease) => {
            await completeTerminal(createTerminalHandle(lateLease.release));
          }),
        );
      }
      deadline.dispose();
      throw error;
    }

    const finalization = this.#retainFinalization(
      this.#finalizeReview(reference, deadline.signal, lease),
    );
    try {
      return await deadline.wait(finalization);
    } finally {
      deadline.dispose();
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
    signal: AbortSignal,
    lease: Awaited<ReturnType<ReviewLock["acquire"]>>,
  ): Promise<ManualReviewResult> {
    let result: ManualReviewResult | undefined;
    let failure: unknown;
    try {
      result = await this.#reviewWithLease(reference, signal);
    } catch (error) {
      failure = error;
    }

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
    signal: AbortSignal,
  ): Promise<ManualReviewResult> {
    const terminalSignal = new AbortController().signal;
    let workspaceCleanup: TerminalHandle | undefined;
    let activeReaction: TerminalHandle | undefined;
    let pendingReviewCleanup: TerminalHandle | undefined;
    let result: ManualReviewResult | undefined;
    let failure: unknown;

    try {
      const github = await this.#github.authenticate(this.#configuration.github, reference, signal);
      throwIfAborted(signal);
      const pullRequest = await github.getPullRequest(reference, signal);
      assertPullRequestEligible(reference, pullRequest, this.#configuration.github);
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
      await github.removeOwnPendingReview(reference, signal);
      throwIfAborted(signal);
      if (currentSha === pullRequest.headSha) {
        if (engineResult.findings.length > 0) {
          const publication = createReviewPublication(pullRequest.headSha, engineResult.findings);
          pendingReviewCleanup = createTerminalHandle(() =>
            github.removeOwnPendingReview(reference, terminalSignal),
          );
          const pendingReview = await github.createPendingReview(reference, publication, signal);
          pendingReviewCleanup = createTerminalHandle(() => pendingReview.delete(terminalSignal));
          throwIfAborted(signal);
          const postDraftSha = await github.getHeadSha(reference, signal);
          throwIfAborted(signal);
          if (postDraftSha === pullRequest.headSha) {
            try {
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
            result = {
              status: "findings",
              reviewedSha: pullRequest.headSha,
              currentSha: postDraftSha,
              publishedFindings: engineResult.findings.length,
              rejectedFindings: engineResult.diagnostics.length,
              diagnostics: engineResult.diagnostics,
            };
          } else {
            const pendingReviewFailures = await completePendingReview(pendingReviewCleanup);
            pendingReviewCleanup = undefined;
            throwCleanupFailures(pendingReviewFailures, "Pending review cleanup required retries.");
            result = {
              status: "stale",
              reviewedSha: pullRequest.headSha,
              currentSha: postDraftSha,
            };
          }
        } else {
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
      } else {
        result = {
          status: "stale",
          reviewedSha: pullRequest.headSha,
          currentSha,
        };
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

    if (failure !== undefined) {
      throw combineFailures(
        failure,
        cleanupFailures,
        "Review failed and cleanup also encountered errors.",
      );
    }
    throwCleanupFailures(cleanupFailures, "Review cleanup failed.");
    if (result === undefined) {
      throw new Error("Review ended without a result.");
    }
    return result;
  }
}

export function createDefaultManualReviewService(
  configuration: RevoirConfiguration,
): ManualReviewService {
  return new CleanReviewOrchestrator(configuration, {
    github: new GitHubAppReviewGateway(),
    lock: new FileReviewLock(configuration.paths.stateDir),
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
