import { isAbsolute } from "node:path";

export const CONFIG_VERSION = 1 as const;
export const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";
export const DEFAULT_REASONING = "high" as const;
export const DEFAULT_REVIEW_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_SHELL_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface RepositoryIdentity {
  id: number;
  owner: string;
  name: string;
}

export interface RevoirConfiguration {
  version: typeof CONFIG_VERSION;
  model: {
    id: string;
    reasoning: ReasoningLevel;
  };
  github: {
    userId: number;
    appId: number;
    installationId: number;
    privateKey: string;
    repositories: RepositoryIdentity[];
  };
  cloudflare: {
    accountId: string;
    queueId: string;
    apiToken: string;
  };
  timeouts: {
    reviewMs: number;
    shellCommandMs: number;
  };
  paths: {
    cacheDir: string;
    stateDir: string;
    dataDir: string;
  };
}

export interface ConfigurationInput {
  model?: {
    id?: string;
    reasoning?: ReasoningLevel;
  };
  github: RevoirConfiguration["github"];
  cloudflare: RevoirConfiguration["cloudflare"];
  timeouts?: Partial<RevoirConfiguration["timeouts"]>;
  paths: RevoirConfiguration["paths"];
}

export class ConfigurationValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Configuration is invalid:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ConfigurationValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(
  value: Record<string, unknown>,
  path: string,
  expected: readonly string[],
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) {
      issues.push(`${path}.${key} is not supported.`);
    }
  }
}

function readObject(
  value: unknown,
  path: string,
  issues: string[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object.`);
    return undefined;
  }
  return value;
}

function readString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be a non-empty string.`);
    return undefined;
  }
  return value;
}

function readPositiveInteger(value: unknown, path: string, issues: string[]): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    issues.push(`${path} must be a positive integer.`);
    return undefined;
  }
  return value as number;
}

function readAbsolutePath(value: unknown, path: string, issues: string[]): string | undefined {
  const parsed = readString(value, path, issues);
  if (parsed !== undefined && !isAbsolute(parsed)) {
    issues.push(`${path} must be an absolute path.`);
    return undefined;
  }
  return parsed;
}

function parseRepository(
  value: unknown,
  index: number,
  issues: string[],
): RepositoryIdentity | undefined {
  const path = `github.repositories[${index}]`;
  const repository = readObject(value, path, issues);
  if (repository === undefined) {
    return undefined;
  }
  checkKeys(repository, path, ["id", "owner", "name"], issues);
  const id = readPositiveInteger(repository.id, `${path}.id`, issues);
  const owner = readString(repository.owner, `${path}.owner`, issues);
  const name = readString(repository.name, `${path}.name`, issues);
  if (id === undefined || owner === undefined || name === undefined) {
    return undefined;
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner)) {
    issues.push(`${path}.owner is not a valid GitHub owner name.`);
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) {
    issues.push(`${path}.name is not a valid GitHub repository name.`);
  }
  return { id, owner, name };
}

export function validateConfiguration(value: unknown): RevoirConfiguration {
  const issues: string[] = [];
  const root = readObject(value, "configuration", issues);
  if (root === undefined) {
    throw new ConfigurationValidationError(issues);
  }
  checkKeys(
    root,
    "configuration",
    ["version", "model", "github", "cloudflare", "timeouts", "paths"],
    issues,
  );

  if (root.version !== CONFIG_VERSION) {
    issues.push(`version must be ${CONFIG_VERSION}.`);
  }

  const model = readObject(root.model, "model", issues);
  if (model !== undefined) {
    checkKeys(model, "model", ["id", "reasoning"], issues);
  }
  const modelId = model === undefined ? undefined : readString(model.id, "model.id", issues);
  if (modelId !== undefined && !/^openai-codex\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(modelId)) {
    issues.push('model.id must use the "openai-codex/<model>" format.');
  }
  const reasoning = model?.reasoning;
  if (
    typeof reasoning !== "string" ||
    !(REASONING_LEVELS as readonly string[]).includes(reasoning)
  ) {
    issues.push(`model.reasoning must be one of: ${REASONING_LEVELS.join(", ")}.`);
  }

  const github = readObject(root.github, "github", issues);
  if (github !== undefined) {
    checkKeys(
      github,
      "github",
      ["userId", "appId", "installationId", "privateKey", "repositories"],
      issues,
    );
  }
  const userId =
    github === undefined ? undefined : readPositiveInteger(github.userId, "github.userId", issues);
  const appId =
    github === undefined ? undefined : readPositiveInteger(github.appId, "github.appId", issues);
  const installationId =
    github === undefined
      ? undefined
      : readPositiveInteger(github.installationId, "github.installationId", issues);
  const privateKey =
    github === undefined ? undefined : readString(github.privateKey, "github.privateKey", issues);
  if (
    privateKey !== undefined &&
    !/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/u.test(
      privateKey,
    )
  ) {
    issues.push("github.privateKey must be a PEM-encoded private key.");
  }

  const repositoriesValue = github?.repositories;
  const repositories: RepositoryIdentity[] = [];
  if (!Array.isArray(repositoriesValue) || repositoriesValue.length === 0) {
    issues.push("github.repositories must contain at least one repository.");
  } else {
    for (const [index, repository] of repositoriesValue.entries()) {
      const parsed = parseRepository(repository, index, issues);
      if (parsed !== undefined) {
        repositories.push(parsed);
      }
    }
    const ids = new Set<number>();
    const names = new Set<string>();
    for (const repository of repositories) {
      const fullName = `${repository.owner}/${repository.name}`.toLowerCase();
      if (ids.has(repository.id)) {
        issues.push(`github.repositories contains duplicate repository id ${repository.id}.`);
      }
      if (names.has(fullName)) {
        issues.push(`github.repositories contains duplicate repository ${fullName}.`);
      }
      ids.add(repository.id);
      names.add(fullName);
    }
  }

  const cloudflare = readObject(root.cloudflare, "cloudflare", issues);
  if (cloudflare !== undefined) {
    checkKeys(cloudflare, "cloudflare", ["accountId", "queueId", "apiToken"], issues);
  }
  const accountId =
    cloudflare === undefined
      ? undefined
      : readString(cloudflare.accountId, "cloudflare.accountId", issues);
  const queueId =
    cloudflare === undefined
      ? undefined
      : readString(cloudflare.queueId, "cloudflare.queueId", issues);
  const apiToken =
    cloudflare === undefined
      ? undefined
      : readString(cloudflare.apiToken, "cloudflare.apiToken", issues);

  const timeouts = readObject(root.timeouts, "timeouts", issues);
  if (timeouts !== undefined) {
    checkKeys(timeouts, "timeouts", ["reviewMs", "shellCommandMs"], issues);
  }
  const reviewMs =
    timeouts === undefined
      ? undefined
      : readPositiveInteger(timeouts.reviewMs, "timeouts.reviewMs", issues);
  const shellCommandMs =
    timeouts === undefined
      ? undefined
      : readPositiveInteger(timeouts.shellCommandMs, "timeouts.shellCommandMs", issues);

  const paths = readObject(root.paths, "paths", issues);
  if (paths !== undefined) {
    checkKeys(paths, "paths", ["cacheDir", "stateDir", "dataDir"], issues);
  }
  const cacheDir =
    paths === undefined ? undefined : readAbsolutePath(paths.cacheDir, "paths.cacheDir", issues);
  const stateDir =
    paths === undefined ? undefined : readAbsolutePath(paths.stateDir, "paths.stateDir", issues);
  const dataDir =
    paths === undefined ? undefined : readAbsolutePath(paths.dataDir, "paths.dataDir", issues);

  if (
    issues.length > 0 ||
    modelId === undefined ||
    typeof reasoning !== "string" ||
    userId === undefined ||
    appId === undefined ||
    installationId === undefined ||
    privateKey === undefined ||
    accountId === undefined ||
    queueId === undefined ||
    apiToken === undefined ||
    reviewMs === undefined ||
    shellCommandMs === undefined ||
    cacheDir === undefined ||
    stateDir === undefined ||
    dataDir === undefined
  ) {
    throw new ConfigurationValidationError(issues);
  }

  return {
    version: CONFIG_VERSION,
    model: { id: modelId, reasoning: reasoning as ReasoningLevel },
    github: {
      userId,
      appId,
      installationId,
      privateKey,
      repositories,
    },
    cloudflare: { accountId, queueId, apiToken },
    timeouts: { reviewMs, shellCommandMs },
    paths: { cacheDir, stateDir, dataDir },
  };
}

export function createConfiguration(input: ConfigurationInput): RevoirConfiguration {
  return validateConfiguration({
    version: CONFIG_VERSION,
    model: {
      id: input.model?.id ?? DEFAULT_MODEL,
      reasoning: input.model?.reasoning ?? DEFAULT_REASONING,
    },
    github: input.github,
    cloudflare: input.cloudflare,
    timeouts: {
      reviewMs: input.timeouts?.reviewMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      shellCommandMs: input.timeouts?.shellCommandMs ?? DEFAULT_SHELL_COMMAND_TIMEOUT_MS,
    },
    paths: input.paths,
  });
}
