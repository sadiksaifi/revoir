import type { RevoirConfiguration } from "../config/schema.js";
import { GitHubAppReviewGateway, type GitHubReviewGateway } from "./github.js";
import { FileReviewLock, type ReviewLock } from "./lock.js";
import { PiReviewEngine, type ReviewEngine } from "./pi.js";
import { assertPullRequestEligible, type PullRequestReference } from "./pull-request.js";
import { createTerminalHandle, type TerminalHandle } from "./terminal-handle.js";
import {
  GitWorkspacePreparer,
  WorkspacePreparationError,
  type WorkspacePreparer,
} from "./workspace.js";

export interface ManualReviewResult {
  status: "clean" | "stale";
  reviewedSha: string;
  currentSha: string;
}

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

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.wait(Promise.resolve().then(operation));
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

async function acquireReviewLock(lock: ReviewLock, signal: AbortSignal) {
  throwIfAborted(signal);
  const acquisition = lock.acquire(signal);
  return new Promise<Awaited<ReturnType<ReviewLock["acquire"]>>>((resolve, reject) => {
    let abandoned = false;
    const onAbort = (): void => {
      abandoned = true;
      reject(signal.reason instanceof Error ? signal.reason : new Error("Review was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void acquisition.then(
      async (lease) => {
        signal.removeEventListener("abort", onAbort);
        if (abandoned || signal.aborted) {
          await lease.release().catch(() => {});
          if (!abandoned) {
            reject(
              signal.reason instanceof Error ? signal.reason : new Error("Review was cancelled."),
            );
          }
          return;
        }
        resolve(lease);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (!abandoned) {
          reject(error);
        }
      },
    );
  });
}

export class CleanReviewOrchestrator implements ManualReviewService {
  readonly #configuration: RevoirConfiguration;
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

    let lease: Awaited<ReturnType<ReviewLock["acquire"]>> | undefined;
    let result: ManualReviewResult | undefined;
    let failure: unknown;
    try {
      lease = await deadline.wait(acquireReviewLock(this.#lock, deadline.signal));
      throwIfAborted(deadline.signal);
      result = await this.#reviewWithLease(reference, deadline);
    } catch (error) {
      failure = error;
    }

    let releaseFailure: unknown;
    if (lease !== undefined) {
      try {
        await deadline.run(() => lease.release());
      } catch (error) {
        releaseFailure = error;
      }
    }
    deadline.dispose();
    if (failure !== undefined && releaseFailure !== undefined) {
      throw combineFailures(
        failure,
        [releaseFailure],
        "Review failed and the process lock could not be released.",
      );
    }
    if (releaseFailure !== undefined) {
      throw releaseFailure;
    }
    if (failure !== undefined) {
      throw failure;
    }
    if (result === undefined) {
      throw new Error("Review ended without a result.");
    }
    return result;
  }

  async #reviewWithLease(
    reference: PullRequestReference,
    deadline: ReviewDeadline,
  ): Promise<ManualReviewResult> {
    const signal = deadline.signal;
    const terminalSignal = new AbortController().signal;
    let workspaceCleanup: TerminalHandle | undefined;
    let activeReaction: TerminalHandle | undefined;
    let result: ManualReviewResult | undefined;
    let failure: unknown;

    try {
      const github = await deadline.run(() =>
        this.#github.authenticate(this.#configuration.github, reference, signal),
      );
      const pullRequest = await deadline.run(() => github.getPullRequest(reference, signal));
      assertPullRequestEligible(reference, pullRequest, this.#configuration.github);
      throwIfAborted(signal);

      await deadline.run(() => github.removeOwnCompletionReaction(reference, signal));
      activeReaction = createTerminalHandle(() =>
        github.removeOwnReaction(reference, "eyes", terminalSignal),
      );
      const reactionId = await deadline.run(() => github.addReaction(reference, "eyes", signal));
      activeReaction = createTerminalHandle(() =>
        github.deleteReaction(reference, reactionId, terminalSignal),
      );

      const preparation = this.#workspaces.prepare(
        reference,
        pullRequest,
        github.installationToken,
        signal,
      );
      let workspace;
      try {
        workspace = await deadline.wait(preparation);
      } catch (error) {
        if (error instanceof WorkspacePreparationError) {
          workspaceCleanup = createTerminalHandle(error.cleanup);
        } else if (error === deadline.error) {
          void preparation.catch((lateError: unknown) => {
            if (lateError instanceof WorkspacePreparationError) {
              void lateError.cleanup().catch(() => {});
            }
          });
        }
        throw error;
      }
      workspaceCleanup = createTerminalHandle(workspace.cleanup);
      throwIfAborted(signal);
      await deadline.run(() =>
        this.#reviewEngine.review({ reference, pullRequest, workspace }, signal),
      );
      throwIfAborted(signal);

      await deadline.run(workspaceCleanup);
      workspaceCleanup = undefined;
      await deadline.run(activeReaction);
      activeReaction = undefined;

      const currentSha = await deadline.run(() => github.getHeadSha(reference, signal));
      throwIfAborted(signal);
      if (currentSha === pullRequest.headSha) {
        activeReaction = createTerminalHandle(() =>
          github.removeOwnReaction(reference, "+1", terminalSignal),
        );
        const completionReactionId = await deadline.run(() =>
          github.addReaction(reference, "+1", signal),
        );
        activeReaction = createTerminalHandle(() =>
          github.deleteReaction(reference, completionReactionId, terminalSignal),
        );
        const postCompletionSha = await deadline.run(() => github.getHeadSha(reference, signal));
        throwIfAborted(signal);
        if (postCompletionSha === pullRequest.headSha) {
          activeReaction = undefined;
          result = {
            status: "clean",
            reviewedSha: pullRequest.headSha,
            currentSha: postCompletionSha,
          };
        } else {
          await deadline.run(activeReaction);
          activeReaction = undefined;
          result = {
            status: "stale",
            reviewedSha: pullRequest.headSha,
            currentSha: postCompletionSha,
          };
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
      try {
        await deadline.run(workspaceCleanup);
        workspaceCleanup = undefined;
      } catch (error) {
        cleanupFailures.push(asError(error));
      }
    }
    if (activeReaction !== undefined) {
      try {
        await deadline.run(activeReaction);
        activeReaction = undefined;
      } catch (error) {
        cleanupFailures.push(asError(error));
      }
    }

    if (failure !== undefined) {
      throw combineFailures(
        failure,
        cleanupFailures,
        "Review failed and cleanup also encountered errors.",
      );
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Review cleanup failed.");
    }
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
    reviewEngine: new PiReviewEngine(configuration.model),
    workspaces: new GitWorkspacePreparer(
      configuration.paths.cacheDir,
      configuration.timeouts.shellCommandMs,
    ),
  });
}
