import { createSign } from "node:crypto";

import { installationForRepository, type RevoirConfiguration } from "../config/schema.js";
import { SecretRedactor } from "../redaction.js";
import type { CompletedCheckEvidence, GitHubReviewEvidence } from "./evidence.js";
import { REVIEW_FAILURE_MARKER } from "./failure-marker.js";
import type { GitHubReviewPayload, ReviewPublication } from "./publication.js";
import { PullRequestEligibilityError } from "./pull-request.js";
import type {
  PullRequestReference,
  PullRequestRepository,
  PullRequestSnapshot,
} from "./pull-request.js";
import {
  bodyStateFindingIdentities,
  findingMarkerIdentities,
  runMarkerHeadShas,
  type PriorFindingIdentity,
  type PriorReviewState,
} from "./reconciliation.js";

export type ReviewReaction = "eyes" | "+1" | "confused";

export interface GitHubPendingReview {
  readonly id: number;
  delete(signal: AbortSignal): Promise<void>;
  submit(signal: AbortSignal, reconciliationSignal: AbortSignal): Promise<void>;
}

export type ReviewThreadResolution =
  | { readonly status: "resolved" }
  | { readonly status: "stale"; readonly currentSha: string };

export interface GitHubReviewSession {
  readonly installationToken: string;
  getPullRequest(
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<PullRequestSnapshot>;
  getReviewEvidence(
    reference: PullRequestReference,
    headSha: string,
    signal: AbortSignal,
  ): Promise<GitHubReviewEvidence>;
  getHeadSha(reference: PullRequestReference, signal: AbortSignal): Promise<string>;
  removeOwnCompletionReaction(reference: PullRequestReference, signal: AbortSignal): Promise<void>;
  upsertFailureComment(
    reference: PullRequestReference,
    body: string,
    signal: AbortSignal,
  ): Promise<void>;
  removeOwnFailureComment(reference: PullRequestReference, signal: AbortSignal): Promise<void>;
  removeOwnPendingReview(reference: PullRequestReference, signal: AbortSignal): Promise<void>;
  getPriorReviewState(
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<PriorReviewState>;
  resolveReviewThreads(
    reference: PullRequestReference,
    threadIds: readonly string[],
    expectedHeadSha: string,
    signal: AbortSignal,
  ): Promise<ReviewThreadResolution>;
  removeOwnReaction(
    reference: PullRequestReference,
    reaction: ReviewReaction,
    signal: AbortSignal,
  ): Promise<void>;
  addReaction(
    reference: PullRequestReference,
    reaction: ReviewReaction,
    signal: AbortSignal,
  ): Promise<number>;
  deleteReaction(
    reference: PullRequestReference,
    reactionId: number,
    signal: AbortSignal,
  ): Promise<void>;
  createPendingReview(
    reference: PullRequestReference,
    publication: ReviewPublication,
    signal: AbortSignal,
  ): Promise<GitHubPendingReview>;
}

export interface GitHubReviewGateway {
  authenticate(
    configuration: RevoirConfiguration["github"],
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<GitHubReviewSession>;
}

export class ReviewSubmissionUncertainError extends Error {
  constructor(options?: ErrorOptions) {
    super("GitHub review submission state could not be confirmed.", options);
    this.name = "ReviewSubmissionUncertainError";
  }
}

export class PendingReviewUncertainError extends Error {
  constructor(options?: ErrorOptions) {
    super("GitHub pending review state could not be settled.", options);
    this.name = "PendingReviewUncertainError";
  }
}

export type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

interface GitHubAppResponse {
  slug: string;
}

interface InstallationTokenResponse {
  token: string;
}

interface GitHubReactionResponse {
  id: number;
  content: string;
  user: {
    login: string;
  };
}

interface GitHubReviewResponse {
  body: string;
  id: number;
  state: string;
  userLogin: string;
}

interface GitHubIssueCommentResponse {
  body: string;
  id: number;
  userLogin: string;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function createGitHubAppJwt(
  appId: number,
  privateKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: String(appId),
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Review was cancelled.");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function settleEffect<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    const value = await operation;
    throwIfAborted(signal);
    return value;
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
}

function boundedEffect<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  throwIfAborted(parentSignal);
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]);
  const effect = Promise.resolve().then(() => operation(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void effect.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function settledValues<T>(results: readonly PromiseSettledResult<T>[], message: string): T[] {
  const values: T[] = [];
  const failures: Error[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      values.push(result.value);
    } else {
      const error = asError(result.reason);
      if (!failures.includes(error)) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, message);
  }
  return values;
}

async function yieldToEventLoop(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearImmediate(immediate);
      reject(abortReason(signal));
    };
    const immediate = setImmediate(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function responseJson(
  response: Response,
  action: string,
  signal: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  if (!response.ok) {
    throw new Error(`GitHub ${action} failed with HTTP ${response.status}.`);
  }
  try {
    return await settleEffect(response.json(), signal);
  } catch (error) {
    if (signal.aborted) {
      throw abortReason(signal);
    }
    throw new Error(`GitHub ${action} returned invalid JSON.`, { cause: error });
  }
}

function record(value: unknown, action: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GitHub ${action} returned an invalid response.`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`GitHub returned an invalid ${path}.`);
  }
  return value as number;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub returned an invalid ${path}.`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`GitHub returned an invalid ${path}.`);
  }
  return value;
}

function repository(value: unknown, path: string): PullRequestRepository {
  const repositoryValue = record(value, path);
  return {
    id: positiveInteger(repositoryValue.id, `${path}.id`),
    fullName: string(repositoryValue.full_name, `${path}.full_name`),
    cloneUrl: string(repositoryValue.clone_url, `${path}.clone_url`),
  };
}

function parsePullRequest(value: unknown): PullRequestSnapshot {
  const pullRequest = record(value, "pull request");
  const user = record(pullRequest.user, "pull request user");
  const base = record(pullRequest.base, "pull request base");
  const head = record(pullRequest.head, "pull request head");
  return {
    number: positiveInteger(pullRequest.number, "pull request number"),
    description: optionalString(pullRequest.body, "pull request description") ?? "",
    state: string(pullRequest.state, "pull request state"),
    draft:
      typeof pullRequest.draft === "boolean"
        ? pullRequest.draft
        : (() => {
            throw new Error("GitHub returned an invalid pull request draft state.");
          })(),
    authorId: positiveInteger(user.id, "pull request author id"),
    baseSha: string(base.sha, "pull request base SHA"),
    headSha: string(head.sha, "pull request head SHA"),
    baseRepository: repository(base.repo, "pull request base repository"),
    headRepository: repository(head.repo, "pull request head repository"),
  };
}

const FAILED_ACTIONS_CONCLUSIONS = new Set([
  "action_required",
  "failure",
  "startup_failure",
  "timed_out",
]);
const MAX_ACTIONS_LOG_BYTES = 64 * 1024;
const MAX_ACTIONS_LOG_TOTAL_BYTES = 256 * 1024;
const MAX_ACTIONS_LOG_ENTRIES = MAX_ACTIONS_LOG_TOTAL_BYTES / MAX_ACTIONS_LOG_BYTES;
const ACTIONS_LOG_TRUNCATION_MARKER = "\n...[Revoir truncated GitHub Actions log]...\n";
const ACTIONS_LOG_ENTRY_LIMIT_DIAGNOSTIC =
  "GitHub Actions job log omitted (evidence entry limit reached).";
const ACTIONS_LOG_AGGREGATE_LIMIT_DIAGNOSTIC =
  "GitHub Actions job log omitted (aggregate byte limit reached).";

interface ParsedCompletedCheck {
  evidence: CompletedCheckEvidence;
  actionsJobId?: number;
}

class ActionsJobLogHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GitHub Actions job log lookup failed with HTTP ${status}.`);
    this.name = "ActionsJobLogHttpError";
    this.status = status;
  }
}

function actionsJobLogUnavailableDiagnostic(error: unknown): string {
  return error instanceof ActionsJobLogHttpError
    ? `GitHub Actions job log unavailable (HTTP ${error.status}).`
    : "GitHub Actions job log unavailable (request failed).";
}

function asciiCaseInsensitiveEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    const normalizedLeft = leftCode >= 65 && leftCode <= 90 ? leftCode + 32 : leftCode;
    const normalizedRight = rightCode >= 65 && rightCode <= 90 ? rightCode + 32 : rightCode;
    if (normalizedLeft !== normalizedRight) {
      return false;
    }
  }
  return true;
}

function truncateActionsLogText(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) {
    return value;
  }
  const markerBytes = Buffer.byteLength(ACTIONS_LOG_TRUNCATION_MARKER);
  const payloadBytes = maximumBytes - markerBytes - 6;
  if (payloadBytes <= 0) {
    return ACTIONS_LOG_TRUNCATION_MARKER.trim().slice(0, maximumBytes);
  }
  const headBytes = Math.ceil(payloadBytes / 2);
  const tailBytes = payloadBytes - headBytes;
  return `${bytes.subarray(0, headBytes).toString("utf8")}${ACTIONS_LOG_TRUNCATION_MARKER}${bytes
    .subarray(bytes.length - tailBytes)
    .toString("utf8")}`;
}

async function readBoundedActionsLog(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<string> {
  if (response.body === null) {
    throwIfAborted(signal);
    return "";
  }
  const markerBytes = Buffer.byteLength(ACTIONS_LOG_TRUNCATION_MARKER);
  const payloadBytes = maximumBytes - markerBytes - 6;
  const headMaximum = Math.ceil(payloadBytes / 2);
  const tailMaximum = payloadBytes - headMaximum;
  const completeChunks: Buffer[] = [];
  let complete = true;
  let totalBytes = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  const reader = response.body.getReader();
  try {
    for (;;) {
      throwIfAborted(signal);
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await settleEffect(reader.read(), signal);
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (head.length < headMaximum) {
        const missing = headMaximum - head.length;
        head = Buffer.concat([head, chunk.subarray(0, missing)]);
      }
      if (tailMaximum > 0) {
        const combined =
          chunk.length >= tailMaximum
            ? chunk.subarray(chunk.length - tailMaximum)
            : Buffer.concat([tail, chunk]);
        tail =
          combined.length <= tailMaximum
            ? Buffer.from(combined)
            : Buffer.from(combined.subarray(combined.length - tailMaximum));
      }
      if (complete && totalBytes <= maximumBytes) {
        completeChunks.push(chunk);
      } else if (complete) {
        completeChunks.length = 0;
        complete = false;
      }
    }
  } finally {
    reader.releaseLock();
  }
  throwIfAborted(signal);
  if (complete) {
    return Buffer.concat(completeChunks, totalBytes).toString("utf8");
  }
  return `${head.toString("utf8")}${ACTIONS_LOG_TRUNCATION_MARKER}${tail.toString("utf8")}`;
}

function actionsJobId(detailsUrl: string, reference: PullRequestReference): number | undefined {
  let url: URL;
  try {
    url = new URL(detailsUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "") {
    return undefined;
  }
  const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/u.exec(
    url.pathname,
  );
  if (
    match === null ||
    !asciiCaseInsensitiveEqual(match[1]!, reference.owner) ||
    !asciiCaseInsensitiveEqual(match[2]!, reference.repository)
  ) {
    return undefined;
  }
  const jobId = Number(match[4]);
  return Number.isSafeInteger(jobId) ? jobId : undefined;
}

function parseCompletedCheck(
  value: unknown,
  reference: PullRequestReference,
): ParsedCompletedCheck | undefined {
  const check = record(value, "check run");
  const status = string(check.status, "check run status");
  if (status !== "completed") {
    return undefined;
  }
  const conclusion = string(check.conclusion, "completed check run conclusion");
  const detailsUrl = optionalString(check.details_url, "check run details URL");
  const output =
    check.output === undefined || check.output === null
      ? undefined
      : record(check.output, "check output");
  const title = optionalString(output?.title, "check output title");
  const summary = optionalString(output?.summary, "check output summary");
  const evidence: CompletedCheckEvidence = {
    name: string(check.name, "check run name"),
    conclusion,
    ...(detailsUrl === undefined ? {} : { detailsUrl }),
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
  };
  const jobId =
    detailsUrl !== undefined && FAILED_ACTIONS_CONCLUSIONS.has(conclusion)
      ? actionsJobId(detailsUrl, reference)
      : undefined;
  return {
    evidence,
    ...(jobId === undefined ? {} : { actionsJobId: jobId }),
  };
}

function parseApp(value: unknown): GitHubAppResponse {
  const app = record(value, "App");
  return { slug: string(app.slug, "App slug") };
}

function parseInstallationToken(value: unknown): InstallationTokenResponse {
  const token = record(value, "installation token");
  return { token: string(token.token, "installation token") };
}

function parseReaction(value: unknown): GitHubReactionResponse {
  const reaction = record(value, "reaction");
  const user = record(reaction.user, "reaction user");
  return {
    id: positiveInteger(reaction.id, "reaction id"),
    content: string(reaction.content, "reaction content"),
    user: { login: string(user.login, "reaction user login") },
  };
}

function parseReview(value: unknown): GitHubReviewResponse {
  const review = record(value, "review");
  const user = record(review.user, "review user");
  return {
    body:
      review.body === null || review.body === undefined
        ? ""
        : typeof review.body === "string"
          ? review.body
          : (() => {
              throw new Error("GitHub returned an invalid review body.");
            })(),
    id: positiveInteger(review.id, "review id"),
    state: string(review.state, "review state"),
    userLogin: string(user.login, "review user login"),
  };
}

function parseIssueComment(value: unknown): GitHubIssueCommentResponse {
  const comment = record(value, "issue comment");
  const user = record(comment.user, "issue comment user");
  return {
    body: string(comment.body, "issue comment body"),
    id: positiveInteger(comment.id, "issue comment id"),
    userLogin: string(user.login, "issue comment user login"),
  };
}

class InstallationSession implements GitHubReviewSession {
  readonly installationToken: string;
  readonly #apiBase: string;
  readonly #botLogin: string;
  readonly #fetch: FetchLike;
  readonly #pendingFenceAttemptMs: number;
  readonly #redactor: SecretRedactor;
  #ownedOpenThreadIds = new Set<string>();
  #priorRunWasClean = false;

  constructor(
    installationToken: string,
    appSlug: string,
    fetchImplementation: FetchLike,
    apiBase: string,
    pendingFenceAttemptMs: number,
    redactor: SecretRedactor,
  ) {
    this.installationToken = installationToken;
    this.#apiBase = apiBase;
    this.#botLogin = `${appSlug}[bot]`.toLowerCase();
    this.#fetch = fetchImplementation;
    this.#pendingFenceAttemptMs = pendingFenceAttemptMs;
    this.#redactor = redactor;
  }

  async #request(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    throwIfAborted(signal);
    return settleEffect(
      this.#fetch(`${this.#apiBase}${path}`, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.installationToken}`,
          "User-Agent": "revoir",
          "X-GitHub-Api-Version": "2022-11-28",
          ...init.headers,
        },
        signal,
      }),
      signal,
    );
  }

  async getPullRequest(
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<PullRequestSnapshot> {
    const response = await this.#request(
      `/repos/${reference.owner}/${reference.repository}/pulls/${reference.number}`,
      signal,
    );
    return parsePullRequest(await responseJson(response, "pull request lookup", signal));
  }

  async getHeadSha(reference: PullRequestReference, signal: AbortSignal): Promise<string> {
    return (await this.getPullRequest(reference, signal)).headSha;
  }

  async getReviewEvidence(
    reference: PullRequestReference,
    headSha: string,
    signal: AbortSignal,
  ): Promise<GitHubReviewEvidence> {
    const checks: ParsedCompletedCheck[] = [];
    let page = 1;
    for (;;) {
      throwIfAborted(signal);
      // Check pages are consumed as they exist now; pending checks are deliberately ignored.
      // eslint-disable-next-line no-await-in-loop
      const response = await this.#request(
        `/repos/${reference.owner}/${reference.repository}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
        signal,
      );
      // eslint-disable-next-line no-await-in-loop
      const responseValue = await responseJson(response, "check run lookup", signal);
      const value = record(responseValue, "check run lookup");
      if (!Array.isArray(value.check_runs)) {
        throw new Error("GitHub check run lookup returned an invalid response.");
      }
      for (const check of value.check_runs) {
        const parsed = parseCompletedCheck(check, reference);
        if (parsed !== undefined) {
          checks.push(parsed);
        }
      }
      if (value.check_runs.length < 100) {
        break;
      }
      page += 1;
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop(signal);
    }

    const selectedLogIndices = new Set<number>();
    const selectedJobIds = new Set<number>();
    for (const [index, check] of checks.entries()) {
      if (check.actionsJobId !== undefined && selectedLogIndices.size < MAX_ACTIONS_LOG_ENTRIES) {
        selectedLogIndices.add(index);
        selectedJobIds.add(check.actionsJobId);
      }
    }
    const jobIds = [...selectedJobIds];
    const settledLogs = await Promise.allSettled(
      jobIds.map((jobId) => this.#getActionsJobLog(reference, jobId, signal)),
    );
    throwIfAborted(signal);
    const logsByJobId = new Map(
      jobIds.map((jobId, index) => [jobId, settledLogs[index]!] as const),
    );
    let aggregateLogBytes = 0;
    const completedChecks = checks.map((check, index): CompletedCheckEvidence => {
      if (check.actionsJobId === undefined) {
        return check.evidence;
      }
      if (!selectedLogIndices.has(index)) {
        return Object.assign({}, check.evidence, {
          failedActionsLogUnavailable: ACTIONS_LOG_ENTRY_LIMIT_DIAGNOSTIC,
        });
      }
      const result = logsByJobId.get(check.actionsJobId)!;
      if (result.status === "rejected") {
        return Object.assign({}, check.evidence, {
          failedActionsLogUnavailable: actionsJobLogUnavailableDiagnostic(result.reason),
        });
      }
      const logBytes = Buffer.byteLength(result.value);
      if (aggregateLogBytes + logBytes > MAX_ACTIONS_LOG_TOTAL_BYTES) {
        return Object.assign({}, check.evidence, {
          failedActionsLogUnavailable: ACTIONS_LOG_AGGREGATE_LIMIT_DIAGNOSTIC,
        });
      }
      aggregateLogBytes += logBytes;
      return Object.assign({}, check.evidence, { failedActionsLog: result.value });
    });
    return { completedChecks };
  }

  async #getActionsJobLog(
    reference: PullRequestReference,
    jobId: number,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.#request(
      `/repos/${reference.owner}/${reference.repository}/actions/jobs/${jobId}/logs`,
      signal,
    );
    if (!response.ok) {
      throw new ActionsJobLogHttpError(response.status);
    }
    const log = await readBoundedActionsLog(response, signal, MAX_ACTIONS_LOG_BYTES);
    return truncateActionsLogText(this.#redactor.text(log), MAX_ACTIONS_LOG_BYTES);
  }

  async removeOwnCompletionReaction(
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<void> {
    const removed = settledValues(
      await Promise.allSettled([
        this.#removeOwnReaction(reference, "+1", signal),
        this.#removeOwnReaction(reference, "confused", signal),
      ]),
      "GitHub completion reaction reconciliation failed.",
    );
    this.#priorRunWasClean = removed[0]!;
  }

  async #getOwnFailureComments(
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<GitHubIssueCommentResponse[]> {
    const owned: GitHubIssueCommentResponse[] = [];
    let page = 1;
    for (;;) {
      throwIfAborted(signal);
      // Comment pages form one authoritative snapshot and must remain ordered.
      // eslint-disable-next-line no-await-in-loop
      const response = await this.#request(
        `/repos/${reference.owner}/${reference.repository}/issues/${reference.number}/comments?per_page=100&page=${page}`,
        signal,
      );
      // eslint-disable-next-line no-await-in-loop
      const value = await responseJson(response, "failure comment lookup", signal);
      if (!Array.isArray(value)) {
        throw new Error("GitHub failure comment lookup returned an invalid response.");
      }
      const comments = value.map((item) => parseIssueComment(item));
      owned.push(
        ...comments.filter(
          (comment) =>
            comment.userLogin.toLowerCase() === this.#botLogin &&
            comment.body.includes(REVIEW_FAILURE_MARKER),
        ),
      );
      if (comments.length < 100) {
        return owned;
      }
      page += 1;
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop(signal);
    }
  }

  async #deleteIssueComment(
    reference: PullRequestReference,
    commentId: number,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.#request(
      `/repos/${reference.owner}/${reference.repository}/issues/comments/${commentId}`,
      signal,
      { method: "DELETE" },
    );
    if (response.status !== 204 && response.status !== 404) {
      throw new Error(`GitHub failure comment removal failed with HTTP ${response.status}.`);
    }
  }

  async upsertFailureComment(
    reference: PullRequestReference,
    body: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!body.startsWith(REVIEW_FAILURE_MARKER)) {
      throw new Error("Revoir failure comments must include the ownership marker.");
    }
    const [current, ...duplicates] = await this.#getOwnFailureComments(reference, signal);
    if (current === undefined) {
      const response = await this.#request(
        `/repos/${reference.owner}/${reference.repository}/issues/${reference.number}/comments`,
        signal,
        {
          method: "POST",
          body: JSON.stringify({ body }),
          headers: { "Content-Type": "application/json" },
        },
      );
      parseIssueComment(await responseJson(response, "failure comment creation", signal));
      return;
    }
    const response = await this.#request(
      `/repos/${reference.owner}/${reference.repository}/issues/comments/${current.id}`,
      signal,
      {
        method: "PATCH",
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
      },
    );
    parseIssueComment(await responseJson(response, "failure comment update", signal));
    settledValues(
      await Promise.allSettled(
        duplicates.map((comment) => this.#deleteIssueComment(reference, comment.id, signal)),
      ),
      "GitHub duplicate failure comment cleanup failed.",
    );
  }

  async removeOwnFailureComment(
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<void> {
    const comments = await this.#getOwnFailureComments(reference, signal);
    settledValues(
      await Promise.allSettled(
        comments.map((comment) => this.#deleteIssueComment(reference, comment.id, signal)),
      ),
      "GitHub failure comment cleanup failed.",
    );
  }

  async #graphql(
    query: string,
    variables: Record<string, unknown>,
    action: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.#request("/graphql", signal, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
      headers: { "Content-Type": "application/json" },
    });
    const envelope = record(await responseJson(response, action, signal), action);
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
      throw new Error(`GitHub ${action} returned GraphQL errors.`);
    }
    return record(envelope.data, `${action} data`);
  }

  async getPriorReviewState(
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<PriorReviewState> {
    const activeFingerprints = new Set<string>();
    const runHeadShas = new Set<string>();
    let latestBodyFindings: readonly PriorFindingIdentity[] = [];
    let bodyStateMigrationRequired = false;
    let foundExplicitBodyState = false;
    let reviewPage = 1;
    for (;;) {
      throwIfAborted(signal);
      // Review pages are part of one authoritative snapshot and remain ordered.
      // eslint-disable-next-line no-await-in-loop
      const response = await this.#request(
        `/repos/${reference.owner}/${reference.repository}/pulls/${reference.number}/reviews?per_page=100&page=${reviewPage}`,
        signal,
      );
      // eslint-disable-next-line no-await-in-loop
      const value = await responseJson(response, "prior review lookup", signal);
      if (!Array.isArray(value)) {
        throw new Error("GitHub prior review lookup returned an invalid response.");
      }
      const reviews = value.map((item) => parseReview(item));
      for (const review of reviews) {
        if (
          review.state.toUpperCase() !== "PENDING" &&
          review.userLogin.toLowerCase() === this.#botLogin
        ) {
          const reviewHeadShas = runMarkerHeadShas(review.body);
          for (const headSha of reviewHeadShas) {
            runHeadShas.add(headSha);
          }
          const bodyState = bodyStateFindingIdentities(review.body);
          if (bodyState !== undefined) {
            latestBodyFindings = bodyState;
            bodyStateMigrationRequired = false;
            foundExplicitBodyState = true;
          } else if (!foundExplicitBodyState) {
            latestBodyFindings = findingMarkerIdentities(review.body);
            bodyStateMigrationRequired = true;
          }
        }
      }
      if (reviews.length < 100) {
        break;
      }
      reviewPage += 1;
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop(signal);
    }
    if (!this.#priorRunWasClean) {
      for (const finding of latestBodyFindings) {
        activeFingerprints.add(finding.fingerprint);
      }
    } else {
      latestBodyFindings = [];
      bodyStateMigrationRequired = false;
    }

    const ownedOpenThreads: Array<{
      id: string;
      fingerprint: string;
      aliases?: readonly string[];
    }> = [];
    let after: string | null = null;
    for (;;) {
      // GraphQL exposes the review-thread node IDs required by resolveReviewThread.
      // eslint-disable-next-line no-await-in-loop
      const data = await this.#graphql(
        `query RevoirReviewThreads($owner: String!, $repository: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $repository) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                nodes {
                  id
                  isResolved
                  comments(first: 1) {
                    nodes {
                      body
                      author { login }
                    }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        {
          owner: reference.owner,
          repository: reference.repository,
          number: reference.number,
          after,
        },
        "review thread lookup",
        signal,
      );
      const repositoryValue = record(data.repository, "review thread repository");
      const pullRequest = record(repositoryValue.pullRequest, "review thread pull request");
      const threads = record(pullRequest.reviewThreads, "review threads");
      if (!Array.isArray(threads.nodes)) {
        throw new Error("GitHub review thread lookup returned invalid nodes.");
      }
      for (const candidate of threads.nodes) {
        const thread = record(candidate, "review thread");
        const id = string(thread.id, "review thread id");
        if (typeof thread.isResolved !== "boolean") {
          throw new Error("GitHub returned an invalid review thread resolution state.");
        }
        const comments = record(thread.comments, "review thread comments");
        if (!Array.isArray(comments.nodes)) {
          throw new Error("GitHub returned invalid review thread comments.");
        }
        const firstComment = comments.nodes[0];
        if (firstComment === undefined) {
          continue;
        }
        const comment = record(firstComment, "review thread opening comment");
        const author = record(comment.author, "review thread opening author");
        const authorLogin = string(author.login, "review thread opening author login");
        const body = string(comment.body, "review thread opening comment body");
        const findingIdentities = findingMarkerIdentities(body);
        if (
          !thread.isResolved &&
          authorLogin.toLowerCase() === this.#botLogin &&
          findingIdentities.length === 1
        ) {
          const findingIdentity = findingIdentities[0]!;
          activeFingerprints.add(findingIdentity.fingerprint);
          ownedOpenThreads.push({
            id,
            fingerprint: findingIdentity.fingerprint,
            ...(findingIdentity.aliases === undefined ? {} : { aliases: findingIdentity.aliases }),
          });
        }
      }
      const pageInfo = record(threads.pageInfo, "review thread page info");
      if (typeof pageInfo.hasNextPage !== "boolean") {
        throw new Error("GitHub returned invalid review thread pagination.");
      }
      if (!pageInfo.hasNextPage) {
        break;
      }
      after = string(pageInfo.endCursor, "review thread end cursor");
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop(signal);
    }

    const sortedThreads = ownedOpenThreads.toSorted((left, right) =>
      left.id.localeCompare(right.id),
    );
    this.#ownedOpenThreadIds = new Set(sortedThreads.map(({ id }) => id));
    return {
      activeFingerprints: [...activeFingerprints].toSorted(),
      bodyFindings: latestBodyFindings,
      ...(bodyStateMigrationRequired ? { bodyStateMigrationRequired: true } : {}),
      ownedOpenThreads: sortedThreads,
      runHeadShas: [...runHeadShas].toSorted(),
    };
  }

  async resolveReviewThreads(
    reference: PullRequestReference,
    threadIds: readonly string[],
    expectedHeadSha: string,
    signal: AbortSignal,
  ): Promise<ReviewThreadResolution> {
    const uniqueThreadIds = [...new Set(threadIds)].toSorted();
    for (const threadId of uniqueThreadIds) {
      if (!this.#ownedOpenThreadIds.has(threadId)) {
        throw new Error("Refusing to resolve a review thread not owned by this GitHub App.");
      }
    }
    for (const threadId of uniqueThreadIds) {
      // Each mutation must still belong to the reviewed head.
      // eslint-disable-next-line no-await-in-loop
      const currentSha = await this.getHeadSha(reference, signal);
      if (currentSha !== expectedHeadSha) {
        return { status: "stale", currentSha };
      }
      // Resolution remains ordered so a partial failure has deterministic remote state.
      // eslint-disable-next-line no-await-in-loop
      const data = await this.#graphql(
        `mutation RevoirResolveThread($threadId: ID!) {
          resolveReviewThread(input: {threadId: $threadId}) {
            thread { id isResolved }
          }
        }`,
        { threadId },
        "review thread resolution",
        signal,
      );
      const result = record(data.resolveReviewThread, "review thread resolution result");
      const thread = record(result.thread, "resolved review thread");
      if (
        string(thread.id, "resolved review thread id") !== threadId ||
        thread.isResolved !== true
      ) {
        throw new Error("GitHub did not confirm review thread resolution.");
      }
      this.#ownedOpenThreadIds.delete(threadId);
    }
    return { status: "resolved" };
  }

  async removeOwnPendingReview(
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<void> {
    const ownedReviewIds = new Set<number>();
    let page = 1;
    for (;;) {
      throwIfAborted(signal);
      // Review pages must be requested and validated in order.
      // eslint-disable-next-line no-await-in-loop
      const response = await this.#request(
        `/repos/${reference.owner}/${reference.repository}/pulls/${reference.number}/reviews?per_page=100&page=${page}`,
        signal,
      );
      // eslint-disable-next-line no-await-in-loop
      const value = await responseJson(response, "pending review lookup", signal);
      if (!Array.isArray(value)) {
        throw new Error("GitHub pending review lookup returned an invalid response.");
      }
      const reviews = value.map((item) => parseReview(item));
      for (const review of reviews) {
        if (
          review.state.toUpperCase() === "PENDING" &&
          review.userLogin.toLowerCase() === this.#botLogin
        ) {
          ownedReviewIds.add(review.id);
        }
      }
      if (reviews.length < 100) {
        break;
      }
      page += 1;
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop(signal);
    }
    settledValues(
      await Promise.allSettled(
        [...ownedReviewIds].map((reviewId) =>
          this.#deletePendingReview(reference, reviewId, signal),
        ),
      ),
      "GitHub pending review reconciliation failed.",
    );
  }

  async #removeOwnReaction(
    reference: PullRequestReference,
    reaction: ReviewReaction,
    signal: AbortSignal,
  ): Promise<boolean> {
    const ownedReactionIds = new Set<number>();
    let page = 1;
    for (;;) {
      throwIfAborted(signal);
      // Reaction pages must be requested and validated in order.
      // eslint-disable-next-line no-await-in-loop
      const response = await this.#request(
        `/repos/${reference.owner}/${reference.repository}/issues/${reference.number}/reactions?per_page=100&page=${page}`,
        signal,
      );
      // eslint-disable-next-line no-await-in-loop
      const value = await responseJson(response, "reaction lookup", signal);
      if (!Array.isArray(value)) {
        throw new Error("GitHub reaction lookup returned an invalid response.");
      }
      const pageReactions = value.map((item) => parseReaction(item));
      for (const candidate of pageReactions) {
        if (
          candidate.content === reaction &&
          candidate.user.login.toLowerCase() === this.#botLogin
        ) {
          ownedReactionIds.add(candidate.id);
        }
      }
      if (pageReactions.length < 100) {
        break;
      }
      page += 1;
      // Yield so cancellation can interrupt an unexpectedly endless page sequence.
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop(signal);
    }
    settledValues(
      await Promise.allSettled(
        [...ownedReactionIds].map((reactionId) =>
          this.deleteReaction(reference, reactionId, signal),
        ),
      ),
      "GitHub reaction reconciliation failed.",
    );
    return ownedReactionIds.size > 0;
  }

  async removeOwnReaction(
    reference: PullRequestReference,
    reaction: ReviewReaction,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#removeOwnReaction(reference, reaction, signal);
  }

  async addReaction(
    reference: PullRequestReference,
    reaction: ReviewReaction,
    signal: AbortSignal,
  ): Promise<number> {
    const response = await this.#request(
      `/repos/${reference.owner}/${reference.repository}/issues/${reference.number}/reactions`,
      signal,
      {
        method: "POST",
        body: JSON.stringify({ content: reaction }),
        headers: { "Content-Type": "application/json" },
      },
    );
    return parseReaction(await responseJson(response, "reaction creation", signal)).id;
  }

  async deleteReaction(
    _reference: PullRequestReference,
    reactionId: number,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.#request(`/reactions/${reactionId}`, signal, {
      method: "DELETE",
    });
    if (response.status !== 204 && response.status !== 404) {
      throw new Error(`GitHub reaction removal failed with HTTP ${response.status}.`);
    }
  }

  async #createReview(
    reference: PullRequestReference,
    payload: GitHubReviewPayload,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.#request(
      `/repos/${reference.owner}/${reference.repository}/pulls/${reference.number}/reviews`,
      signal,
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  async #deletePendingReview(
    reference: PullRequestReference,
    reviewId: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#settlePendingReview(reference, reviewId, signal);
  }

  async #getReview(
    reference: PullRequestReference,
    reviewId: number,
    signal: AbortSignal,
  ): Promise<GitHubReviewResponse> {
    const response = await this.#request(
      `/repos/${reference.owner}/${reference.repository}/pulls/${reference.number}/reviews/${reviewId}`,
      signal,
    );
    return parseReview(await responseJson(response, "review lookup", signal));
  }

  async #boundedGetReview(
    reference: PullRequestReference,
    reviewId: number,
    signal: AbortSignal,
  ): Promise<GitHubReviewResponse> {
    return boundedEffect(
      (boundedSignal) => this.#getReview(reference, reviewId, boundedSignal),
      signal,
      this.#pendingFenceAttemptMs,
    );
  }

  async #settlePendingReview(
    reference: PullRequestReference,
    reviewId: number,
    signal: AbortSignal,
  ): Promise<"removed" | "submitted"> {
    const failures: Error[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let deleteResponse: Response | undefined;
      try {
        // eslint-disable-next-line no-await-in-loop
        deleteResponse = await boundedEffect(
          (boundedSignal) =>
            this.#request(
              `/repos/${reference.owner}/${reference.repository}/pulls/${reference.number}/reviews/${reviewId}`,
              boundedSignal,
              { method: "DELETE" },
            ),
          signal,
          this.#pendingFenceAttemptMs,
        );
      } catch (error) {
        failures.push(asError(error));
      }
      if (deleteResponse?.status === 200 || deleteResponse?.status === 404) {
        return "removed";
      }
      if (deleteResponse !== undefined && deleteResponse.status !== 422) {
        failures.push(
          new Error(`GitHub pending review removal failed with HTTP ${deleteResponse.status}.`),
        );
      }

      try {
        // A rejected or ambiguous deletion needs an ordered state readback.
        // eslint-disable-next-line no-await-in-loop
        const review = await this.#boundedGetReview(reference, reviewId, signal);
        if (review.userLogin.toLowerCase() !== this.#botLogin) {
          failures.push(new Error("GitHub returned a pending review owned by another user."));
        } else if (review.state.toUpperCase() !== "PENDING") {
          return "submitted";
        }
      } catch (error) {
        failures.push(asError(error));
      }

      if (attempt < 2) {
        // Preserve request ordering while allowing late remote state to settle.
        // eslint-disable-next-line no-await-in-loop
        await yieldToEventLoop(signal);
      }
    }
    throw new PendingReviewUncertainError({
      cause: new AggregateError(failures, "GitHub pending review compensation was inconclusive."),
    });
  }

  async createPendingReview(
    reference: PullRequestReference,
    publication: ReviewPublication,
    signal: AbortSignal,
  ): Promise<GitHubPendingReview> {
    const response = await this.#createReview(reference, publication.payload, signal);
    let reviewResponse = response;
    if (
      !response.ok &&
      response.status === 422 &&
      publication.payload.comments !== undefined &&
      publication.payload.comments.length > 0
    ) {
      reviewResponse = await this.#createReview(reference, publication.fallbackPayload, signal);
    }
    if (!reviewResponse.ok) {
      throw new Error(`GitHub pending review creation failed with HTTP ${reviewResponse.status}.`);
    }
    const created = record(
      await responseJson(reviewResponse, "pending review creation", signal),
      "pending review",
    );
    const id = positiveInteger(created.id, "pending review id");
    return {
      id,
      delete: (deleteSignal) => this.#deletePendingReview(reference, id, deleteSignal),
      submit: async (submitSignal, reconciliationSignal) => {
        let failure: unknown;
        let definitiveRejection = false;
        try {
          const submitResponse = await this.#request(
            `/repos/${reference.owner}/${reference.repository}/pulls/${reference.number}/reviews/${id}/events`,
            submitSignal,
            {
              method: "POST",
              body: JSON.stringify({ event: "COMMENT" }),
              headers: { "Content-Type": "application/json" },
            },
          );
          if (submitResponse.ok) {
            throwIfAborted(submitSignal);
            return;
          }
          failure =
            submitResponse.status === 422
              ? new Error("GitHub rejected the non-blocking review submission.")
              : new Error(`GitHub review submission failed with HTTP ${submitResponse.status}.`);
          definitiveRejection = submitResponse.status === 422;
        } catch (error) {
          failure = error;
        }

        let liveReview: GitHubReviewResponse | undefined;
        let reconciliationFailure: Error | undefined;
        try {
          liveReview = await this.#boundedGetReview(reference, id, reconciliationSignal);
        } catch (error) {
          reconciliationFailure = asError(error);
        }
        if (
          liveReview !== undefined &&
          liveReview.userLogin.toLowerCase() === this.#botLogin &&
          liveReview.state.toUpperCase() !== "PENDING"
        ) {
          return;
        }
        if (
          definitiveRejection &&
          liveReview?.userLogin.toLowerCase() === this.#botLogin &&
          liveReview.state.toUpperCase() === "PENDING"
        ) {
          throw failure;
        }
        if (liveReview !== undefined && liveReview.userLogin.toLowerCase() !== this.#botLogin) {
          throw new ReviewSubmissionUncertainError();
        }

        try {
          const outcome = await this.#settlePendingReview(reference, id, reconciliationSignal);
          if (outcome === "submitted") {
            return;
          }
          throw failure;
        } catch (error) {
          if (!(error instanceof PendingReviewUncertainError)) {
            throw error;
          }
          throw new ReviewSubmissionUncertainError({
            cause: new AggregateError(
              [asError(failure), ...(reconciliationFailure ? [reconciliationFailure] : []), error],
              "GitHub review submission compensation was inconclusive.",
            ),
          });
        }
      },
    };
  }
}

export class GitHubAppReviewGateway implements GitHubReviewGateway {
  readonly #apiBase: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #pendingFenceAttemptMs: number;

  constructor(
    fetchImplementation: FetchLike = fetch,
    apiBase = "https://api.github.com",
    now: () => number = () => Math.floor(Date.now() / 1000),
    pendingFenceAttemptMs = 1_000,
  ) {
    this.#fetch = fetchImplementation;
    this.#apiBase = apiBase.replace(/\/$/u, "");
    this.#now = now;
    this.#pendingFenceAttemptMs = pendingFenceAttemptMs;
  }

  async authenticate(
    configuration: RevoirConfiguration["github"],
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<GitHubReviewSession> {
    const configuredInstallation = installationForRepository(
      configuration,
      reference.owner,
      reference.repository,
    );
    const configuredRepository = configuredInstallation?.repositories.find(
      (candidate) =>
        candidate.owner.toLowerCase() === reference.owner.toLowerCase() &&
        candidate.name.toLowerCase() === reference.repository.toLowerCase(),
    );
    if (configuredInstallation === undefined || configuredRepository === undefined) {
      throw new PullRequestEligibilityError(
        `${reference.owner}/${reference.repository} is not in the configured repository allowlist.`,
      );
    }

    const jwt = createGitHubAppJwt(configuration.appId, configuration.privateKey, this.#now());
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "revoir",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    throwIfAborted(signal);
    const authenticationResponses = settledValues(
      await Promise.allSettled([
        settleEffect(this.#fetch(`${this.#apiBase}/app`, { headers, signal }), signal),
        settleEffect(
          this.#fetch(
            `${this.#apiBase}/app/installations/${configuredInstallation.id}/access_tokens`,
            {
              method: "POST",
              body: JSON.stringify({ repository_ids: [configuredRepository.id] }),
              headers: { ...headers, "Content-Type": "application/json" },
              signal,
            },
          ),
          signal,
        ),
      ]),
      "GitHub App authentication requests failed.",
    );
    const authenticationValues = settledValues(
      await Promise.allSettled([
        responseJson(authenticationResponses[0]!, "App authentication", signal),
        responseJson(authenticationResponses[1]!, "installation authentication", signal),
      ]),
      "GitHub App authentication responses failed.",
    );
    const app = parseApp(authenticationValues[0]);
    const installation = parseInstallationToken(authenticationValues[1]);
    return new InstallationSession(
      installation.token,
      app.slug,
      this.#fetch,
      this.#apiBase,
      this.#pendingFenceAttemptMs,
      new SecretRedactor({
        configuration,
        installationToken: installation.token,
      }),
    );
  }
}
