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

const LOCK_TOKEN = /^[A-Za-z0-9-]{1,128}$/u;

export interface CommandLockLease {
  release(): Promise<void>;
}

export interface CommandLockAcquisitionOptions {
  afterStaleSnapshot?(): Promise<void> | void;
  beforePublish?(candidatePath: string): Promise<void> | void;
  afterReclaimCandidate?(candidatePath: string): Promise<void> | void;
  afterReclaimPublication?(claimPath: string): Promise<void> | void;
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
    !LOCK_TOKEN.test(record.token) ||
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
    !LOCK_TOKEN.test(value.target.token) ||
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

async function cleanUniqueCandidates(path: string): Promise<void> {
  const directory = dirname(path);
  const names = await readdir(directory);
  await Promise.all(
    names.map(async (name) => {
      const pending = /^\.command-lock\.(\d+)\.([A-Za-z0-9-]{1,128})\.pending$/u.exec(name);
      const reclaim =
        /^\.command-lock\.([A-Za-z0-9-]{1,128})\.reclaim\.(\d+)\.([A-Za-z0-9-]{1,128})\.tmp$/u.exec(
          name,
        );
      if (pending === null && reclaim === null) return;
      const pid = Number(pending?.[1] ?? reclaim?.[2]);
      const token = pending?.[2] ?? reclaim?.[3];
      if (token === undefined) return;
      if (!Number.isSafeInteger(pid) || pid <= 0 || processIsRunning(pid)) return;
      const candidatePath = join(directory, name);
      try {
        const value = await loadProtectedJson(candidatePath, "Command lock candidate");
        if (pending !== null) {
          const candidate = validateLock(value);
          if (candidate.pid !== pid || candidate.token !== token) return;
        } else {
          const candidate = validateReclaim(value);
          if (
            candidate === undefined ||
            candidate.target.token !== reclaim?.[1] ||
            candidate.claimant.pid !== pid ||
            candidate.claimant.token !== token
          ) {
            return;
          }
        }
        await unlink(candidatePath);
      } catch (error) {
        if (isFileSystemError(error, "ENOENT") || isProtectedFileSystemError(error, "ENOENT")) {
          return;
        }
        if (error instanceof ProtectedFileError) {
          await unlink(candidatePath).catch(() => {});
          return;
        }
        throw error;
      }
    }),
  );
}

function reclaimClaimName(name: string): { generation: number; targetToken: string } | undefined {
  const match = /^\.command-lock\.([A-Za-z0-9-]{1,128})\.reclaim(?:\.(0|[1-9]\d*))?$/u.exec(name);
  if (match?.[1] === undefined) return undefined;
  return { targetToken: match[1], generation: match[2] === undefined ? 0 : Number(match[2]) };
}

function sameReclaimTarget(
  left: CommandLockReclaim["target"],
  right: CommandLockReclaim["target"],
): boolean {
  return left.token === right.token && left.device === right.device && left.inode === right.inode;
}

async function publishReclaimClaim(
  path: string,
  target: CommandLockSnapshot,
  claimant: CommandLockRecord,
  options: CommandLockAcquisitionOptions,
): Promise<{ paths: string[] } | undefined> {
  const directory = dirname(path);
  const claimRoot = join(directory, `.command-lock.${target.record.token}.reclaim`);
  const candidatePath = `${claimRoot}.${claimant.pid}.${claimant.token}.tmp`;
  const claim: CommandLockReclaim = {
    version: 1,
    target: { token: target.record.token, device: target.device, inode: target.inode },
    claimant,
  };
  const paths: string[] = [];
  try {
    await writeDurableRecord(candidatePath, claim);
    await options.afterReclaimCandidate?.(candidatePath);
    const artifactCount = (await readdir(directory)).length;
    for (let generation = 0; generation <= artifactCount; generation += 1) {
      const claimPath = generation === 0 ? claimRoot : `${claimRoot}.${generation}`;
      try {
        // eslint-disable-next-line no-await-in-loop
        await link(candidatePath, claimPath);
        paths.push(claimPath);
        // eslint-disable-next-line no-await-in-loop
        await options.afterReclaimPublication?.(claimPath);
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
        !sameReclaimTarget(existing.target, claim.target) ||
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

async function cleanPublishedReclaimClaims(
  path: string,
  options: CommandLockAcquisitionOptions,
): Promise<void> {
  const directory = dirname(path);
  const names = await readdir(directory);
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const claim = reclaimClaimName(name);
    if (claim === undefined || !Number.isSafeInteger(claim.generation)) continue;
    const group = groups.get(claim.targetToken) ?? [];
    group.push(join(directory, name));
    groups.set(claim.targetToken, group);
  }

  for (const [targetToken, claimPaths] of groups) {
    let target: CommandLockReclaim["target"] | undefined;
    let reclaimable = true;
    for (const claimPath of claimPaths) {
      let claim: CommandLockReclaim | undefined;
      try {
        // eslint-disable-next-line no-await-in-loop
        claim = validateReclaim(await loadProtectedJson(claimPath, "Command lock reclaim"));
      } catch (error) {
        if (isFileSystemError(error, "ENOENT") || isProtectedFileSystemError(error, "ENOENT")) {
          reclaimable = false;
          break;
        }
        throw error;
      }
      if (
        claim === undefined ||
        claim.target.token !== targetToken ||
        (target !== undefined && !sameReclaimTarget(target, claim.target)) ||
        processIsRunning(claim.claimant.pid)
      ) {
        reclaimable = false;
        break;
      }
      target = claim.target;
    }
    if (!reclaimable || target === undefined) continue;

    const claimant: CommandLockRecord = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };
    // Claim groups are reclaimed sequentially so one process never publishes competing claims.
    // eslint-disable-next-line no-await-in-loop
    const lease = await publishReclaimClaim(
      path,
      { record: { ...claimant, token: target.token }, device: target.device, inode: target.inode },
      claimant,
      options,
    );
    if (lease === undefined) continue;
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      [...new Set([...claimPaths, ...lease.paths])].map((claimPath) =>
        unlink(claimPath).catch(() => {}),
      ),
    );
  }
}

async function cleanCommandLockArtifacts(
  path: string,
  options: CommandLockAcquisitionOptions,
): Promise<void> {
  await cleanUniqueCandidates(path);
  await cleanPublishedReclaimClaims(path, options);
}

async function claimStaleLock(
  path: string,
  target: CommandLockSnapshot,
  claimant: CommandLockRecord,
  options: CommandLockAcquisitionOptions,
): Promise<{ paths: string[] } | undefined> {
  return publishReclaimClaim(path, target, claimant, options);
}

async function removeStaleLock(
  path: string,
  observed: CommandLockSnapshot,
  claimant: CommandLockRecord,
  options: CommandLockAcquisitionOptions,
): Promise<boolean> {
  const claim = await claimStaleLock(path, observed, claimant, options);
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
  await cleanCommandLockArtifacts(path, options);
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
    if (!(await removeStaleLock(path, existing, record, options))) {
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
