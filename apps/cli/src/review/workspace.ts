import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PullRequestReference, PullRequestSnapshot } from "./pull-request.js";
import { createTerminalHandle, type TerminalHandle } from "./terminal-handle.js";

const executeFile = promisify(execFile);

export interface CommandOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(
    command: string,
    arguments_: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult>;
}

export class SystemCommandRunner implements CommandRunner {
  async run(
    command: string,
    arguments_: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    try {
      const result = await executeFile(command, [...arguments_], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.environment === undefined ? {} : { env: options.environment }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const detail =
        typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof error.stderr === "string"
          ? `: ${error.stderr.trim()}`
          : "";
      throw new Error(`${command} failed${detail}`, { cause: error });
    }
  }
}

export interface PreparedWorkspace {
  root: string;
  checkout: string;
  diff: string;
  remoteUrl: string;
  cleanup(): Promise<void>;
}

export interface WorkspacePreparer {
  prepare(
    reference: PullRequestReference,
    pullRequest: PullRequestSnapshot,
    installationToken: string,
    signal: AbortSignal,
  ): Promise<PreparedWorkspace>;
}

export class WorkspacePreparationError extends AggregateError {
  readonly cleanup: TerminalHandle;

  constructor(primary: Error, cleanupFailure: Error, cleanup: TerminalHandle) {
    super(
      [primary, cleanupFailure],
      "Workspace preparation failed and partial workspace cleanup also failed.",
    );
    this.name = "WorkspacePreparationError";
    this.cleanup = cleanup;
  }
}

export interface GitWorkspacePreparerHooks {
  remove?(path: string, options: { recursive: true; force: true }): Promise<void>;
}

const ASKPASS = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$REVOIR_GIT_USERNAME" ;;
  *) printf '%s\\n' "$REVOIR_GIT_PASSWORD" ;;
esac
`;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Review was cancelled.");
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function redactError(value: unknown, secret: string): Error {
  const source = asError(value);
  const redacted = new Error(source.message.split(secret).join("[REDACTED]"));
  redacted.name = source.name;
  return redacted;
}

export class GitWorkspacePreparer implements WorkspacePreparer {
  readonly #cacheDirectory: string;
  readonly #remove: NonNullable<GitWorkspacePreparerHooks["remove"]>;
  readonly #shellTimeoutMs: number;
  readonly #runner: CommandRunner;

  constructor(
    cacheDirectory: string,
    shellTimeoutMs: number,
    runner: CommandRunner = new SystemCommandRunner(),
    hooks: GitWorkspacePreparerHooks = {},
  ) {
    this.#cacheDirectory = cacheDirectory;
    this.#remove = hooks.remove ?? rm;
    this.#shellTimeoutMs = shellTimeoutMs;
    this.#runner = runner;
  }

  async prepare(
    reference: PullRequestReference,
    pullRequest: PullRequestSnapshot,
    installationToken: string,
    signal: AbortSignal,
  ): Promise<PreparedWorkspace> {
    throwIfAborted(signal);
    const checkoutsDirectory = join(this.#cacheDirectory, "checkouts");
    await mkdir(checkoutsDirectory, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(
      join(
        checkoutsDirectory,
        `${reference.owner}-${reference.repository}-pr-${reference.number}-`,
      ),
    );
    const cleanup = createTerminalHandle(() =>
      this.#remove(root, { recursive: true, force: true }),
    );
    const askpass = join(root, "git-askpass.sh");
    const checkout = join(root, "repository");
    const emptyTemplate = join(root, "git-template");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_ASKPASS: askpass,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_TERMINAL_PROMPT: "0",
      REVOIR_GIT_PASSWORD: installationToken,
      REVOIR_GIT_USERNAME: "x-access-token",
    };
    const runGit = async (
      arguments_: readonly string[],
      cwd?: string,
      commandEnvironment: NodeJS.ProcessEnv = environment,
    ): Promise<CommandResult> => {
      throwIfAborted(signal);
      return this.#runner.run("git", arguments_, {
        ...(cwd === undefined ? {} : { cwd }),
        environment: commandEnvironment,
        signal,
        timeoutMs: this.#shellTimeoutMs,
      });
    };

    try {
      await writeFile(askpass, ASKPASS, { mode: 0o700 });
      await chmod(askpass, 0o700);
      await mkdir(emptyTemplate, { mode: 0o700 });
      await runGit([
        "clone",
        "--no-checkout",
        "--filter=blob:none",
        `--template=${emptyTemplate}`,
        "--origin",
        "origin",
        pullRequest.baseRepository.cloneUrl,
        checkout,
      ]);
      await runGit(
        ["fetch", "--no-tags", "origin", pullRequest.baseSha, pullRequest.headSha],
        checkout,
      );
      await runGit(["checkout", "--detach", pullRequest.headSha], checkout);
      const diffEnvironment = { ...environment };
      delete diffEnvironment.GIT_EXTERNAL_DIFF;
      delete diffEnvironment.GIT_DIFF_OPTS;
      delete diffEnvironment.GIT_ATTR_GLOBAL;
      delete diffEnvironment.GIT_ATTR_SOURCE;
      delete diffEnvironment.GIT_ATTR_SYSTEM;
      diffEnvironment.GIT_ATTR_NOSYSTEM = "1";
      diffEnvironment.GIT_CONFIG_NOSYSTEM = "1";
      diffEnvironment.GIT_CONFIG_GLOBAL = devNull;
      const diff = await runGit(
        [
          "-c",
          "color.ui=false",
          "-c",
          "color.diff=false",
          "-c",
          "diff.noprefix=false",
          "-c",
          "diff.mnemonicPrefix=false",
          "-c",
          "diff.renames=true",
          "-c",
          "diff.renameLimit=0",
          "-c",
          "diff.algorithm=myers",
          "-c",
          "diff.indentHeuristic=false",
          "-c",
          "diff.context=3",
          "-c",
          "diff.interHunkContext=0",
          "-c",
          "diff.suppressBlankEmpty=false",
          "-c",
          "diff.submodule=short",
          "-c",
          "core.quotePath=true",
          "-c",
          `core.attributesFile=${devNull}`,
          `--attr-source=${pullRequest.headSha}`,
          "diff",
          "--patch",
          "--find-renames=50%",
          "-l0",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--diff-algorithm=myers",
          "--no-indent-heuristic",
          "--unified=3",
          "--inter-hunk-context=0",
          "--binary",
          "--no-relative",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--output-indicator-new=+",
          "--output-indicator-old=-",
          "--output-indicator-context= ",
          "--submodule=short",
          "--ignore-submodules=none",
          `${pullRequest.baseSha}...${pullRequest.headSha}`,
          "--",
        ],
        checkout,
        diffEnvironment,
      );
      const remote = await runGit(["remote", "get-url", "origin"], checkout);
      const remoteUrl = remote.stdout.trim();
      if (remoteUrl.includes(installationToken)) {
        throw new Error("Installation credential was persisted in the Git remote.");
      }

      return {
        root,
        checkout,
        diff: diff.stdout,
        remoteUrl,
        cleanup,
      };
    } catch (error) {
      const primary = redactError(error, installationToken);
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new WorkspacePreparationError(primary, asError(cleanupError), cleanup);
      }
      throw primary;
    }
  }
}
