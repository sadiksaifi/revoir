import { readFile } from "node:fs/promises";

import type { ApplicationPaths } from "./config/paths.js";
import {
  createConfiguration,
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  DEFAULT_REVIEW_TIMEOUT_MS,
  DEFAULT_SHELL_COMMAND_TIMEOUT_MS,
  type ReasoningLevel,
  REASONING_LEVELS,
  type RevoirConfiguration,
  type RepositoryIdentity,
} from "./config/schema.js";

export type PromptFunction = (message: string) => Promise<string>;

export interface SetupOptions {
  nonInteractive: boolean;
  model?: string;
  reasoning?: string;
  githubUserId?: string;
  githubAppId?: string;
  githubInstallationId?: string;
  githubPrivateKeyFile?: string;
  repositories: string[];
  cloudflareAccountId?: string;
  cloudflareQueueId?: string;
  cloudflareApiTokenFile?: string;
  reviewTimeoutMs?: string;
  shellCommandTimeoutMs?: string;
}

type TextFileReader = (path: string, encoding: "utf8") => Promise<string>;

function takeValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function parseSetupOptions(arguments_: readonly string[]): SetupOptions {
  const options: SetupOptions = { nonInteractive: false, repositories: [] };
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === "--non-interactive") {
      options.nonInteractive = true;
      continue;
    }
    const value = takeValue(arguments_, index, option ?? "option");
    index += 1;
    switch (option) {
      case "--model":
        options.model = value;
        break;
      case "--reasoning":
        options.reasoning = value;
        break;
      case "--github-user-id":
        options.githubUserId = value;
        break;
      case "--github-app-id":
        options.githubAppId = value;
        break;
      case "--github-installation-id":
        options.githubInstallationId = value;
        break;
      case "--github-private-key-file":
        options.githubPrivateKeyFile = value;
        break;
      case "--repository":
        options.repositories.push(value);
        break;
      case "--cloudflare-account-id":
        options.cloudflareAccountId = value;
        break;
      case "--cloudflare-queue-id":
        options.cloudflareQueueId = value;
        break;
      case "--cloudflare-api-token-file":
        options.cloudflareApiTokenFile = value;
        break;
      case "--review-timeout-ms":
        options.reviewTimeoutMs = value;
        break;
      case "--shell-command-timeout-ms":
        options.shellCommandTimeoutMs = value;
        break;
      default:
        throw new Error(`Unknown setup option "${option}".`);
    }
  }
  return options;
}

async function valueOrPrompt(
  value: string | undefined,
  name: string,
  prompt: PromptFunction | undefined,
  fallback?: string,
): Promise<string> {
  if (value !== undefined) {
    return value;
  }
  if (fallback !== undefined && prompt === undefined) {
    return fallback;
  }
  if (prompt === undefined) {
    throw new Error(`Missing required setup option ${name}.`);
  }
  const answer = await prompt(fallback === undefined ? `${name}: ` : `${name} [${fallback}]: `);
  return answer.trim() === "" && fallback !== undefined ? fallback : answer.trim();
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe positive integer.`);
  }
  return parsed;
}

export function parseRepository(value: string): RepositoryIdentity {
  const match = /^(?<id>[1-9]\d*):(?<owner>[^/]+)\/(?<name>[^/]+)$/u.exec(value.trim());
  if (match?.groups === undefined) {
    throw new Error(`Repository "${value}" must use the "<numeric-id>:<owner>/<name>" format.`);
  }
  return {
    id: parsePositiveInteger(match.groups.id ?? "", "repository id"),
    owner: match.groups.owner ?? "",
    name: match.groups.name ?? "",
  };
}

async function readCredentialFile(
  file: string,
  label: string,
  readTextFile: TextFileReader,
): Promise<string> {
  let value: string;
  try {
    value = await readTextFile(file, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label} file "${file}".`, { cause: error });
  }
  if (value.trim() === "") {
    throw new Error(`${label} file "${file}" is empty.`);
  }
  return value;
}

export async function collectSetupConfiguration(
  options: SetupOptions,
  paths: ApplicationPaths,
  prompt?: PromptFunction,
  readTextFile: TextFileReader = readFile,
): Promise<RevoirConfiguration> {
  const effectivePrompt = options.nonInteractive ? undefined : prompt;
  const model = await valueOrPrompt(options.model, "Codex model", effectivePrompt, DEFAULT_MODEL);
  const reasoning = await valueOrPrompt(
    options.reasoning,
    "Reasoning level",
    effectivePrompt,
    DEFAULT_REASONING,
  );
  if (!(REASONING_LEVELS as readonly string[]).includes(reasoning)) {
    throw new Error(`Reasoning level must be one of: ${REASONING_LEVELS.join(", ")}.`);
  }
  const userId = parsePositiveInteger(
    await valueOrPrompt(options.githubUserId, "GitHub immutable user id", effectivePrompt),
    "GitHub immutable user id",
  );
  const appId = parsePositiveInteger(
    await valueOrPrompt(options.githubAppId, "GitHub App id", effectivePrompt),
    "GitHub App id",
  );
  const installationId = parsePositiveInteger(
    await valueOrPrompt(
      options.githubInstallationId,
      "GitHub App installation id",
      effectivePrompt,
    ),
    "GitHub App installation id",
  );
  const privateKeyFile = await valueOrPrompt(
    options.githubPrivateKeyFile,
    "GitHub private key file",
    effectivePrompt,
  );

  let repositoryValues = options.repositories;
  if (repositoryValues.length === 0) {
    const answer = await valueOrPrompt(
      undefined,
      "Allowed repositories (<id>:<owner>/<name>, comma separated)",
      effectivePrompt,
    );
    repositoryValues = answer
      .split(",")
      .map((repository) => repository.trim())
      .filter((repository) => repository !== "");
  }

  const accountId = await valueOrPrompt(
    options.cloudflareAccountId,
    "Cloudflare account id",
    effectivePrompt,
  );
  const queueId = await valueOrPrompt(
    options.cloudflareQueueId,
    "Cloudflare Queue id",
    effectivePrompt,
  );
  const apiTokenFile = await valueOrPrompt(
    options.cloudflareApiTokenFile,
    "Cloudflare API token file",
    effectivePrompt,
  );
  const reviewTimeoutMs = parsePositiveInteger(
    await valueOrPrompt(
      options.reviewTimeoutMs,
      "Review timeout in milliseconds",
      effectivePrompt,
      String(DEFAULT_REVIEW_TIMEOUT_MS),
    ),
    "Review timeout",
  );
  const shellCommandMs = parsePositiveInteger(
    await valueOrPrompt(
      options.shellCommandTimeoutMs,
      "Shell command timeout in milliseconds",
      effectivePrompt,
      String(DEFAULT_SHELL_COMMAND_TIMEOUT_MS),
    ),
    "Shell command timeout",
  );

  const [privateKey, apiToken] = await Promise.all([
    readCredentialFile(privateKeyFile, "GitHub private key", readTextFile),
    readCredentialFile(apiTokenFile, "Cloudflare API token", readTextFile),
  ]);

  return createConfiguration({
    model: { id: model, reasoning: reasoning as ReasoningLevel },
    github: {
      userId,
      appId,
      installationId,
      privateKey,
      repositories: repositoryValues.map(parseRepository),
    },
    cloudflare: {
      accountId,
      queueId,
      apiToken: apiToken.trim(),
    },
    timeouts: { reviewMs: reviewTimeoutMs, shellCommandMs },
    paths: {
      cacheDir: paths.cacheDir,
      stateDir: paths.stateDir,
      dataDir: paths.dataDir,
    },
  });
}
