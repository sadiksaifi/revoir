import { parseRevoirPolicy, REVOIR_POLICY_KV_KEY } from "@revoir/contracts";

import { intersectPolicies, loadPolicy, writePolicy, type RevoirPolicy } from "./config/policy.js";
import type { RevoirConfiguration } from "./config/schema.js";
import {
  githubInstallationSettingsUrl,
  parseGitHubInstallation,
  type GitHubInstallationIdentity,
} from "./github-installation.js";
import {
  type RepositoryApproval,
  type RepositoryDiscovery,
  type RepositoryGitHubGateway,
  type RepositoryPolicyStore,
  type RepositoryReference,
} from "./repository.js";
import { createGitHubAppJwt, type FetchLike } from "./review/github.js";
import type { GitHubManifestBrowser } from "./setup/github-manifest.js";
import { ChildProcessSetupRunner, type SetupProcessRunner } from "./setup/platform.js";

const GITHUB_PAGE_SIZE = 100;
const MAX_GITHUB_PAGES = 100;
const KV_PROPAGATION_WINDOW_MS = 60_000;
const KV_ACTIVATION_DEADLINE_MS = 65_000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response.`);
  }
  return value as Record<string, unknown>;
}

function repository(value: unknown) {
  const parsed = record(value, "GitHub repository");
  const owner = record(parsed.owner, "GitHub repository owner");
  if (
    !Number.isSafeInteger(parsed.id) ||
    typeof parsed.name !== "string" ||
    typeof owner.login !== "string"
  ) {
    throw new Error("GitHub repository response omitted its immutable identity.");
  }
  return { id: parsed.id as number, owner: owner.login, name: parsed.name };
}

function appHeaders(token: string): Readonly<Record<string, string>> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "revoir",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function responseJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export class GitHubRepositoryGateway implements RepositoryGitHubGateway {
  readonly #browser: GitHubManifestBrowser;
  readonly #configuration: RevoirConfiguration["github"];
  readonly #fetch: FetchLike;
  readonly #pollAttempts: number;
  readonly #process: SetupProcessRunner;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(input: {
    browser: GitHubManifestBrowser;
    configuration: RevoirConfiguration["github"];
    fetch?: FetchLike;
    process?: SetupProcessRunner;
    pollAttempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#browser = input.browser;
    this.#configuration = input.configuration;
    this.#fetch = input.fetch ?? fetch;
    this.#process = input.process ?? new ChildProcessSetupRunner();
    this.#pollAttempts = input.pollAttempts ?? 15;
    this.#sleep =
      input.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async #appInstallations(): Promise<GitHubInstallationIdentity[]> {
    const entries: GitHubInstallationIdentity[] = [];
    for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
      const jwt = createGitHubAppJwt(this.#configuration.appId, this.#configuration.privateKey);
      // eslint-disable-next-line no-await-in-loop
      const response = await this.#fetch(
        `https://api.github.com/app/installations?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
        { headers: appHeaders(jwt) },
      );
      // eslint-disable-next-line no-await-in-loop
      const value = await responseJson(response, "GitHub App installation discovery");
      if (!Array.isArray(value)) {
        throw new Error("GitHub App installation discovery returned an invalid response.");
      }
      entries.push(...value.map(parseGitHubInstallation));
      if (value.length < GITHUB_PAGE_SIZE) {
        return entries;
      }
    }
    throw new Error("GitHub App installation discovery exceeded the supported pagination limit.");
  }

  async #installationToken(installationId: number): Promise<string | undefined> {
    const jwt = createGitHubAppJwt(this.#configuration.appId, this.#configuration.privateKey);
    const response = await this.#fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      { method: "POST", headers: appHeaders(jwt) },
    );
    if (response.status === 404) return undefined;
    const value = record(
      await responseJson(response, "GitHub installation authentication"),
      "GitHub installation authentication",
    );
    if (typeof value.token !== "string" || value.token === "") {
      throw new Error("GitHub installation authentication omitted its token.");
    }
    return value.token;
  }

  async #hasAccess(installationId: number, repositoryId: number): Promise<boolean | undefined> {
    const token = await this.#installationToken(installationId);
    if (token === undefined) return undefined;
    const response = await this.#fetch(`https://api.github.com/repositories/${repositoryId}`, {
      headers: appHeaders(token),
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`GitHub repository access verification failed with HTTP ${response.status}.`);
    }
    return true;
  }

  async #publicRepository(reference: RepositoryReference) {
    const output = await this.#process
      .run("gh", ["api", `repos/${reference.owner}/${reference.name}`])
      .then(({ stdout }) => stdout)
      .catch((error: unknown) => {
        throw new Error(
          `GitHub CLI could not resolve ${reference.owner}/${reference.name}. Verify your access and spelling.`,
          { cause: error },
        );
      });
    return repository(JSON.parse(output) as unknown);
  }

  async ensureAuthenticated(): Promise<void> {
    try {
      await this.#process.run("gh", ["auth", "status"]);
    } catch {
      await this.#process.run("gh", ["auth", "login", "--web"], { interactive: true });
    }
  }

  async discover(reference: RepositoryReference): Promise<RepositoryDiscovery> {
    const resolvedRepository = await this.#publicRepository(reference);
    const installations = await this.#appInstallations();
    const candidate = installations.find(
      (item) => item.accountLogin.toLowerCase() === resolvedRepository.owner.toLowerCase(),
    );
    const access =
      candidate === undefined
        ? undefined
        : await this.#hasAccess(candidate.id, resolvedRepository.id);
    return {
      repository: resolvedRepository,
      ...(candidate === undefined || access === undefined
        ? {}
        : {
            installation: {
              id: candidate.id,
              hasRepositoryAccess: access,
              settingsUrl: githubInstallationSettingsUrl(candidate),
            },
          }),
      newInstallationUrl: `https://github.com/apps/${this.#configuration.appSlug}/installations/new`,
    };
  }

  open(url: string): Promise<void> {
    return this.#browser.open(url);
  }

  async waitForInstallation(reference: RepositoryReference): Promise<RepositoryApproval> {
    const resolvedRepository = await this.#publicRepository(reference);
    let discoveredInstallation: GitHubInstallationIdentity | undefined;
    for (let attempt = 0; attempt < this.#pollAttempts; attempt += 1) {
      // The short bounded poll makes organization-owner approval resumable.
      // eslint-disable-next-line no-await-in-loop
      const installations = await this.#appInstallations();
      const candidate = installations.find(
        (item) => item.accountLogin.toLowerCase() === reference.owner.toLowerCase(),
      );
      discoveredInstallation = candidate ?? discoveredInstallation;
      if (
        candidate !== undefined &&
        // eslint-disable-next-line no-await-in-loop
        (await this.#hasAccess(candidate.id, resolvedRepository.id)) === true
      ) {
        return {
          status: "approved",
          installationId: candidate.id,
          settingsUrl: githubInstallationSettingsUrl(candidate),
        };
      }
      // eslint-disable-next-line no-await-in-loop
      await this.#sleep(2_000);
    }
    return {
      status: "pending",
      ...(discoveredInstallation === undefined
        ? {}
        : { installationId: discoveredInstallation.id }),
      settingsUrl:
        discoveredInstallation === undefined
          ? `https://github.com/apps/${this.#configuration.appSlug}/installations/new`
          : githubInstallationSettingsUrl(discoveredInstallation),
    };
  }

  async waitForRepositoryAccess(
    installationId: number,
    candidate: { id: number },
    expected: boolean,
  ): Promise<"confirmed" | "pending" | "installation-absent"> {
    for (let attempt = 0; attempt < this.#pollAttempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const access = await this.#hasAccess(installationId, candidate.id);
      if (access === undefined) return "installation-absent";
      if (access === expected) return "confirmed";
      // eslint-disable-next-line no-await-in-loop
      await this.#sleep(2_000);
    }
    return "pending";
  }

  async listAccessibleRepositories() {
    const installations = await this.#appInstallations();
    const entries: { installationId: number; repository: ReturnType<typeof repository> }[] = [];
    for (const candidate of installations) {
      // eslint-disable-next-line no-await-in-loop
      const token = await this.#installationToken(candidate.id);
      if (token === undefined) continue;
      let complete = false;
      for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop
        const response = await this.#fetch(
          `https://api.github.com/installation/repositories?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
          { headers: appHeaders(token) },
        );
        // eslint-disable-next-line no-await-in-loop
        const responseValue = await responseJson(response, "GitHub installation repositories");
        const value = record(responseValue, "GitHub installation repositories");
        if (!Array.isArray(value.repositories)) {
          throw new Error("GitHub installation repositories returned an invalid response.");
        }
        entries.push(
          ...value.repositories.map((item) => ({
            installationId: candidate.id,
            repository: repository(item),
          })),
        );
        if (value.repositories.length < GITHUB_PAGE_SIZE) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        throw new Error(
          `GitHub installation ${candidate.id} repositories exceeded the supported pagination limit.`,
        );
      }
    }
    return entries;
  }
}

export class LocalAndWranglerPolicyStore implements RepositoryPolicyStore {
  readonly #configuration: RevoirConfiguration["cloudflare"];
  readonly #now: () => number;
  readonly #policyFile: string;
  readonly #process: SetupProcessRunner;
  readonly #shellCommandMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(input: {
    cloudflare: RevoirConfiguration["cloudflare"];
    now?: () => number;
    policyFile: string;
    process?: SetupProcessRunner;
    shellCommandMs: number;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#configuration = input.cloudflare;
    this.#now = input.now ?? Date.now;
    this.#policyFile = input.policyFile;
    this.#process = input.process ?? new ChildProcessSetupRunner();
    this.#shellCommandMs = input.shellCommandMs;
    this.#sleep =
      input.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  loadLocal(): Promise<RevoirPolicy> {
    return loadPolicy(this.#policyFile);
  }

  writeLocal(policy: RevoirPolicy): Promise<void> {
    return writePolicy(this.#policyFile, policy);
  }

  async ensureAuthenticated(): Promise<void> {
    const options = {
      environment: { CLOUDFLARE_ACCOUNT_ID: this.#configuration.accountId },
    };
    try {
      await this.#process.run("wrangler", ["whoami", "--json"], options);
    } catch {
      await this.#process.run("wrangler", ["login"], { interactive: true });
      await this.#process.run("wrangler", ["whoami", "--json"], options);
    }
  }

  async loadCloud(signal?: AbortSignal): Promise<RevoirPolicy> {
    const result = await this.#process.run(
      "wrangler",
      [
        "kv",
        "key",
        "get",
        `--namespace-id=${this.#configuration.kvNamespaceId}`,
        REVOIR_POLICY_KV_KEY,
        "--remote",
        "--text",
      ],
      {
        environment: { CLOUDFLARE_ACCOUNT_ID: this.#configuration.accountId },
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.#shellCommandMs,
      },
    );
    return parseRevoirPolicy(JSON.parse(result.stdout) as unknown);
  }

  async writeCloud(policy: RevoirPolicy): Promise<void> {
    await this.#process.run(
      "wrangler",
      [
        "kv",
        "key",
        "put",
        `--namespace-id=${this.#configuration.kvNamespaceId}`,
        REVOIR_POLICY_KV_KEY,
        JSON.stringify(parseRevoirPolicy(policy)),
        "--remote",
      ],
      {
        environment: { CLOUDFLARE_ACCOUNT_ID: this.#configuration.accountId },
        timeoutMs: this.#shellCommandMs,
      },
    );
  }

  async verifyCloud(policy: RevoirPolicy): Promise<void> {
    const startedAt = this.#now();
    const activationAt = startedAt + KV_PROPAGATION_WINDOW_MS;
    const deadline = startedAt + KV_ACTIVATION_DEADLINE_MS;
    do {
      try {
        // eslint-disable-next-line no-await-in-loop
        const cloud = await this.loadCloud();
        if (JSON.stringify(cloud) === JSON.stringify(policy) && this.#now() >= activationAt) {
          return;
        }
      } catch {
        // Stale and transient reads are retried; callers remain fail closed meanwhile.
      }
      // eslint-disable-next-line no-await-in-loop
      await this.#sleep(1_000);
    } while (this.#now() < deadline);
    throw new Error("Cloudflare KV policy did not propagate before the activation deadline.");
  }
}

export function createEffectivePolicyLoader(
  policies: Pick<RepositoryPolicyStore, "loadLocal" | "loadCloud">,
): (signal?: AbortSignal) => Promise<RevoirPolicy> {
  return async (signal) => {
    const [local, cloud] = await Promise.all([
      policies.loadLocal(signal),
      policies.loadCloud(signal),
    ]);
    return intersectPolicies(local, cloud);
  };
}
