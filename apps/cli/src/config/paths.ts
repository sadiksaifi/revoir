import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface ApplicationPaths {
  configDir: string;
  configFile: string;
  policyFile: string;
  setupCheckpointFile: string;
  commandLockFile: string;
  cacheDir: string;
  stateDir: string;
  dataDir: string;
}

export type PathEnvironment = Readonly<Record<string, string | undefined>>;

function resolveXdgBase(
  environment: PathEnvironment,
  name: "XDG_CONFIG_HOME" | "XDG_CACHE_HOME" | "XDG_STATE_HOME" | "XDG_DATA_HOME",
  fallback: string,
): string {
  const configured = environment[name];
  if (configured === undefined || configured === "") {
    return fallback;
  }
  if (!isAbsolute(configured)) {
    throw new Error(`${name} must be an absolute path, received "${configured}".`);
  }
  return configured;
}

export function resolveApplicationPaths(
  environment: PathEnvironment = process.env,
  userHome = homedir(),
): ApplicationPaths {
  if (!isAbsolute(userHome)) {
    throw new Error(`The user home directory must be an absolute path, received "${userHome}".`);
  }

  const configDir = join(
    resolveXdgBase(environment, "XDG_CONFIG_HOME", join(userHome, ".config")),
    "revoir",
  );

  return {
    configDir,
    configFile: join(configDir, "config.json"),
    policyFile: join(configDir, "policy.json"),
    setupCheckpointFile: join(configDir, "setup-checkpoint.json"),
    commandLockFile: join(configDir, "command.lock"),
    cacheDir: join(
      resolveXdgBase(environment, "XDG_CACHE_HOME", join(userHome, ".cache")),
      "revoir",
    ),
    stateDir: join(
      resolveXdgBase(environment, "XDG_STATE_HOME", join(userHome, ".local", "state")),
      "revoir",
    ),
    dataDir: join(
      resolveXdgBase(environment, "XDG_DATA_HOME", join(userHome, ".local", "share")),
      "revoir",
    ),
  };
}

export function scopeApplicationPathsToConfig(
  paths: ApplicationPaths,
  configFile: string,
): ApplicationPaths {
  if (configFile === paths.configFile) return paths;
  return {
    ...paths,
    configDir: dirname(configFile),
    configFile,
    policyFile: `${configFile}.policy.json`,
    setupCheckpointFile: `${configFile}.setup-checkpoint.json`,
    commandLockFile: `${configFile}.command.lock`,
  };
}
