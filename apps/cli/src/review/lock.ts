import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCK_FILE = "manual-review.lock";
const LOCK_MODE = 0o600;

interface LockOwner {
  pid: number;
  owner: string;
}

interface StaleClaim {
  format: "revoir-stale-claim-v1";
  target: LockOwner;
  claimant: LockOwner;
}

interface FileReviewLockHooks {
  afterStaleClaim?(): Promise<void>;
}

type LockState = { kind: "missing" } | { kind: "invalid" } | { kind: "owned"; owner: LockOwner };

type LockSnapshot =
  | { kind: "missing" }
  | { kind: "invalid"; device: number; inode: number }
  | { kind: "owned"; owner: LockOwner; device: number; inode: number };

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

function toLockOwner(value: unknown): LockOwner | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("pid" in value) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    !("owner" in value) ||
    typeof value.owner !== "string" ||
    value.owner.length === 0
  ) {
    return undefined;
  }
  return { pid: value.pid as number, owner: value.owner };
}

function parseLockOwner(value: string): LockOwner | undefined {
  try {
    return toLockOwner(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseStaleClaim(value: string): StaleClaim | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("format" in parsed) ||
      parsed.format !== "revoir-stale-claim-v1" ||
      !("target" in parsed) ||
      !("claimant" in parsed)
    ) {
      return undefined;
    }
    const target = toLockOwner(parsed.target);
    const claimant = toLockOwner(parsed.claimant);
    return target === undefined || claimant === undefined
      ? undefined
      : { format: parsed.format, target, claimant };
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

async function readLockSnapshot(path: string): Promise<LockSnapshot> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return { kind: "missing" };
    }
    throw error;
  }

  try {
    const [value, stats] = await Promise.all([handle.readFile("utf8"), handle.stat()]);
    const owner = parseLockOwner(value);
    return owner === undefined
      ? { kind: "invalid", device: stats.dev, inode: stats.ino }
      : { kind: "owned", owner, device: stats.dev, inode: stats.ino };
  } finally {
    await handle.close();
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
  readonly #hooks: FileReviewLockHooks;

  constructor(stateDirectory: string, hooks: FileReviewLockHooks = {}) {
    this.#lockPath = join(stateDirectory, LOCK_FILE);
    this.#hooks = hooks;
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
      if (attemptsRemaining <= 1 || !(await this.#removeStaleOwner(owner))) {
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

  async #removeStaleOwner(claimant: LockOwner): Promise<boolean> {
    const observed = await readLockSnapshot(this.#lockPath);
    if (observed.kind === "missing") {
      return true;
    }
    if (observed.kind === "invalid" || isProcessAlive(observed.owner.pid)) {
      return false;
    }

    const ownerKey = createHash("sha256")
      .update(`${observed.owner.pid}\0${observed.owner.owner}`)
      .digest("hex");
    const claimRootPath = `${this.#lockPath}.${ownerKey}.reclaim`;
    const claim = await this.#claimStaleOwner(claimRootPath, observed.owner, claimant);
    if (claim === undefined) {
      return false;
    }

    try {
      await this.#hooks.afterStaleClaim?.();
      const current = await readLockSnapshot(this.#lockPath);
      if (current.kind === "missing") {
        return true;
      }
      if (
        current.kind !== "owned" ||
        !sameOwner(current.owner, observed.owner) ||
        current.device !== observed.device ||
        current.inode !== observed.inode
      ) {
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
      await Promise.all(
        claim.paths.map((path) =>
          unlink(path).catch((error: unknown) => {
            if (!isFileSystemError(error, "ENOENT")) {
              throw error;
            }
          }),
        ),
      );
    }
  }

  async #claimStaleOwner(
    claimRootPath: string,
    target: LockOwner,
    claimant: LockOwner,
  ): Promise<{ paths: string[] } | undefined> {
    const candidatePath = `${claimRootPath}.${claimant.pid}.${claimant.owner}.tmp`;
    const claim: StaleClaim = {
      format: "revoir-stale-claim-v1",
      target,
      claimant,
    };
    const paths: string[] = [];

    try {
      const handle = await open(candidatePath, "wx", LOCK_MODE);
      try {
        await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      let generation = 0;
      for (;;) {
        const claimPath = generation === 0 ? claimRootPath : `${claimRootPath}.${generation}`;
        try {
          // Claim generations must be inspected and created in order.
          // eslint-disable-next-line no-await-in-loop
          await link(candidatePath, claimPath);
          paths.push(claimPath);
          return { paths };
        } catch (error) {
          if (!isFileSystemError(error, "EEXIST")) {
            throw error;
          }
        }

        let value: string;
        try {
          // A later generation is safe only after this claimant is known to have exited.
          // eslint-disable-next-line no-await-in-loop
          value = await readFile(claimPath, "utf8");
        } catch (error) {
          if (isFileSystemError(error, "ENOENT")) {
            continue;
          }
          throw error;
        }

        const existing = parseStaleClaim(value);
        if (
          existing === undefined ||
          !sameOwner(existing.target, target) ||
          isProcessAlive(existing.claimant.pid)
        ) {
          return undefined;
        }
        paths.push(claimPath);
        generation += 1;
      }
    } finally {
      await unlink(candidatePath).catch(() => {});
    }
  }
}
