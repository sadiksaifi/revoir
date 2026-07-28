import type { RevoirConfiguration } from "../config/schema.js";
import { GitHubAppReviewGateway, type GitHubReviewGateway } from "./github.js";
import { FileReviewLock, type ReviewLock } from "./lock.js";
import { PiReviewEngine, type ReviewEngine } from "./pi.js";
import { assertPullRequestEligible, type PullRequestReference } from "./pull-request.js";
import {
  GitWorkspacePreparer,
  type PreparedWorkspace,
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
    const lease = await this.#lock.acquire();
    let result: ManualReviewResult | undefined;
    let failure: unknown;
    try {
      result = await this.#reviewWithLease(reference);
    } catch (error) {
      failure = error;
    }

    let releaseFailure: unknown;
    try {
      await lease.release();
    } catch (error) {
      releaseFailure = error;
    }
    if (failure !== undefined && releaseFailure !== undefined) {
      throw new AggregateError(
        [asError(failure), asError(releaseFailure)],
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

  async #reviewWithLease(reference: PullRequestReference): Promise<ManualReviewResult> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort(new ReviewTimeoutError(this.#configuration.timeouts.reviewMs));
    }, this.#configuration.timeouts.reviewMs);

    let workspace: PreparedWorkspace | undefined;
    let activeReaction:
      | {
          delete(signal: AbortSignal): Promise<void>;
        }
      | undefined;
    let result: ManualReviewResult | undefined;
    let failure: unknown;

    try {
      const github = await this.#github.authenticate(
        this.#configuration.github,
        reference,
        abortController.signal,
      );
      const pullRequest = await github.getPullRequest(reference, abortController.signal);
      assertPullRequestEligible(reference, pullRequest, this.#configuration.github);
      throwIfAborted(abortController.signal);

      await github.removeOwnCompletionReaction(reference, abortController.signal);
      const reactionId = await github.addReaction(reference, "eyes", abortController.signal);
      activeReaction = {
        delete: (signal) => github.deleteReaction(reference, reactionId, signal),
      };

      workspace = await this.#workspaces.prepare(
        reference,
        pullRequest,
        github.installationToken,
        abortController.signal,
      );
      throwIfAborted(abortController.signal);
      await this.#reviewEngine.review(
        { reference, pullRequest, workspace },
        abortController.signal,
      );
      throwIfAborted(abortController.signal);

      await workspace.cleanup();
      workspace = undefined;
      await activeReaction.delete(abortController.signal);
      activeReaction = undefined;

      const currentSha = await github.getHeadSha(reference, abortController.signal);
      throwIfAborted(abortController.signal);
      if (currentSha === pullRequest.headSha) {
        await github.addReaction(reference, "+1", abortController.signal);
        result = {
          status: "clean",
          reviewedSha: pullRequest.headSha,
          currentSha,
        };
      } else {
        result = {
          status: "stale",
          reviewedSha: pullRequest.headSha,
          currentSha,
        };
      }
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timeout);
      if (!abortController.signal.aborted) {
        abortController.abort(asError(failure ?? "Review finished."));
      }
    }

    const cleanupFailures: Error[] = [];
    if (workspace !== undefined) {
      try {
        await workspace.cleanup();
      } catch (error) {
        cleanupFailures.push(asError(error));
      }
    }
    if (activeReaction !== undefined) {
      const cleanupController = new AbortController();
      const cleanupTimeout = setTimeout(() => {
        cleanupController.abort(new ReviewTimeoutError(this.#configuration.timeouts.reviewMs));
      }, this.#configuration.timeouts.reviewMs);
      try {
        await activeReaction.delete(cleanupController.signal);
      } catch (error) {
        cleanupFailures.push(asError(error));
      } finally {
        clearTimeout(cleanupTimeout);
      }
    }

    if (failure !== undefined) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [asError(failure), ...cleanupFailures],
          "Review failed and cleanup also encountered errors.",
        );
      }
      throw failure;
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
