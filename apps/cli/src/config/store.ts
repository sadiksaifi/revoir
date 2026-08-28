import {
  assertProtectedFile,
  ensurePrivateDirectory,
  loadProtectedJson,
  ProtectedFileError,
  writeProtectedJson,
} from "./protected-file.js";
import { type RevoirConfiguration, validateConfiguration } from "./schema.js";

export class ConfigurationFileError extends ProtectedFileError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationFileError";
  }
}

function translate(error: unknown): never {
  if (error instanceof ConfigurationFileError) throw error;
  if (error instanceof ProtectedFileError) {
    throw new ConfigurationFileError(error.message, { cause: error });
  }
  throw error;
}

export async function assertConfigurationPermissions(configFile: string): Promise<void> {
  try {
    await assertProtectedFile(configFile, "Configuration file");
  } catch (error) {
    translate(error);
  }
}

export async function loadConfiguration(configFile: string): Promise<RevoirConfiguration> {
  try {
    return validateConfiguration(await loadProtectedJson(configFile, "Configuration file"));
  } catch (error) {
    translate(error);
  }
}

export async function writeConfiguration(
  configFile: string,
  configuration: RevoirConfiguration,
): Promise<void> {
  const validated = validateConfiguration(configuration);
  try {
    await Promise.all([
      ensurePrivateDirectory(validated.paths.cacheDir, "Cache directory"),
      ensurePrivateDirectory(validated.paths.stateDir, "State directory"),
      ensurePrivateDirectory(validated.paths.dataDir, "Data directory"),
    ]);
    await writeProtectedJson(configFile, "Configuration file", validated);
  } catch (error) {
    translate(error);
  }
}
