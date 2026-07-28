import { spawn } from "node:child_process";

import type { LaunchctlGateway, LaunchctlInspection } from "./manager.js";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(executable: string, arguments_: readonly string[]): Promise<ProcessResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  async run(executable: string, arguments_: readonly string[]): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, arguments_, {
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "C",
          LC_ALL: "C",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let overflow = false;

      const collect = (target: Buffer[], chunk: Buffer): void => {
        if (overflow) {
          return;
        }
        outputBytes += chunk.length;
        if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (overflow) {
          reject(new Error(`Process output exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes.`));
          return;
        }
        if (code === null) {
          reject(new Error(`Process terminated by ${signal ?? "an unknown signal"}.`));
          return;
        }
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  }
}

function isMissingService(result: ProcessResult): boolean {
  return (
    result.exitCode !== 0 &&
    /(?:could not find service|service .* not found|no such process)/iu.test(
      `${result.stdout}\n${result.stderr}`,
    )
  );
}

function parseInteger(output: string, field: string): number | undefined {
  const match = new RegExp(`^\\s*${field}\\s*=\\s*(-?\\d+)\\s*$`, "imu").exec(output);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parseInspection(output: string): LaunchctlInspection {
  const state = /^\s*state\s*=\s*(.+?)\s*$/imu.exec(output)?.[1];
  return {
    state,
    pid: parseInteger(output, "pid"),
    lastExitCode: parseInteger(output, "last exit code"),
  };
}

function failureDetail(result: ProcessResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return detail.replaceAll(/\s+/gu, " ");
}

export class LaunchctlProcessAdapter implements LaunchctlGateway {
  readonly #executable: string;
  readonly #runner: ProcessRunner;

  constructor(runner: ProcessRunner = new NodeProcessRunner(), executable = "/bin/launchctl") {
    this.#runner = runner;
    this.#executable = executable;
  }

  async inspect(target: string): Promise<LaunchctlInspection | undefined> {
    const result = await this.#run(["print", target], "print");
    if (result.exitCode === 0) {
      const inspection = parseInspection(result.stdout);
      if (
        inspection.state === undefined &&
        inspection.pid === undefined &&
        inspection.lastExitCode === undefined
      ) {
        throw new Error(
          "launchctl print returned unrecognized output; service health could not be established.",
        );
      }
      return inspection;
    }
    if (isMissingService(result)) {
      return undefined;
    }
    throw new Error(
      `launchctl print failed; launchctl may be unavailable or the user domain may be inaccessible: ${failureDetail(result)}`,
    );
  }

  async bootstrap(domain: string, plistFile: string): Promise<void> {
    const result = await this.#run(["bootstrap", domain, plistFile], "bootstrap");
    if (result.exitCode !== 0) {
      throw new Error(
        `launchctl bootstrap failed for an unloadable plist: ${failureDetail(result)}`,
      );
    }
  }

  async bootout(target: string): Promise<void> {
    const result = await this.#run(["bootout", target], "bootout");
    if (result.exitCode !== 0 && !isMissingService(result)) {
      throw new Error(`launchctl bootout failed: ${failureDetail(result)}`);
    }
  }

  async kickstart(target: string): Promise<void> {
    const result = await this.#run(["kickstart", "-k", target], "kickstart");
    if (result.exitCode !== 0) {
      throw new Error(`launchctl kickstart failed: ${failureDetail(result)}`);
    }
  }

  async #run(arguments_: readonly string[], operation: string): Promise<ProcessResult> {
    try {
      return await this.#runner.run(this.#executable, arguments_);
    } catch (error) {
      throw new Error(
        `launchctl ${operation} could not run. Verify that "${this.#executable}" exists and is executable.`,
        { cause: error },
      );
    }
  }
}
