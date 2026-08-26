import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const STATE_DIRECTORY = "completed-review-requests";
const STATE_VERSION = 1;

export interface ReviewRequestIdentity {
  readonly repositoryId: number;
  readonly commentId: number;
}

export interface ReviewRequestCompletionStore {
  has(identity: ReviewRequestIdentity, signal?: AbortSignal): Promise<boolean>;
  mark(identity: ReviewRequestIdentity, signal?: AbortSignal): Promise<void>;
}

interface PersistedReviewRequestCompletion extends ReviewRequestIdentity {
  readonly version: typeof STATE_VERSION;
}

function stateFileName(identity: ReviewRequestIdentity): string {
  const key = `${identity.repositoryId}:${identity.commentId}`;
  return `${createHash("sha256").update(key).digest("hex")}.json`;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validateIdentity(identity: ReviewRequestIdentity): void {
  if (!isPositiveInteger(identity.repositoryId) || !isPositiveInteger(identity.commentId)) {
    throw new Error("Review request completion identity is invalid.");
  }
}

function parseCompletion(contents: string, expected: ReviewRequestIdentity): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error("Review request completion is not valid JSON.", { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("version" in parsed) ||
    parsed.version !== STATE_VERSION ||
    !("repositoryId" in parsed) ||
    parsed.repositoryId !== expected.repositoryId ||
    !("commentId" in parsed) ||
    parsed.commentId !== expected.commentId ||
    Object.keys(parsed).length !== 3
  ) {
    throw new Error("Review request completion is invalid.");
  }
}

export class FileReviewRequestCompletionStore implements ReviewRequestCompletionStore {
  readonly #directory: string;

  constructor(stateDirectory: string) {
    this.#directory = join(stateDirectory, STATE_DIRECTORY);
  }

  async has(identity: ReviewRequestIdentity, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    validateIdentity(identity);
    try {
      parseCompletion(
        await readFile(join(this.#directory, stateFileName(identity)), {
          encoding: "utf8",
          signal,
        }),
        identity,
      );
      return true;
    } catch (error) {
      if (isMissingFile(error)) {
        return false;
      }
      throw error;
    }
  }

  async mark(identity: ReviewRequestIdentity, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    validateIdentity(identity);
    await this.#ensureDirectory(signal);
    const persisted: PersistedReviewRequestCompletion = {
      version: STATE_VERSION,
      ...identity,
    };
    const temporaryFile = join(
      this.#directory,
      `.${stateFileName(identity)}.${process.pid}.${randomUUID()}.tmp`,
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
      await rename(temporaryFile, join(this.#directory, stateFileName(identity)));
      signal?.throwIfAborted();
    } catch (error) {
      await unlink(temporaryFile).catch(() => {});
      throw error;
    }
  }

  async #ensureDirectory(signal?: AbortSignal): Promise<void> {
    const created = await mkdir(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
    signal?.throwIfAborted();
    const stats = await lstat(this.#directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Review request completion directory must be a real directory.");
    }
    if (created !== undefined || (stats.mode & 0o777) !== DIRECTORY_MODE) {
      await chmod(this.#directory, DIRECTORY_MODE);
    }
    signal?.throwIfAborted();
  }
}
