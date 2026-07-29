import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ApplicationPaths } from "../config/paths.js";
import { LaunchctlProcessAdapter } from "./launchctl.js";
import {
  createLaunchAgentDefinition,
  LAUNCH_AGENT_LABEL,
  renderLaunchAgentPlist,
} from "./launchd.js";
import { prepareServiceLogFiles } from "./logging.js";

const PLIST_MODE = 0o600;

export interface LaunchctlInspection {
  state: string | undefined;
  pid: number | undefined;
  lastExitCode: number | undefined;
}

export interface LaunchctlGateway {
  inspect(target: string): Promise<LaunchctlInspection | undefined>;
  bootstrap(domain: string, plistFile: string): Promise<void>;
  bootout(target: string): Promise<void>;
  kickstart(target: string): Promise<void>;
}

export interface LaunchdServiceInput {
  configFile: string;
  executableArguments: readonly string[];
  homeDir: string;
  paths: ApplicationPaths;
  uid: number;
}

export interface ServiceStatus {
  state: "uninstalled" | "stopped" | "starting" | "healthy" | "failed";
  detail: string;
  pid?: number;
}

export interface ServiceManager {
  install(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
  uninstall(): Promise<void>;
}

export interface ServiceExecutableRuntime {
  executable: string;
  entryPoint: string | undefined;
  runtimeArguments: readonly string[];
  packaged: boolean;
}

export class ServiceManagementError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServiceManagementError";
  }
}

async function validateExecutable(executable: string): Promise<void> {
  try {
    const executableStats = await stat(executable);
    if (!executableStats.isFile()) {
      throw new Error("path is not a regular file");
    }
    await access(executable, constants.X_OK);
  } catch (error) {
    throw new ServiceManagementError(
      `Revoir cannot install the service because executable "${executable}" is unavailable or not executable. Install Revoir at an absolute executable path and retry.`,
      { cause: error },
    );
  }
}

async function writePlist(plistFile: string, contents: string): Promise<void> {
  const directory = dirname(plistFile);
  await mkdir(directory, { recursive: true });
  try {
    const existing = await lstat(plistFile);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new ServiceManagementError(
        `Refusing to replace unsafe LaunchAgent path "${plistFile}". Remove it manually only after verifying its target.`,
      );
    }
  } catch (error) {
    if (
      error instanceof ServiceManagementError ||
      (error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code !== "ENOENT")
    ) {
      throw error;
    }
  }

  const temporaryFile = `${plistFile}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryFile, "wx", PLIST_MODE);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(temporaryFile, plistFile);
    await chmod(plistFile, PLIST_MODE);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }
}

export class LaunchdServiceManager {
  readonly #definition: ReturnType<typeof createLaunchAgentDefinition>;
  readonly #domain: string;
  readonly #executable: string;
  readonly #expectedPlist: string;
  readonly #launchctl: LaunchctlGateway;
  readonly #stateDir: string;
  readonly #target: string;
  readonly plistFile: string;

  constructor(input: LaunchdServiceInput, launchctl: LaunchctlGateway) {
    this.#definition = createLaunchAgentDefinition({
      executableArguments: input.executableArguments,
      configFile: input.configFile,
      homeDir: input.homeDir,
      paths: input.paths,
    });
    this.#expectedPlist = renderLaunchAgentPlist(this.#definition);
    const executable = input.executableArguments[0];
    if (executable === undefined) {
      throw new ServiceManagementError("The Revoir service requires an executable.");
    }
    this.#executable = executable;
    this.#domain = `gui/${input.uid}`;
    this.#stateDir = input.paths.stateDir;
    this.#target = `${this.#domain}/${LAUNCH_AGENT_LABEL}`;
    this.plistFile = join(input.homeDir, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
    this.#launchctl = launchctl;
  }

  async install(): Promise<void> {
    await validateExecutable(this.#executable);
    await prepareServiceLogFiles(this.#stateDir);
    if ((await this.#launchctl.inspect(this.#target)) !== undefined) {
      await this.#launchctl.bootout(this.#target);
    }
    await writePlist(this.plistFile, this.#expectedPlist);
    try {
      await this.#launchctl.bootstrap(this.#domain, this.plistFile);
    } catch (error) {
      throw new ServiceManagementError(
        `The LaunchAgent definition was written to "${this.plistFile}", but launchd could not load it. Run "revoir status" for diagnostics.`,
        { cause: error },
      );
    }
  }

  async start(): Promise<void> {
    await validateExecutable(this.#executable);
    await this.#assertInstalledDefinition();
    const inspection = await this.#launchctl.inspect(this.#target);
    if (inspection === undefined) {
      await this.#launchctl.bootstrap(this.#domain, this.plistFile);
      return;
    }
    if (
      inspection.state?.toLowerCase() === "running" &&
      inspection.pid !== undefined &&
      inspection.pid > 0
    ) {
      return;
    }
    if (
      inspection.lastExitCode === undefined &&
      ["waiting", "starting", "spawn scheduled"].includes(
        inspection.state?.toLowerCase() ?? "waiting",
      )
    ) {
      return;
    }
    await this.#launchctl.kickstart(this.#target);
  }

  async stop(): Promise<void> {
    if ((await this.#launchctl.inspect(this.#target)) !== undefined) {
      await this.#launchctl.bootout(this.#target);
    }
  }

  async status(): Promise<ServiceStatus> {
    const inspection = await this.#launchctl.inspect(this.#target);
    const plistState = await this.#readPlistState();
    if (plistState === "missing") {
      if (inspection !== undefined) {
        return {
          state: "failed",
          detail:
            'launchd has a loaded Revoir service without its generated plist. Run "revoir uninstall", then "revoir install".',
        };
      }
      return {
        state: "uninstalled",
        detail: `LaunchAgent is not installed at "${this.plistFile}". Run "revoir install".`,
      };
    }
    if (plistState !== "valid") {
      return { state: "failed", detail: plistState };
    }
    try {
      await validateExecutable(this.#executable);
    } catch (error) {
      return {
        state: "failed",
        detail:
          error instanceof Error
            ? error.message
            : "The configured Revoir executable is unavailable.",
      };
    }
    if (inspection === undefined) {
      return {
        state: "stopped",
        detail: 'LaunchAgent is installed but stopped. Run "revoir start".',
      };
    }
    if (
      inspection.state?.toLowerCase() === "running" &&
      inspection.pid !== undefined &&
      inspection.pid > 0
    ) {
      return {
        state: "healthy",
        detail: `LaunchAgent is healthy with process ${inspection.pid}.`,
        pid: inspection.pid,
      };
    }
    if (inspection.lastExitCode !== undefined && inspection.lastExitCode !== 0) {
      return {
        state: "failed",
        detail: `LaunchAgent failed with exit code ${inspection.lastExitCode}. Inspect "revoir logs", fix the reported configuration or executable problem, then run "revoir start".`,
      };
    }
    if (
      inspection.lastExitCode === 0 &&
      ["exited", "stopped", "not running"].includes(inspection.state?.toLowerCase() ?? "stopped")
    ) {
      return {
        state: "stopped",
        detail: 'LaunchAgent is loaded but stopped. Run "revoir start".',
      };
    }
    if (
      ["waiting", "starting", "spawn scheduled"].includes(
        inspection.state?.toLowerCase() ?? "waiting",
      )
    ) {
      return {
        state: "starting",
        detail: "LaunchAgent is loaded and waiting for launchd to start it.",
      };
    }
    return {
      state: "failed",
      detail: `launchd reports the service as "${inspection.state ?? "unknown"}" without a process identifier. Run "revoir stop", then "revoir start"; reinstall if the problem persists.`,
    };
  }

  async uninstall(): Promise<void> {
    if ((await this.#launchctl.inspect(this.#target)) !== undefined) {
      await this.#launchctl.bootout(this.#target);
    }
    try {
      const existing = await lstat(this.plistFile);
      if (!existing.isFile() && !existing.isSymbolicLink()) {
        throw new ServiceManagementError(
          `Refusing to remove non-file LaunchAgent path "${this.plistFile}".`,
        );
      }
      await unlink(this.plistFile);
    } catch (error) {
      if (
        error instanceof ServiceManagementError ||
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
  }

  async #assertInstalledDefinition(): Promise<void> {
    const plistState = await this.#readPlistState();
    if (plistState === "missing") {
      throw new ServiceManagementError(
        `LaunchAgent is not installed at "${this.plistFile}". Run "revoir install" first.`,
      );
    }
    if (plistState !== "valid") {
      throw new ServiceManagementError(plistState);
    }
  }

  async #readPlistState(): Promise<"missing" | "valid" | string> {
    try {
      const existing = await lstat(this.plistFile);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        return `LaunchAgent path "${this.plistFile}" is unsafe. Run "revoir uninstall", verify the path, then reinstall.`;
      }
      const contents = await readFile(this.plistFile, "utf8");
      if (contents !== this.#expectedPlist) {
        return `LaunchAgent definition at "${this.plistFile}" does not match this Revoir installation. Run "revoir install" to replace it safely.`;
      }
      return "valid";
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return "missing";
      }
      throw new ServiceManagementError(
        `Unable to inspect LaunchAgent definition "${this.plistFile}".`,
        { cause: error },
      );
    }
  }
}

export function resolveServiceExecutableArguments(
  runtime: ServiceExecutableRuntime,
): readonly string[] {
  const executable = resolve(runtime.executable);
  if (runtime.packaged) {
    return [executable];
  }
  const entryPoint = runtime.entryPoint === undefined ? undefined : resolve(runtime.entryPoint);
  if (entryPoint === undefined || entryPoint === executable) {
    return [executable];
  }
  return [executable, ...runtime.runtimeArguments, entryPoint];
}

function currentExecutableArguments(): readonly string[] {
  return resolveServiceExecutableArguments({
    executable: process.execPath,
    entryPoint: process.argv[1],
    runtimeArguments: process.execArgv,
    packaged: "pkg" in process,
  });
}

export function createDefaultServiceManager(input: {
  configFile: string;
  homeDir: string;
  paths: ApplicationPaths;
}): ServiceManager {
  if (process.platform !== "darwin") {
    throw new ServiceManagementError(
      'Revoir service commands require macOS launchd. Run the daemon directly with "revoir run" on this platform.',
    );
  }
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 1) {
    throw new ServiceManagementError(
      "Revoir could not determine a non-admin macOS user domain. Do not run service commands with sudo.",
    );
  }
  return new LaunchdServiceManager(
    {
      configFile: input.configFile,
      executableArguments: currentExecutableArguments(),
      homeDir: input.homeDir,
      paths: input.paths,
      uid,
    },
    new LaunchctlProcessAdapter(),
  );
}
