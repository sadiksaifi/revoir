import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  createReviewBashOperations,
  createReviewResourceLoader,
  createReviewToolDefinitions,
} from "../src/review/pi.js";

const execFile = promisify(execFileCallback);
const HOST_GIT =
  process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}\n${source}\n`);
  await chmod(path, 0o755);
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(() => access(path), { code: "ENOENT" });
}

describe("Pi review isolation", () => {
  it("exposes only Revoir's fixed resources even when repository Pi resources exist", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "revoir-pi-resources-"));
    try {
      await mkdir(join(checkout, ".pi", "extensions"), { recursive: true });
      await mkdir(join(checkout, ".pi", "skills", "malicious"), { recursive: true });
      await mkdir(join(checkout, ".pi", "prompts"), { recursive: true });
      await Promise.all([
        writeFile(join(checkout, ".pi", "extensions", "evil.ts"), "throw new Error('loaded')"),
        writeFile(join(checkout, ".pi", "skills", "malicious", "SKILL.md"), "must not load"),
        writeFile(join(checkout, ".pi", "prompts", "review.md"), "must not load"),
        writeFile(join(checkout, ".pi", "settings.json"), '{"tools":["write"]}'),
        writeFile(join(checkout, ".pi", "models.json"), '{"models":["other"]}'),
      ]);

      const loader = createReviewResourceLoader("fixed rubric");
      await loader.reload();
      assert.deepEqual(loader.getExtensions().extensions, []);
      assert.deepEqual(loader.getSkills().skills, []);
      assert.deepEqual(loader.getPrompts().prompts, []);
      assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
      assert.equal(loader.getSystemPrompt(), "fixed rubric");
      assert.deepEqual(
        createReviewToolDefinitions(checkout, 1_500).map(({ name }) => name),
        ["read", "grep", "find", "ls", "bash"],
      );
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it("spawns the fixed executable from the checkout with an exact isolated environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-review-command-env-"));
    const checkout = join(root, "checkout");
    const temporaryDirectory = join(root, "temporary");
    const fakeGit = join(root, "host-git");
    try {
      await Promise.all([
        mkdir(checkout),
        mkdir(temporaryDirectory),
        writeExecutable(
          fakeGit,
          "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));",
        ),
      ]);
      const output: Buffer[] = [];
      const operations = createReviewBashOperations(checkout, 1_500, {
        gitExecutable: fakeGit,
        temporaryDirectory,
      });

      assert.deepEqual(
        await operations.exec("git diff --stat HEAD", "/wrong/cwd", {
          onData(data) {
            output.push(data);
          },
          timeout: 60,
          env: {
            AWS_SECRET_ACCESS_KEY: "review-host-secret",
            PATH: join(root, "hostile-bin"),
            TMPDIR: join(root, "hostile-tmp"),
          },
        }),
        { exitCode: 0 },
      );

      const result = JSON.parse(Buffer.concat(output).toString("utf8")) as {
        argv: string[];
        cwd: string;
        env: NodeJS.ProcessEnv;
      };
      const isolationRoot = dirname(result.env.HOME!);
      const isolatedTemporary = join(isolationRoot, "tmp");
      const macTextEncoding =
        process.platform === "darwin" && process.getuid !== undefined
          ? `0x${process.getuid().toString(16).toUpperCase()}:0x0:0x0`
          : undefined;
      assert.equal(await realpath(result.cwd), await realpath(checkout));
      assert.deepEqual(result.argv, [
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
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--stat",
        "HEAD",
      ]);
      assert.deepEqual(result.env, {
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        HOME: join(isolationRoot, "home"),
        LANG: "C",
        LC_ALL: "C",
        TEMP: isolatedTemporary,
        TMP: isolatedTemporary,
        TMPDIR: isolatedTemporary,
        XDG_CACHE_HOME: join(isolationRoot, "xdg-cache"),
        XDG_CONFIG_HOME: join(isolationRoot, "xdg-config"),
        XDG_DATA_HOME: join(isolationRoot, "xdg-data"),
        XDG_STATE_HOME: join(isolationRoot, "xdg-state"),
        ...(macTextEncoding === undefined ? {} : { __CF_USER_TEXT_ENCODING: macTextEncoding }),
      });
      await assertMissing(isolationRoot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows only the bounded literal read-only Git capability matrix", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-review-command-matrix-"));
    const checkout = join(root, "checkout");
    const temporaryDirectory = join(root, "temporary");
    const fakeGit = join(root, "host-git");
    try {
      await Promise.all([
        mkdir(checkout),
        mkdir(temporaryDirectory),
        writeExecutable(fakeGit, 'process.stdout.write("invoked\\n");'),
      ]);
      const operations = createReviewBashOperations(checkout, 2_000, {
        gitExecutable: fakeGit,
        temporaryDirectory,
      });
      const allowed = [
        "git status --short --branch",
        "git diff --stat HEAD",
        "git show --name-only HEAD",
        "git log --oneline --max-count=20 HEAD",
        "git grep --ignore-case Review -- apps/cli/src",
        "git ls-files --cached -- apps/cli/src",
        "git ls-tree -r --name-only HEAD -- apps/cli/src",
        "git cat-file -t HEAD",
        "git rev-parse --verify HEAD",
      ];
      let invocations = 0;
      for (const command of allowed) {
        // eslint-disable-next-line no-await-in-loop
        const result = await operations.exec(command, "/wrong/cwd", {
          onData() {
            invocations += 1;
          },
        });
        assert.equal(result.exitCode, 0, command);
      }
      assert.equal(invocations, allowed.length);

      const denied = [
        "git status && git diff",
        "git status | cat",
        "bash -lc git-status",
        "sh -c git-status",
        "pnpm install",
        "npm test",
        "python -m pip install",
        "make test",
        "just test",
        "env git status",
        "command git status",
        "xargs git status",
        "nohup git status",
        "printf cG5wbSBpbnN0YWxsCg== | base64 -d | xargs env",
        "git add .",
        "git commit",
        "git checkout HEAD",
        "git reset --hard",
        "git clean -fd",
        "git fetch origin",
        "git pull",
        "git push",
        "git clone repository",
        "git remote get-url origin",
        "git config --get user.name",
        "git -c alias.status=!command status",
        "git diff --output=leak HEAD",
        "git show --output=leak HEAD",
        "git diff HEAD -- ../secret",
        "git diff HEAD -- /etc/passwd",
        "git diff HEAD -- src/../../secret",
        "git diff HEAD -- :(literal)file",
        "git diff 'HEAD'",
        "git diff HEAD;pnpm install",
      ];
      for (const command of denied) {
        // Commands outside the literal capability grammar must fail before process creation.
        // eslint-disable-next-line no-await-in-loop
        await assert.rejects(
          () => operations.exec(command, checkout, { onData() {} }),
          /only literal read-only Git inspection commands/u,
          command,
        );
      }
      assert.equal(invocations, allowed.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a hostile PATH and repository process configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-review-command-hostile-"));
    const checkout = join(root, "checkout");
    const hostileBin = join(root, "hostile-bin");
    const marker = join(root, "invoked");
    const hostileExecutable = join(hostileBin, "git");
    const temporaryDirectory = join(root, "temporary");
    try {
      await Promise.all([mkdir(hostileBin), mkdir(temporaryDirectory)]);
      await execFile(HOST_GIT, ["init", "--quiet", checkout]);
      await writeFile(join(checkout, "tracked.txt"), "content\n");
      await execFile(HOST_GIT, ["-C", checkout, "add", "tracked.txt"]);
      await writeExecutable(
        hostileExecutable,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "invoked");`,
      );
      await execFile(HOST_GIT, ["-C", checkout, "config", "core.fsmonitor", hostileExecutable]);
      const output: Buffer[] = [];
      const operations = createReviewBashOperations(checkout, 2_000, {
        temporaryDirectory,
      });

      assert.deepEqual(
        await operations.exec("git status --short", "/wrong/cwd", {
          env: {
            PATH: hostileBin,
            HOME: join(root, "hostile-home"),
            AWS_SECRET_ACCESS_KEY: "review-host-secret",
          },
          onData(data) {
            output.push(data);
          },
        }),
        { exitCode: 0 },
      );
      assert.match(Buffer.concat(output).toString("utf8"), /tracked\.txt/u);
      await assertMissing(marker);
      assert.deepEqual(await readdir(temporaryDirectory), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("kills timed-out and aborted processes and removes every isolated environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-review-command-cleanup-"));
    const checkout = join(root, "checkout");
    const temporaryDirectory = join(root, "temporary");
    const fakeGit = join(root, "host-git");
    const pidFile = join(root, "pid");
    try {
      await Promise.all([
        mkdir(checkout),
        mkdir(temporaryDirectory),
        writeExecutable(
          fakeGit,
          `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1_000);`,
        ),
      ]);

      const timedOperations = createReviewBashOperations(checkout, 1_000, {
        gitExecutable: fakeGit,
        temporaryDirectory,
      });
      await assert.rejects(
        () => timedOperations.exec("git status", checkout, { onData() {}, timeout: 60 }),
        /timeout:1/u,
      );
      const timedPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      assert.throws(() => process.kill(timedPid, 0), { code: "ESRCH" });
      assert.deepEqual(await readdir(temporaryDirectory), []);

      await rm(pidFile);
      const controller = new AbortController();
      const abortOperations = createReviewBashOperations(checkout, 2_000, {
        gitExecutable: fakeGit,
        temporaryDirectory,
      });
      const operation = abortOperations.exec("git status", checkout, {
        onData() {},
        signal: controller.signal,
      });
      while (true) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await access(pidFile);
          break;
        } catch {
          // Yield until the directly spawned process records its PID.
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      controller.abort();
      await assert.rejects(() => operation, /aborted/u);
      const abortedPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      assert.throws(() => process.kill(abortedPid, 0), { code: "ESRCH" });
      assert.deepEqual(await readdir(temporaryDirectory), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
