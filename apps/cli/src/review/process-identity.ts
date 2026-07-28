import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export type ProcessIdentity =
  | { kind: "missing" }
  | { kind: "alive"; processBirth: string | undefined };

const PROCESS_INSPECTION_TIMEOUT_MS = 1_000;

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileSystemError(error, "ESRCH");
  }
}

export function linuxProcessBirth(stat: string, bootId: string): string | undefined {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) {
    return undefined;
  }

  // The fields after the command start at proc(5) field 3; starttime is field 22.
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startTime = fields[19];
  const normalizedBootId = bootId.trim();
  return startTime !== undefined &&
    /^\d+$/.test(startTime) &&
    /^[0-9a-f-]+$/i.test(normalizedBootId)
    ? `linux:${normalizedBootId}:${startTime}`
    : undefined;
}

export function darwinProcessBirth(output: string, pid: number): string | undefined {
  const normalized = output.trim().replace(/\s+/g, " ");
  const separator = normalized.indexOf(" ");
  if (separator < 0 || normalized.slice(0, separator) !== String(pid)) {
    return undefined;
  }
  const startedAt = normalized.slice(separator + 1);
  return startedAt.length === 0 ? undefined : `darwin:${startedAt}`;
}

async function inspectLinuxProcess(pid: number, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const [stat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal }),
      readFile("/proc/sys/kernel/random/boot_id", { encoding: "utf8", signal }),
    ]);
    return linuxProcessBirth(stat, bootId);
  } catch {
    return undefined;
  }
}

async function inspectDarwinProcess(
  pid: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-p", String(pid), "-o", "pid=", "-o", "lstart="],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        signal,
        timeout: PROCESS_INSPECTION_TIMEOUT_MS,
      },
      (error, stdout) => {
        resolve(error === null ? darwinProcessBirth(stdout, pid) : undefined);
      },
    );
  });
}

export async function inspectProcess(pid: number, signal?: AbortSignal): Promise<ProcessIdentity> {
  if (!processExists(pid)) {
    return { kind: "missing" };
  }

  const processBirth =
    process.platform === "linux"
      ? await inspectLinuxProcess(pid, signal)
      : process.platform === "darwin"
        ? await inspectDarwinProcess(pid, signal)
        : undefined;

  if (processBirth !== undefined) {
    return { kind: "alive", processBirth };
  }
  return processExists(pid) ? { kind: "alive", processBirth: undefined } : { kind: "missing" };
}
