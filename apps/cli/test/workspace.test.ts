import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { parsePullRequestUrl, type PullRequestSnapshot } from "../src/review/pull-request.js";
import {
  GitWorkspacePreparer,
  SystemCommandRunner,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "../src/review/workspace.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

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
  await writeFile(join(root, "file with spaces.txt"), "base\n");
  await git(root, "add", "--", "file with spaces.txt");
  await git(root, "commit", "-m", "base");
  const baseSha = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "file with spaces.txt"), "base\nhead\n");
  await git(root, "add", "--", "file with spaces.txt");
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
});
