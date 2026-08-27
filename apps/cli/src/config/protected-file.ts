import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export class ProtectedFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtectedFileError";
  }
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function assertAbsoluteNormalizedPath(path: string, kind: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new ProtectedFileError(`${kind} "${path}" must be an absolute normalized path.`);
  }
}

async function assertOwnedByCurrentUser(
  path: string,
  ownerId: number,
  kind: string,
): Promise<void> {
  if (typeof process.getuid === "function" && ownerId !== process.getuid()) {
    throw new ProtectedFileError(`${kind} "${path}" must be owned by the current user.`);
  }
}

export async function assertPrivateDirectory(path: string, kind: string): Promise<void> {
  assertAbsoluteNormalizedPath(path, kind);
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    throw new ProtectedFileError(`${kind} "${path}" is not available.`, { cause: error });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ProtectedFileError(
      `${kind} "${path}" must be a real directory, not a symbolic link.`,
    );
  }
  if ((stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new ProtectedFileError(
      `${kind} "${path}" has unsafe mode ${formatMode(stats.mode)}; run "chmod 700 ${path}".`,
    );
  }
  await assertOwnedByCurrentUser(path, stats.uid, kind);
}

export async function ensurePrivateDirectory(path: string, kind: string): Promise<void> {
  assertAbsoluteNormalizedPath(path, kind);
  const created = await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ProtectedFileError(
      `${kind} "${path}" must be a real directory, not a symbolic link.`,
    );
  }
  await assertOwnedByCurrentUser(path, stats.uid, kind);
  if (created !== undefined) {
    await chmod(path, PRIVATE_DIRECTORY_MODE);
    return;
  }
  if ((stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new ProtectedFileError(
      `${kind} "${path}" has unsafe mode ${formatMode(stats.mode)}. Revoir will not change permissions on an existing directory.`,
    );
  }
}

export async function assertProtectedFile(path: string, kind: string): Promise<void> {
  assertAbsoluteNormalizedPath(path, kind);
  await assertPrivateDirectory(dirname(path), `${kind} directory`);
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    throw new ProtectedFileError(`${kind} "${path}" is not available.`, { cause: error });
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ProtectedFileError(`${kind} "${path}" must be a regular file, not a symbolic link.`);
  }
  if ((stats.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new ProtectedFileError(
      `${kind} "${path}" has unsafe mode ${formatMode(stats.mode)}; run "chmod 600 ${path}".`,
    );
  }
  await assertOwnedByCurrentUser(path, stats.uid, kind);
}

export async function loadProtectedJson(path: string, kind: string): Promise<unknown> {
  await assertProtectedFile(path, kind);
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new ProtectedFileError(`${kind} "${path}" is not valid JSON.`, { cause: error });
  }
}

export async function writeProtectedJson(
  path: string,
  kind: string,
  value: unknown,
): Promise<void> {
  assertAbsoluteNormalizedPath(path, kind);
  const directory = dirname(path);
  await ensurePrivateDirectory(directory, `${kind} directory`);

  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new ProtectedFileError(
        `Refusing to replace ${kind.toLowerCase()} "${path}" because it is not a regular file.`,
      );
    }
    await assertProtectedFile(path, kind);
  } catch (error) {
    if (
      error instanceof ProtectedFileError ||
      (error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code !== "ENOENT")
    ) {
      throw error;
    }
  }

  const temporaryFile = join(
    directory,
    `.${kind.toLowerCase().replaceAll(" ", "-")}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryFile, "wx", PRIVATE_FILE_MODE);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryFile, path);
    await chmod(path, PRIVATE_FILE_MODE);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }
  await assertProtectedFile(path, kind);
}
