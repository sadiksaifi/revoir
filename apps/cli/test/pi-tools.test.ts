import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createReviewBashOperations,
  createReviewResourceLoader,
  createReviewToolDefinitions,
} from "../src/review/pi.js";

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}\n${source}\n`);
  await chmod(path, 0o755);
}

describe("Pi review tools", () => {
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

  it("runs unrestricted shell commands from the checkout with the supplied environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-host-shell-"));
    const checkout = join(root, "checkout");
    try {
      await mkdir(checkout);
      const output: Buffer[] = [];
      const operations = createReviewBashOperations(checkout, 2_000, {
        shellExecutable: "/bin/bash",
        shellArguments: ["-c"],
        environment: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          REVIEW_TOKEN: "available-to-review",
        },
      });

      assert.deepEqual(
        await operations.exec(
          "printf '%s' \"$REVIEW_TOKEN\" > generated.txt && printf '%s' \"$(pwd)\"",
          "/wrong/cwd",
          {
            onData(data) {
              output.push(data);
            },
          },
        ),
        { exitCode: 0 },
      );
      assert.equal(Buffer.concat(output).toString("utf8"), await realpath(checkout));
      assert.equal(await readFile(join(checkout, "generated.txt"), "utf8"), "available-to-review");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes commands unchanged to a login and interactive user shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-review-shell-"));
    const checkout = join(root, "checkout");
    const fakeShell = join(root, "user-shell");
    const calls = join(root, "shell-calls");
    try {
      await mkdir(checkout);
      await writeExecutable(
        fakeShell,
        `require("node:fs").writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));`,
      );
      const operations = createReviewBashOperations(checkout, 1_500, {
        shellExecutable: fakeShell,
        environment: {
          HOME: "/Users/reviewer",
          PATH: "/custom/tools:/usr/bin:/bin",
          REVIEW_SECRET: "host-secret",
        },
      });
      const command = "mise install && pnpm test";

      assert.deepEqual(
        await operations.exec(command, "/wrong/cwd", {
          env: { HOME: "/ignored", PATH: "/ignored" },
          onData() {},
        }),
        { exitCode: 0 },
      );

      const result = JSON.parse(await readFile(calls, "utf8")) as {
        argv: string[];
        cwd: string;
        env: NodeJS.ProcessEnv;
      };
      assert.deepEqual(result.argv, ["-l", "-i", "-c", command]);
      assert.equal(result.cwd, await realpath(checkout));
      assert.equal(result.env.HOME, "/Users/reviewer");
      assert.equal(result.env.PATH, "/custom/tools:/usr/bin:/bin");
      assert.equal(result.env.REVIEW_SECRET, "host-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts package managers, task runners, nested shells, and arbitrary project commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-review-command-matrix-"));
    const checkout = join(root, "checkout");
    const fakeShell = join(root, "user-shell");
    const calls = join(root, "shell-calls");
    try {
      await mkdir(checkout);
      await writeExecutable(
        fakeShell,
        `require("node:fs").appendFileSync(${JSON.stringify(calls)}, process.argv.at(-1) + "\\n");`,
      );
      const operations = createReviewBashOperations(checkout, 2_000, {
        shellExecutable: fakeShell,
        shellArguments: ["-c"],
        environment: { PATH: "/usr/bin:/bin" },
      });
      const commands = [
        "mise install --yes && mise run test",
        "pnpm install --frozen-lockfile && pnpm test",
        "bun install && bun test",
        "yarn install && yarn test",
        "npx eslint .",
        "pnpx vitest",
        "bunx prettier --check .",
        "pnpm dlx tsx scripts/check.ts",
        "go mod download && go test ./...",
        "cargo run --bin verify",
        "bash ./scripts/verify.sh",
        "./project-specific-command --verify",
      ];

      for (const command of commands) {
        // eslint-disable-next-line no-await-in-loop
        assert.deepEqual(await operations.exec(command, checkout, { onData() {} }), {
          exitCode: 0,
        });
      }
      assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), commands);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("kills timed-out and aborted process trees", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-review-command-cleanup-"));
    const checkout = join(root, "checkout");
    const hangingCommand = join(root, "hang");
    const pidFile = join(root, "pid");
    try {
      await mkdir(checkout);
      await writeFile(
        hangingCommand,
        `#!/bin/sh
sleep 60 &
child=$!
printf '%s\\n%s' "$$" "$child" > ${JSON.stringify(pidFile)}
wait
`,
        { mode: 0o755 },
      );

      const timedOperations = createReviewBashOperations(checkout, 2_000, {
        shellExecutable: "/bin/bash",
        shellArguments: ["-c"],
      });
      await assert.rejects(
        () => timedOperations.exec(hangingCommand, checkout, { onData() {}, timeout: 60 }),
        /timeout:2/u,
      );
      const timedPids = (await readFile(pidFile, "utf8"))
        .split("\n")
        .map((value) => Number.parseInt(value, 10));
      for (const pid of timedPids) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }

      await rm(pidFile);
      const controller = new AbortController();
      const abortOperations = createReviewBashOperations(checkout, 2_000, {
        shellExecutable: "/bin/bash",
        shellArguments: ["-c"],
      });
      const operation = abortOperations.exec(hangingCommand, checkout, {
        onData() {},
        signal: controller.signal,
      });
      let abortedPids: number[] | undefined;
      while (abortedPids === undefined) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const recordedPids = (await readFile(pidFile, "utf8"))
            .split("\n")
            .map((value) => Number.parseInt(value, 10));
          if (
            recordedPids.length === 2 &&
            recordedPids.every((pid) => Number.isSafeInteger(pid) && pid > 0)
          ) {
            abortedPids = recordedPids;
          }
        } catch {
          // The process has not created its PID file yet.
        }
        if (abortedPids === undefined) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      controller.abort();
      await assert.rejects(() => operation, /aborted/u);
      for (const pid of abortedPids) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds streamed output and terminates the command", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-review-command-output-"));
    const checkout = join(root, "checkout");
    const outputCommand = join(root, "output");
    try {
      await mkdir(checkout);
      await writeExecutable(
        outputCommand,
        'process.stdout.write("x".repeat(4_096)); setInterval(() => {}, 1_000);',
      );
      const output: Buffer[] = [];
      const operations = createReviewBashOperations(checkout, 2_000, {
        shellExecutable: "/bin/bash",
        shellArguments: ["-c"],
        maximumOutputBytes: 64,
      });

      await assert.rejects(
        () =>
          operations.exec(outputCommand, checkout, {
            onData(data) {
              output.push(data);
            },
          }),
        /output-limit:64/u,
      );
      assert.equal(Buffer.concat(output).length, 64);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
