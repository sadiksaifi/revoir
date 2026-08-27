import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  intersectPolicies,
  installationForRepository,
  withRepository,
  withoutRepository,
  type RepositoryIdentity,
  type RevoirPolicy,
} from "./config/policy.js";
import {
  assertProtectedPath,
  loadProtectedJson,
  writeProtectedJson,
} from "./config/protected-file.js";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPOSITORY = /^[A-Za-z0-9._-]+$/u;

export interface RepositoryReference {
  owner: string;
  name: string;
}

export interface RepositoryDiscovery {
  repository: RepositoryIdentity;
  installation?: {
    id: number;
    hasRepositoryAccess: boolean;
    settingsUrl: string;
  };
  newInstallationUrl: string;
}

export type RepositoryApproval =
  | { status: "approved"; installationId: number; settingsUrl: string }
  | { status: "pending"; installationId?: number; settingsUrl: string };

export interface RepositoryGitHubGateway {
  ensureAuthenticated?(): Promise<void>;
  discover(reference: RepositoryReference): Promise<RepositoryDiscovery>;
  open(url: string): Promise<void>;
  waitForInstallation(reference: RepositoryReference): Promise<RepositoryApproval>;
  waitForRepositoryAccess(
    installationId: number,
    repository: RepositoryIdentity,
    expected: boolean,
  ): Promise<"confirmed" | "pending">;
  listAccessibleRepositories(): Promise<
    readonly { installationId: number; repository: RepositoryIdentity }[]
  >;
}

export interface RepositoryPolicyStore {
  ensureAuthenticated?(): Promise<void>;
  loadLocal(): Promise<RevoirPolicy>;
  writeLocal(policy: RevoirPolicy): Promise<void>;
  loadCloud(): Promise<RevoirPolicy>;
  writeCloud(policy: RevoirPolicy): Promise<void>;
  verifyCloud(policy: RevoirPolicy): Promise<void>;
}

export interface PendingRepositoryOperation {
  version: 1;
  kind: "add" | "remove";
  repository: RepositoryIdentity;
  installationId?: number;
  settingsUrl: string;
  createdAt: string;
}

export interface PendingRepositoryStore {
  load(): Promise<readonly PendingRepositoryOperation[]>;
  upsert(operation: PendingRepositoryOperation): Promise<void>;
  remove(kind: "add" | "remove", repositoryId: number): Promise<void>;
}

export type RepositoryAddResult =
  | { status: "authorized"; repository: RepositoryIdentity; installationId: number }
  | { status: "pending"; repository: RepositoryIdentity; installationId?: number };

export type RepositoryRemoveResult =
  | { status: "removed"; repository: RepositoryIdentity }
  | { status: "github-access-pending"; repository: RepositoryIdentity };

export type RepositoryListStatus =
  | "authorized"
  | "pending"
  | "drifted"
  | "inaccessible"
  | "github-access-only";

export interface RepositoryListEntry {
  repository: RepositoryIdentity;
  installationId?: number;
  status: RepositoryListStatus;
  local: boolean;
  cloud: boolean;
  github: boolean;
}

export class RepositoryPolicyUpdateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryPolicyUpdateError";
  }
}

export function parseRepositoryReference(value: string): RepositoryReference {
  const match = /^([^/]+)\/([^/]+)$/u.exec(value.trim());
  const owner = match?.[1];
  const name = match?.[2];
  if (owner === undefined || name === undefined || !OWNER.test(owner) || !REPOSITORY.test(name)) {
    throw new Error('Repository must use the "OWNER/REPOSITORY" format.');
  }
  return { owner, name };
}

export function parseGitHubRemote(value: string): RepositoryReference {
  const trimmed = value.trim().replace(/\.git$/u, "");
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+)$/u.exec(trimmed);
  if (ssh?.[1] !== undefined && ssh[2] !== undefined) {
    return parseRepositoryReference(`${ssh[1]}/${ssh[2]}`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("The current Git remote is not a canonical GitHub repository URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("The current Git remote is not a canonical GitHub repository URL.");
  }
  return parseRepositoryReference(url.pathname.replace(/^\//u, ""));
}

export async function inferCurrentRepository(cwd: string): Promise<RepositoryReference> {
  const remote = await new Promise<string>((resolve, reject) => {
    execFileCallback(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    );
  }).catch((error: unknown) => {
    throw new Error(
      "Unable to infer a GitHub repository from the current directory. Pass OWNER/REPOSITORY explicitly.",
      { cause: error },
    );
  });
  return parseGitHubRemote(remote);
}

function repositories(policy: RevoirPolicy): readonly {
  installationId: number;
  repository: RepositoryIdentity;
}[] {
  return policy.installations.flatMap((installation) =>
    installation.repositories.map((repository) => ({
      installationId: installation.id,
      repository,
    })),
  );
}

function repositoryMatches(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return (
    left.id === right.id &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function policiesMatch(left: RevoirPolicy, right: RevoirPolicy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pendingKey(operation: Pick<PendingRepositoryOperation, "kind" | "repository">): string {
  return `${operation.kind}:${operation.repository.id}`;
}

export class RepositoryManager {
  readonly #github: RepositoryGitHubGateway;
  readonly #pending: PendingRepositoryStore;
  readonly #policies: RepositoryPolicyStore;
  readonly #now: () => Date;

  constructor(input: {
    github: RepositoryGitHubGateway;
    pending: PendingRepositoryStore;
    policies: RepositoryPolicyStore;
    now?: () => Date;
  }) {
    this.#github = input.github;
    this.#pending = input.pending;
    this.#policies = input.policies;
    this.#now = input.now ?? (() => new Date());
  }

  async #authenticate(): Promise<void> {
    await Promise.all([
      this.#github.ensureAuthenticated?.(),
      this.#policies.ensureAuthenticated?.(),
    ]);
  }

  async add(reference: RepositoryReference): Promise<RepositoryAddResult> {
    await this.#authenticate();
    const discovered = await this.#github.discover(reference);
    let installation = discovered.installation;
    if (installation === undefined) {
      await this.#github.open(discovered.newInstallationUrl);
      const approval = await this.#github.waitForInstallation(reference);
      if (approval.status === "pending" || approval.installationId === undefined) {
        await this.#pending.upsert({
          version: 1,
          kind: "add",
          repository: discovered.repository,
          ...(approval.installationId === undefined
            ? {}
            : { installationId: approval.installationId }),
          settingsUrl: approval.settingsUrl,
          createdAt: this.#now().toISOString(),
        });
        return {
          status: "pending",
          repository: discovered.repository,
          ...(approval.installationId === undefined
            ? {}
            : { installationId: approval.installationId }),
        };
      }
      installation = {
        id: approval.installationId,
        hasRepositoryAccess: true,
        settingsUrl: approval.settingsUrl,
      };
    }

    const [priorLocal, priorCloud] = await Promise.all([
      this.#policies.loadLocal(),
      this.#policies.loadCloud(),
    ]);
    const prior = intersectPolicies(priorLocal, priorCloud);
    if (!policiesMatch(priorLocal, prior)) {
      // Cloud-side revocations may safely narrow local trust before an explicit addition.
      await this.#policies.writeLocal(prior);
    }
    const next = withRepository(prior, installation.id, discovered.repository);
    await this.#policies.writeLocal(next);
    try {
      await this.#policies.writeCloud(next);
      await this.#policies.verifyCloud(next);
    } catch (error) {
      await this.#policies.writeLocal(prior);
      throw new RepositoryPolicyUpdateError(
        `Cloud authorization failed for ${discovered.repository.owner}/${discovered.repository.name}; local authorization was restored to its prior state.`,
        { cause: error },
      );
    }

    if (!installation.hasRepositoryAccess) {
      await this.#github.open(installation.settingsUrl);
      const approval = await this.#github.waitForRepositoryAccess(
        installation.id,
        discovered.repository,
        true,
      );
      if (approval === "pending") {
        await this.#pending.upsert({
          version: 1,
          kind: "add",
          repository: discovered.repository,
          installationId: installation.id,
          settingsUrl: installation.settingsUrl,
          createdAt: this.#now().toISOString(),
        });
        return {
          status: "pending",
          repository: discovered.repository,
          installationId: installation.id,
        };
      }
    }
    await this.#pending.remove("add", discovered.repository.id);
    return {
      status: "authorized",
      repository: discovered.repository,
      installationId: installation.id,
    };
  }

  async remove(
    reference: RepositoryReference,
    options: { keepGitHubAccess?: boolean } = {},
  ): Promise<RepositoryRemoveResult> {
    await this.#authenticate();
    const discovered = await this.#github.discover(reference);
    const [local, cloud] = await Promise.all([
      this.#policies.loadLocal(),
      this.#policies.loadCloud(),
    ]);
    const effective = intersectPolicies(local, cloud);
    if (!policiesMatch(local, effective)) {
      await this.#policies.writeLocal(effective);
    }
    const configured = installationForRepository(
      effective,
      discovered.repository.owner,
      discovered.repository.name,
    );
    const next = withoutRepository(effective, discovered.repository.id);
    // Revocation order is deliberately one-way: a later failure never restores local trust.
    await this.#policies.writeLocal(next);
    try {
      await this.#policies.writeCloud(next);
      await this.#policies.verifyCloud(next);
    } catch (error) {
      throw new RepositoryPolicyUpdateError(
        `Local authorization was revoked for ${discovered.repository.owner}/${discovered.repository.name}, but Cloudflare policy cleanup is still required.`,
        { cause: error },
      );
    }
    await this.#pending.remove("add", discovered.repository.id);
    if (
      options.keepGitHubAccess === true ||
      discovered.installation === undefined ||
      !discovered.installation.hasRepositoryAccess
    ) {
      return { status: "removed", repository: discovered.repository };
    }
    const installationId = configured?.id ?? discovered.installation.id;
    await this.#github.open(discovered.installation.settingsUrl);
    if (
      (await this.#github.waitForRepositoryAccess(installationId, discovered.repository, false)) ===
      "pending"
    ) {
      await this.#pending.upsert({
        version: 1,
        kind: "remove",
        repository: discovered.repository,
        installationId,
        settingsUrl: discovered.installation.settingsUrl,
        createdAt: this.#now().toISOString(),
      });
      return { status: "github-access-pending", repository: discovered.repository };
    }
    await this.#pending.remove("remove", discovered.repository.id);
    return { status: "removed", repository: discovered.repository };
  }

  async list(options: { authenticate?: boolean } = {}): Promise<readonly RepositoryListEntry[]> {
    if (options.authenticate !== false) {
      await this.#authenticate();
    }
    const [local, cloud, github, pending] = await Promise.all([
      this.#policies.loadLocal(),
      this.#policies.loadCloud(),
      this.#github.listAccessibleRepositories(),
      this.#pending.load(),
    ]);
    const entries = new Map<number, { installationId?: number; repository: RepositoryIdentity }>();
    for (const candidate of [...repositories(local), ...repositories(cloud), ...github]) {
      entries.set(candidate.repository.id, candidate);
    }
    for (const operation of pending) {
      if (!entries.has(operation.repository.id)) {
        entries.set(operation.repository.id, {
          repository: operation.repository,
          ...(operation.installationId === undefined
            ? {}
            : { installationId: operation.installationId }),
        });
      }
    }
    const pendingKeys = new Set(pending.map(pendingKey));
    return [...entries.values()]
      .map((entry): RepositoryListEntry => {
        const inLocal = repositories(local).some(({ repository }) =>
          repositoryMatches(repository, entry.repository),
        );
        const inCloud = repositories(cloud).some(({ repository }) =>
          repositoryMatches(repository, entry.repository),
        );
        const inGitHub = github.some(({ repository }) =>
          repositoryMatches(repository, entry.repository),
        );
        let status: RepositoryListStatus;
        if (
          pendingKeys.has(`add:${entry.repository.id}`) ||
          pendingKeys.has(`remove:${entry.repository.id}`)
        ) {
          status = "pending";
        } else if (inLocal && inCloud && inGitHub) {
          status = "authorized";
        } else if (!inLocal && !inCloud && inGitHub) {
          status = "github-access-only";
        } else if (inLocal && inCloud && !inGitHub) {
          status = "inaccessible";
        } else {
          status = "drifted";
        }
        const result = {
          repository: entry.repository,
          status,
          local: inLocal,
          cloud: inCloud,
          github: inGitHub,
        };
        return entry.installationId === undefined
          ? result
          : Object.assign(result, { installationId: entry.installationId });
      })
      .toSorted((left, right) =>
        `${left.repository.owner}/${left.repository.name}`.localeCompare(
          `${right.repository.owner}/${right.repository.name}`,
        ),
      );
  }
}

function parsePending(value: unknown): PendingRepositoryOperation[] {
  if (!Array.isArray(value)) {
    throw new Error("Pending repository operation state must be an array.");
  }
  return value.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`Pending repository operation ${index} is invalid.`);
    }
    const operation = candidate as Record<string, unknown>;
    const repository = operation.repository as RepositoryIdentity;
    if (
      operation.version !== 1 ||
      (operation.kind !== "add" && operation.kind !== "remove") ||
      typeof repository !== "object" ||
      repository === null ||
      !Number.isSafeInteger(repository.id) ||
      typeof repository.owner !== "string" ||
      typeof repository.name !== "string" ||
      typeof operation.settingsUrl !== "string" ||
      !operation.settingsUrl.startsWith("https://github.com/") ||
      typeof operation.createdAt !== "string" ||
      !Number.isFinite(Date.parse(operation.createdAt)) ||
      (operation.installationId !== undefined &&
        (typeof operation.installationId !== "number" ||
          !Number.isSafeInteger(operation.installationId) ||
          operation.installationId <= 0))
    ) {
      throw new Error(`Pending repository operation ${index} is invalid.`);
    }
    return operation as unknown as PendingRepositoryOperation;
  });
}

export class FilePendingRepositoryStore implements PendingRepositoryStore {
  readonly #file: string;

  constructor(stateDirectory: string) {
    this.#file = join(stateDirectory, "pending-repositories.json");
  }

  async load(): Promise<readonly PendingRepositoryOperation[]> {
    assertProtectedPath(this.#file, "Pending repository state");
    try {
      await lstat(this.#file);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
    return parsePending(await loadProtectedJson(this.#file, "Pending repository state"));
  }

  async #write(operations: readonly PendingRepositoryOperation[]): Promise<void> {
    await writeProtectedJson(this.#file, "Pending repository state", operations);
  }

  async upsert(operation: PendingRepositoryOperation): Promise<void> {
    const operations = await this.load();
    const key = pendingKey(operation);
    await this.#write([
      ...operations.filter((candidate) => pendingKey(candidate) !== key),
      operation,
    ]);
  }

  async remove(kind: "add" | "remove", repositoryId: number): Promise<void> {
    const operations = await this.load();
    const next = operations.filter(
      (candidate) => !(candidate.kind === kind && candidate.repository.id === repositoryId),
    );
    if (next.length !== operations.length) {
      await this.#write(next);
    }
  }
}
