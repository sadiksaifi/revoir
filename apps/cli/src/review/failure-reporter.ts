import type { RevoirPolicy } from "../config/policy.js";
import type { RevoirConfiguration } from "../config/schema.js";
import { classifyReviewFailure, renderReviewFailureComment } from "./failure.js";
import { GitHubAppReviewGateway, type ReviewReaction } from "./github.js";
import type { PullRequestReference } from "./pull-request.js";

export interface ReviewFailureSession {
  removeOwnCompletionReaction(reference: PullRequestReference, signal: AbortSignal): Promise<void>;
  removeOwnReaction(
    reference: PullRequestReference,
    reaction: ReviewReaction,
    signal: AbortSignal,
  ): Promise<void>;
  addReaction(
    reference: PullRequestReference,
    reaction: ReviewReaction,
    signal: AbortSignal,
  ): Promise<unknown>;
  upsertFailureComment(
    reference: PullRequestReference,
    body: string,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface ReviewFailureGateway {
  authenticate(
    configuration: RevoirConfiguration["github"],
    policy: RevoirPolicy,
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<ReviewFailureSession>;
}

export interface ReviewFailureReporter {
  report(
    reference: PullRequestReference,
    error: unknown,
    attempt: number,
    totalAttempts: number,
    signal: AbortSignal,
  ): Promise<void>;
}

function failures(results: readonly PromiseSettledResult<unknown>[]): Error[] {
  return results.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
      : [],
  );
}

export class GitHubReviewFailureReporter implements ReviewFailureReporter {
  readonly #configuration: RevoirConfiguration["github"];
  readonly #gateway: ReviewFailureGateway;
  readonly #loadPolicy: (signal?: AbortSignal) => Promise<RevoirPolicy>;

  constructor(
    configuration: RevoirConfiguration["github"],
    loadPolicy: (signal?: AbortSignal) => Promise<RevoirPolicy>,
    gateway: ReviewFailureGateway = new GitHubAppReviewGateway(),
  ) {
    this.#configuration = configuration;
    this.#loadPolicy = loadPolicy;
    this.#gateway = gateway;
  }

  async report(
    reference: PullRequestReference,
    error: unknown,
    attempt: number,
    totalAttempts: number,
    signal: AbortSignal,
  ): Promise<void> {
    const session = await this.#gateway.authenticate(
      this.#configuration,
      await this.#loadPolicy(signal),
      reference,
      signal,
    );
    const cleanupFailures = failures(
      await Promise.allSettled([
        session.removeOwnReaction(reference, "eyes", signal),
        session.removeOwnCompletionReaction(reference, signal),
      ]),
    );
    const body = renderReviewFailureComment(
      classifyReviewFailure(error),
      attempt,
      totalAttempts,
      reference,
    );
    const publicationFailures = failures(
      await Promise.allSettled([
        session.addReaction(reference, "confused", signal),
        session.upsertFailureComment(reference, body, signal),
      ]),
    );
    const allFailures = [...cleanupFailures, ...publicationFailures];
    if (allFailures.length === 1) {
      throw allFailures[0];
    }
    if (allFailures.length > 1) {
      throw new AggregateError(allFailures, "GitHub review failure reporting was incomplete.");
    }
  }
}
