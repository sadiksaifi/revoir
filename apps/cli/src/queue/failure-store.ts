import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const STATE_DIRECTORY = "queue-review-failures";
const STATE_VERSION = 1;
const MAX_OPERATIONAL_FAILURES = 3;

export interface OperationalFailureStore {
  load(deliveryId: string): Promise<number>;
  save(deliveryId: string, failures: number): Promise<void>;
  clear(deliveryId: string): Promise<void>;
}

interface OperationalFailureState {
  version: typeof STATE_VERSION;
  deliveryId: string;
  failures: number;
}

function stateFileName(deliveryId: string): string {
  return `${createHash("sha256").update(deliveryId).digest("hex")}.json`;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function parseState(contents: string, expectedDeliveryId: string): OperationalFailureState {
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
  return parsed as OperationalFailureState;
}

export class FileOperationalFailureStore implements OperationalFailureStore {
  readonly #directory: string;

  constructor(stateDirectory: string) {
    this.#directory = join(stateDirectory, STATE_DIRECTORY);
  }

  async load(deliveryId: string): Promise<number> {
    try {
      return parseState(
        await readFile(join(this.#directory, stateFileName(deliveryId)), "utf8"),
        deliveryId,
      ).failures;
    } catch (error) {
      if (isMissingFile(error)) {
        return 0;
      }
      throw error;
    }
  }

  async save(deliveryId: string, failures: number): Promise<void> {
    if (
      deliveryId.length === 0 ||
      !Number.isSafeInteger(failures) ||
      failures < 1 ||
      failures > MAX_OPERATIONAL_FAILURES
    ) {
      throw new Error("Operational review failure state is invalid.");
    }
    await this.#ensureDirectory();
    const state: OperationalFailureState = {
      version: STATE_VERSION,
      deliveryId,
      failures,
    };
    const temporaryFile = join(
      this.#directory,
      `.${stateFileName(deliveryId)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryFile, "wx", FILE_MODE);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryFile, join(this.#directory, stateFileName(deliveryId)));
    } catch (error) {
      await unlink(temporaryFile).catch(() => {});
      throw error;
    }
  }

  async clear(deliveryId: string): Promise<void> {
    try {
      await unlink(join(this.#directory, stateFileName(deliveryId)));
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }

  async #ensureDirectory(): Promise<void> {
    const created = await mkdir(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
    const stats = await lstat(this.#directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Operational review failure state directory must be a real directory.");
    }
    if (created !== undefined || (stats.mode & 0o777) !== DIRECTORY_MODE) {
      await chmod(this.#directory, DIRECTORY_MODE);
    }
  }
}
