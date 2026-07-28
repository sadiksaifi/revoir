import { REVIEW_FAILURE_MARKER } from "./failure-marker.js";
import { FindingContractError } from "./findings.js";
import { ReviewTimeoutError } from "./orchestrator.js";
import type { PullRequestReference } from "./pull-request.js";
import { WorkspacePreparationError } from "./workspace.js";

export { REVIEW_FAILURE_MARKER } from "./failure-marker.js";

export type ReviewFailureCategory =
  | "timeout"
  | "github"
  | "cloudflare"
  | "git"
  | "pi"
  | "model"
  | "filesystem"
  | "unknown";

export interface ReviewFailure {
  readonly category: ReviewFailureCategory;
  readonly reason: string;
}

const REASONS: Readonly<Record<ReviewFailureCategory, string>> = {
  timeout: "The review exceeded its configured total timeout.",
  github: "A GitHub operation failed while reviewing the pull request.",
  cloudflare: "The queue service failed while settling the review job.",
  git: "A Git operation failed while preparing or inspecting the review workspace.",
  pi: "The Pi review session or configured model failed.",
  model: "The model returned a malformed or non-publishable review result.",
  filesystem: "A local filesystem operation failed while running the review.",
  unknown: "An unexpected operational error interrupted the review.",
};
const CATEGORIES = Object.keys(REASONS) as ReviewFailureCategory[];

const FILESYSTEM_CODES = new Set([
  "EACCES",
  "EDQUOT",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "EPERM",
  "EROFS",
]);

function errorCandidates(value: unknown): Error[] {
  const candidates: Error[] = [];
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (!(candidate instanceof Error)) {
      continue;
    }
    candidates.push(candidate);
    if (candidate instanceof AggregateError) {
      pending.push(...candidate.errors);
    }
    if (candidate.cause !== undefined) {
      pending.push(candidate.cause);
    }
  }
  return candidates;
}

function categoryFor(error: Error): ReviewFailureCategory | undefined {
  if (error instanceof ReviewTimeoutError || error.name === "TimeoutError") {
    return "timeout";
  }
  if (error instanceof FindingContractError) {
    return "model";
  }
  if (error instanceof WorkspacePreparationError) {
    return "git";
  }
  if (
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    FILESYSTEM_CODES.has((error as NodeJS.ErrnoException).code!)
  ) {
    return "filesystem";
  }
  if (/^GitHub\b/u.test(error.message)) {
    return "github";
  }
  if (/^Cloudflare Queue\b/u.test(error.message)) {
    return "cloudflare";
  }
  if (/\bgit\b|Git tree/u.test(error.message)) {
    return "git";
  }
  if (/\bPi\b|\bmodel\b/u.test(error.message)) {
    return "pi";
  }
  return undefined;
}

export function classifyReviewFailure(error: unknown): ReviewFailure {
  if (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    typeof error.category === "string" &&
    CATEGORIES.includes(error.category as ReviewFailureCategory)
  ) {
    return reviewFailureForCategory(error.category as ReviewFailureCategory);
  }
  for (const candidate of errorCandidates(error)) {
    const category = categoryFor(candidate);
    if (category !== undefined) {
      return { category, reason: REASONS[category] };
    }
  }
  return { category: "unknown", reason: REASONS.unknown };
}

export function reviewFailureForCategory(category: ReviewFailureCategory): ReviewFailure {
  return { category, reason: REASONS[category] };
}

export function renderReviewFailureComment(
  failure: ReviewFailure,
  attempt: number,
  totalAttempts: number,
  reference: PullRequestReference,
): string {
  const attemptState =
    attempt >= totalAttempts
      ? `Automatic retries are exhausted. Run \`revoir review ${reference.url}\` to retry manually.`
      : "Revoir will retry automatically after an increasing delay.";
  return `${REVIEW_FAILURE_MARKER}
Revoir could not complete this review.

**Reason:** ${failure.reason}

**Attempt ${attempt} of ${totalAttempts}.** ${attemptState}`;
}
