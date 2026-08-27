import {
  REVOIR_POLICY_KV_KEY,
  REVIEW_JOB_ACTIONS,
  parseReviewQueueJob,
  parseRevoirPolicy,
  type AutomaticReviewTrigger,
  type RequestedReviewTrigger,
  type RevoirPolicyRepository,
  type RevoirPolicyV1,
  type ReviewJobAction,
  type ReviewQueueJob,
} from "@revoir/contracts";

export interface QueueProducer<Body> {
  send(body: Body, options?: { contentType?: "json" }): Promise<unknown>;
}

export interface PolicyReader {
  get(key: string): Promise<string | null>;
}

export interface RelayEnvironment {
  GITHUB_WEBHOOK_SECRET: string;
  POLICY_KV: PolicyReader;
  REVIEW_QUEUE: QueueProducer<ReviewQueueJob>;
}

const SIGNATURE = /^sha256=([0-9a-f]{64})$/u;
const REVIEW_COMMAND = /^@revoirapp[\t ]+review$/iu;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function lowerHexBytes(value: string): ArrayBuffer {
  const buffer = new ArrayBuffer(value.length / 2);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return buffer;
}

async function verifySignature(
  rawBody: ArrayBuffer,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  const match = signatureHeader === null ? null : SIGNATURE.exec(signatureHeader);
  if (match?.[1] === undefined || secret.length === 0) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, lowerHexBytes(match[1]), rawBody);
}

async function loadPolicy(environment: RelayEnvironment): Promise<RevoirPolicyV1> {
  const value = await environment.POLICY_KV.get(REVOIR_POLICY_KV_KEY);
  if (value === null) {
    throw new Error("Revoir policy is unavailable.");
  }
  return parseRevoirPolicy(value);
}

function repositoryPolicy(
  repository: Record<string, unknown>,
  installationId: number,
  policy: RevoirPolicyV1,
): RevoirPolicyRepository | undefined {
  const id = positiveInteger(repository.id);
  const owner = record(repository.owner)?.login;
  const name = repository.name;
  const fullName = repository.full_name;
  if (
    id === undefined ||
    typeof owner !== "string" ||
    typeof name !== "string" ||
    typeof fullName !== "string"
  ) {
    return undefined;
  }
  return policy.installations
    .find((candidate) => candidate.id === installationId)
    ?.repositories.find(
      (candidate) =>
        candidate.id === id &&
        candidate.owner.toLowerCase() === owner.toLowerCase() &&
        candidate.name.toLowerCase() === name.toLowerCase() &&
        `${candidate.owner}/${candidate.name}`.toLowerCase() === fullName.toLowerCase(),
    );
}

function createAutomaticReviewJob(
  payloadValue: unknown,
  deliveryId: string,
  policy: RevoirPolicyV1,
  now: Date,
): ReviewQueueJob | undefined {
  const payload = record(payloadValue);
  const repository = record(payload?.repository);
  const pullRequest = record(payload?.pull_request);
  const installation = record(payload?.installation);
  const sender = record(payload?.sender);
  const author = record(pullRequest?.user);
  const base = record(pullRequest?.base);
  const head = record(pullRequest?.head);
  const baseRepository = record(base?.repo);
  const headRepository = record(head?.repo);
  if (
    payload === undefined ||
    repository === undefined ||
    pullRequest === undefined ||
    installation === undefined ||
    sender === undefined ||
    author === undefined ||
    base === undefined ||
    head === undefined ||
    baseRepository === undefined ||
    headRepository === undefined
  ) {
    return undefined;
  }

  const action = payload.action;
  const installationId = positiveInteger(installation.id);
  if (
    typeof action !== "string" ||
    !(REVIEW_JOB_ACTIONS as readonly string[]).includes(action) ||
    installationId === undefined
  ) {
    return undefined;
  }
  const configuredRepository = repositoryPolicy(repository, installationId, policy);
  const repositoryId = positiveInteger(repository.id);
  const pullRequestNumber = positiveInteger(pullRequest.number);
  const envelopeNumber = positiveInteger(payload.number);
  const authorId = positiveInteger(author.id);
  const senderId = positiveInteger(sender.id);
  const baseRepositoryId = positiveInteger(baseRepository.id);
  const headRepositoryId = positiveInteger(headRepository.id);
  const baseRepositoryName = baseRepository.full_name;
  const headRepositoryName = headRepository.full_name;
  if (
    configuredRepository === undefined ||
    repositoryId === undefined ||
    pullRequestNumber === undefined ||
    envelopeNumber !== pullRequestNumber ||
    authorId !== policy.userId ||
    senderId !== policy.userId ||
    pullRequest.state !== "open" ||
    pullRequest.draft !== false ||
    baseRepositoryId !== repositoryId ||
    headRepositoryId !== repositoryId ||
    typeof baseRepositoryName !== "string" ||
    typeof headRepositoryName !== "string" ||
    baseRepositoryName.toLowerCase() !==
      `${configuredRepository.owner}/${configuredRepository.name}`.toLowerCase() ||
    headRepositoryName.toLowerCase() !== baseRepositoryName.toLowerCase()
  ) {
    return undefined;
  }

  const trigger: AutomaticReviewTrigger = {
    kind: "automatic",
    action: action as ReviewJobAction,
    authorId,
    senderId,
    baseRepositoryId,
    headRepositoryId,
    baseSha: typeof base.sha === "string" ? base.sha : "",
    headSha: typeof head.sha === "string" ? head.sha : "",
  };
  try {
    return parseReviewQueueJob({
      version: 1,
      deliveryId,
      installationId,
      repository: configuredRepository,
      pullRequest: { number: pullRequestNumber },
      trigger,
      enqueuedAt: now.toISOString(),
    });
  } catch {
    return undefined;
  }
}

function createRequestedReviewJob(
  payloadValue: unknown,
  deliveryId: string,
  policy: RevoirPolicyV1,
  now: Date,
): ReviewQueueJob | undefined {
  const payload = record(payloadValue);
  const repository = record(payload?.repository);
  const installation = record(payload?.installation);
  const sender = record(payload?.sender);
  const issue = record(payload?.issue);
  const pullRequest = record(issue?.pull_request);
  const comment = record(payload?.comment);
  const commentAuthor = record(comment?.user);
  if (
    payload === undefined ||
    repository === undefined ||
    installation === undefined ||
    sender === undefined ||
    issue === undefined ||
    pullRequest === undefined ||
    comment === undefined ||
    commentAuthor === undefined
  ) {
    return undefined;
  }

  const installationId = positiveInteger(installation.id);
  if (installationId === undefined) {
    return undefined;
  }
  const configuredRepository = repositoryPolicy(repository, installationId, policy);
  const pullRequestNumber = positiveInteger(issue.number);
  const commentId = positiveInteger(comment.id);
  const senderId = positiveInteger(sender.id);
  const commentAuthorId = positiveInteger(commentAuthor.id);
  if (
    payload.action !== "created" ||
    configuredRepository === undefined ||
    pullRequestNumber === undefined ||
    commentId === undefined ||
    senderId !== policy.userId ||
    commentAuthorId !== senderId ||
    typeof comment.body !== "string" ||
    !REVIEW_COMMAND.test(comment.body.trim())
  ) {
    return undefined;
  }

  const trigger: RequestedReviewTrigger = {
    kind: "requested",
    source: "issue_comment",
    commentId,
    senderId,
  };
  try {
    return parseReviewQueueJob({
      version: 1,
      deliveryId,
      installationId,
      repository: configuredRepository,
      pullRequest: { number: pullRequestNumber },
      trigger,
      enqueuedAt: now.toISOString(),
    });
  } catch {
    return undefined;
  }
}

export function createWebhookRelay(now: () => Date = () => new Date()) {
  return {
    async fetch(request: Request, environment: RelayEnvironment): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== "/github/webhook") {
        return new Response("Not Found", { status: 404 });
      }
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !== "application/json") {
        return new Response("Unsupported Media Type", { status: 415 });
      }

      const rawBody = await request.arrayBuffer();
      if (
        !(await verifySignature(
          rawBody,
          request.headers.get("X-Hub-Signature-256"),
          environment.GITHUB_WEBHOOK_SECRET,
        ))
      ) {
        return new Response("Unauthorized", { status: 401 });
      }
      const event = request.headers.get("X-GitHub-Event");
      if (event !== "pull_request" && event !== "issue_comment") {
        return new Response("Accepted", { status: 202 });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      let policy: RevoirPolicyV1;
      try {
        policy = await loadPolicy(environment);
      } catch {
        return new Response("Service Unavailable", { status: 503 });
      }
      const deliveryId = request.headers.get("X-GitHub-Delivery");
      const job =
        deliveryId === null
          ? undefined
          : event === "pull_request"
            ? createAutomaticReviewJob(payload, deliveryId, policy, now())
            : createRequestedReviewJob(payload, deliveryId, policy, now());
      if (job === undefined) {
        return new Response("Accepted", { status: 202 });
      }

      try {
        await environment.REVIEW_QUEUE.send(job, { contentType: "json" });
      } catch {
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response("Accepted", { status: 202 });
    },
  };
}

export default createWebhookRelay() satisfies ExportedHandler<Env>;
