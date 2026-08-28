import {
  parseRevoirPolicy,
  REVOIR_POLICY_CONTRACT_VERSION,
  type RevoirPolicyInstallation,
  type RevoirPolicyRepository,
  type RevoirPolicyV1,
} from "@revoir/contracts";

import { loadProtectedJson, ProtectedFileError, writeProtectedJson } from "./protected-file.js";

export type RevoirPolicy = RevoirPolicyV1;
export type GitHubInstallationPolicy = RevoirPolicyInstallation;
export type RepositoryIdentity = RevoirPolicyRepository;

export class PolicyFileError extends ProtectedFileError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolicyFileError";
  }
}

export class PolicyMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyMutationError";
  }
}

export function createEmptyPolicy(userId: number): RevoirPolicy {
  return parseRevoirPolicy({
    version: REVOIR_POLICY_CONTRACT_VERSION,
    revision: 0,
    userId,
    installations: [],
  });
}

export function configuredRepositories(policy: RevoirPolicy): readonly RepositoryIdentity[] {
  return policy.installations.flatMap((installation) => installation.repositories);
}

export function installationForRepository(
  policy: RevoirPolicy,
  owner: string,
  name: string,
): GitHubInstallationPolicy | undefined {
  const fullName = `${owner}/${name}`.toLowerCase();
  return policy.installations.find((installation) =>
    installation.repositories.some(
      (repository) => `${repository.owner}/${repository.name}`.toLowerCase() === fullName,
    ),
  );
}

export function repositoryInPolicy(
  policy: RevoirPolicy,
  installationId: number,
  repository: RepositoryIdentity,
): boolean {
  const installation = policy.installations.find(({ id }) => id === installationId);
  return (
    installation?.repositories.some(
      (candidate) =>
        candidate.id === repository.id &&
        candidate.owner.toLowerCase() === repository.owner.toLowerCase() &&
        candidate.name.toLowerCase() === repository.name.toLowerCase(),
    ) ?? false
  );
}

export function intersectPolicies(local: RevoirPolicy, cloud: RevoirPolicy): RevoirPolicy {
  if (local.userId !== cloud.userId) {
    return {
      version: REVOIR_POLICY_CONTRACT_VERSION,
      revision: Math.min(local.revision, cloud.revision),
      userId: local.userId,
      installations: [],
    };
  }
  const installations = local.installations.flatMap((localInstallation) => {
    const cloudInstallation = cloud.installations.find(({ id }) => id === localInstallation.id);
    if (cloudInstallation === undefined) return [];
    const repositories = localInstallation.repositories.filter((repository) =>
      repositoryInPolicy(cloud, cloudInstallation.id, repository),
    );
    return [{ id: localInstallation.id, repositories }];
  });
  return parseRevoirPolicy({
    version: REVOIR_POLICY_CONTRACT_VERSION,
    revision: Math.min(local.revision, cloud.revision),
    userId: local.userId,
    installations,
  });
}

export function withRepository(
  policy: RevoirPolicy,
  installationId: number,
  repository: RepositoryIdentity,
): RevoirPolicy {
  const canonicalName = `${repository.owner}/${repository.name}`.toLowerCase();
  const existingById = configuredRepositories(policy).find(({ id }) => id === repository.id);
  const existingByName = configuredRepositories(policy).find(
    ({ owner, name }) => `${owner}/${name}`.toLowerCase() === canonicalName,
  );
  if (
    (existingById !== undefined &&
      `${existingById.owner}/${existingById.name}`.toLowerCase() !== canonicalName) ||
    (existingByName !== undefined && existingByName.id !== repository.id)
  ) {
    throw new PolicyMutationError("Repository identity conflicts with the existing policy.");
  }
  const installationContainingRepository = policy.installations.find((installation) =>
    installation.repositories.some(({ id }) => id === repository.id),
  );
  if (
    installationContainingRepository !== undefined &&
    installationContainingRepository.id !== installationId
  ) {
    throw new PolicyMutationError("Repository is already assigned to another installation.");
  }
  if (repositoryInPolicy(policy, installationId, repository)) return policy;

  const foundInstallation = policy.installations.some(({ id }) => id === installationId);
  return parseRevoirPolicy({
    ...policy,
    revision: policy.revision + 1,
    installations: foundInstallation
      ? policy.installations.map((installation) =>
          installation.id === installationId
            ? { ...installation, repositories: [...installation.repositories, repository] }
            : installation,
        )
      : [...policy.installations, { id: installationId, repositories: [repository] }],
  });
}

export function withoutRepository(policy: RevoirPolicy, repositoryId: number): RevoirPolicy {
  if (!configuredRepositories(policy).some(({ id }) => id === repositoryId)) return policy;
  return parseRevoirPolicy({
    ...policy,
    revision: policy.revision + 1,
    installations: policy.installations.flatMap((installation) => {
      const repositories = installation.repositories.filter(({ id }) => id !== repositoryId);
      return repositories.length === 0 ? [] : [{ ...installation, repositories }];
    }),
  });
}

function translate(error: unknown): never {
  if (error instanceof PolicyFileError) throw error;
  if (error instanceof ProtectedFileError) {
    throw new PolicyFileError(error.message, { cause: error });
  }
  throw error;
}

export async function loadPolicy(path: string): Promise<RevoirPolicy> {
  try {
    return parseRevoirPolicy(await loadProtectedJson(path, "Policy file"));
  } catch (error) {
    translate(error);
  }
}

export async function writePolicy(path: string, policy: RevoirPolicy): Promise<void> {
  const validated = parseRevoirPolicy(policy);
  try {
    await writeProtectedJson(path, "Policy file", validated);
  } catch (error) {
    translate(error);
  }
}
