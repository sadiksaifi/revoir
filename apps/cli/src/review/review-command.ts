import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";

import type { BashOperations } from "@earendil-works/pi-coding-agent";

const DEFAULT_SHELL_EXECUTABLE = "/bin/bash";
const DEFAULT_SHELL_ARGUMENTS = ["-l", "-i", "-c"] as const;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ReviewBashOperationsOptions {
  shellExecutable?: string;
  shellArguments?: readonly string[];
  maximumOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
}

function terminateProcess(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process group has already exited.
    }
  }
}

async function executeShell(
  executable: string,
  arguments_: readonly string[],
  checkout: string,
  environment: NodeJS.ProcessEnv,
  onData: (data: Buffer) => void,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutSeconds: number,
  maximumOutputBytes: number,
): Promise<{ exitCode: number | null }> {
  if (signal?.aborted) {
    throw new Error("aborted");
  }

  const child = spawn(executable, [...arguments_], {
    cwd: checkout,
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let outputBytes = 0;
  let outputLimitExceeded = false;
  const handleData = (data: Buffer) => {
    const remaining = maximumOutputBytes - outputBytes;
    if (remaining > 0) {
      const accepted = data.length <= remaining ? data : data.subarray(0, remaining);
      outputBytes += accepted.length;
      onData(accepted);
    }
    if (data.length > remaining) {
      outputLimitExceeded = true;
      terminateProcess(child.pid);
    }
  };
  child.stdout.on("data", handleData);
  child.stderr.on("data", handleData);

  let timedOut = false;
  const terminate = () => terminateProcess(child.pid);
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  signal?.addEventListener("abort", terminate, { once: true });

  let settled = false;
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", (error) => {
        settled = true;
        reject(error);
      });
      child.once("close", (code) => {
        settled = true;
        resolve(code);
      });
      if (signal?.aborted) {
        terminate();
      }
    });
    if (signal?.aborted) {
      throw new Error("aborted");
    }
    if (timedOut) {
      throw new Error(`timeout:${timeoutSeconds}`);
    }
    if (outputLimitExceeded) {
      throw new Error(`output-limit:${maximumOutputBytes}`);
    }
    return { exitCode };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", terminate);
    if (!settled) {
      terminate();
    }
  }
}

function defaultShellExecutable(): string {
  const configured = process.env.SHELL;
  if (configured !== undefined && isAbsolute(configured)) {
    return configured;
  }
  const accountShell = userInfo().shell;
  return accountShell !== null && accountShell !== "" && isAbsolute(accountShell)
    ? accountShell
    : DEFAULT_SHELL_EXECUTABLE;
}

export function createReviewBashOperations(
  checkout: string,
  shellCommandMs: number,
  options: ReviewBashOperationsOptions = {},
): BashOperations {
  const executable = options.shellExecutable ?? defaultShellExecutable();
  const shellArguments = options.shellArguments ?? DEFAULT_SHELL_ARGUMENTS;
  const maximumOutputBytes = options.maximumOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!isAbsolute(executable)) {
    throw new Error("Review shell executable must be absolute.");
  }
  if (shellArguments.some((argument) => argument.includes("\0"))) {
    throw new Error("Review shell arguments must not contain null bytes.");
  }
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes <= 0) {
    throw new Error("Review shell output limit must be a positive safe integer.");
  }
  const maximumTimeoutSeconds = shellCommandMs / 1_000;

  return {
    async exec(command, _cwd, commandOptions) {
      const requestedTimeout = commandOptions.timeout ?? maximumTimeoutSeconds;
      if (
        !Number.isFinite(requestedTimeout) ||
        requestedTimeout <= 0 ||
        !Number.isFinite(maximumTimeoutSeconds) ||
        maximumTimeoutSeconds <= 0 ||
        maximumTimeoutSeconds * 1_000 > MAX_TIMEOUT_MS
      ) {
        throw new Error("Invalid timeout: must be a finite positive number of seconds.");
      }
      const timeoutSeconds = Math.min(requestedTimeout, maximumTimeoutSeconds);
      const environment = options.environment ?? commandOptions.env ?? process.env;
      return executeShell(
        executable,
        [...shellArguments, command],
        checkout,
        environment,
        commandOptions.onData,
        commandOptions.signal,
        timeoutSeconds * 1_000,
        timeoutSeconds,
        maximumOutputBytes,
      );
    },
  };
}
