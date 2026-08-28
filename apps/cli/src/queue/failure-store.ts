import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { ReviewFailureCategory } from "../review/failure.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const STATE_DIRECTORY = "queue-review-failures";
const STATE_VERSION = 5;
const MAX_OPERATIONAL_FAILURES = 3;

export type OperationalFailureCount = 0 | 1 | 2 | 3;
export type OperationalAttemptSlot = 1 | 2 | 3;

export interface OperationalFailureReservation {
  readonly slot: OperationalAttemptSlot;
  readonly ownerToken: string;
  readonly transportAttempt: number;
}

export interface OperationalFailureState {
  readonly committedFailures: OperationalFailureCount;
  readonly reservation?: OperationalFailureReservation;
  readonly reviewCompleted?: true;
  readonly terminalCategory?: ReviewFailureCategory;
}

export interface OperationalFailureStore {
  load(deliveryId: string, signal?: AbortSignal): Promise<OperationalFailureState>;
  save(deliveryId: string, state: OperationalFailureState, signal?: AbortSignal): Promise<void>;
  clear(deliveryId: string, signal?: AbortSignal): Promise<void>;
}

type PersistedOperationalFailureState = OperationalFailureState & {
  readonly version: typeof STATE_VERSION;
  readonly deliveryId: string;
};

const EMPTY_STATE: OperationalFailureState = { committedFailures: 0 };
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
  if (
    !Number.isSafeInteger(value.committedFailures) ||
    value.committedFailures < 0 ||
    value.committedFailures > MAX_OPERATIONAL_FAILURES
  ) {
    return false;
  }
  const reservation = value.reservation;
  const reviewCompleted = value.reviewCompleted === true;
  if (
    ("reviewCompleted" in value && !reviewCompleted) ||
    (reviewCompleted &&
      (reservation !== undefined ||
        "terminalCategory" in value ||
        value.committedFailures === MAX_OPERATIONAL_FAILURES))
  ) {
    return false;
  }
  if (
    reservation !== undefined &&
    (typeof reservation !== "object" ||
      reservation === null ||
      !Number.isSafeInteger(reservation.slot) ||
      reservation.slot !== value.committedFailures + 1 ||
      reservation.slot > MAX_OPERATIONAL_FAILURES ||
      typeof reservation.ownerToken !== "string" ||
      reservation.ownerToken.length === 0 ||
      !Number.isSafeInteger(reservation.transportAttempt) ||
      reservation.transportAttempt < 1 ||
      Object.keys(reservation).length !== 3)
  ) {
    return false;
  }
  const terminal =
    !reviewCompleted &&
    (value.committedFailures === MAX_OPERATIONAL_FAILURES || reservation?.slot === 3);
  if (
    terminal !== "terminalCategory" in value ||
    (terminal &&
      (typeof value.terminalCategory !== "string" ||
        !REVIEW_FAILURE_CATEGORIES.has(value.terminalCategory)))
  ) {
    return false;
  }
  return (
    Object.keys(value).length ===
    1 + (reservation === undefined ? 0 : 1) + (reviewCompleted ? 1 : 0) + (terminal ? 1 : 0)
  );
}

function isValidPersistedState(
  value: Record<string, unknown>,
  expectedDeliveryId: string,
): boolean {
  if (
    value.version !== STATE_VERSION ||
    value.deliveryId !== expectedDeliveryId ||
    !("committedFailures" in value)
  ) {
    return false;
  }
  const state: OperationalFailureState = {
    committedFailures: value.committedFailures as OperationalFailureCount,
    ...("reservation" in value
      ? { reservation: value.reservation as OperationalFailureReservation }
      : {}),
    ...("reviewCompleted" in value ? { reviewCompleted: value.reviewCompleted as true } : {}),
    ...("terminalCategory" in value
      ? { terminalCategory: value.terminalCategory as ReviewFailureCategory }
      : {}),
  };
  return isValidState(state) && Object.keys(value).length === 2 + Object.keys(state).length;
}

function persistedState(value: PersistedOperationalFailureState): OperationalFailureState {
  return {
    committedFailures: value.committedFailures,
    ...(value.reservation === undefined ? {} : { reservation: value.reservation }),
    ...(value.reviewCompleted === true ? { reviewCompleted: true as const } : {}),
    ...(value.terminalCategory === undefined ? {} : { terminalCategory: value.terminalCategory }),
  };
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
    !isValidPersistedState(parsed as Record<string, unknown>, expectedDeliveryId)
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
      return persistedState(persisted);
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
      ...state,
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
