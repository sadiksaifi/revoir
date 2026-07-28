import { chmod, lstat, mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { SecretRedactor } from "../redaction.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface ServiceLogPaths {
  structured: string;
  launchdStdout: string;
  launchdStderr: string;
}

export interface ServiceLogger {
  write(event: string, data?: Readonly<Record<string, unknown>>): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class ServiceLogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServiceLogError";
  }
}

export function serviceLogPaths(stateDir: string): ServiceLogPaths {
  const logsDirectory = join(stateDir, "logs");
  return {
    structured: join(logsDirectory, "service.jsonl"),
    launchdStdout: join(logsDirectory, "launchd.stdout.log"),
    launchdStderr: join(logsDirectory, "launchd.stderr.log"),
  };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function assertCurrentUser(path: string, ownerId: number, kind: string): Promise<void> {
  if (typeof process.getuid === "function" && ownerId !== process.getuid()) {
    throw new ServiceLogError(`${kind} "${path}" must be owned by the current user.`);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  let created = false;
  try {
    await lstat(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(path, DIRECTORY_MODE);
    created = true;
  }
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ServiceLogError(`Service log directory "${path}" must be a real directory.`);
  }
  await assertCurrentUser(path, stats.uid, "Service log directory");
  if (!created && (stats.mode & 0o777) !== DIRECTORY_MODE) {
    throw new ServiceLogError(
      `Service log directory "${path}" has unsafe permissions; set its mode to 0700 after verifying it contains no unrelated files.`,
    );
  }
}

async function openPrivateLog(path: string): Promise<FileHandle> {
  await ensurePrivateDirectory(dirname(path));
  let created = false;
  try {
    await lstat(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    created = true;
  }
  const handle = await open(path, "a", FILE_MODE);
  try {
    if (created) {
      await chmod(path, FILE_MODE);
    }
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new ServiceLogError(`Service log "${path}" must be a regular file.`);
    }
    await assertCurrentUser(path, stats.uid, "Service log");
    if ((stats.mode & 0o777) !== FILE_MODE) {
      throw new ServiceLogError(
        `Service log "${path}" has unsafe permissions; set its mode to 0600 or remove it before restarting Revoir.`,
      );
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function prepareServiceLogFiles(stateDir: string): Promise<void> {
  const paths = serviceLogPaths(stateDir);
  const handles: FileHandle[] = [];
  try {
    for (const path of [paths.structured, paths.launchdStdout, paths.launchdStderr]) {
      // Open sequentially so a later unsafe path cannot leak an earlier file descriptor.
      // eslint-disable-next-line no-await-in-loop
      handles.push(await openPrivateLog(path));
    }
  } finally {
    await Promise.all(handles.map(async (handle) => handle.close()));
  }
}

function safeLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.cause === undefined ? {} : { cause: safeLogValue(value.cause, seen) }),
    };
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => safeLogValue(item, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, safeLogValue(nested, seen)]),
  );
}

export class JsonLineServiceLogger implements ServiceLogger {
  readonly #clock: () => Date;
  readonly #handle: FileHandle;
  readonly #redactor: SecretRedactor;
  #closePromise: Promise<void> | undefined;
  #pending: Promise<void> = Promise.resolve();

  private constructor(handle: FileHandle, redactor: SecretRedactor, clock: () => Date) {
    this.#handle = handle;
    this.#redactor = redactor;
    this.#clock = clock;
  }

  static async open(
    path: string,
    redactor: SecretRedactor,
    clock: () => Date = () => new Date(),
  ): Promise<JsonLineServiceLogger> {
    return new JsonLineServiceLogger(await openPrivateLog(path), redactor, clock);
  }

  write(event: string, data: Readonly<Record<string, unknown>> = {}): Promise<void> {
    if (!/^[a-z][a-z0-9_]*$/u.test(event)) {
      return Promise.reject(new ServiceLogError(`Invalid service log event "${event}".`));
    }
    if (this.#closePromise !== undefined) {
      return Promise.reject(new ServiceLogError("Cannot write to a closed service log."));
    }
    const record = {
      timestamp: this.#clock().toISOString(),
      event,
      data: this.#redactor.value(safeLogValue(data)),
    };
    this.#pending = this.#pending.then(async () => {
      await this.#handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
    });
    return this.#pending;
  }

  async flush(): Promise<void> {
    await this.#pending;
    await this.#handle.sync();
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      await this.flush();
      await this.#handle.close();
    })();
    return this.#closePromise;
  }
}

async function readSafeLog(path: string): Promise<string | undefined> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ServiceLogError(`Refusing to read unsafe service log path "${path}".`);
  }
  await assertCurrentUser(path, stats.uid, "Service log");
  if ((stats.mode & 0o777) !== FILE_MODE) {
    throw new ServiceLogError(
      `Refusing to read service log "${path}" with unsafe permissions; expected mode 0600.`,
    );
  }
  return readFile(path, "utf8");
}

export async function readServiceLogs(stateDir: string): Promise<string> {
  const paths = serviceLogPaths(stateDir);
  const [structured, stdout, stderr] = await Promise.all([
    readSafeLog(paths.structured),
    readSafeLog(paths.launchdStdout),
    readSafeLog(paths.launchdStderr),
  ]);
  const sections: string[] = [];
  if (structured !== undefined && structured.length > 0) {
    sections.push(structured.trimEnd());
  }
  if (stdout !== undefined && stdout.length > 0) {
    sections.push(`[launchd stdout]\n${stdout.trimEnd()}`);
  }
  if (stderr !== undefined && stderr.length > 0) {
    sections.push(`[launchd stderr]\n${stderr.trimEnd()}`);
  }
  if (sections.length === 0) {
    throw new ServiceLogError(
      `No service logs are available beneath "${dirname(paths.structured)}". Start Revoir and retry.`,
    );
  }
  return `${sections.join("\n\n")}\n`;
}
