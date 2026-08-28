import { lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assertPrivateDirectory,
  assertProtectedPath,
  loadProtectedJson,
  ProtectedFileError,
  writeProtectedJson,
} from "./protected-file.js";

export const SETUP_CHECKPOINT_VERSION = 1 as const;
export const SETUP_STAGES = [
  "prerequisites",
  "cloudflare-resources",
  "relay-deployed",
  "github-app",
  "queue-token",
  "local-state",
  "service-installed",
  "diagnostics",
] as const;
export type SetupStage = (typeof SETUP_STAGES)[number];

export interface SetupCheckpoint {
  version: typeof SETUP_CHECKPOINT_VERSION;
  completedStages: SetupStage[];
  resources: {
    setupId?: string;
    identity?: { userId: number; login: string };
    cloudflareAccountId?: string;
    cloudflare?: {
      accountId: string;
      kvNamespaceId?: string;
      queueId?: string;
      queueName: string;
      workerName: string;
      relayUrl?: string;
    };
    github?: { appId: number; appSlug: string };
  };
  secrets: {
    githubManifestCode?: string;
    githubWebhookSecret?: string;
    githubPrivateKey?: string;
    cloudflareQueueApiToken?: string;
  };
}

export class SetupCheckpointError extends ProtectedFileError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SetupCheckpointError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isIdentity(
  value: unknown,
): value is NonNullable<SetupCheckpoint["resources"]["identity"]> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["userId", "login"]) &&
    isPositiveInteger(value.userId) &&
    isNonEmptyString(value.login)
  );
}

function isCloudflareResources(
  value: unknown,
): value is NonNullable<SetupCheckpoint["resources"]["cloudflare"]> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "accountId",
      "kvNamespaceId",
      "queueId",
      "queueName",
      "workerName",
      "relayUrl",
    ]) &&
    isNonEmptyString(value.accountId) &&
    optionalString(value.kvNamespaceId) &&
    optionalString(value.queueId) &&
    isNonEmptyString(value.queueName) &&
    isNonEmptyString(value.workerName) &&
    optionalString(value.relayUrl)
  );
}

function isGitHubResources(
  value: unknown,
): value is NonNullable<SetupCheckpoint["resources"]["github"]> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["appId", "appSlug"]) &&
    isPositiveInteger(value.appId) &&
    isNonEmptyString(value.appSlug)
  );
}

export function createSetupCheckpoint(): SetupCheckpoint {
  return { version: SETUP_CHECKPOINT_VERSION, completedStages: [], resources: {}, secrets: {} };
}

export function validateSetupCheckpoint(value: unknown): SetupCheckpoint {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "completedStages", "resources", "secrets"])
  ) {
    throw new SetupCheckpointError("Setup checkpoint has an invalid top-level shape.");
  }
  if (value.version !== SETUP_CHECKPOINT_VERSION) {
    throw new SetupCheckpointError(`Setup checkpoint version must be ${SETUP_CHECKPOINT_VERSION}.`);
  }
  if (
    !Array.isArray(value.completedStages) ||
    !value.completedStages.every(
      (stage): stage is SetupStage =>
        typeof stage === "string" && (SETUP_STAGES as readonly string[]).includes(stage),
    ) ||
    new Set(value.completedStages).size !== value.completedStages.length
  ) {
    throw new SetupCheckpointError("Setup checkpoint completedStages is invalid.");
  }
  const lastCompletedIndex = value.completedStages.reduce(
    (last, stage) => Math.max(last, SETUP_STAGES.indexOf(stage)),
    -1,
  );
  if (
    value.completedStages.some((stage, index) => SETUP_STAGES.indexOf(stage) !== index) ||
    lastCompletedIndex !== value.completedStages.length - 1
  ) {
    throw new SetupCheckpointError("Setup checkpoint stages must be a contiguous ordered prefix.");
  }

  if (
    !isRecord(value.resources) ||
    !hasOnlyKeys(value.resources, [
      "setupId",
      "identity",
      "cloudflareAccountId",
      "cloudflare",
      "github",
    ]) ||
    !optionalString(value.resources.setupId) ||
    (value.resources.identity !== undefined && !isIdentity(value.resources.identity)) ||
    !optionalString(value.resources.cloudflareAccountId) ||
    (value.resources.cloudflare !== undefined &&
      !isCloudflareResources(value.resources.cloudflare)) ||
    (value.resources.github !== undefined && !isGitHubResources(value.resources.github))
  ) {
    throw new SetupCheckpointError("Setup checkpoint resources are invalid.");
  }
  if (
    !isRecord(value.secrets) ||
    !hasOnlyKeys(value.secrets, [
      "githubManifestCode",
      "githubWebhookSecret",
      "githubPrivateKey",
      "cloudflareQueueApiToken",
    ]) ||
    !optionalString(value.secrets.githubManifestCode) ||
    !optionalString(value.secrets.githubWebhookSecret) ||
    !optionalString(value.secrets.githubPrivateKey) ||
    !optionalString(value.secrets.cloudflareQueueApiToken)
  ) {
    throw new SetupCheckpointError("Setup checkpoint secrets are invalid.");
  }

  return value as unknown as SetupCheckpoint;
}

function translate(error: unknown): never {
  if (error instanceof SetupCheckpointError) throw error;
  if (error instanceof ProtectedFileError) {
    throw new SetupCheckpointError(error.message, { cause: error });
  }
  throw error;
}

export async function loadSetupCheckpoint(path: string): Promise<SetupCheckpoint | undefined> {
  assertProtectedPath(path, "Setup checkpoint");
  try {
    await lstat(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  try {
    return validateSetupCheckpoint(await loadProtectedJson(path, "Setup checkpoint"));
  } catch (error) {
    translate(error);
  }
}

export async function writeSetupCheckpoint(
  path: string,
  checkpoint: SetupCheckpoint,
): Promise<void> {
  const validated = validateSetupCheckpoint(checkpoint);
  try {
    await writeProtectedJson(path, "Setup checkpoint", validated);
  } catch (error) {
    translate(error);
  }
}

export async function removeSetupCheckpoint(path: string): Promise<void> {
  const existing = await loadSetupCheckpoint(path);
  if (existing === undefined) return;
  try {
    await assertPrivateDirectory(dirname(path), "Setup checkpoint directory");
    await unlink(path);
  } catch (error) {
    translate(error);
  }
}
