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

  it("runs static host diagnostics and pipelines through Bash from the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-host-bash-"));
    const checkout = join(root, "checkout");
    const trustedBin = join(root, "trusted-bin");
    const temporaryDirectory = join(root, "temporary");
    try {
      await Promise.all([mkdir(checkout), mkdir(trustedBin), mkdir(temporaryDirectory)]);
      await Promise.all([
        writeFile(join(checkout, "source.ts"), "// TODO: inspect\n"),
        writeExecutable(
          join(trustedBin, "rg"),
          "process.stdout.write(`${process.cwd()}\\nTODO: inspect\\n`);",
        ),
      ]);
      const output: Buffer[] = [];
      const operations = createReviewBashOperations(checkout, 2_000, {
        temporaryDirectory,
        trustedPath: `${trustedBin}:/usr/bin:/bin`,
      });

      assert.deepEqual(
        await operations.exec("rg TODO source.ts | head -n 2", "/wrong/cwd", {
          env: { PATH: join(root, "hostile-bin"), BASH_ENV: join(root, "hostile-profile") },
          onData(data) {
            output.push(data);
          },
        }),
        { exitCode: 0 },
      );
      assert.equal(
        Buffer.concat(output).toString("utf8"),
        `${await realpath(checkout)}\nTODO: inspect\n`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("spawns the fixed executable from the checkout with an exact isolated environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-review-command-env-"));
    const checkout = join(root, "checkout");
    const temporaryDirectory = join(root, "temporary");
    const fakeBash = join(root, "host-bash");
    const bashCalls = join(root, "bash-calls");
    const trustedPath = "/usr/bin:/bin";
    try {
      await Promise.all([
        mkdir(checkout),
        mkdir(temporaryDirectory),
        writeExecutable(
          fakeBash,
          `const argv = process.argv.slice(2); require("node:fs").appendFileSync(${JSON.stringify(bashCalls)}, JSON.stringify(argv) + "\\n"); if (argv.includes("-n")) process.exit(0); process.stdout.write(JSON.stringify({ argv, cwd: process.cwd(), env: process.env }));`,
        ),
      ]);
      const output: Buffer[] = [];
      const operations = createReviewBashOperations(checkout, 1_500, {
        bashExecutable: fakeBash,
        temporaryDirectory,
        trustedPath,
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
      const securedGitCommand = [
        "git",
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
      ]
        .map((argument) => `'${argument}'`)
        .join(" ");
      const isolationRoot = dirname(result.env.HOME!);
      const isolatedTemporary = join(isolationRoot, "tmp");
      const macTextEncoding =
        process.platform === "darwin" && process.getuid !== undefined
          ? `0x${process.getuid().toString(16).toUpperCase()}:0x0:0x0`
          : undefined;
      assert.equal(await realpath(result.cwd), await realpath(checkout));
      assert.deepEqual(result.argv, ["--noprofile", "--norc", "-c", securedGitCommand]);
      assert.deepEqual(
        (await readFile(bashCalls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        [
          ["--noprofile", "--norc", "-n", "-c", "git diff --stat HEAD"],
          ["--noprofile", "--norc", "-c", securedGitCommand],
        ],
      );
      assert.deepEqual(result.env, {
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "8",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_KEY_0: "color.ui",
        GIT_CONFIG_KEY_1: "core.attributesFile",
        GIT_CONFIG_KEY_2: "core.excludesFile",
        GIT_CONFIG_KEY_3: "core.fsmonitor",
        GIT_CONFIG_KEY_4: "core.pager",
        GIT_CONFIG_KEY_5: "core.untrackedCache",
        GIT_CONFIG_KEY_6: "credential.helper",
        GIT_CONFIG_KEY_7: "diff.external",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_VALUE_1: devNull,
        GIT_CONFIG_VALUE_2: devNull,
        GIT_CONFIG_VALUE_3: "false",
        GIT_CONFIG_VALUE_4: "",
        GIT_CONFIG_VALUE_5: "false",
        GIT_CONFIG_VALUE_6: "",
        GIT_CONFIG_VALUE_7: "",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        HOME: join(isolationRoot, "home"),
        LANG: "C",
        LC_ALL: "C",
        PATH: trustedPath,
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

  it("allows the static diagnostic capability matrix and rejects dynamic or mutating commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-review-command-matrix-"));
    const checkout = join(root, "checkout");
    const temporaryDirectory = join(root, "temporary");
    const trustedBin = join(root, "trusted-bin");
    const invocations = join(root, "invocations");
    try {
      await Promise.all([mkdir(checkout), mkdir(temporaryDirectory), mkdir(trustedBin)]);
      const executableSource = `require("node:fs").appendFileSync(${JSON.stringify(invocations)}, process.argv[1].split("/").at(-1) + "\\n");`;
      await Promise.all(
        ["cat", "git", "head", "just", "make", "node", "rg", "tsc"].map((name) =>
          writeExecutable(join(trustedBin, name), executableSource),
        ),
      );
      await writeExecutable(
        join(checkout, "unit-test"),
        `require("node:fs").appendFileSync(${JSON.stringify(invocations)}, "unit-test\\n");`,
      );
      const operations = createReviewBashOperations(checkout, 2_000, {
        temporaryDirectory,
        trustedPath: `${trustedBin}:/usr/bin:/bin`,
      });
      const allowed = [
        "git --version",
        "git status --short --branch",
        "git diff --stat HEAD",
        "git show --name-only HEAD",
        "git log --oneline --max-count=20 HEAD",
        "git grep --ignore-case Review -- apps/cli/src",
        "git ls-files --cached -- apps/cli/src",
        "git ls-tree -r --name-only HEAD -- apps/cli/src",
        "git cat-file -t HEAD",
        "git rev-parse --verify HEAD",
        "git status --short | cat",
        "rg TODO source.ts | head -n 1",
        "node --test test/pi-tools.test.ts",
        "tsc --noEmit",
        "make test",
        "just test",
        "./unit-test --filter focused",
      ];
      for (const command of allowed) {
        // eslint-disable-next-line no-await-in-loop
        const result = await operations.exec(command, "/wrong/cwd", {
          onData() {},
        });
        assert.equal(result.exitCode, 0, command);
      }
      const allowedInvocationCount = (await readFile(invocations, "utf8"))
        .trim()
        .split("\n").length;
      assert.equal(allowedInvocationCount, allowed.length + 2);

      const denied = [
        "git status && git diff",
        "git status || git diff",
        "git status > status.txt",
        "git status\ncat status.txt",
        "bash -lc git-status",
        "sh -c git-status",
        "pnpm install",
        "npm test",
        "yarn lint",
        "bun test",
        "npx eslint .",
        "python -m pip install",
        "cargo install tool",
        "go get example.test/module",
        "make install",
        "just build",
        "node -e process.exit(0)",
        "env git status",
        "command git status",
        "xargs git status",
        "nohup git status",
        "source script.sh",
        ". script.sh",
        "eval git status",
        "find . -exec git status",
        "printf cG5wbSBpbnN0YWxsCg== | base64 -d | xargs env",
        "p'n'p'm install",
        String.raw`p\npm install`,
        "p{n,}pm install",
        String.raw`$PM install`,
        String.raw`$(printf pnpm) install`,
        "`printf pnpm` install",
        "gh run rerun 123",
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
        "git diff HEAD;pnpm install",
        "rg 'unterminated",
        "rg TODO || head -n 1",
        "curl https://example.test",
      ];
      for (const command of denied) {
        // Unsupported syntax and commands must fail before host execution.
        // eslint-disable-next-line no-await-in-loop
        await assert.rejects(
          () => operations.exec(command, checkout, { onData() {} }),
          /host Bash policy rejected/u,
          command,
        );
      }
      assert.equal(
        (await readFile(invocations, "utf8")).trim().split("\n").length,
        allowedInvocationCount,
      );
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
    const trustedBin = join(root, "trusted-bin");
    const fakeNode = join(trustedBin, "node");
    const pidFile = join(root, "pid");
    try {
      await Promise.all([mkdir(checkout), mkdir(temporaryDirectory), mkdir(trustedBin)]);
      await writeExecutable(
        fakeNode,
        `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n" + child.pid); setInterval(() => {}, 1_000);`,
      );

      const timedOperations = createReviewBashOperations(checkout, 1_000, {
        temporaryDirectory,
        trustedPath: `${trustedBin}:/usr/bin:/bin`,
      });
      await assert.rejects(
        () =>
          timedOperations.exec("node --test hang.test.ts", checkout, {
            onData() {},
            timeout: 60,
          }),
        /timeout:1/u,
      );
      const timedPids = (await readFile(pidFile, "utf8"))
        .split("\n")
        .map((value) => Number.parseInt(value, 10));
      for (const pid of timedPids) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
      assert.deepEqual(await readdir(temporaryDirectory), []);

      await rm(pidFile);
      const controller = new AbortController();
      const abortOperations = createReviewBashOperations(checkout, 2_000, {
        temporaryDirectory,
        trustedPath: `${trustedBin}:/usr/bin:/bin`,
      });
      const operation = abortOperations.exec("node --test hang.test.ts", checkout, {
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
      const abortedPids = (await readFile(pidFile, "utf8"))
        .split("\n")
        .map((value) => Number.parseInt(value, 10));
      for (const pid of abortedPids) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
      assert.deepEqual(await readdir(temporaryDirectory), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds streamed output and removes the isolated environment after termination", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-review-command-output-"));
    const checkout = join(root, "checkout");
    const temporaryDirectory = join(root, "temporary");
    const trustedBin = join(root, "trusted-bin");
    try {
      await Promise.all([mkdir(checkout), mkdir(temporaryDirectory), mkdir(trustedBin)]);
      await writeExecutable(
        join(trustedBin, "rg"),
        'process.stdout.write("x".repeat(4_096)); setInterval(() => {}, 1_000);',
      );
      const output: Buffer[] = [];
      const operations = createReviewBashOperations(checkout, 2_000, {
        maximumOutputBytes: 64,
        temporaryDirectory,
        trustedPath: `${trustedBin}:/usr/bin:/bin`,
      });

      await assert.rejects(
        () =>
          operations.exec("rg TODO", checkout, {
            onData(data) {
              output.push(data);
            },
          }),
        /output-limit:64/u,
      );
      assert.equal(Buffer.concat(output).length, 64);
      assert.deepEqual(await readdir(temporaryDirectory), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
