import { parseRevoirPolicy, REVOIR_POLICY_KV_KEY } from "@revoir/contracts";

import { loadPolicy, writePolicy, type RevoirPolicy } from "./config/policy.js";
import type { RevoirConfiguration } from "./config/schema.js";
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

interface GitHubInstallationRecord {
  id: number;
  accountLogin: string;
  targetType: string;
}

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

function installation(value: unknown): GitHubInstallationRecord {
  const parsed = record(value, "GitHub installation");
  const account = record(parsed.account, "GitHub installation account");
  if (
    !Number.isSafeInteger(parsed.id) ||
    typeof account.login !== "string" ||
    typeof parsed.target_type !== "string"
  ) {
    throw new Error("GitHub installation response omitted its immutable identity.");
  }
  return {
    id: parsed.id as number,
    accountLogin: account.login,
    targetType: parsed.target_type,
  };
}

function settingsUrl(candidate: GitHubInstallationRecord): string {
  return candidate.targetType.toLowerCase() === "organization"
    ? `https://github.com/organizations/${encodeURIComponent(candidate.accountLogin)}/settings/installations/${candidate.id}`
    : `https://github.com/settings/installations/${candidate.id}`;
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

  async #appInstallations(): Promise<GitHubInstallationRecord[]> {
    const jwt = createGitHubAppJwt(this.#configuration.appId, this.#configuration.privateKey);
    const response = await this.#fetch("https://api.github.com/app/installations?per_page=100", {
      headers: appHeaders(jwt),
    });
    const value = await responseJson(response, "GitHub App installation discovery");
    if (!Array.isArray(value)) {
      throw new Error("GitHub App installation discovery returned an invalid response.");
    }
    return value.map(installation);
  }

  async #installationToken(installationId: number): Promise<string> {
    const jwt = createGitHubAppJwt(this.#configuration.appId, this.#configuration.privateKey);
    const response = await this.#fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      { method: "POST", headers: appHeaders(jwt) },
    );
    const value = record(
      await responseJson(response, "GitHub installation authentication"),
      "GitHub installation authentication",
    );
    if (typeof value.token !== "string" || value.token === "") {
      throw new Error("GitHub installation authentication omitted its token.");
    }
    return value.token;
  }

  async #hasAccess(installationId: number, repositoryId: number): Promise<boolean> {
    const token = await this.#installationToken(installationId);
    const response = await this.#fetch(`https://api.github.com/repositories/${repositoryId}`, {
      headers: appHeaders(token),
    });
    if (response.status === 404 || response.status === 403) return false;
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
    return {
      repository: resolvedRepository,
      ...(candidate === undefined
        ? {}
        : {
            installation: {
              id: candidate.id,
              hasRepositoryAccess: await this.#hasAccess(candidate.id, resolvedRepository.id),
              settingsUrl: settingsUrl(candidate),
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
    let discoveredInstallation: GitHubInstallationRecord | undefined;
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
        (await this.#hasAccess(candidate.id, resolvedRepository.id))
      ) {
        return {
          status: "approved",
          installationId: candidate.id,
          settingsUrl: settingsUrl(candidate),
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
          : settingsUrl(discoveredInstallation),
    };
  }

  async waitForRepositoryAccess(
    installationId: number,
    candidate: { id: number },
    expected: boolean,
  ): Promise<"confirmed" | "pending"> {
    for (let attempt = 0; attempt < this.#pollAttempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      if ((await this.#hasAccess(installationId, candidate.id)) === expected) return "confirmed";
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
      // eslint-disable-next-line no-await-in-loop
      const response = await this.#fetch(
        "https://api.github.com/installation/repositories?per_page=100",
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
    }
    return entries;
  }
}

export class LocalAndWranglerPolicyStore implements RepositoryPolicyStore {
  readonly #configuration: RevoirConfiguration["cloudflare"];
  readonly #policyFile: string;
  readonly #process: SetupProcessRunner;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(input: {
    cloudflare: RevoirConfiguration["cloudflare"];
    policyFile: string;
    process?: SetupProcessRunner;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#configuration = input.cloudflare;
    this.#policyFile = input.policyFile;
    this.#process = input.process ?? new ChildProcessSetupRunner();
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
    try {
      await this.#process.run("wrangler", ["whoami"]);
    } catch {
      await this.#process.run("wrangler", ["login"], { interactive: true });
    }
  }

  async loadCloud(): Promise<RevoirPolicy> {
    const result = await this.#process.run("wrangler", [
      "kv",
      "key",
      "get",
      `--namespace-id=${this.#configuration.kvNamespaceId}`,
      REVOIR_POLICY_KV_KEY,
      "--remote",
      "--text",
    ]);
    return parseRevoirPolicy(JSON.parse(result.stdout) as unknown);
  }

  async writeCloud(policy: RevoirPolicy): Promise<void> {
    await this.#process.run("wrangler", [
      "kv",
      "key",
      "put",
      `--namespace-id=${this.#configuration.kvNamespaceId}`,
      REVOIR_POLICY_KV_KEY,
      JSON.stringify(parseRevoirPolicy(policy)),
      "--remote",
    ]);
  }

  async verifyCloud(policy: RevoirPolicy): Promise<void> {
    const deadline = Date.now() + 65_000;
    do {
      try {
        // eslint-disable-next-line no-await-in-loop
        const cloud = await this.loadCloud();
        if (JSON.stringify(cloud) === JSON.stringify(policy)) return;
      } catch {
        // Stale and transient reads are retried; callers remain fail closed meanwhile.
      }
      // eslint-disable-next-line no-await-in-loop
      await this.#sleep(1_000);
    } while (Date.now() < deadline);
    throw new Error("Cloudflare KV policy did not propagate before the activation deadline.");
  }
}
