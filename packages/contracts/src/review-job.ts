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

const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]+$/u;
const SHA = /^[0-9a-f]{40}$/u;
const TOP_LEVEL_FIELDS = [
  "version",
  "deliveryId",
  "installationId",
  "repository",
  "pullRequest",
  "action",
  "enqueuedAt",
] as const;
const REPOSITORY_FIELDS = ["id", "owner", "name"] as const;
const PULL_REQUEST_FIELDS = [
  "number",
  "authorId",
  "senderId",
  "baseRepositoryId",
  "headRepositoryId",
  "baseSha",
  "headSha",
] as const;

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReviewJobSchemaError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function checkKeys(
  value: Record<string, unknown>,
  path: string,
  expected: readonly string[],
): void {
  if (Object.keys(value).some((key) => !expected.includes(key))) {
    throw new ReviewJobSchemaError(`${path} contains an unknown field.`);
  }
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
  checkKeys(job, "review job", TOP_LEVEL_FIELDS);
  if (job.version !== REVIEW_JOB_CONTRACT_VERSION) {
    throw new ReviewJobSchemaError(`review job.version must be ${REVIEW_JOB_CONTRACT_VERSION}.`);
  }
  const repository = record(job.repository, "review job.repository");
  checkKeys(repository, "review job.repository", REPOSITORY_FIELDS);
  const pullRequest = record(job.pullRequest, "review job.pullRequest");
  checkKeys(pullRequest, "review job.pullRequest", PULL_REQUEST_FIELDS);
  const action = string(job.action, "review job.action");
  if (!(REVIEW_JOB_ACTIONS as readonly string[]).includes(action)) {
    throw new ReviewJobSchemaError("review job.action is not supported.");
  }
  const deliveryId = string(job.deliveryId, "review job.deliveryId");
  if (!DELIVERY_ID.test(deliveryId)) {
    throw new ReviewJobSchemaError("review job.deliveryId is malformed.");
  }
  const repositoryId = positiveInteger(repository.id, "review job.repository.id");
  const owner = string(repository.owner, "review job.repository.owner");
  if (!GITHUB_OWNER.test(owner)) {
    throw new ReviewJobSchemaError("review job.repository.owner is malformed.");
  }
  const name = string(repository.name, "review job.repository.name");
  if (!GITHUB_REPOSITORY.test(name)) {
    throw new ReviewJobSchemaError("review job.repository.name is malformed.");
  }
  const baseRepositoryId = positiveInteger(
    pullRequest.baseRepositoryId,
    "review job.pullRequest.baseRepositoryId",
  );
  const headRepositoryId = positiveInteger(
    pullRequest.headRepositoryId,
    "review job.pullRequest.headRepositoryId",
  );
  if (baseRepositoryId !== repositoryId || headRepositoryId !== repositoryId) {
    throw new ReviewJobSchemaError(
      "review job repository identities must describe one same-repository pull request.",
    );
  }
  const baseSha = string(pullRequest.baseSha, "review job.pullRequest.baseSha");
  const headSha = string(pullRequest.headSha, "review job.pullRequest.headSha");
  if (!SHA.test(baseSha) || !SHA.test(headSha)) {
    throw new ReviewJobSchemaError("review job revisions must be lowercase 40-character SHAs.");
  }
  const enqueuedAt = string(job.enqueuedAt, "review job.enqueuedAt");
  if (
    !enqueuedAt.endsWith("Z") ||
    Number.isNaN(Date.parse(enqueuedAt)) ||
    new Date(enqueuedAt).toISOString() !== enqueuedAt
  ) {
    throw new ReviewJobSchemaError("review job.enqueuedAt must be a canonical UTC timestamp.");
  }

  return {
    version: REVIEW_JOB_CONTRACT_VERSION,
    deliveryId,
    installationId: positiveInteger(job.installationId, "review job.installationId"),
    repository: {
      id: repositoryId,
      owner,
      name,
    },
    pullRequest: {
      number: positiveInteger(pullRequest.number, "review job.pullRequest.number"),
      authorId: positiveInteger(pullRequest.authorId, "review job.pullRequest.authorId"),
      senderId: positiveInteger(pullRequest.senderId, "review job.pullRequest.senderId"),
      baseRepositoryId,
      headRepositoryId,
      baseSha,
      headSha,
    },
    action: action as ReviewJobAction,
    enqueuedAt,
  };
}
