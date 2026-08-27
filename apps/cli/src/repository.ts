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
  ): Promise<"confirmed" | "pending" | "installation-absent">;
  listAccessibleRepositories(): Promise<
    readonly { installationId: number; repository: RepositoryIdentity }[]
  >;
}

export interface RepositoryPolicyStore {
  ensureAuthenticated?(): Promise<void>;
  loadLocal(signal?: AbortSignal): Promise<RevoirPolicy>;
  writeLocal(policy: RevoirPolicy): Promise<void>;
  loadCloud(signal?: AbortSignal): Promise<RevoirPolicy>;
  writeCloud(policy: RevoirPolicy): Promise<void>;
  verifyCloud(policy: RevoirPolicy): Promise<void>;
}

export interface PendingRepositoryOperation {
  version: 1;
  kind: "add" | "remove";
  repository: RepositoryIdentity;
  installationId?: number;
  settingsUrl?: string;
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

export class RepositoryGitHubAccessPendingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryGitHubAccessPendingError";
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

function configuredRepository(
  policy: RevoirPolicy,
  reference: RepositoryReference,
): { installationId: number; repository: RepositoryIdentity } | undefined {
  const installation = installationForRepository(policy, reference.owner, reference.name);
  const repository = installation?.repositories.find(
    (candidate) =>
      candidate.owner.toLowerCase() === reference.owner.toLowerCase() &&
      candidate.name.toLowerCase() === reference.name.toLowerCase(),
  );
  return installation === undefined || repository === undefined
    ? undefined
    : { installationId: installation.id, repository };
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
    const pendingRemoval = (await this.#pending.load()).find(
      (operation) =>
        operation.kind === "remove" && operation.repository.id === discovered.repository.id,
    );
    if (pendingRemoval !== undefined) {
      const [local, cloud] = await Promise.all([
        this.#policies.loadLocal(),
        this.#policies.loadCloud(),
      ]);
      const revoked = withoutRepository(intersectPolicies(local, cloud), discovered.repository.id);
      if (!policiesMatch(local, revoked)) {
        await this.#policies.writeLocal(revoked);
      }
      if (!policiesMatch(cloud, revoked)) {
        try {
          await this.#policies.writeCloud(revoked);
          await this.#policies.verifyCloud(revoked);
        } catch (error) {
          throw new RepositoryPolicyUpdateError(
            `The earlier GitHub removal for ${discovered.repository.owner}/${discovered.repository.name} is still pending. Local authorization is revoked, but Cloudflare policy cleanup must finish before access can be re-added.`,
            { cause: error },
          );
        }
      }
      const installationId = pendingRemoval.installationId ?? installation?.id;
      const settingsUrl = pendingRemoval.settingsUrl ?? installation?.settingsUrl;
      if (
        pendingRemoval.installationId !== undefined &&
        installation?.id !== pendingRemoval.installationId
      ) {
        await this.#pending.remove("remove", discovered.repository.id);
      } else {
        if (installationId === undefined || settingsUrl === undefined) {
          return { status: "pending", repository: discovered.repository };
        }
        let removal: "confirmed" | "pending" | "installation-absent";
        try {
          await this.#github.open(settingsUrl);
          removal = await this.#github.waitForRepositoryAccess(
            installationId,
            discovered.repository,
            false,
          );
        } catch (error) {
          throw new RepositoryGitHubAccessPendingError(
            `The earlier GitHub removal for ${discovered.repository.owner}/${discovered.repository.name} is still pending. Revoir kept authorization revoked; rerun the same command to finish removal before re-adding access.`,
            { cause: error },
          );
        }
        if (removal === "pending") {
          return {
            status: "pending",
            repository: discovered.repository,
            installationId,
          };
        }
        await this.#pending.remove("remove", discovered.repository.id);
        if (removal === "installation-absent") {
          installation = undefined;
        } else if (installation?.id === installationId) {
          installation = { ...installation, hasRepositoryAccess: false };
        }
      }
    }
    if (installation === undefined) {
      const pendingOperation: PendingRepositoryOperation = {
        version: 1,
        kind: "add",
        repository: discovered.repository,
        settingsUrl: discovered.newInstallationUrl,
        createdAt: this.#now().toISOString(),
      };
      await this.#pending.upsert(pendingOperation);
      let approval: RepositoryApproval;
      try {
        await this.#github.open(discovered.newInstallationUrl);
        approval = await this.#github.waitForInstallation(reference);
      } catch (error) {
        throw new RepositoryGitHubAccessPendingError(
          `No Revoir authorization was added for ${discovered.repository.owner}/${discovered.repository.name}; GitHub installation approval remains pending and was saved. Rerun the same command to resume.`,
          { cause: error },
        );
      }
      if (approval.status === "pending" || approval.installationId === undefined) {
        await this.#pending.upsert({
          ...pendingOperation,
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
      const pendingOperation: PendingRepositoryOperation = {
        version: 1,
        kind: "add",
        repository: discovered.repository,
        installationId: installation.id,
        settingsUrl: installation.settingsUrl,
        createdAt: this.#now().toISOString(),
      };
      await this.#pending.upsert(pendingOperation);
      let approval: "confirmed" | "pending" | "installation-absent";
      try {
        await this.#github.open(installation.settingsUrl);
        approval = await this.#github.waitForRepositoryAccess(
          installation.id,
          discovered.repository,
          true,
        );
      } catch (error) {
        throw new RepositoryGitHubAccessPendingError(
          `Local and cloud policy are synchronized for ${discovered.repository.owner}/${discovered.repository.name}, but GitHub App access remains pending and was saved. Revoir will not review the repository until GitHub grants access; rerun the same command to resume.`,
          { cause: error },
        );
      }
      if (approval !== "confirmed") {
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
    const [local, pendingOperations] = await Promise.all([
      this.#policies.loadLocal(),
      this.#pending.load(),
    ]);
    const localEntry = configuredRepository(local, reference);
    const priorPending = pendingOperations.find(
      (operation) =>
        operation.kind === "remove" &&
        operation.repository.owner.toLowerCase() === reference.owner.toLowerCase() &&
        operation.repository.name.toLowerCase() === reference.name.toLowerCase(),
    );
    const priorPendingAdd = pendingOperations.find(
      (operation) =>
        operation.kind === "add" &&
        operation.repository.owner.toLowerCase() === reference.owner.toLowerCase() &&
        operation.repository.name.toLowerCase() === reference.name.toLowerCase(),
    );
    let repository =
      localEntry?.repository ?? priorPending?.repository ?? priorPendingAdd?.repository;
    let installationId =
      localEntry?.installationId ?? priorPending?.installationId ?? priorPendingAdd?.installationId;
    const createdAt = priorPending?.createdAt ?? this.#now().toISOString();
    const savePendingRemoval = async (): Promise<void> => {
      if (repository === undefined) return;
      await this.#pending.upsert({
        version: 1,
        kind: "remove",
        repository,
        ...(installationId === undefined ? {} : { installationId }),
        ...(priorPending?.settingsUrl === undefined
          ? {}
          : { settingsUrl: priorPending.settingsUrl }),
        createdAt,
      });
    };
    // Persist the execution-gate revocation before any remote authentication or discovery.
    let locallyRevoked = repository === undefined ? local : withoutRepository(local, repository.id);
    if (!policiesMatch(local, locallyRevoked)) {
      await this.#policies.writeLocal(locallyRevoked);
    }
    await savePendingRemoval();

    await this.#policies.ensureAuthenticated?.();
    const cloud = await this.#policies.loadCloud();
    const cloudEntry = configuredRepository(cloud, reference);
    repository ??= cloudEntry?.repository;
    installationId ??= cloudEntry?.installationId;
    await savePendingRemoval();
    const effective = intersectPolicies(locallyRevoked, cloud);
    if (!policiesMatch(locallyRevoked, effective)) {
      await this.#policies.writeLocal(effective);
      locallyRevoked = effective;
    }
    const next = repository === undefined ? effective : withoutRepository(effective, repository.id);
    try {
      await this.#policies.writeCloud(next);
      await this.#policies.verifyCloud(next);
    } catch (error) {
      const label = `${repository?.owner ?? reference.owner}/${repository?.name ?? reference.name}`;
      throw new RepositoryPolicyUpdateError(
        `Local authorization was revoked for ${label}, but Cloudflare policy cleanup is still required.`,
        { cause: error },
      );
    }
    if (repository !== undefined) {
      await this.#pending.remove("add", repository.id);
    }
    if (options.keepGitHubAccess === true && repository !== undefined) {
      await this.#pending.remove("remove", repository.id);
      return { status: "removed", repository };
    }

    let discovered: RepositoryDiscovery;
    try {
      await this.#github.ensureAuthenticated?.();
      discovered = await this.#github.discover(reference);
    } catch (error) {
      if (repository === undefined) throw error;
      throw new RepositoryGitHubAccessPendingError(
        `Revoir authorization is revoked for ${repository.owner}/${repository.name}, but GitHub App access cleanup remains pending and was saved. Rerun the same command to resume.`,
        { cause: error },
      );
    }
    if (repository !== undefined && !repositoryMatches(repository, discovered.repository)) {
      throw new RepositoryPolicyUpdateError(
        `GitHub now resolves ${reference.owner}/${reference.name} to a different immutable repository id; Revoir authorization remains revoked.`,
      );
    }
    repository = discovered.repository;
    installationId ??= discovered.installation?.id;
    if (options.keepGitHubAccess === true) {
      await this.#pending.remove("add", discovered.repository.id);
      await this.#pending.remove("remove", discovered.repository.id);
      return { status: "removed", repository: discovered.repository };
    }
    if (discovered.installation === undefined || !discovered.installation.hasRepositoryAccess) {
      await this.#pending.remove("remove", discovered.repository.id);
      return { status: "removed", repository: discovered.repository };
    }
    installationId ??= discovered.installation.id;
    const pendingOperation: PendingRepositoryOperation = {
      version: 1,
      kind: "remove",
      repository: discovered.repository,
      installationId,
      settingsUrl: discovered.installation.settingsUrl,
      createdAt: this.#now().toISOString(),
    };
    await this.#pending.upsert(pendingOperation);
    let approval: "confirmed" | "pending" | "installation-absent";
    try {
      await this.#github.open(discovered.installation.settingsUrl);
      approval = await this.#github.waitForRepositoryAccess(
        installationId,
        discovered.repository,
        false,
      );
    } catch (error) {
      throw new RepositoryGitHubAccessPendingError(
        `Revoir authorization is revoked for ${discovered.repository.owner}/${discovered.repository.name}, but GitHub App access remains and its cleanup was saved. Rerun the same command to resume.`,
        { cause: error },
      );
    }
    if (approval === "pending") {
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
      (operation.kind === "add" && typeof operation.settingsUrl !== "string") ||
      (operation.settingsUrl !== undefined &&
        (typeof operation.settingsUrl !== "string" ||
          !operation.settingsUrl.startsWith("https://github.com/"))) ||
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
    await this.#write([
      ...operations.filter((candidate) => {
        if (candidate.repository.id !== operation.repository.id) return true;
        return operation.kind === "add" && candidate.kind === "remove";
      }),
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
