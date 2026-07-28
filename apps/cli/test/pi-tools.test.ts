import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { BashOperations } from "@earendil-works/pi-coding-agent";

import {
  createReviewBashOperations,
  createReviewResourceLoader,
  createReviewToolDefinitions,
} from "../src/review/pi.js";

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

  it("runs allowed host commands from the checkout with the configured maximum timeout", async () => {
    const calls: Array<{
      command: string;
      cwd: string;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    }> = [];
    const delegate: BashOperations = {
      async exec(command, cwd, options) {
        calls.push({
          command,
          cwd,
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          ...(options.env === undefined ? {} : { env: options.env }),
        });
        return { exitCode: 0 };
      },
    };
    const operations = createReviewBashOperations("/fresh/checkout", 1_500, delegate);

    await operations.exec("git diff --stat", "/wrong/cwd", {
      onData() {},
      timeout: 60,
      env: {
        PATH: "/bin",
        GH_TOKEN: "must-not-leak",
        GITHUB_TOKEN: "must-not-leak",
      },
    });

    assert.deepEqual(calls, [
      {
        command: "git diff --stat",
        cwd: "/fresh/checkout",
        timeout: 1.5,
        env: { PATH: "/bin" },
      },
    ]);
  });

  it("denies dependency installation, lifecycle scripts, and GitHub mutations", async () => {
    const executed: string[] = [];
    const delegate: BashOperations = {
      async exec(command) {
        executed.push(command);
        return { exitCode: 0 };
      },
    };
    const operations = createReviewBashOperations("/fresh/checkout", 2_000, delegate);
    const denied = [
      "pnpm install",
      "npm ci",
      "yarn test",
      "bun run build",
      "python -m pip install package",
      "uv sync",
      "cargo install tool",
      "git status && bundle install",
      "gh run rerun 123",
      "gh workflow run ci.yml",
      "CI=1 pnpm install",
      "env CI=1 pnpm install",
      "command env CI=1 pnpm install",
      "sh -c 'pnpm install'",
      'bash -lc "npm ci"',
      "nohup yarn test",
    ];

    for (const command of denied) {
      // Denied commands must fail before reaching the host process boundary.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () => operations.exec(command, "/fresh/checkout", { onData() {} }),
        /review policy denies/u,
      );
    }
    assert.deepEqual(executed, []);
  });
});
