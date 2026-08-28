export const REVOIR_POLICY_CONTRACT_VERSION = 1 as const;
export const REVOIR_POLICY_KV_KEY = "policy" as const;

export interface RevoirPolicyRepository {
  id: number;
  owner: string;
  name: string;
}

export interface RevoirPolicyInstallation {
  id: number;
  repositories: RevoirPolicyRepository[];
}

export interface RevoirPolicyV1 {
  version: typeof REVOIR_POLICY_CONTRACT_VERSION;
  revision: number;
  userId: number;
  installations: RevoirPolicyInstallation[];
}

export class PolicySchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolicySchemaError";
  }
}

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]+$/u;
const TOP_LEVEL_FIELDS = ["version", "revision", "userId", "installations"] as const;
const INSTALLATION_FIELDS = ["id", "repositories"] as const;
const REPOSITORY_FIELDS = ["id", "owner", "name"] as const;

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolicySchemaError(`${path} must be an object.`);
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
    throw new PolicySchemaError(`${path} must contain exactly the expected fields.`);
  }
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new PolicySchemaError(`${path} must be a positive integer.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PolicySchemaError(`${path} must be a non-negative integer.`);
  }
  return value as number;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PolicySchemaError(`${path} must be a non-empty string.`);
  }
  return value;
}

function candidate(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new PolicySchemaError("Revoir policy must be valid JSON.", { cause: error });
  }
}

function parseRepository(value: unknown, path: string): RevoirPolicyRepository {
  const repository = record(value, path);
  checkKeys(repository, path, REPOSITORY_FIELDS);
  const owner = string(repository.owner, `${path}.owner`);
  const name = string(repository.name, `${path}.name`);
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPOSITORY.test(name)) {
    throw new PolicySchemaError(`${path} contains a malformed GitHub repository identity.`);
  }
  return {
    id: positiveInteger(repository.id, `${path}.id`),
    owner,
    name,
  };
}

export function parseRevoirPolicy(value: unknown): RevoirPolicyV1 {
  const policy = record(candidate(value), "Revoir policy");
  checkKeys(policy, "Revoir policy", TOP_LEVEL_FIELDS);
  if (policy.version !== REVOIR_POLICY_CONTRACT_VERSION) {
    throw new PolicySchemaError(`Revoir policy.version must be ${REVOIR_POLICY_CONTRACT_VERSION}.`);
  }
  if (!Array.isArray(policy.installations)) {
    throw new PolicySchemaError("Revoir policy.installations must be an array.");
  }

  const installationIds = new Set<number>();
  const repositoryIds = new Set<number>();
  const repositoryNames = new Set<string>();
  const installations = policy.installations.map((installationValue, installationIndex) => {
    const path = `Revoir policy.installations[${installationIndex}]`;
    const installation = record(installationValue, path);
    checkKeys(installation, path, INSTALLATION_FIELDS);
    const id = positiveInteger(installation.id, `${path}.id`);
    if (installationIds.has(id)) {
      throw new PolicySchemaError("Revoir policy contains a duplicate installation ID.");
    }
    installationIds.add(id);
    if (!Array.isArray(installation.repositories)) {
      throw new PolicySchemaError(`${path}.repositories must be an array.`);
    }
    const repositories = installation.repositories.map((repositoryValue, repositoryIndex) => {
      const repository = parseRepository(
        repositoryValue,
        `${path}.repositories[${repositoryIndex}]`,
      );
      const fullName = `${repository.owner}/${repository.name}`.toLowerCase();
      if (repositoryIds.has(repository.id)) {
        throw new PolicySchemaError("Revoir policy contains a duplicate repository ID.");
      }
      if (repositoryNames.has(fullName)) {
        throw new PolicySchemaError("Revoir policy contains a duplicate repository full name.");
      }
      repositoryIds.add(repository.id);
      repositoryNames.add(fullName);
      return repository;
    });
    return { id, repositories };
  });

  return {
    version: REVOIR_POLICY_CONTRACT_VERSION,
    revision: nonNegativeInteger(policy.revision, "Revoir policy.revision"),
    userId: positiveInteger(policy.userId, "Revoir policy.userId"),
    installations,
  };
}
