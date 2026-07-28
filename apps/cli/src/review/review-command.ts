import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { BashOperations } from "@earendil-works/pi-coding-agent";

const HOST_GIT_EXECUTABLE =
  process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
const MAX_COMMAND_LENGTH = 4_096;
const MAX_LOG_COUNT = 200;
const MAX_TIMEOUT_MS = 2_147_483_647;
const LITERAL_TOKEN = /^[\p{L}\p{N}._/,:@%+=~^-]+$/u;
const SAFE_PATH_TOKEN = /^[\p{L}\p{N}._/@%+=,-]+$/u;
const REVISION_ATOM = String.raw`(?:HEAD|[0-9A-Fa-f]{7,64})(?:[~^][0-9]{1,3})*`;
const REVISION = new RegExp(`^${REVISION_ATOM}(?:\\.{2,3}${REVISION_ATOM})?$`, "u");

const DISPLAY_OPTIONS = new Set([
  "--name-only",
  "--name-status",
  "--no-color",
  "--no-patch",
  "--patch",
  "--shortstat",
  "--stat",
  "--summary",
  "-p",
]);
const STATUS_OPTIONS = new Set([
  "--branch",
  "--porcelain",
  "--porcelain=v1",
  "--porcelain=v2",
  "--short",
  "--untracked-files=all",
  "--untracked-files=no",
  "--untracked-files=normal",
]);
const LOG_OPTIONS = new Set([
  ...DISPLAY_OPTIONS,
  "--all",
  "--decorate=no",
  "--format=medium",
  "--format=oneline",
  "--format=short",
  "--no-decorate",
  "--no-merges",
  "--oneline",
]);
const GREP_OPTIONS = new Set(["--ignore-case", "--line-number", "--word-regexp", "-i", "-n", "-w"]);
const LS_FILES_OPTIONS = new Set([
  "--cached",
  "--deleted",
  "--exclude-standard",
  "--modified",
  "--others",
  "--stage",
  "--unmerged",
]);
const LS_TREE_OPTIONS = new Set([
  "--full-tree",
  "--long",
  "--name-only",
  "--name-status",
  "-d",
  "-l",
  "-r",
  "-t",
]);

const FIXED_GIT_ARGUMENTS = [
  "--no-pager",
  "-c",
  "color.ui=false",
  "-c",
  "core.attributesFile=" + devNull,
  "-c",
  "core.excludesFile=" + devNull,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "credential.helper=",
  "-c",
  "diff.external=",
];

const SAFE_SUBCOMMAND_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  "cat-file": [],
  diff: ["--no-color", "--no-ext-diff", "--no-textconv"],
  grep: ["--fixed-strings", "--line-number", "--no-color"],
  log: ["--max-count=200", "--no-color", "--no-ext-diff", "--no-textconv"],
  "ls-files": [],
  "ls-tree": [],
  "rev-parse": [],
  show: ["--no-color", "--no-ext-diff", "--no-textconv"],
  status: [],
};

export interface ReviewBashOperationsOptions {
  gitExecutable?: string;
  temporaryDirectory?: string;
}

function denied(): never {
  throw new Error("Revoir review policy permits only literal read-only Git inspection commands.");
}

function literalTokens(command: string): readonly string[] {
  if (
    command.length === 0 ||
    command.length > MAX_COMMAND_LENGTH ||
    !/^[^ ]+(?: [^ ]+)*$/u.test(command)
  ) {
    return denied();
  }
  const tokens = command.split(" ");
  if (tokens.some((token) => !LITERAL_TOKEN.test(token))) {
    return denied();
  }
  return tokens;
}

function isSafeRepositoryPath(value: string): boolean {
  if (
    !SAFE_PATH_TOKEN.test(value) ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.includes("//")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== ".git",
  );
}

function splitPaths(arguments_: readonly string[]): {
  commandArguments: readonly string[];
  paths: readonly string[];
} {
  const separator = arguments_.indexOf("--");
  if (separator < 0) {
    return { commandArguments: arguments_, paths: [] };
  }
  if (arguments_.lastIndexOf("--") !== separator || separator === arguments_.length - 1) {
    return denied();
  }
  const paths = arguments_.slice(separator + 1);
  if (!paths.every(isSafeRepositoryPath)) {
    return denied();
  }
  return { commandArguments: arguments_.slice(0, separator), paths };
}

function validateDisplayArguments(
  arguments_: readonly string[],
  options: ReadonlySet<string>,
  maximumRevisions: number,
): void {
  const { commandArguments } = splitPaths(arguments_);
  let revisions = 0;
  for (const argument of commandArguments) {
    if (
      options.has(argument) ||
      /^--unified=(?:[0-9]|1[0-9]|20)$/u.test(argument) ||
      /^-U(?:[0-9]|1[0-9]|20)$/u.test(argument)
    ) {
      continue;
    }
    if (!REVISION.test(argument)) {
      return denied();
    }
    revisions += 1;
    if (revisions > maximumRevisions) {
      return denied();
    }
  }
}

function validateLogArguments(arguments_: readonly string[]): void {
  const { commandArguments } = splitPaths(arguments_);
  let revisions = 0;
  for (const argument of commandArguments) {
    if (LOG_OPTIONS.has(argument)) {
      continue;
    }
    const count = /^--max-count=([0-9]+)$/u.exec(argument);
    if (count !== null) {
      const value = Number.parseInt(count[1]!, 10);
      if (value < 1 || value > MAX_LOG_COUNT) {
        return denied();
      }
      continue;
    }
    if (!REVISION.test(argument) || revisions > 0) {
      return denied();
    }
    revisions += 1;
  }
}

function validateGrepArguments(arguments_: readonly string[]): void {
  const { commandArguments } = splitPaths(arguments_);
  let patternSeen = false;
  for (const argument of commandArguments) {
    if (!patternSeen && GREP_OPTIONS.has(argument)) {
      continue;
    }
    if (
      patternSeen ||
      argument.startsWith("-") ||
      argument.length > 256 ||
      !LITERAL_TOKEN.test(argument)
    ) {
      return denied();
    }
    patternSeen = true;
  }
  if (!patternSeen) {
    return denied();
  }
}

function validateLsFilesArguments(arguments_: readonly string[]): void {
  const { commandArguments } = splitPaths(arguments_);
  if (!commandArguments.every((argument) => LS_FILES_OPTIONS.has(argument))) {
    return denied();
  }
}

function validateLsTreeArguments(arguments_: readonly string[]): void {
  const { commandArguments } = splitPaths(arguments_);
  const revisions = commandArguments.filter((argument) => REVISION.test(argument));
  if (
    revisions.length !== 1 ||
    !commandArguments.every((argument) => LS_TREE_OPTIONS.has(argument) || REVISION.test(argument))
  ) {
    return denied();
  }
}

function validateCatFileArguments(arguments_: readonly string[]): void {
  if (
    arguments_.length !== 2 ||
    !new Set(["-p", "-s", "-t"]).has(arguments_[0]!) ||
    !REVISION.test(arguments_[1]!)
  ) {
    return denied();
  }
}

function validateRevParseArguments(arguments_: readonly string[]): void {
  if (
    (arguments_.length === 1 &&
      (REVISION.test(arguments_[0]!) ||
        new Set(["--is-inside-work-tree", "--show-prefix", "--show-toplevel"]).has(
          arguments_[0]!,
        ))) ||
    (arguments_.length === 2 && arguments_[0] === "--verify" && REVISION.test(arguments_[1]!))
  ) {
    return;
  }
  return denied();
}

function parseReviewCommand(command: string): readonly string[] {
  const [executable, subcommand, ...arguments_] = literalTokens(command);
  if (executable !== "git" || subcommand === undefined) {
    return denied();
  }

  switch (subcommand) {
    case "status":
      if (!arguments_.every((argument) => STATUS_OPTIONS.has(argument))) {
        return denied();
      }
      break;
    case "diff":
      validateDisplayArguments(arguments_, DISPLAY_OPTIONS, 2);
      break;
    case "show":
      validateDisplayArguments(arguments_, DISPLAY_OPTIONS, 1);
      break;
    case "log":
      validateLogArguments(arguments_);
      break;
    case "grep":
      validateGrepArguments(arguments_);
      break;
    case "ls-files":
      validateLsFilesArguments(arguments_);
      break;
    case "ls-tree":
      validateLsTreeArguments(arguments_);
      break;
    case "cat-file":
      validateCatFileArguments(arguments_);
      break;
    case "rev-parse":
      validateRevParseArguments(arguments_);
      break;
    default:
      return denied();
  }

  return [
    ...FIXED_GIT_ARGUMENTS,
    subcommand,
    ...(SAFE_SUBCOMMAND_ARGUMENTS[subcommand] ?? []),
    ...arguments_,
  ];
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
      // The process has already exited.
    }
  }
}

async function executeGit(
  executable: string,
  arguments_: readonly string[],
  checkout: string,
  environment: NodeJS.ProcessEnv,
  onData: (data: Buffer) => void,
  signal: AbortSignal | undefined,
  timeoutSeconds: number,
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
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  let timedOut = false;
  const terminate = () => terminateProcess(child.pid);
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutSeconds * 1_000);
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
    return { exitCode };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", terminate);
    if (!settled) {
      terminate();
    }
  }
}

function reviewEnvironment(root: string): NodeJS.ProcessEnv {
  const temporary = join(root, "tmp");
  const macTextEncoding =
    process.platform === "darwin" && process.getuid !== undefined
      ? `0x${process.getuid().toString(16).toUpperCase()}:0x0:0x0`
      : undefined;
  return {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    HOME: join(root, "home"),
    LANG: "C",
    LC_ALL: "C",
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    ...(macTextEncoding === undefined ? {} : { __CF_USER_TEXT_ENCODING: macTextEncoding }),
  };
}

export function createReviewBashOperations(
  checkout: string,
  shellCommandMs: number,
  options: ReviewBashOperationsOptions = {},
): BashOperations {
  const executable = options.gitExecutable ?? HOST_GIT_EXECUTABLE;
  const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
  if (!isAbsolute(executable) || !isAbsolute(temporaryDirectory)) {
    throw new Error("Review command executable and temporary directory must be absolute.");
  }
  const maximumTimeoutSeconds = shellCommandMs / 1_000;

  return {
    async exec(command, _cwd, commandOptions) {
      const commandArguments = parseReviewCommand(command);
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
      const isolationRoot = await mkdtemp(join(temporaryDirectory, "revoir-review-command-"));
      try {
        const environment = reviewEnvironment(isolationRoot);
        await Promise.all(
          [
            environment.HOME,
            environment.TMPDIR,
            environment.XDG_CACHE_HOME,
            environment.XDG_CONFIG_HOME,
            environment.XDG_DATA_HOME,
            environment.XDG_STATE_HOME,
          ].map((directory) => mkdir(directory!, { recursive: true, mode: 0o700 })),
        );
        return await executeGit(
          executable,
          commandArguments,
          checkout,
          environment,
          commandOptions.onData,
          commandOptions.signal,
          timeoutSeconds,
        );
      } finally {
        await rm(isolationRoot, { recursive: true, force: true });
      }
    },
  };
}
