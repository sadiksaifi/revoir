import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { inspectProcess, type ProcessIdentity } from "./process-identity.js";
import { createTerminalHandle } from "./terminal-handle.js";

const LOCK_FILE = "manual-review.lock";
const LOCK_MODE = 0o600;

interface LockOwner {
  pid: number;
  owner: string;
  processBirth?: string;
}

interface StaleClaim {
  format: "revoir-stale-claim-v1";
  target: LockOwner;
  claimant: LockOwner;
}

export interface FileReviewLockHooks {
  afterStaleClaim?(): Promise<void>;
  inspectProcess?(pid: number, signal: AbortSignal): Promise<ProcessIdentity>;
  readFile?(path: string, encoding: BufferEncoding): Promise<string>;
  unlink?(path: string): Promise<void>;
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
  acquire(signal: AbortSignal): Promise<ReviewLockLease>;
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

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Review was cancelled.");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
    value.owner.length === 0 ||
    ("processBirth" in value &&
      (typeof value.processBirth !== "string" || value.processBirth.length === 0))
  ) {
    return undefined;
  }
  return {
    pid: value.pid as number,
    owner: value.owner,
    ...("processBirth" in value ? { processBirth: value.processBirth as string } : {}),
  };
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

async function readLockState(
  path: string,
  read: (path: string, encoding: BufferEncoding) => Promise<string> = readFile,
): Promise<LockState> {
  try {
    const owner = parseLockOwner(await read(path, "utf8"));
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

function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return (
    left.pid === right.pid && left.owner === right.owner && left.processBirth === right.processBirth
  );
}

export class FileReviewLock implements ReviewLock {
  readonly #lockPath: string;
  readonly #hooks: FileReviewLockHooks;
  readonly #inspectProcess: (pid: number, signal: AbortSignal) => Promise<ProcessIdentity>;
  readonly #readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  readonly #unlink: (path: string) => Promise<void>;

  constructor(stateDirectory: string, hooks: FileReviewLockHooks = {}) {
    this.#lockPath = join(stateDirectory, LOCK_FILE);
    this.#hooks = hooks;
    this.#inspectProcess = hooks.inspectProcess ?? inspectProcess;
    this.#readFile = hooks.readFile ?? readFile;
    this.#unlink = hooks.unlink ?? unlink;
  }

  async acquire(signal: AbortSignal = new AbortController().signal): Promise<ReviewLockLease> {
    throwIfAborted(signal);
    await mkdir(dirname(this.#lockPath), { recursive: true, mode: 0o700 });
    throwIfAborted(signal);
    return this.#tryAcquire(3, signal);
  }

  async #tryAcquire(attemptsRemaining: number, signal: AbortSignal): Promise<ReviewLockLease> {
    const identity = await abortable(this.#inspectProcess(process.pid, signal), signal);
    const owner: LockOwner = {
      pid: process.pid,
      owner: randomUUID(),
      ...(identity.kind === "alive" && identity.processBirth !== undefined
        ? { processBirth: identity.processBirth }
        : {}),
    };
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
      const lease = this.#lease(owner);
      if (signal.aborted) {
        await lease.release();
        throw abortReason(signal);
      }
      return lease;
    } catch (error) {
      await unlink(candidatePath).catch(() => {});
      if (!isFileSystemError(error, "EEXIST")) {
        throw error;
      }
      if (attemptsRemaining <= 1 || !(await this.#removeStaleOwner(owner, signal))) {
        throw new ReviewInProgressError();
      }
      return this.#tryAcquire(attemptsRemaining - 1, signal);
    }
  }

  #lease(owner: LockOwner): ReviewLockLease {
    const release = createTerminalHandle(async () => {
      const current = await readLockState(this.#lockPath, this.#readFile);
      if (current.kind === "owned" && sameOwner(current.owner, owner)) {
        await this.#unlink(this.#lockPath).catch((error: unknown) => {
          if (!isFileSystemError(error, "ENOENT")) {
            throw error;
          }
        });
      }
    });
    return {
      release,
    };
  }

  async #removeStaleOwner(claimant: LockOwner, signal: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    const observed = await readLockSnapshot(this.#lockPath);
    throwIfAborted(signal);
    if (observed.kind === "missing") {
      return true;
    }
    if (observed.kind === "invalid" || (await this.#isOwnerAlive(observed.owner, signal))) {
      return false;
    }

    const ownerKey = createHash("sha256")
      .update(`${observed.owner.pid}\0${observed.owner.owner}`)
      .digest("hex");
    const claimRootPath = `${this.#lockPath}.${ownerKey}.reclaim`;
    const claim = await this.#claimStaleOwner(claimRootPath, observed.owner, claimant, signal);
    if (claim === undefined) {
      return false;
    }

    try {
      await this.#hooks.afterStaleClaim?.();
      throwIfAborted(signal);
      const current = await readLockSnapshot(this.#lockPath);
      throwIfAborted(signal);
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
    signal: AbortSignal,
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
        throwIfAborted(signal);
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
        let existingClaimantAlive = false;
        if (existing !== undefined && sameOwner(existing.target, target)) {
          // Claim generations must be inspected in order.
          // eslint-disable-next-line no-await-in-loop
          existingClaimantAlive = await this.#isOwnerAlive(existing.claimant, signal);
        }
        if (
          existing === undefined ||
          !sameOwner(existing.target, target) ||
          existingClaimantAlive
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

  async #isOwnerAlive(owner: LockOwner, signal: AbortSignal): Promise<boolean> {
    const identity = await abortable(this.#inspectProcess(owner.pid, signal), signal);
    if (identity.kind === "missing") {
      return false;
    }
    return (
      owner.processBirth === undefined ||
      identity.processBirth === undefined ||
      owner.processBirth === identity.processBirth
    );
  }
}
