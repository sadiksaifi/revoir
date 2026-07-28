export const REVIEW_JOB_CONTRACT_VERSION = 1 as const;

export const REVIEW_JOB_ACTIONS = [
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
] as const;

export type ReviewJobAction = (typeof REVIEW_JOB_ACTIONS)[number];

export interface ReviewJobV1 {
  version: typeof REVIEW_JOB_CONTRACT_VERSION;
  deliveryId: string;
  installationId: number;
  repository: {
    id: number;
    owner: string;
    name: string;
  };
  pullRequest: {
    number: number;
    authorId: number;
    senderId: number;
    baseRepositoryId: number;
    headRepositoryId: number;
    baseSha: string;
    headSha: string;
  };
  action: ReviewJobAction;
  enqueuedAt: string;
}

export class ReviewJobSchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewJobSchemaError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReviewJobSchemaError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReviewJobSchemaError(`${path} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ReviewJobSchemaError(`${path} must be a positive integer.`);
  }
  return value as number;
}

export function parseReviewJob(value: unknown): ReviewJobV1 {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch (error) {
      throw new ReviewJobSchemaError("Review job must be valid JSON.", { cause: error });
    }
  }

  const job = record(candidate, "review job");
  if (job.version !== REVIEW_JOB_CONTRACT_VERSION) {
    throw new ReviewJobSchemaError(`review job.version must be ${REVIEW_JOB_CONTRACT_VERSION}.`);
  }
  const repository = record(job.repository, "review job.repository");
  const pullRequest = record(job.pullRequest, "review job.pullRequest");
  const action = string(job.action, "review job.action");
  if (!(REVIEW_JOB_ACTIONS as readonly string[]).includes(action)) {
    throw new ReviewJobSchemaError("review job.action is not supported.");
  }

  return {
    version: REVIEW_JOB_CONTRACT_VERSION,
    deliveryId: string(job.deliveryId, "review job.deliveryId"),
    installationId: positiveInteger(job.installationId, "review job.installationId"),
    repository: {
      id: positiveInteger(repository.id, "review job.repository.id"),
      owner: string(repository.owner, "review job.repository.owner"),
      name: string(repository.name, "review job.repository.name"),
    },
    pullRequest: {
      number: positiveInteger(pullRequest.number, "review job.pullRequest.number"),
      authorId: positiveInteger(pullRequest.authorId, "review job.pullRequest.authorId"),
      senderId: positiveInteger(pullRequest.senderId, "review job.pullRequest.senderId"),
      baseRepositoryId: positiveInteger(
        pullRequest.baseRepositoryId,
        "review job.pullRequest.baseRepositoryId",
      ),
      headRepositoryId: positiveInteger(
        pullRequest.headRepositoryId,
        "review job.pullRequest.headRepositoryId",
      ),
      baseSha: string(pullRequest.baseSha, "review job.pullRequest.baseSha"),
      headSha: string(pullRequest.headSha, "review job.pullRequest.headSha"),
    },
    action: action as ReviewJobAction,
    enqueuedAt: string(job.enqueuedAt, "review job.enqueuedAt"),
  };
}
