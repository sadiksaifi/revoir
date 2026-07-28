import { dirname, isAbsolute, join } from "node:path";

import type { ApplicationPaths } from "../config/paths.js";

export const LAUNCH_AGENT_LABEL = "io.github.sadiksaifi.revoir";
export const LAUNCH_AGENT_THROTTLE_SECONDS = 30;
export const LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS = 30;

export interface LaunchAgentDefinition {
  label: string;
  programArguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  standardOutputPath: string;
  standardErrorPath: string;
  throttleIntervalSeconds: number;
  exitTimeoutSeconds: number;
}

export interface LaunchAgentInput {
  executableArguments: readonly string[];
  configFile: string;
  homeDir: string;
  paths: ApplicationPaths;
}

function requireAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path, received "${value}".`);
  }
}

export function createLaunchAgentDefinition(input: LaunchAgentInput): LaunchAgentDefinition {
  if (input.executableArguments.length === 0) {
    throw new Error("The LaunchAgent requires an executable.");
  }
  for (const [index, argument] of input.executableArguments.entries()) {
    if (index === 0) {
      requireAbsolutePath(argument, "The Revoir executable");
    }
  }
  requireAbsolutePath(input.configFile, "The configuration file");
  requireAbsolutePath(input.homeDir, "The user home directory");

  return {
    label: LAUNCH_AGENT_LABEL,
    programArguments: [...input.executableArguments, "run", "--config", input.configFile],
    environment: {
      HOME: input.homeDir,
      XDG_CACHE_HOME: dirname(input.paths.cacheDir),
      XDG_CONFIG_HOME: dirname(input.paths.configDir),
      XDG_DATA_HOME: dirname(input.paths.dataDir),
      XDG_STATE_HOME: dirname(input.paths.stateDir),
    },
    standardOutputPath: join(input.paths.stateDir, "logs", "launchd.stdout.log"),
    standardErrorPath: join(input.paths.stateDir, "logs", "launchd.stderr.log"),
    throttleIntervalSeconds: LAUNCH_AGENT_THROTTLE_SECONDS,
    exitTimeoutSeconds: LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderString(value: string, indentation: string): string {
  return `${indentation}<string>${escapeXml(value)}</string>`;
}

export function renderLaunchAgentPlist(definition: LaunchAgentDefinition): string {
  const argumentsXml = definition.programArguments
    .map((argument) => renderString(argument, "      "))
    .join("\n");
  const environmentXml = Object.entries(definition.environment)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => [
      `      <key>${escapeXml(key)}</key>`,
      renderString(value, "      "),
    ])
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
${renderString(definition.label, "    ")}
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environmentXml}
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>Crashed</key>
      <true/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>${definition.throttleIntervalSeconds}</integer>
    <key>ExitTimeOut</key>
    <integer>${definition.exitTimeoutSeconds}</integer>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
${renderString(definition.standardOutputPath, "    ")}
    <key>StandardErrorPath</key>
${renderString(definition.standardErrorPath, "    ")}
  </dict>
</plist>
`;
}
