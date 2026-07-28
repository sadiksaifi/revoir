import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, normalize } from "node:path";

import type { BashOperations } from "@earendil-works/pi-coding-agent";

const HOST_BASH_EXECUTABLE = "/bin/bash";
const MAX_COMMAND_LENGTH = 4_096;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_LOG_COUNT = 200;
const MAX_TIMEOUT_MS = 2_147_483_647;
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

const STATIC_DIAGNOSTICS = new Set([
  "cat",
  "cmp",
  "comm",
  "cut",
  "diff",
  "file",
  "find",
  "grep",
  "head",
  "jq",
  "ls",
  "pwd",
  "rg",
  "sort",
  "stat",
  "strings",
  "tail",
  "tr",
  "type",
  "uniq",
  "wc",
  "xxd",
]);
const DIRECT_COMPILERS = new Set([
  "c++",
  "cc",
  "clang",
  "clang++",
  "g++",
  "gcc",
  "javac",
  "kotlinc",
  "rustc",
  "swiftc",
  "tsc",
]);
const DIRECT_TEST_RUNNERS = new Set(["ctest", "jest", "mocha", "pytest", "tsx", "vitest"]);
const PACKAGE_AND_LIFECYCLE_COMMANDS = new Set([
  "bundle",
  "bundler",
  "bun",
  "composer",
  "corepack",
  "gem",
  "npm",
  "npx",
  "pip",
  "pip3",
  "pipx",
  "pnpm",
  "uv",
  "yarn",
]);
const COMMAND_WRAPPERS = new Set([
  ".",
  "command",
  "doas",
  "env",
  "exec",
  "nice",
  "nohup",
  "source",
  "sudo",
  "time",
  "timeout",
  "xargs",
]);
const SHELL_INTERPRETERS = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);

const GIT_CONFIG_OVERRIDES = [
  ["color.ui", "false"],
  ["core.attributesFile", devNull],
  ["core.excludesFile", devNull],
  ["core.fsmonitor", "false"],
  ["core.pager", ""],
  ["core.untrackedCache", "false"],
  ["credential.helper", ""],
  ["diff.external", ""],
] as const;
const FIXED_GIT_ARGUMENTS = [
  "--no-pager",
  "-c",
  "color.ui=false",
  "-c",
  `core.attributesFile=${devNull}`,
  "-c",
  `core.excludesFile=${devNull}`,
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
] as const;
const SAFE_GIT_SUBCOMMAND_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
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
  bashExecutable?: string;
  maximumOutputBytes?: number;
  temporaryDirectory?: string;
  trustedPath?: string;
}

interface StaticCommand {
  executable: string;
  arguments: readonly string[];
}

interface StaticPipeline {
  commands: readonly StaticCommand[];
}

function denied(detail = "unsupported command"): never {
  throw new Error(
    `Revoir host Bash policy rejected ${detail}; only static diagnostics, direct tests or compilers, and read-only Git inspection are permitted.`,
  );
}

function pushWord(words: string[], value: string, started: boolean): void {
  if (started) {
    words.push(value);
  }
}

function parseStaticPipeline(command: string): StaticPipeline {
  if (
    command.length === 0 ||
    command.length > MAX_COMMAND_LENGTH ||
    command.includes("\0") ||
    command.includes("\r") ||
    command.includes("\n")
  ) {
    return denied("invalid command text");
  }

  const commands: StaticCommand[] = [];
  let words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | undefined;

  const finishWord = () => {
    pushWord(words, word, wordStarted);
    word = "";
    wordStarted = false;
  };
  const finishCommand = () => {
    finishWord();
    const [executable, ...arguments_] = words;
    if (executable === undefined || executable.length === 0) {
      return denied("an empty pipeline command");
    }
    commands.push({ executable, arguments: arguments_ });
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote === "'") {
      if (character === "'") {
        quote = undefined;
      } else {
        word += character;
      }
      wordStarted = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "$" || character === "`") {
        return denied("dynamic shell expansion");
      }
      if (character === "\\") {
        const escaped = command[index + 1];
        if (escaped === undefined || escaped === "\n") {
          return denied("dynamic shell expansion");
        }
        if (escaped === "$" || escaped === "`" || escaped === '"' || escaped === "\\") {
          word += escaped;
          index += 1;
          wordStarted = true;
          continue;
        }
      }
      word += character;
      wordStarted = true;
      continue;
    }

    if (character === "'") {
      quote = "'";
      wordStarted = true;
      continue;
    }
    if (character === '"') {
      quote = '"';
      wordStarted = true;
      continue;
    }
    if (character === "$" || character === "`") {
      return denied("dynamic shell expansion");
    }
    if (character === "\\") {
      const escaped = command[index + 1];
      if (escaped === undefined || escaped === "\n") {
        return denied("dynamic shell expansion");
      }
      word += escaped;
      wordStarted = true;
      index += 1;
      continue;
    }
    if (character === "|") {
      if (command[index + 1] === "|" || command[index + 1] === "&") {
        return denied("shell control flow");
      }
      finishCommand();
      continue;
    }
    if (
      character === ";" ||
      character === "&" ||
      character === "<" ||
      character === ">" ||
      character === "(" ||
      character === ")" ||
      character === "{" ||
      character === "}" ||
      character === "#"
    ) {
      return denied("shell control flow or redirection");
    }
    if (/\s/u.test(character)) {
      finishWord();
      continue;
    }
    word += character;
    wordStarted = true;
  }

  if (quote !== undefined) {
    return denied("invalid Bash syntax");
  }
  finishCommand();
  return { commands };
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
    return denied("unsafe Git path arguments");
  }
  const paths = arguments_.slice(separator + 1);
  if (!paths.every(isSafeRepositoryPath)) {
    return denied("unsafe Git path arguments");
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
      return denied("unsafe Git arguments");
    }
    revisions += 1;
    if (revisions > maximumRevisions) {
      return denied("unsafe Git arguments");
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
        return denied("unsafe Git arguments");
      }
      continue;
    }
    if (!REVISION.test(argument) || revisions > 0) {
      return denied("unsafe Git arguments");
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
    if (patternSeen || argument.startsWith("-") || argument.length > 256) {
      return denied("unsafe Git arguments");
    }
    patternSeen = true;
  }
  if (!patternSeen) {
    return denied("unsafe Git arguments");
  }
}

function validateGitCommand(arguments_: readonly string[]): void {
  if (arguments_.length === 1 && arguments_[0] === "--version") {
    return;
  }
  const [subcommand, ...subcommandArguments] = arguments_;
  if (subcommand === undefined) {
    return denied("an incomplete Git command");
  }

  switch (subcommand) {
    case "status":
      if (!subcommandArguments.every((argument) => STATUS_OPTIONS.has(argument))) {
        return denied("unsafe Git arguments");
      }
      return;
    case "diff":
      return validateDisplayArguments(subcommandArguments, DISPLAY_OPTIONS, 2);
    case "show":
      return validateDisplayArguments(subcommandArguments, DISPLAY_OPTIONS, 1);
    case "log":
      return validateLogArguments(subcommandArguments);
    case "grep":
      return validateGrepArguments(subcommandArguments);
    case "ls-files": {
      const { commandArguments } = splitPaths(subcommandArguments);
      if (!commandArguments.every((argument) => LS_FILES_OPTIONS.has(argument))) {
        return denied("unsafe Git arguments");
      }
      return;
    }
    case "ls-tree": {
      const { commandArguments } = splitPaths(subcommandArguments);
      const revisions = commandArguments.filter((argument) => REVISION.test(argument));
      if (
        revisions.length !== 1 ||
        !commandArguments.every(
          (argument) => LS_TREE_OPTIONS.has(argument) || REVISION.test(argument),
        )
      ) {
        return denied("unsafe Git arguments");
      }
      return;
    }
    case "cat-file":
      if (
        subcommandArguments.length !== 2 ||
        !new Set(["-p", "-s", "-t"]).has(subcommandArguments[0]!) ||
        !REVISION.test(subcommandArguments[1]!)
      ) {
        return denied("unsafe Git arguments");
      }
      return;
    case "rev-parse":
      if (
        (subcommandArguments.length === 1 &&
          (REVISION.test(subcommandArguments[0]!) ||
            new Set(["--is-inside-work-tree", "--show-prefix", "--show-toplevel"]).has(
              subcommandArguments[0]!,
            ))) ||
        (subcommandArguments.length === 2 &&
          subcommandArguments[0] === "--verify" &&
          REVISION.test(subcommandArguments[1]!))
      ) {
        return;
      }
      return denied("unsafe Git arguments");
    default:
      return denied("a mutating or unsupported Git command");
  }
}

function validateDiagnosticCommand(executable: string, arguments_: readonly string[]): void {
  if (executable === "find") {
    const deniedFindArguments = new Set([
      "-delete",
      "-exec",
      "-execdir",
      "-fls",
      "-fprint",
      "-fprint0",
      "-fprintf",
      "-ok",
      "-okdir",
    ]);
    if (arguments_.some((argument) => deniedFindArguments.has(argument))) {
      return denied("a mutating or dispatching find action");
    }
  }
  if (
    executable === "rg" &&
    arguments_.some(
      (argument) =>
        argument === "--pre" ||
        argument.startsWith("--pre=") ||
        argument === "--hostname-bin" ||
        argument.startsWith("--hostname-bin="),
    )
  ) {
    return denied("a diagnostic command subprocess hook");
  }
  if (
    executable === "sort" &&
    arguments_.some(
      (argument) =>
        argument === "-o" || argument === "--output" || argument.startsWith("--output="),
    )
  ) {
    return denied("diagnostic output redirection");
  }
}

function validateDirectCommand(executable: string, arguments_: readonly string[]): void {
  if (executable === "node") {
    if (!arguments_.some((argument) => argument === "--test" || argument.startsWith("--test="))) {
      return denied("non-test Node execution");
    }
    if (
      arguments_.some((argument) =>
        new Set(["-e", "--eval", "-p", "--print", "-c", "--check"]).has(argument),
      )
    ) {
      return denied("dynamic Node execution");
    }
    return;
  }
  if (executable === "python" || /^python3(?:\.[0-9]+)?$/u.test(executable)) {
    if (!(arguments_[0] === "-m" && arguments_[1] === "pytest")) {
      return denied("non-test Python execution");
    }
    return;
  }
  if (executable === "go") {
    if (arguments_[0] !== "test" && arguments_[0] !== "vet") {
      return denied("a non-diagnostic Go command");
    }
    return;
  }
  if (executable === "cargo") {
    if (!new Set(["check", "clippy", "test"]).has(arguments_[0] ?? "")) {
      return denied("a Cargo install or lifecycle command");
    }
    return;
  }
  if (executable === "make" || executable === "just") {
    if (arguments_.length !== 1 || arguments_[0] !== "test") {
      return denied("a non-test task-runner target");
    }
  }
}

function isCheckoutExecutable(executable: string): boolean {
  if (!executable.startsWith("./")) {
    return false;
  }
  const segments = executable.slice(2).split("/");
  return (
    segments.length > 0 &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function executableName(executable: string, trusted: ReadonlySet<string>): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(executable)) {
    return executable;
  }
  if (isCheckoutExecutable(executable)) {
    return basename(executable);
  }
  if (isAbsolute(executable) && trusted.has(dirname(executable))) {
    return basename(executable);
  }
  return denied("an untrusted executable path");
}

function validateStaticPipeline(pipeline: StaticPipeline, trusted: ReadonlySet<string>): void {
  for (const command of pipeline.commands) {
    const name = executableName(command.executable, trusted);
    if (
      PACKAGE_AND_LIFECYCLE_COMMANDS.has(name) ||
      COMMAND_WRAPPERS.has(name) ||
      SHELL_INTERPRETERS.has(name) ||
      name === "eval" ||
      name === "gh"
    ) {
      return denied("an installer, lifecycle command, wrapper, nested shell, or GitHub command");
    }
    if (name === "git") {
      validateGitCommand(command.arguments);
      continue;
    }
    if (STATIC_DIAGNOSTICS.has(name)) {
      validateDiagnosticCommand(name, command.arguments);
      continue;
    }
    if (
      DIRECT_COMPILERS.has(name) ||
      DIRECT_TEST_RUNNERS.has(name) ||
      name === "node" ||
      name === "python" ||
      /^python3(?:\.[0-9]+)?$/u.test(name) ||
      name === "go" ||
      name === "cargo" ||
      name === "make" ||
      name === "just"
    ) {
      validateDirectCommand(name, command.arguments);
      continue;
    }
    if (isCheckoutExecutable(command.executable)) {
      continue;
    }
    return denied("an unknown host command");
  }
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderStaticPipeline(pipeline: StaticPipeline, trusted: ReadonlySet<string>): string {
  return pipeline.commands
    .map((command) => {
      const name = executableName(command.executable, trusted);
      if (name !== "git" || command.arguments[0] === "--version") {
        return [command.executable, ...command.arguments].map(shellLiteral).join(" ");
      }
      const [subcommand, ...arguments_] = command.arguments;
      return [
        command.executable,
        ...FIXED_GIT_ARGUMENTS,
        subcommand!,
        ...(SAFE_GIT_SUBCOMMAND_ARGUMENTS[subcommand!] ?? []),
        ...arguments_,
      ]
        .map(shellLiteral)
        .join(" ");
    })
    .join(" | ");
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

async function executeBash(
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
    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      child.once("error", (error) => {
        settled = true;
        reject(error);
      });
      child.once("close", (code) => {
        settled = true;
        resolvePromise(code);
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

function defaultTrustedPath(): string {
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((directory) => isAbsolute(directory));
  return [...new Set(directories)].join(delimiter);
}

function parseTrustedDirectories(value: string): ReadonlySet<string> {
  const directories = value.split(delimiter);
  if (
    directories.length === 0 ||
    directories.some(
      (directory) =>
        directory.length === 0 ||
        !isAbsolute(directory) ||
        directory.includes("\0") ||
        normalize(directory) !== directory,
    )
  ) {
    return denied("an invalid trusted tool PATH");
  }
  return new Set(directories);
}

function reviewEnvironment(root: string, path: string): NodeJS.ProcessEnv {
  const temporary = join(root, "tmp");
  const macTextEncoding =
    process.platform === "darwin" && process.getuid !== undefined
      ? `0x${process.getuid().toString(16).toUpperCase()}:0x0:0x0`
      : undefined;
  const gitOverrides = Object.fromEntries(
    GIT_CONFIG_OVERRIDES.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  );
  return {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(GIT_CONFIG_OVERRIDES.length),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    HOME: join(root, "home"),
    LANG: "C",
    LC_ALL: "C",
    PATH: path,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    ...gitOverrides,
    ...(macTextEncoding === undefined ? {} : { __CF_USER_TEXT_ENCODING: macTextEncoding }),
  };
}

export function createReviewBashOperations(
  checkout: string,
  shellCommandMs: number,
  options: ReviewBashOperationsOptions = {},
): BashOperations {
  const executable = options.bashExecutable ?? HOST_BASH_EXECUTABLE;
  const maximumOutputBytes = options.maximumOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
  const path = options.trustedPath ?? defaultTrustedPath();
  const trusted = parseTrustedDirectories(path);
  if (!isAbsolute(executable) || !isAbsolute(temporaryDirectory)) {
    throw new Error("Review Bash executable and temporary directory must be absolute.");
  }
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes <= 0) {
    throw new Error("Review Bash output limit must be a positive safe integer.");
  }
  const maximumTimeoutSeconds = shellCommandMs / 1_000;

  return {
    async exec(command, _cwd, commandOptions) {
      const pipeline = parseStaticPipeline(command);
      validateStaticPipeline(pipeline, trusted);
      const executionCommand = renderStaticPipeline(pipeline, trusted);
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
      const deadline = Date.now() + timeoutSeconds * 1_000;
      const isolationRoot = await mkdtemp(join(temporaryDirectory, "revoir-review-command-"));
      try {
        const environment = reviewEnvironment(isolationRoot, path);
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

        const syntaxTimeoutMs = Math.max(1, deadline - Date.now());
        const syntax = await executeBash(
          executable,
          ["--noprofile", "--norc", "-n", "-c", command],
          checkout,
          environment,
          () => {},
          commandOptions.signal,
          syntaxTimeoutMs,
          timeoutSeconds,
          maximumOutputBytes,
        );
        if (syntax.exitCode !== 0) {
          return denied("invalid Bash syntax");
        }

        const executionTimeoutMs = deadline - Date.now();
        if (executionTimeoutMs <= 0) {
          throw new Error(`timeout:${timeoutSeconds}`);
        }
        return await executeBash(
          executable,
          ["--noprofile", "--norc", "-c", executionCommand],
          checkout,
          environment,
          commandOptions.onData,
          commandOptions.signal,
          executionTimeoutMs,
          timeoutSeconds,
          maximumOutputBytes,
        );
      } finally {
        await rm(isolationRoot, { recursive: true, force: true });
      }
    },
  };
}
