import { randomUUID } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assertProtectedFile,
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

export async function acquireCommandLock(path: string): Promise<CommandLockLease> {
  return attemptCommandLock(path, true);
}

async function attemptCommandLock(path: string, mayRetry: boolean): Promise<CommandLockLease> {
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
  let created = false;
  try {
    await ensurePrivateDirectory(dirname(path), "Command lock directory");
    const handle = await open(path, "wx", PRIVATE_FILE_MODE);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertProtectedFile(path, "Command lock");
  } catch (error) {
    if (created) await unlink(path).catch(() => {});
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      if (mayRetry) return attemptCommandLock(path, false);
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
