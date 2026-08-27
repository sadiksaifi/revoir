import { randomUUID } from "node:crypto";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  assertProtectedFile,
  assertProtectedPath,
  ensurePrivateDirectory,
  loadProtectedJson,
  PRIVATE_FILE_MODE,
  ProtectedFileError,
} from "./protected-file.js";

interface CommandLockRecord {
  version: 1;
  pid: number;
  token: string;
  acquiredAt: string;
}

interface CommandLockSnapshot {
  record: CommandLockRecord;
  device: number;
  inode: number;
}

interface CommandLockReclaim {
  version: 1;
  target: { token: string; device: number; inode: number };
  claimant: CommandLockRecord;
}

export interface CommandLockLease {
  release(): Promise<void>;
}

export interface CommandLockAcquisitionOptions {
  afterStaleSnapshot?(): Promise<void> | void;
  beforePublish?(candidatePath: string): Promise<void> | void;
}

export class ConcurrentCommandError extends Error {
  constructor(path: string, pid: number) {
    super(`Another Revoir command is running with process id ${pid} (lock: ${path}).`);
    this.name = "ConcurrentCommandError";
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function isProtectedFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof ProtectedFileError && "cause" in error && isFileSystemError(error.cause, code)
  );
}

function validateLock(value: unknown): CommandLockRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["version", "pid", "token", "acquiredAt"].includes(key))
  ) {
    throw new ProtectedFileError("Command lock has an invalid shape.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.token !== "string" ||
    record.token === "" ||
    typeof record.acquiredAt !== "string" ||
    Number.isNaN(Date.parse(record.acquiredAt))
  ) {
    throw new ProtectedFileError("Command lock has invalid values.");
  }
  return record as unknown as CommandLockRecord;
}

function validateReclaim(value: unknown): CommandLockReclaim | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("target" in value) ||
    typeof value.target !== "object" ||
    value.target === null ||
    !("token" in value.target) ||
    typeof value.target.token !== "string" ||
    !("device" in value.target) ||
    !Number.isSafeInteger(value.target.device) ||
    !("inode" in value.target) ||
    !Number.isSafeInteger(value.target.inode) ||
    !("claimant" in value)
  ) {
    return undefined;
  }
  try {
    return {
      version: 1,
      target: {
        token: value.target.token,
        device: value.target.device as number,
        inode: value.target.inode as number,
      },
      claimant: validateLock(value.claimant),
    };
  } catch {
    return undefined;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isFileSystemError(error, "EPERM");
  }
}

async function readLockSnapshot(path: string): Promise<CommandLockSnapshot | undefined> {
  assertProtectedPath(path, "Command lock");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let before;
    try {
      // eslint-disable-next-line no-await-in-loop
      before = await lstat(path);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return undefined;
      throw error;
    }
    // eslint-disable-next-line no-await-in-loop
    const record = validateLock(await loadProtectedJson(path, "Command lock"));
    let after;
    try {
      // eslint-disable-next-line no-await-in-loop
      after = await lstat(path);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) continue;
      throw error;
    }
    if (before.dev === after.dev && before.ino === after.ino) {
      return { record, device: after.dev, inode: after.ino };
    }
  }
  throw new ConcurrentCommandError(path, process.pid);
}

function sameSnapshot(left: CommandLockSnapshot, right: CommandLockSnapshot | undefined): boolean {
  return (
    right !== undefined &&
    left.record.token === right.record.token &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

async function writeDurableRecord(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanPendingCandidates(path: string): Promise<void> {
  const directory = dirname(path);
  const names = await readdir(directory);
  await Promise.all(
    names.map(async (name) => {
      const match = /^\.command-lock\.(\d+)\.([0-9a-f-]+)\.pending$/iu.exec(name);
      if (match === null) return;
      const pid = Number(match[1]);
      const token = match[2]!;
      if (!Number.isSafeInteger(pid) || pid <= 0 || processIsRunning(pid)) return;
      const candidatePath = join(directory, name);
      try {
        const candidate = validateLock(await loadProtectedJson(candidatePath, "Command lock"));
        if (candidate.pid !== pid || candidate.token !== token) return;
        await unlink(candidatePath);
      } catch (error) {
        if (isFileSystemError(error, "ENOENT")) return;
        if (error instanceof ProtectedFileError) {
          await unlink(candidatePath).catch(() => {});
          return;
        }
        throw error;
      }
    }),
  );
}

async function claimStaleLock(
  path: string,
  target: CommandLockSnapshot,
  claimant: CommandLockRecord,
): Promise<{ paths: string[] } | undefined> {
  const claimRoot = join(dirname(path), `.command-lock.${target.record.token}.reclaim`);
  const candidatePath = `${claimRoot}.${claimant.pid}.${claimant.token}.tmp`;
  const claim: CommandLockReclaim = {
    version: 1,
    target: { token: target.record.token, device: target.device, inode: target.inode },
    claimant,
  };
  const paths: string[] = [];
  try {
    await writeDurableRecord(candidatePath, claim);
    for (let generation = 0; generation < 100; generation += 1) {
      const claimPath = generation === 0 ? claimRoot : `${claimRoot}.${generation}`;
      try {
        // eslint-disable-next-line no-await-in-loop
        await link(candidatePath, claimPath);
        paths.push(claimPath);
        return { paths };
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
      }

      let existing: CommandLockReclaim | undefined;
      try {
        // eslint-disable-next-line no-await-in-loop
        existing = validateReclaim(await loadProtectedJson(claimPath, "Command lock reclaim"));
      } catch (error) {
        if (isFileSystemError(error, "ENOENT") || isProtectedFileSystemError(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      }
      if (
        existing === undefined ||
        existing.target.token !== target.record.token ||
        existing.target.device !== target.device ||
        existing.target.inode !== target.inode ||
        processIsRunning(existing.claimant.pid)
      ) {
        return undefined;
      }
      paths.push(claimPath);
    }
    return undefined;
  } finally {
    await unlink(candidatePath).catch(() => {});
  }
}

async function removeStaleLock(
  path: string,
  observed: CommandLockSnapshot,
  claimant: CommandLockRecord,
): Promise<boolean> {
  const claim = await claimStaleLock(path, observed, claimant);
  if (claim === undefined) return false;
  try {
    const current = await readLockSnapshot(path);
    if (!sameSnapshot(observed, current)) return false;
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return false;
      throw error;
    }
  } finally {
    await Promise.all(claim.paths.map((claimPath) => unlink(claimPath).catch(() => {})));
  }
}

export async function acquireCommandLock(
  path: string,
  options: CommandLockAcquisitionOptions = {},
): Promise<CommandLockLease> {
  assertProtectedPath(path, "Command lock");
  await ensurePrivateDirectory(dirname(path), "Command lock directory");
  await cleanPendingCandidates(path);
  return attemptCommandLock(path, 3, options);
}

async function attemptCommandLock(
  path: string,
  attemptsRemaining: number,
  options: CommandLockAcquisitionOptions,
): Promise<CommandLockLease> {
  const record: CommandLockRecord = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const existing = await readLockSnapshot(path);
  if (existing !== undefined) {
    if (processIsRunning(existing.record.pid)) {
      throw new ConcurrentCommandError(path, existing.record.pid);
    }
    await options.afterStaleSnapshot?.();
    if (!(await removeStaleLock(path, existing, record))) {
      throw new ConcurrentCommandError(path, existing.record.pid);
    }
  }

  const candidatePath = join(dirname(path), `.command-lock.${record.pid}.${record.token}.pending`);
  try {
    await writeDurableRecord(candidatePath, record);
    await options.beforePublish?.(candidatePath);
    await link(candidatePath, path);
    await unlink(candidatePath).catch(() => {});
    await assertProtectedFile(path, "Command lock");
  } catch (error) {
    await unlink(candidatePath).catch(() => {});
    if (isFileSystemError(error, "EEXIST") && attemptsRemaining > 1) {
      return attemptCommandLock(path, attemptsRemaining - 1, options);
    }
    if (isFileSystemError(error, "EEXIST")) {
      const concurrent = await readLockSnapshot(path);
      if (concurrent !== undefined) {
        throw new ConcurrentCommandError(path, concurrent.record.pid);
      }
    }
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const current = await readLockSnapshot(path);
      if (current?.record.token === record.token) await unlink(path);
    },
  };
}

export async function withCommandLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lease = await acquireCommandLock(path);
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}
