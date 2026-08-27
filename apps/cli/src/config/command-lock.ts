import { randomUUID } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
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

export interface CommandLockLease {
  release(): Promise<void>;
}

export interface CommandLockAcquisitionOptions {
  beforePublish?(candidatePath: string): Promise<void> | void;
}

export class ConcurrentCommandError extends Error {
  constructor(path: string, pid: number) {
    super(`Another Revoir command is running with process id ${pid} (lock: ${path}).`);
    this.name = "ConcurrentCommandError";
  }
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

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

async function readExistingLock(path: string): Promise<CommandLockRecord | undefined> {
  assertProtectedPath(path, "Command lock");
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
  return validateLock(await loadProtectedJson(path, "Command lock"));
}

export async function acquireCommandLock(
  path: string,
  options: CommandLockAcquisitionOptions = {},
): Promise<CommandLockLease> {
  return attemptCommandLock(path, true, options);
}

async function attemptCommandLock(
  path: string,
  mayRetry: boolean,
  options: CommandLockAcquisitionOptions,
): Promise<CommandLockLease> {
  const existing = await readExistingLock(path);
  if (existing !== undefined) {
    if (processIsRunning(existing.pid)) throw new ConcurrentCommandError(path, existing.pid);
    await unlink(path);
  }

  const record: CommandLockRecord = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const candidatePath = join(dirname(path), `.command-lock.${record.token}.pending`);
  try {
    await ensurePrivateDirectory(dirname(path), "Command lock directory");
    const handle = await open(candidatePath, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforePublish?.(candidatePath);
    await link(candidatePath, path);
    await unlink(candidatePath).catch(() => {});
    await assertProtectedFile(path, "Command lock");
  } catch (error) {
    await unlink(candidatePath).catch(() => {});
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      if (mayRetry) return attemptCommandLock(path, false, options);
      const concurrent = await readExistingLock(path);
      if (concurrent !== undefined) throw new ConcurrentCommandError(path, concurrent.pid);
    }
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const current = await readExistingLock(path);
      if (current?.token === record.token) await unlink(path);
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
