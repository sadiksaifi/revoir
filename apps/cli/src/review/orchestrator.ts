import type { RevoirConfiguration } from "../config/schema.js";
import { GitHubAppReviewGateway, type GitHubReviewGateway } from "./github.js";
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
  readonly #reviewEngine: ReviewEngine;
  readonly #workspaces: WorkspacePreparer;

  constructor(
    configuration: RevoirConfiguration,
    dependencies: {
      github: GitHubReviewGateway;
      reviewEngine: ReviewEngine;
      workspaces: WorkspacePreparer;
    },
  ) {
    this.#configuration = configuration;
    this.#github = dependencies.github;
    this.#reviewEngine = dependencies.reviewEngine;
    this.#workspaces = dependencies.workspaces;
  }

  async review(reference: PullRequestReference): Promise<ManualReviewResult> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort(new ReviewTimeoutError(this.#configuration.timeouts.reviewMs));
    }, this.#configuration.timeouts.reviewMs);
    timeout.unref();

    let workspace: PreparedWorkspace | undefined;
    let activeReaction:
      | {
          delete(): Promise<void>;
        }
      | undefined;
    let result: ManualReviewResult | undefined;
    let failure: unknown;

    try {
      const github = await this.#github.authenticate(this.#configuration.github, reference);
      const pullRequest = await github.getPullRequest(reference);
      assertPullRequestEligible(reference, pullRequest, this.#configuration.github);
      throwIfAborted(abortController.signal);

      await github.removeOwnCompletionReaction(reference);
      const reactionId = await github.addReaction(reference, "eyes");
      activeReaction = {
        delete: () => github.deleteReaction(reference, reactionId),
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
      const currentSha = await github.getHeadSha(reference);
      throwIfAborted(abortController.signal);

      await workspace.cleanup();
      workspace = undefined;
      await activeReaction.delete();
      activeReaction = undefined;

      if (currentSha === pullRequest.headSha) {
        await github.addReaction(reference, "+1");
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
      try {
        await activeReaction.delete();
      } catch (error) {
        cleanupFailures.push(asError(error));
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
    reviewEngine: new PiReviewEngine(configuration.model),
    workspaces: new GitWorkspacePreparer(
      configuration.paths.cacheDir,
      configuration.timeouts.shellCommandMs,
    ),
  });
}
