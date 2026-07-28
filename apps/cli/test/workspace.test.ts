import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { parseGitDiff } from "../src/review/diff.js";
import { parsePullRequestUrl, type PullRequestSnapshot } from "../src/review/pull-request.js";
import {
  GitWorkspacePreparer,
  SystemCommandRunner,
  WorkspacePreparationError,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "../src/review/workspace.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];
const NFD_OLD_PATH = "cafe\u0301-old.ts";
const NFD_NEW_PATH = "cafe\u0301-new.ts";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  const result = await executeFile("git", arguments_, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function repositoryFixture(): Promise<{
  root: string;
  baseSha: string;
  headSha: string;
}> {
  const root = await temporaryDirectory("revoir-origin-");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Revoir Test");
  await git(root, "config", "core.precomposeUnicode", "false");
  await Promise.all([
    writeFile(join(root, "file with spaces.txt"), "base\n"),
    writeFile(join(root, "old-name.ts"), "keep one\nkeep two\nold value\nkeep four\n"),
    writeFile(join(root, NFD_OLD_PATH), "keep one\nkeep two\nold value\nkeep four\n"),
    writeFile(join(root, ".gitattributes"), "*.ts text !diff\nattribute.bin binary\n"),
    writeFile(join(root, "attribute.bin"), Buffer.from([0x00, 0x01])),
  ]);
  await git(
    root,
    "add",
    "--",
    "file with spaces.txt",
    "old-name.ts",
    NFD_OLD_PATH,
    ".gitattributes",
    "attribute.bin",
  );
  await git(root, "commit", "-m", "base");
  const baseSha = await git(root, "rev-parse", "HEAD");
  await Promise.all([
    rename(join(root, "old-name.ts"), join(root, "new-name.ts")),
    rename(join(root, NFD_OLD_PATH), join(root, NFD_NEW_PATH)),
  ]);
  await writeFile(join(root, "file with spaces.txt"), "base\nhead\n");
  await Promise.all([
    writeFile(join(root, "new-name.ts"), "keep one\nkeep two\nnew value\nkeep four\n"),
    writeFile(join(root, NFD_NEW_PATH), "keep one\nkeep two\nnew value\nkeep four\n"),
    writeFile(join(root, "attribute.bin"), Buffer.from([0x00, 0x02])),
  ]);
  await git(root, "add", "--all");
  await git(root, "commit", "-m", "head");
  return { root, baseSha, headSha: await git(root, "rev-parse", "HEAD") };
}

async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

class CapturingRunner implements CommandRunner {
  readonly calls: Array<{
    command: string;
    arguments: readonly string[];
    options: CommandOptions;
    result: CommandResult;
  }> = [];
  readonly #delegate = new SystemCommandRunner();

  async run(
    command: string,
    arguments_: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    const result = await this.#delegate.run(command, arguments_, options);
    this.calls.push({ command, arguments: [...arguments_], options, result });
    return result;
  }
}

class HostileGitConfigRunner implements CommandRunner {
  readonly calls: Array<{ arguments: readonly string[]; environment: NodeJS.ProcessEnv }> = [];
  readonly #delegate = new SystemCommandRunner();
  readonly #externalDiff: string;

  constructor(externalDiff: string) {
    this.#externalDiff = externalDiff;
  }

  async run(
    command: string,
    arguments_: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    if (arguments_.includes("diff") && options.cwd !== undefined) {
      const hostileLocalValues = [
        ["diff.noprefix", "true"],
        ["diff.mnemonicPrefix", "true"],
        ["diff.renames", "false"],
        ["diff.algorithm", "histogram"],
        ["diff.indentHeuristic", "true"],
        ["diff.context", "0"],
        ["diff.suppressBlankEmpty", "true"],
        ["diff.external", this.#externalDiff],
        ["diff.hostile.command", this.#externalDiff],
        ["diff.hostile.textconv", this.#externalDiff],
        ["diff.submodule", "log"],
        ["color.ui", "always"],
        ["color.diff", "always"],
        ["core.quotePath", "false"],
      ] as const;
      for (const [key, value] of hostileLocalValues) {
        // Keep each hostile local setting explicit so the authoritative command must override it.
        // eslint-disable-next-line no-await-in-loop
        await executeFile("git", ["config", "--local", key, value], {
          cwd: options.cwd,
          env: options.environment,
        });
      }
    }
    this.calls.push({
      arguments: [...arguments_],
      environment: { ...options.environment },
    });
    return this.#delegate.run(command, arguments_, options);
  }
}

describe("Git review workspace", () => {
  it("creates a fresh base-to-head checkout with system Git and no persisted token", async () => {
    try {
      const origin = await repositoryFixture();
      const cache = await temporaryDirectory("revoir-cache-");
      const runner = new CapturingRunner();
      const preparer = new GitWorkspacePreparer(cache, 10_000, runner);
      const token = "installation-token-must-not-leak";
      const pullRequest: PullRequestSnapshot = {
        number: 17,
        state: "open",
        draft: false,
        authorId: 42,
        baseSha: origin.baseSha,
        headSha: origin.headSha,
        baseRepository: {
          id: 99,
          fullName: "owner/repository",
          cloneUrl: origin.root,
        },
        headRepository: {
          id: 99,
          fullName: "owner/repository",
          cloneUrl: origin.root,
        },
      };

      const workspace = await preparer.prepare(
        parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
        pullRequest,
        token,
        new AbortController().signal,
      );
      assert.match(workspace.root, new RegExp(`^${cache}/checkouts/`, "u"));
      assert.equal(await git(workspace.checkout, "rev-parse", "HEAD"), origin.headSha);
      assert.match(workspace.diff, /file with spaces\.txt/u);
      assert.match(workspace.diff, /\+head/u);
      assert.equal(workspace.remoteUrl, origin.root);
      assert.doesNotMatch(workspace.remoteUrl, new RegExp(token, "u"));

      const captured = JSON.stringify(
        runner.calls.map((call) => ({
          command: call.command,
          arguments: call.arguments,
          stdout: call.result.stdout,
          stderr: call.result.stderr,
        })),
      );
      assert.doesNotMatch(captured, new RegExp(token, "u"));
      assert.ok(runner.calls.every((call) => call.command === "git"));
      assert.ok(runner.calls.every((call) => call.options.environment?.GIT_ASKPASS !== undefined));

      await workspace.cleanup();
      await assert.rejects(() => lstat(workspace.root), { code: "ENOENT" });
      await workspace.cleanup();
    } finally {
      await cleanupTemporaryDirectories();
    }
  });

  it("produces one hermetic rename-aware diff despite hostile Git config and environment", async () => {
    try {
      const origin = await repositoryFixture();
      const cache = await temporaryDirectory("revoir-cache-hostile-git-config-");
      const configDirectory = await temporaryDirectory("revoir-git-config-");
      const xdgDirectory = await temporaryDirectory("revoir-git-xdg-");
      const templateDirectory = await temporaryDirectory("revoir-git-template-");
      const globalConfig = join(configDirectory, "config");
      const globalAttributes = join(configDirectory, "global-attributes");
      const systemAttributes = join(configDirectory, "system-attributes");
      const marker = join(configDirectory, "external-diff-ran");
      const externalDiff = join(configDirectory, "external-diff.sh");
      await mkdir(join(xdgDirectory, "git"), { recursive: true });
      await mkdir(join(templateDirectory, "info"), { recursive: true });
      const hostileAttributes = "*.ts binary diff=hostile\n*.txt binary diff=hostile\n*.bin text\n";
      await Promise.all([
        writeFile(join(xdgDirectory, "git", "attributes"), hostileAttributes),
        writeFile(globalAttributes, hostileAttributes),
        writeFile(systemAttributes, hostileAttributes),
        writeFile(join(templateDirectory, "info", "attributes"), hostileAttributes),
      ]);
      await writeFile(
        externalDiff,
        `#!/bin/sh\ntouch "${marker}"\nprintf '\\033[31mhelper\\033[0m\\n'\n`,
      );
      await chmod(externalDiff, 0o700);
      await writeFile(
        globalConfig,
        `[diff]
\tnoprefix = true
\tmnemonicPrefix = true
\trenames = false
\talgorithm = patience
\tindentHeuristic = true
\tcontext = 0
\tsuppressBlankEmpty = true
\texternal = ${externalDiff}
\tsubmodule = log
[color]
\tui = always
\tdiff = always
[core]
\tquotePath = false
`,
      );
      const previousEnvironment = {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        GIT_ATTR_GLOBAL: process.env.GIT_ATTR_GLOBAL,
        GIT_ATTR_NOSYSTEM: process.env.GIT_ATTR_NOSYSTEM,
        GIT_ATTR_SOURCE: process.env.GIT_ATTR_SOURCE,
        GIT_ATTR_SYSTEM: process.env.GIT_ATTR_SYSTEM,
        GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,
        GIT_DIFF_OPTS: process.env.GIT_DIFF_OPTS,
        GIT_TEMPLATE_DIR: process.env.GIT_TEMPLATE_DIR,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      };
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      process.env.GIT_ATTR_GLOBAL = globalAttributes;
      process.env.GIT_ATTR_NOSYSTEM = "0";
      process.env.GIT_ATTR_SOURCE = origin.baseSha;
      process.env.GIT_ATTR_SYSTEM = systemAttributes;
      process.env.GIT_EXTERNAL_DIFF = externalDiff;
      process.env.GIT_DIFF_OPTS = "--unified=0";
      process.env.GIT_TEMPLATE_DIR = templateDirectory;
      process.env.XDG_CONFIG_HOME = xdgDirectory;
      const runner = new HostileGitConfigRunner(externalDiff);
      const preparer = new GitWorkspacePreparer(cache, 10_000, runner);
      const snapshot: PullRequestSnapshot = {
        number: 17,
        state: "open",
        draft: false,
        authorId: 42,
        baseSha: origin.baseSha,
        headSha: origin.headSha,
        baseRepository: {
          id: 99,
          fullName: "owner/repository",
          cloneUrl: origin.root,
        },
        headRepository: {
          id: 99,
          fullName: "owner/repository",
          cloneUrl: origin.root,
        },
      };

      try {
        const workspace = await preparer.prepare(
          parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
          snapshot,
          "installation-token",
          new AbortController().signal,
        );
        assert.match(
          workspace.diff,
          /^diff --git a\/file with spaces\.txt b\/file with spaces\.txt/mu,
        );
        assert.match(workspace.diff, /^--- a\/file with spaces\.txt\t?$/mu);
        assert.match(workspace.diff, /^\+\+\+ b\/file with spaces\.txt\t?$/mu);
        assert.equal(workspace.diff.includes(String.fromCharCode(27)), false);
        await assert.rejects(() => lstat(marker), { code: "ENOENT" });
        assert.equal(
          await git(workspace.checkout, "status", "--porcelain", "--untracked-files=no"),
          "",
        );
        assert.equal(await git(workspace.checkout, "diff", "--name-only", "HEAD", "--"), "");
        assert.equal(await git(workspace.checkout, "config", "--local", "diff.renames"), "false");
        await assert.rejects(() => lstat(join(workspace.checkout, ".git", "info", "attributes")), {
          code: "ENOENT",
        });

        const parsed = parseGitDiff(workspace.diff);
        assert.equal(parsed.files.size, 4);
        assert.equal(parsed.files.get("attribute.bin")?.binary, true);
        const renamed = parsed.files.get("new-name.ts");
        assert.ok(renamed);
        assert.equal(renamed.oldPath, "old-name.ts");
        assert.equal(renamed.newPath, "new-name.ts");
        assert.deepEqual([...renamed.changedLines.keys()], ["LEFT:3", "RIGHT:3"]);
        assert.equal(renamed.changedLines.has("RIGHT:1"), false);

        const nfdRename = parsed.files.get(NFD_NEW_PATH);
        assert.ok(nfdRename);
        assert.equal(nfdRename.oldPath, NFD_OLD_PATH);
        assert.equal(nfdRename.newPath, NFD_NEW_PATH);
        assert.deepEqual([...nfdRename.changedLines.keys()], ["LEFT:3", "RIGHT:3"]);

        const diffCall = runner.calls.find(({ arguments: arguments_ }) =>
          arguments_.includes("diff"),
        );
        assert.ok(diffCall);
        for (const argument of [
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
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--output-indicator-new=+",
          "--output-indicator-old=-",
          "--output-indicator-context= ",
          "--submodule=short",
          "--ignore-submodules=none",
          "color.ui=false",
          "color.diff=false",
          "diff.noprefix=false",
          "diff.mnemonicPrefix=false",
          "diff.renames=true",
          "diff.renameLimit=0",
          "diff.algorithm=myers",
          "diff.indentHeuristic=false",
          "diff.context=3",
          "diff.interHunkContext=0",
          "diff.suppressBlankEmpty=false",
          "diff.submodule=short",
          "core.quotePath=true",
          `core.attributesFile=${devNull}`,
          `--attr-source=${origin.headSha}`,
        ]) {
          assert.ok(diffCall.arguments.includes(argument), `missing ${argument}`);
        }
        assert.equal(diffCall.environment.GIT_EXTERNAL_DIFF, undefined);
        assert.equal(diffCall.environment.GIT_DIFF_OPTS, undefined);
        assert.equal(diffCall.environment.GIT_CONFIG_NOSYSTEM, "1");
        assert.equal(diffCall.environment.GIT_ATTR_NOSYSTEM, "1");
        assert.equal(diffCall.environment.GIT_ATTR_GLOBAL, undefined);
        assert.equal(diffCall.environment.GIT_ATTR_SOURCE, undefined);
        assert.equal(diffCall.environment.GIT_ATTR_SYSTEM, undefined);
        assert.notEqual(diffCall.environment.GIT_CONFIG_GLOBAL, globalConfig);
        const cloneCall = runner.calls.find(({ arguments: arguments_ }) =>
          arguments_.includes("clone"),
        );
        assert.equal(cloneCall?.environment.GIT_EXTERNAL_DIFF, externalDiff);
        assert.equal(cloneCall?.environment.GIT_DIFF_OPTS, "--unified=0");
        await workspace.cleanup();
      } finally {
        for (const [key, value] of Object.entries(previousEnvironment)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    } finally {
      await cleanupTemporaryDirectories();
    }
  });

  it("retries a failed cleanup and removes checkout and askpass artifacts", async () => {
    try {
      const origin = await repositoryFixture();
      const cache = await temporaryDirectory("revoir-cache-cleanup-retry-");
      let removalAttempts = 0;
      const preparer = new GitWorkspacePreparer(cache, 10_000, new SystemCommandRunner(), {
        async remove(path, options) {
          removalAttempts += 1;
          if (removalAttempts === 1) {
            throw new Error("injected cleanup failure");
          }
          await rm(path, options);
        },
      });
      const pullRequest: PullRequestSnapshot = {
        number: 17,
        state: "open",
        draft: false,
        authorId: 42,
        baseSha: origin.baseSha,
        headSha: origin.headSha,
        baseRepository: {
          id: 99,
          fullName: "owner/repository",
          cloneUrl: origin.root,
        },
        headRepository: {
          id: 99,
          fullName: "owner/repository",
          cloneUrl: origin.root,
        },
      };
      const workspace = await preparer.prepare(
        parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
        pullRequest,
        "installation-token",
        new AbortController().signal,
      );
      const askpass = join(workspace.root, "git-askpass.sh");

      await assert.rejects(() => workspace.cleanup(), /injected cleanup failure/u);
      await lstat(workspace.checkout);
      await lstat(askpass);

      await Promise.all([workspace.cleanup(), workspace.cleanup()]);
      assert.equal(removalAttempts, 2);
      await assert.rejects(() => lstat(workspace.checkout), { code: "ENOENT" });
      await assert.rejects(() => lstat(askpass), { code: "ENOENT" });
    } finally {
      await cleanupTemporaryDirectories();
    }
  });

  it("removes partial checkout and askpass artifacts and redacts token-bearing errors", async () => {
    try {
      const cache = await temporaryDirectory("revoir-cache-failure-");
      const token = "installation-token-must-not-leak";
      let runRoot: string | undefined;
      const runner: CommandRunner = {
        async run(_command, _arguments, options) {
          const askpass = options.environment?.GIT_ASKPASS;
          if (askpass !== undefined) {
            runRoot = dirname(askpass);
          }
          throw new Error(`clone rejected ${token}`);
        },
      };
      const pullRequest: PullRequestSnapshot = {
        number: 17,
        state: "open",
        draft: false,
        authorId: 42,
        baseSha: "1".repeat(40),
        headSha: "2".repeat(40),
        baseRepository: {
          id: 99,
          fullName: "owner/repository",
          cloneUrl: "https://github.com/owner/repository.git",
        },
        headRepository: {
          id: 99,
          fullName: "owner/repository",
          cloneUrl: "https://github.com/owner/repository.git",
        },
      };
      await assert.rejects(
        () =>
          new GitWorkspacePreparer(cache, 10_000, runner).prepare(
            parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
            pullRequest,
            token,
            new AbortController().signal,
          ),
        (error: unknown) => {
          assert.match(String(error), /\[REDACTED\]/u);
          assert.doesNotMatch(String(error), new RegExp(token, "u"));
          return true;
        },
      );
      if (runRoot === undefined) {
        throw new Error("The failing runner did not capture the review root.");
      }
      const capturedRoot = runRoot;
      await assert.rejects(() => lstat(capturedRoot), { code: "ENOENT" });
    } finally {
      await cleanupTemporaryDirectories();
    }
  });

  it("retains a retryable cleanup handle when partial preparation cleanup fails", async () => {
    try {
      const cache = await temporaryDirectory("revoir-cache-partial-cleanup-retry-");
      const token = "installation-token-must-not-leak";
      let root: string | undefined;
      let removalAttempts = 0;
      let finishRetry: (() => void) | undefined;
      const retryGate = new Promise<void>((resolve) => {
        finishRetry = resolve;
      });
      const runner: CommandRunner = {
        async run(_command, _arguments, options) {
          const askpass = options.environment?.GIT_ASKPASS;
          if (askpass !== undefined) {
            root = dirname(askpass);
          }
          throw new Error(`clone rejected ${token}`);
        },
      };
      const preparer = new GitWorkspacePreparer(cache, 10_000, runner, {
        async remove(path, options) {
          removalAttempts += 1;
          if (removalAttempts === 1) {
            throw new Error("injected initial cleanup failure");
          }
          await retryGate;
          await rm(path, options);
        },
      });
      const snapshot: PullRequestSnapshot = {
        number: 17,
        state: "open",
        draft: false,
        authorId: 42,
        baseSha: "1".repeat(40),
        headSha: "2".repeat(40),
        baseRepository: {
          id: 99,
          fullName: "owner/repository",
          cloneUrl: "https://github.com/owner/repository.git",
        },
        headRepository: {
          id: 99,
          fullName: "owner/repository",
          cloneUrl: "https://github.com/owner/repository.git",
        },
      };

      let preparationError: WorkspacePreparationError | undefined;
      await assert.rejects(
        () =>
          preparer.prepare(
            parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
            snapshot,
            token,
            new AbortController().signal,
          ),
        (error: unknown) => {
          assert.ok(error instanceof WorkspacePreparationError);
          preparationError = error;
          assert.equal(error.errors.length, 2);
          assert.match(error.errors.map(String).join(" "), /clone rejected \[REDACTED\]/u);
          assert.match(error.errors.map(String).join(" "), /injected initial cleanup failure/u);
          assert.doesNotMatch(
            JSON.stringify(error, Object.getOwnPropertyNames(error)),
            new RegExp(token, "u"),
          );
          return true;
        },
      );
      assert.ok(root);
      const capturedRoot = root;
      await lstat(capturedRoot);
      assert.ok(preparationError);

      const retries = [preparationError.cleanup(), preparationError.cleanup()];
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      assert.equal(removalAttempts, 2);
      finishRetry?.();
      await Promise.all(retries);
      await assert.rejects(() => lstat(capturedRoot), { code: "ENOENT" });
      await preparationError.cleanup();
      assert.equal(removalAttempts, 2);
    } finally {
      await cleanupTemporaryDirectories();
    }
  });
});
