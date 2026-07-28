import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { ReviewFailureCategory } from "../review/failure.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const STATE_DIRECTORY = "queue-review-failures";
const STATE_VERSION = 3;
const MAX_OPERATIONAL_FAILURES = 3;

export type OperationalFailureState =
  | { readonly failures: 0 | 1 | 2 }
  | { readonly failures: 3; readonly terminalCategory: ReviewFailureCategory };

export interface OperationalFailureStore {
  load(deliveryId: string, signal?: AbortSignal): Promise<OperationalFailureState>;
  save(deliveryId: string, state: OperationalFailureState, signal?: AbortSignal): Promise<void>;
  clear(deliveryId: string, signal?: AbortSignal): Promise<void>;
}

type PersistedOperationalFailureState = OperationalFailureState & {
  readonly version: typeof STATE_VERSION;
  readonly deliveryId: string;
};

const EMPTY_STATE: OperationalFailureState = { failures: 0 };
const REVIEW_FAILURE_CATEGORIES = new Set<ReviewFailureCategory>([
  "timeout",
  "github",
  "cloudflare",
  "git",
  "pi",
  "model",
  "filesystem",
  "unknown",
]);

function stateFileName(deliveryId: string): string {
  return `${createHash("sha256").update(deliveryId).digest("hex")}.json`;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isValidState(value: OperationalFailureState): boolean {
  if (!Number.isSafeInteger(value.failures) || value.failures < 1 || value.failures > 3) {
    return false;
  }
  if (value.failures < MAX_OPERATIONAL_FAILURES) {
    return Object.keys(value).length === 1;
  }
  return (
    Object.keys(value).length === 2 &&
    "terminalCategory" in value &&
    typeof value.terminalCategory === "string" &&
    REVIEW_FAILURE_CATEGORIES.has(value.terminalCategory as ReviewFailureCategory)
  );
}

function parseState(
  contents: string,
  expectedDeliveryId: string,
): PersistedOperationalFailureState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error("Operational review failure state is not valid JSON.", { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("version" in parsed) ||
    parsed.version !== STATE_VERSION ||
    !("deliveryId" in parsed) ||
    parsed.deliveryId !== expectedDeliveryId ||
    !("failures" in parsed) ||
    !Number.isSafeInteger(parsed.failures) ||
    (parsed.failures as number) < 1 ||
    (parsed.failures as number) > MAX_OPERATIONAL_FAILURES
  ) {
    throw new Error("Operational review failure state is invalid.");
  }
  const failures = parsed.failures as 1 | 2 | 3;
  const state = (
    failures === MAX_OPERATIONAL_FAILURES
      ? {
          failures,
          ...("terminalCategory" in parsed ? { terminalCategory: parsed.terminalCategory } : {}),
        }
      : { failures }
  ) as OperationalFailureState;
  if (
    !isValidState(state) ||
    Object.keys(parsed).length !== (failures === MAX_OPERATIONAL_FAILURES ? 4 : 3)
  ) {
    throw new Error("Operational review failure state is invalid.");
  }
  return parsed as PersistedOperationalFailureState;
}

export class FileOperationalFailureStore implements OperationalFailureStore {
  readonly #directory: string;

  constructor(stateDirectory: string) {
    this.#directory = join(stateDirectory, STATE_DIRECTORY);
  }

  async load(deliveryId: string, signal?: AbortSignal): Promise<OperationalFailureState> {
    signal?.throwIfAborted();
    try {
      const persisted = parseState(
        await readFile(join(this.#directory, stateFileName(deliveryId)), {
          encoding: "utf8",
          signal,
        }),
        deliveryId,
      );
      return persisted.failures === MAX_OPERATIONAL_FAILURES
        ? {
            failures: MAX_OPERATIONAL_FAILURES,
            terminalCategory: persisted.terminalCategory,
          }
        : { failures: persisted.failures };
    } catch (error) {
      if (isMissingFile(error)) {
        return EMPTY_STATE;
      }
      throw error;
    }
  }

  async save(
    deliveryId: string,
    state: OperationalFailureState,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (deliveryId.length === 0 || !isValidState(state)) {
      throw new Error("Operational review failure state is invalid.");
    }
    await this.#ensureDirectory(signal);
    const persisted = {
      version: STATE_VERSION,
      deliveryId,
      ...state,
    } as PersistedOperationalFailureState;
    const temporaryFile = join(
      this.#directory,
      `.${stateFileName(deliveryId)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryFile, "wx", FILE_MODE);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(persisted)}\n`, {
          encoding: "utf8",
          signal,
        });
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      await rename(temporaryFile, join(this.#directory, stateFileName(deliveryId)));
      signal?.throwIfAborted();
    } catch (error) {
      await unlink(temporaryFile).catch(() => {});
      throw error;
    }
  }

  async clear(deliveryId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      await unlink(join(this.#directory, stateFileName(deliveryId)));
      signal?.throwIfAborted();
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }

  async #ensureDirectory(signal?: AbortSignal): Promise<void> {
    const created = await mkdir(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
    signal?.throwIfAborted();
    const stats = await lstat(this.#directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Operational review failure state directory must be a real directory.");
    }
    if (created !== undefined || (stats.mode & 0o777) !== DIRECTORY_MODE) {
      await chmod(this.#directory, DIRECTORY_MODE);
    }
    signal?.throwIfAborted();
  }
}
