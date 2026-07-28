import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type RevoirConfiguration, validateConfiguration } from "./schema.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export class ConfigurationFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationFileError";
  }
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

async function assertOwnedByCurrentUser(
  path: string,
  ownerId: number,
  kind: "Configuration directory" | "Configuration file",
): Promise<void> {
  if (typeof process.getuid === "function" && ownerId !== process.getuid()) {
    throw new ConfigurationFileError(`${kind} "${path}" must be owned by the current user.`);
  }
}

export async function assertConfigurationPermissions(configFile: string): Promise<void> {
  const configDir = dirname(configFile);
  let directoryStats;
  let fileStats;
  try {
    [directoryStats, fileStats] = await Promise.all([lstat(configDir), lstat(configFile)]);
  } catch (error) {
    throw new ConfigurationFileError(
      `Configuration file "${configFile}" is not available. Run "revoir setup" first.`,
      { cause: error },
    );
  }

  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new ConfigurationFileError(
      `Configuration directory "${configDir}" must be a real directory, not a symbolic link.`,
    );
  }
  if ((directoryStats.mode & 0o777) !== DIRECTORY_MODE) {
    throw new ConfigurationFileError(
      `Configuration directory "${configDir}" has unsafe mode ${formatMode(directoryStats.mode)}; run "chmod 700 ${configDir}".`,
    );
  }
  await assertOwnedByCurrentUser(configDir, directoryStats.uid, "Configuration directory");

  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    throw new ConfigurationFileError(
      `Configuration file "${configFile}" must be a regular file, not a symbolic link.`,
    );
  }
  if ((fileStats.mode & 0o777) !== FILE_MODE) {
    throw new ConfigurationFileError(
      `Configuration file "${configFile}" has unsafe mode ${formatMode(fileStats.mode)}; run "chmod 600 ${configFile}".`,
    );
  }
  await assertOwnedByCurrentUser(configFile, fileStats.uid, "Configuration file");
}

export async function loadConfiguration(configFile: string): Promise<RevoirConfiguration> {
  await assertConfigurationPermissions(configFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configFile, "utf8")) as unknown;
  } catch (error) {
    throw new ConfigurationFileError(`Configuration file "${configFile}" is not valid JSON.`, {
      cause: error,
    });
  }
  return validateConfiguration(parsed);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  const directoryStats = await lstat(path);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new ConfigurationFileError(
      `Protected application directory "${path}" must be a real directory, not a symbolic link.`,
    );
  }
  await chmod(path, DIRECTORY_MODE);
}

export async function writeConfiguration(
  configFile: string,
  configuration: RevoirConfiguration,
): Promise<void> {
  const validated = validateConfiguration(configuration);
  const configDir = dirname(configFile);
  await ensurePrivateDirectory(configDir);
  await Promise.all([
    ensurePrivateDirectory(validated.paths.cacheDir),
    ensurePrivateDirectory(validated.paths.stateDir),
    ensurePrivateDirectory(validated.paths.dataDir),
  ]);

  try {
    const existing = await lstat(configFile);
    if (existing.isSymbolicLink()) {
      throw new ConfigurationFileError(
        `Refusing to replace symbolic link "${configFile}". Remove it and run setup again.`,
      );
    }
  } catch (error) {
    if (
      error instanceof ConfigurationFileError ||
      (error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code !== "ENOENT")
    ) {
      throw error;
    }
  }

  const temporaryFile = join(configDir, `.config.json.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporaryFile, "wx", FILE_MODE);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(validated, undefined, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }

  try {
    await rename(temporaryFile, configFile);
    await chmod(configFile, FILE_MODE);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }
  await assertConfigurationPermissions(configFile);
}
