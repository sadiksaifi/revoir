import { createSign } from "node:crypto";

import type { RevoirConfiguration } from "../config/schema.js";
import { PullRequestEligibilityError } from "./pull-request.js";
import type {
  PullRequestReference,
  PullRequestRepository,
  PullRequestSnapshot,
} from "./pull-request.js";

export type ReviewReaction = "eyes" | "+1";

export interface GitHubReviewSession {
  readonly installationToken: string;
  getPullRequest(
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<PullRequestSnapshot>;
  getHeadSha(reference: PullRequestReference, signal: AbortSignal): Promise<string>;
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
  ): Promise<number>;
  deleteReaction(
    reference: PullRequestReference,
    reactionId: number,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface GitHubReviewGateway {
  authenticate(
    configuration: RevoirConfiguration["github"],
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<GitHubReviewSession>;
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

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function responseJson(
  response: Response,
  action: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`GitHub ${action} failed with HTTP ${response.status}.`);
  }
  try {
    return await abortable(response.json(), signal);
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

class InstallationSession implements GitHubReviewSession {
  readonly installationToken: string;
  readonly #apiBase: string;
  readonly #botLogin: string;
  readonly #fetch: FetchLike;

  constructor(
    installationToken: string,
    appSlug: string,
    fetchImplementation: FetchLike,
    apiBase: string,
  ) {
    this.installationToken = installationToken;
    this.#apiBase = apiBase;
    this.#botLogin = `${appSlug}[bot]`.toLowerCase();
    this.#fetch = fetchImplementation;
  }

  async #request(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    return abortable(
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

  async removeOwnCompletionReaction(
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<void> {
    await this.removeOwnReaction(reference, "+1", signal);
  }

  async removeOwnReaction(
    reference: PullRequestReference,
    reaction: ReviewReaction,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.#request(
      `/repos/${reference.owner}/${reference.repository}/issues/${reference.number}/reactions?per_page=100`,
      signal,
    );
    const value = await responseJson(response, "reaction lookup", signal);
    if (!Array.isArray(value)) {
      throw new Error("GitHub reaction lookup returned an invalid response.");
    }
    const ownedReactions = value
      .map((item) => parseReaction(item))
      .filter(
        (candidate) =>
          candidate.content === reaction && candidate.user.login.toLowerCase() === this.#botLogin,
      );
    await Promise.all(
      ownedReactions.map((candidate) => this.deleteReaction(reference, candidate.id, signal)),
    );
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
    if (!response.ok) {
      throw new Error(`GitHub reaction removal failed with HTTP ${response.status}.`);
    }
  }
}

export class GitHubAppReviewGateway implements GitHubReviewGateway {
  readonly #apiBase: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(
    fetchImplementation: FetchLike = fetch,
    apiBase = "https://api.github.com",
    now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.#fetch = fetchImplementation;
    this.#apiBase = apiBase.replace(/\/$/u, "");
    this.#now = now;
  }

  async authenticate(
    configuration: RevoirConfiguration["github"],
    reference: PullRequestReference,
    signal: AbortSignal,
  ): Promise<GitHubReviewSession> {
    const configuredRepository = configuration.repositories.find(
      (candidate) =>
        candidate.owner.toLowerCase() === reference.owner.toLowerCase() &&
        candidate.name.toLowerCase() === reference.repository.toLowerCase(),
    );
    if (configuredRepository === undefined) {
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
    const [appResponse, tokenResponse] = await Promise.all([
      abortable(this.#fetch(`${this.#apiBase}/app`, { headers, signal }), signal),
      abortable(
        this.#fetch(
          `${this.#apiBase}/app/installations/${configuration.installationId}/access_tokens`,
          {
            method: "POST",
            body: JSON.stringify({ repository_ids: [configuredRepository.id] }),
            headers: { ...headers, "Content-Type": "application/json" },
            signal,
          },
        ),
        signal,
      ),
    ]);
    const app = parseApp(await responseJson(appResponse, "App authentication", signal));
    const installation = parseInstallationToken(
      await responseJson(tokenResponse, "installation authentication", signal),
    );
    return new InstallationSession(installation.token, app.slug, this.#fetch, this.#apiBase);
  }
}
