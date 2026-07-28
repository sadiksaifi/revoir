import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { ReviewFailureCategory } from "../review/failure.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const STATE_DIRECTORY = "queue-review-failures";
const STATE_VERSION = 2;
const MAX_OPERATIONAL_FAILURES = 3;

export type TerminalReportState =
  | { readonly status: "not-required" }
  | {
      readonly status: "pending" | "publishing" | "confirmed" | "exhausted";
      readonly attempts: number;
      readonly category: ReviewFailureCategory;
    };

export interface OperationalFailureState {
  readonly failures: number;
  readonly terminalReport: TerminalReportState;
}

export interface OperationalFailureStore {
  load(deliveryId: string, signal?: AbortSignal): Promise<OperationalFailureState>;
  save(deliveryId: string, state: OperationalFailureState, signal?: AbortSignal): Promise<void>;
  clear(deliveryId: string, signal?: AbortSignal): Promise<void>;
}

interface PersistedOperationalFailureState extends OperationalFailureState {
  version: typeof STATE_VERSION;
  deliveryId: string;
}

const EMPTY_STATE: OperationalFailureState = {
  failures: 0,
  terminalReport: { status: "not-required" },
};
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

function isValidTerminalReport(value: unknown, failures: number): value is TerminalReportState {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("status" in value)) {
    return false;
  }
  if (failures < MAX_OPERATIONAL_FAILURES) {
    return value.status === "not-required" && Object.keys(value).length === 1;
  }
  return (
    (value.status === "pending" ||
      value.status === "publishing" ||
      value.status === "confirmed" ||
      value.status === "exhausted") &&
    "attempts" in value &&
    Number.isSafeInteger(value.attempts) &&
    (value.attempts as number) >= (value.status === "pending" ? 0 : 1) &&
    (value.attempts as number) <= MAX_OPERATIONAL_FAILURES &&
    (value.status !== "pending" || (value.attempts as number) < MAX_OPERATIONAL_FAILURES) &&
    (value.status !== "exhausted" || (value.attempts as number) === MAX_OPERATIONAL_FAILURES) &&
    "category" in value &&
    typeof value.category === "string" &&
    REVIEW_FAILURE_CATEGORIES.has(value.category as ReviewFailureCategory)
  );
}

function isValidState(value: OperationalFailureState): boolean {
  return (
    Number.isSafeInteger(value.failures) &&
    value.failures >= 1 &&
    value.failures <= MAX_OPERATIONAL_FAILURES &&
    isValidTerminalReport(value.terminalReport, value.failures)
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
    (parsed.failures as number) > MAX_OPERATIONAL_FAILURES ||
    !("terminalReport" in parsed) ||
    !isValidTerminalReport(parsed.terminalReport, parsed.failures as number)
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
      return {
        failures: persisted.failures,
        terminalReport: persisted.terminalReport,
      };
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
    const persisted: PersistedOperationalFailureState = {
      version: STATE_VERSION,
      deliveryId,
      failures: state.failures,
      terminalReport: state.terminalReport,
    };
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
