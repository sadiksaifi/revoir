import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCK_FILE = "manual-review.lock";
const LOCK_MODE = 0o600;

interface LockOwner {
  pid: number;
  owner: string;
}

type LockState = { kind: "missing" } | { kind: "invalid" } | { kind: "owned"; owner: LockOwner };

export interface ReviewLockLease {
  release(): Promise<void>;
}

export interface ReviewLock {
  acquire(): Promise<ReviewLockLease>;
}

export class ReviewInProgressError extends Error {
  constructor() {
    super("Another manual review is already in progress.");
    this.name = "ReviewInProgressError";
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function parseLockOwner(value: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("pid" in parsed) ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      !("owner" in parsed) ||
      typeof parsed.owner !== "string" ||
      parsed.owner.length === 0
    ) {
      return undefined;
    }
    return { pid: parsed.pid as number, owner: parsed.owner };
  } catch {
    return undefined;
  }
}

async function readLockState(path: string): Promise<LockState> {
  try {
    const owner = parseLockOwner(await readFile(path, "utf8"));
    return owner === undefined ? { kind: "invalid" } : { kind: "owned", owner };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return { kind: "missing" };
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileSystemError(error, "ESRCH");
  }
}

function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return left.pid === right.pid && left.owner === right.owner;
}

export class FileReviewLock implements ReviewLock {
  readonly #lockPath: string;

  constructor(stateDirectory: string) {
    this.#lockPath = join(stateDirectory, LOCK_FILE);
  }

  async acquire(): Promise<ReviewLockLease> {
    await mkdir(dirname(this.#lockPath), { recursive: true, mode: 0o700 });
    return this.#tryAcquire(3);
  }

  async #tryAcquire(attemptsRemaining: number): Promise<ReviewLockLease> {
    const owner: LockOwner = { pid: process.pid, owner: randomUUID() };
    const candidatePath = `${this.#lockPath}.${owner.pid}.${owner.owner}.tmp`;
    try {
      const handle = await open(candidatePath, "wx", LOCK_MODE);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(candidatePath, this.#lockPath);
      await unlink(candidatePath).catch(() => {});
      return this.#lease(owner);
    } catch (error) {
      await unlink(candidatePath).catch(() => {});
      if (!isFileSystemError(error, "EEXIST")) {
        throw error;
      }
      if (attemptsRemaining <= 1 || !(await this.#removeStaleOwner())) {
        throw new ReviewInProgressError();
      }
      return this.#tryAcquire(attemptsRemaining - 1);
    }
  }

  #lease(owner: LockOwner): ReviewLockLease {
    let released = false;
    return {
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        const current = await readLockState(this.#lockPath);
        if (current.kind === "owned" && sameOwner(current.owner, owner)) {
          await unlink(this.#lockPath).catch((error: unknown) => {
            if (!isFileSystemError(error, "ENOENT")) {
              throw error;
            }
          });
        }
      },
    };
  }

  async #removeStaleOwner(): Promise<boolean> {
    const observed = await readLockState(this.#lockPath);
    if (observed.kind === "missing") {
      return true;
    }
    if (observed.kind === "invalid" || isProcessAlive(observed.owner.pid)) {
      return false;
    }

    const ownerKey = createHash("sha256")
      .update(`${observed.owner.pid}\0${observed.owner.owner}`)
      .digest("hex");
    const quarantinePath = `${this.#lockPath}.${ownerKey}.stale`;
    try {
      await link(this.#lockPath, quarantinePath);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        return true;
      }
      if (isFileSystemError(error, "EEXIST")) {
        return false;
      }
      throw error;
    }

    try {
      const quarantined = await readLockState(quarantinePath);
      if (quarantined.kind !== "owned" || !sameOwner(quarantined.owner, observed.owner)) {
        return false;
      }

      const current = await readLockState(this.#lockPath);
      if (current.kind === "missing") {
        return true;
      }
      if (current.kind !== "owned" || !sameOwner(current.owner, observed.owner)) {
        return false;
      }

      const [quarantinedStats, currentStats] = await Promise.all([
        stat(quarantinePath),
        stat(this.#lockPath),
      ]);
      if (quarantinedStats.dev !== currentStats.dev || quarantinedStats.ino !== currentStats.ino) {
        return false;
      }

      try {
        await unlink(this.#lockPath);
        return true;
      } catch (error) {
        if (isFileSystemError(error, "ENOENT")) {
          return true;
        }
        throw error;
      }
    } finally {
      await unlink(quarantinePath).catch((error: unknown) => {
        if (!isFileSystemError(error, "ENOENT")) {
          throw error;
        }
      });
    }
  }
}
