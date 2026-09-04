export const REVIEW_QUEUE_JOB_CONTRACT_VERSION = 2 as const;

export const REVIEW_JOB_ACTIONS = [
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
] as const;

export type ReviewJobAction = (typeof REVIEW_JOB_ACTIONS)[number];

export interface ReviewJobRepository {
  id: number;
  owner: string;
  name: string;
}

export interface AutomaticReviewTrigger {
  kind: "automatic";
  action: ReviewJobAction;
  authorId: number;
  senderId: number;
  baseRepositoryId: number;
  headRepositoryId: number;
  baseSha: string;
  headSha: string;
}

export interface RequestedReviewTrigger {
  kind: "requested";
  source: "issue_comment";
  commentId: number;
  senderId: number;
}

export interface ReviewQueueJobV1 {
  version: 1;
  deliveryId: string;
  installationId: number;
  repository: ReviewJobRepository;
  pullRequest: {
    number: number;
  };
  trigger: AutomaticReviewTrigger | RequestedReviewTrigger;
  enqueuedAt: string;
}

export interface ReviewQueueJobV2 extends Omit<ReviewQueueJobV1, "version"> {
  version: typeof REVIEW_QUEUE_JOB_CONTRACT_VERSION;
  triggeredAt: string;
}

export type ReviewQueueJob = ReviewQueueJobV1 | ReviewQueueJobV2;

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
const V1_TOP_LEVEL_FIELDS = [
  "version",
  "deliveryId",
  "installationId",
  "repository",
  "pullRequest",
  "trigger",
  "enqueuedAt",
] as const;
const V2_TOP_LEVEL_FIELDS = [...V1_TOP_LEVEL_FIELDS, "triggeredAt"] as const;
const REPOSITORY_FIELDS = ["id", "owner", "name"] as const;
const PULL_REQUEST_FIELDS = ["number"] as const;
const AUTOMATIC_TRIGGER_FIELDS = [
  "kind",
  "action",
  "authorId",
  "senderId",
  "baseRepositoryId",
  "headRepositoryId",
  "baseSha",
  "headSha",
] as const;
const REQUESTED_TRIGGER_FIELDS = ["kind", "source", "commentId", "senderId"] as const;

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
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new ReviewJobSchemaError(`${path} must contain exactly the expected fields.`);
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

function candidate(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ReviewJobSchemaError("Review job must be valid JSON.", { cause: error });
  }
}

function parseDeliveryId(value: unknown): string {
  const parsed = string(value, "review job.deliveryId");
  if (!DELIVERY_ID.test(parsed)) {
    throw new ReviewJobSchemaError("review job.deliveryId is malformed.");
  }
  return parsed;
}

function parseRepository(value: unknown): ReviewJobRepository {
  const parsed = record(value, "review job.repository");
  checkKeys(parsed, "review job.repository", REPOSITORY_FIELDS);
  const id = positiveInteger(parsed.id, "review job.repository.id");
  const owner = string(parsed.owner, "review job.repository.owner");
  if (!GITHUB_OWNER.test(owner)) {
    throw new ReviewJobSchemaError("review job.repository.owner is malformed.");
  }
  const name = string(parsed.name, "review job.repository.name");
  if (!GITHUB_REPOSITORY.test(name)) {
    throw new ReviewJobSchemaError("review job.repository.name is malformed.");
  }
  return { id, owner, name };
}

function parseTimestamp(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (
    !parsed.endsWith("Z") ||
    Number.isNaN(Date.parse(parsed)) ||
    new Date(parsed).toISOString() !== parsed
  ) {
    throw new ReviewJobSchemaError(`${path} must be a canonical UTC timestamp.`);
  }
  return parsed;
}

function parseAutomaticTrigger(
  value: Record<string, unknown>,
  repositoryId: number,
): AutomaticReviewTrigger {
  checkKeys(value, "review job.trigger", AUTOMATIC_TRIGGER_FIELDS);
  const action = string(value.action, "review job.trigger.action");
  if (!(REVIEW_JOB_ACTIONS as readonly string[]).includes(action)) {
    throw new ReviewJobSchemaError("review job.trigger.action is not supported.");
  }
  const baseRepositoryId = positiveInteger(
    value.baseRepositoryId,
    "review job.trigger.baseRepositoryId",
  );
  const headRepositoryId = positiveInteger(
    value.headRepositoryId,
    "review job.trigger.headRepositoryId",
  );
  if (baseRepositoryId !== repositoryId || headRepositoryId !== repositoryId) {
    throw new ReviewJobSchemaError(
      "review job repository identities must describe one same-repository pull request.",
    );
  }
  const baseSha = string(value.baseSha, "review job.trigger.baseSha");
  const headSha = string(value.headSha, "review job.trigger.headSha");
  if (!SHA.test(baseSha) || !SHA.test(headSha)) {
    throw new ReviewJobSchemaError("review job revisions must be lowercase 40-character SHAs.");
  }
  return {
    kind: "automatic",
    action: action as ReviewJobAction,
    authorId: positiveInteger(value.authorId, "review job.trigger.authorId"),
    senderId: positiveInteger(value.senderId, "review job.trigger.senderId"),
    baseRepositoryId,
    headRepositoryId,
    baseSha,
    headSha,
  };
}

function parseRequestedTrigger(value: Record<string, unknown>): RequestedReviewTrigger {
  checkKeys(value, "review job.trigger", REQUESTED_TRIGGER_FIELDS);
  if (value.source !== "issue_comment") {
    throw new ReviewJobSchemaError("review job.trigger.source is not supported.");
  }
  return {
    kind: "requested",
    source: value.source,
    commentId: positiveInteger(value.commentId, "review job.trigger.commentId"),
    senderId: positiveInteger(value.senderId, "review job.trigger.senderId"),
  };
}

export function parseReviewQueueJob(value: unknown): ReviewQueueJob {
  const job = record(candidate(value), "review job");
  if (job.version !== 1 && job.version !== REVIEW_QUEUE_JOB_CONTRACT_VERSION) {
    throw new ReviewJobSchemaError("review job.version must be 1 or 2.");
  }
  checkKeys(job, "review job", job.version === 1 ? V1_TOP_LEVEL_FIELDS : V2_TOP_LEVEL_FIELDS);
  const repository = parseRepository(job.repository);
  const pullRequest = record(job.pullRequest, "review job.pullRequest");
  checkKeys(pullRequest, "review job.pullRequest", PULL_REQUEST_FIELDS);
  const trigger = record(job.trigger, "review job.trigger");

  const shared = {
    deliveryId: parseDeliveryId(job.deliveryId),
    installationId: positiveInteger(job.installationId, "review job.installationId"),
    repository,
    pullRequest: {
      number: positiveInteger(pullRequest.number, "review job.pullRequest.number"),
    },
    trigger:
      trigger.kind === "automatic"
        ? parseAutomaticTrigger(trigger, repository.id)
        : trigger.kind === "requested"
          ? parseRequestedTrigger(trigger)
          : (() => {
              throw new ReviewJobSchemaError("review job.trigger.kind is not supported.");
            })(),
    enqueuedAt: parseTimestamp(job.enqueuedAt, "review job.enqueuedAt"),
  };
  return job.version === 1
    ? { version: 1, ...shared }
    : {
        version: REVIEW_QUEUE_JOB_CONTRACT_VERSION,
        ...shared,
        triggeredAt: parseTimestamp(job.triggeredAt, "review job.triggeredAt"),
      };
}
