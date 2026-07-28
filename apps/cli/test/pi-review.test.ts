import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { FindingContractError } from "../src/review/findings.js";
import {
  PiReviewEngine,
  type PiSession,
  type PiSessionFactory,
  type PiSessionOptions,
} from "../src/review/pi.js";
import { parsePullRequestUrl, type PullRequestSnapshot } from "../src/review/pull-request.js";
import type { PreparedWorkspace } from "../src/review/workspace.js";

const execFileAsync = promisify(execFile);

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

const workspace: PreparedWorkspace = {
  root: "/tmp/review",
  checkout: "/tmp/review/repository",
  diff: "diff --git a/source.ts b/source.ts\n+const current = true;\n",
  remoteUrl: "https://github.com/owner/repository.git",
  async cleanup() {},
};

async function commitReviewedHead(checkout: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: checkout });
  await execFileAsync("git", ["config", "user.name", "Revoir Test"], { cwd: checkout });
  await execFileAsync("git", ["config", "user.email", "revoir@example.test"], {
    cwd: checkout,
  });
  await execFileAsync("git", ["add", "--all"], { cwd: checkout });
  await execFileAsync("git", ["commit", "--quiet", "-m", "reviewed head"], {
    cwd: checkout,
  });
}

class FakeSessionFactory implements PiSessionFactory {
  readonly options: PiSessionOptions[] = [];
  readonly prompts: string[] = [];
  disposed = 0;
  result = '{"version":1,"findings":[]}';

  async create(options: PiSessionOptions): Promise<PiSession> {
    this.options.push(options);
    return {
      async abort() {},
      run: async (prompt) => {
        this.prompts.push(prompt);
        return this.result;
      },
      dispose: () => {
        this.disposed += 1;
      },
    };
  }
}

describe("Pi clean review adapter", () => {
  it("creates exactly one in-memory review session with Revoir model settings", async () => {
    const sessions = new FakeSessionFactory();
    const engine = new PiReviewEngine(
      { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
      sessions,
    );
    await engine.review(
      {
        reference: parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
        pullRequest,
        workspace,
      },
      new AbortController().signal,
    );

    assert.equal(sessions.options.length, 1);
    assert.equal(sessions.options[0]?.cwd, workspace.checkout);
    assert.equal(sessions.options[0]?.model, "openai-codex/gpt-5.6-sol");
    assert.equal(sessions.options[0]?.reasoning, "high");
    assert.match(sessions.options[0]?.systemPrompt ?? "", /read-only/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /Do not modify files/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /"version":1/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /P0\|P1\|P2\|P3/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /formatting or lint automation/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /Do not include a fingerprint/u);
    assert.equal(sessions.prompts.length, 1);
    assert.match(sessions.prompts[0] ?? "", new RegExp(pullRequest.baseSha, "u"));
    assert.match(sessions.prompts[0] ?? "", new RegExp(pullRequest.headSha, "u"));
    assert.match(sessions.prompts[0] ?? "", /\+const current = true/u);
    assert.equal(sessions.disposed, 1);
  });

  it("returns validated findings and diagnostics from mixed fake-model output", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "revoir-pi-findings-"));
    try {
      await writeFile(join(checkout, "source.ts"), "const current = true;\n");
      await commitReviewedHead(checkout);
      const sessions = new FakeSessionFactory();
      sessions.result = JSON.stringify({
        version: 1,
        findings: [
          {
            priority: "P1",
            title: "Cancellation is dropped",
            path: "source.ts",
            range: { start: 1, end: 1, side: "RIGHT" },
            issue: "The added operation does not receive the cancellation signal.",
            impact: "The missing cancellation signal keeps timed-out work active.",
            evidence: "The added call has no cancellation signal argument.",
            fixDirection: "Pass the active signal to the call.",
          },
          {
            priority: "P9",
            title: "Invalid priority",
            path: "source.ts",
            range: null,
            issue: "This candidate is invalid.",
            impact: "It must not be published.",
            evidence: "The priority is outside the contract.",
            fixDirection: "Remove the invalid candidate.",
          },
        ],
      });
      const engine = new PiReviewEngine(
        { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
        sessions,
      );
      const result = await engine.review(
        {
          reference: parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
          pullRequest,
          workspace: {
            ...workspace,
            checkout,
            diff: `diff --git a/source.ts b/source.ts
index 1111111..2222222 100644
--- a/source.ts
+++ b/source.ts
@@ -1 +1 @@
-const previous = true;
+const current = true;
`,
          },
        },
        new AbortController().signal,
      );
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0]?.priority, "P1");
      assert.equal(result.diagnostics.length, 1);
      assert.equal(sessions.disposed, 1);
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it("preserves safe per-candidate diagnostics for all-invalid Pi output", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "revoir-pi-invalid-findings-"));
    const sourceSecret = "PRIVATE_SOURCE_TOKEN";
    try {
      await writeFile(join(checkout, "source.ts"), "const current = true;\n");
      const sessions = new FakeSessionFactory();
      sessions.result = JSON.stringify({
        version: 1,
        findings: [
          {
            priority: "P9",
            title: "Invalid priority",
            path: "source.ts",
            range: null,
            issue: `The ${sourceSecret} candidate is invalid.`,
            impact: "It must not be published.",
            evidence: `Observed ${sourceSecret} in private source.`,
            fixDirection: "Remove the invalid candidate.",
          },
          {
            priority: "P1",
            title: "Invalid path",
            path: `../${sourceSecret}.ts`,
            range: null,
            issue: "The path points outside the checkout.",
            impact: "The invalid path escapes the checkout.",
            evidence: "The path traverses above the repository root.",
            fixDirection: "Use a repository-relative path.",
          },
        ],
      });
      const engine = new PiReviewEngine(
        { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
        sessions,
      );

      await assert.rejects(
        () =>
          engine.review(
            {
              reference: parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
              pullRequest,
              workspace: {
                ...workspace,
                checkout,
                diff: `diff --git a/source.ts b/source.ts
index 1111111..2222222 100644
--- a/source.ts
+++ b/source.ts
@@ -1 +1 @@
-const previous = true;
+const current = true;
`,
              },
            },
            new AbortController().signal,
          ),
        (error: unknown) => {
          assert.ok(error instanceof FindingContractError);
          assert.equal(error.diagnostics.length, 2);
          const reasons = error.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
          assert.match(reasons, /priority must be one of P0, P1, P2, or P3/u);
          assert.match(reasons, /normalized repository-relative POSIX path/u);
          assert.doesNotMatch(reasons, new RegExp(sourceSecret, "u"));
          return true;
        },
      );
      assert.equal(sessions.disposed, 1);
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it("rejects unknown contract versions", async () => {
    const sessions = new FakeSessionFactory();
    sessions.result = '{"version":2,"findings":[]}';
    const engine = new PiReviewEngine(
      { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
      sessions,
    );
    await assert.rejects(
      () =>
        engine.review(
          {
            reference: parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
            pullRequest,
            workspace,
          },
          new AbortController().signal,
        ),
      /invalid finding envelope/u,
    );
    assert.equal(sessions.disposed, 1);
  });

  it("rejects malformed and non-empty model output and always disposes the session", async () => {
    await Promise.all(
      ["clean", '{"findings":[{"priority":"P1"}]}', '{"findings":[],"summary":"looks good"}'].map(
        async (output) => {
          const sessions = new FakeSessionFactory();
          sessions.result = output;
          const engine = new PiReviewEngine(
            { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
            sessions,
          );
          await assert.rejects(() =>
            engine.review(
              {
                reference: parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
                pullRequest,
                workspace,
              },
              new AbortController().signal,
            ),
          );
          assert.equal(sessions.disposed, 1);
        },
      ),
    );
  });

  it("joins late session creation and asynchronous disposal after cancellation", async () => {
    let finishCreation: ((session: PiSession) => void) | undefined;
    let finishAbort: (() => void) | undefined;
    let finishDisposal: (() => void) | undefined;
    let abortStarted = false;
    let disposalStarted = false;
    let runCalls = 0;
    const sessions: PiSessionFactory = {
      create: async () =>
        new Promise<PiSession>((resolve) => {
          finishCreation = resolve;
        }),
    };
    const engine = new PiReviewEngine(
      { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
      sessions,
    );
    const cancellation = new Error("cancel late Pi creation");
    const abortController = new AbortController();
    let settled = false;
    const review = engine
      .review(
        {
          reference: parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
          pullRequest,
          workspace,
        },
        abortController.signal,
      )
      .finally(() => {
        settled = true;
      });
    void review.catch(() => {});

    abortController.abort(cancellation);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false);

    assert.ok(finishCreation);
    finishCreation({
      async abort() {
        abortStarted = true;
        await new Promise<void>((resolve) => {
          finishAbort = resolve;
        });
      },
      async run() {
        runCalls += 1;
        return '{"version":1,"findings":[]}';
      },
      async dispose() {
        disposalStarted = true;
        await new Promise<void>((resolve) => {
          finishDisposal = resolve;
        });
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(abortStarted, true);
    assert.equal(disposalStarted, false);
    assert.equal(settled, false);
    finishAbort?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(disposalStarted, true);
    assert.equal(settled, false);
    assert.equal(runCalls, 0);

    finishDisposal?.();
    await assert.rejects(review, cancellation);
  });

  it("memoizes and joins abort before asynchronously disposing an active session", async () => {
    let finishRun: ((value: string) => void) | undefined;
    let finishAbort: (() => void) | undefined;
    let finishDisposal: (() => void) | undefined;
    let markRunStarted: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    let abortCalls = 0;
    let disposalStarted = false;
    const sessions: PiSessionFactory = {
      async create() {
        return {
          async abort() {
            abortCalls += 1;
            await new Promise<void>((resolve) => {
              finishAbort = resolve;
            });
          },
          async run() {
            markRunStarted?.();
            return new Promise<string>((resolve) => {
              finishRun = resolve;
            });
          },
          async dispose() {
            disposalStarted = true;
            await new Promise<void>((resolve) => {
              finishDisposal = resolve;
            });
          },
        };
      },
    };
    const engine = new PiReviewEngine(
      { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
      sessions,
    );
    const abortController = new AbortController();
    const cancellation = new Error("cancel active Pi session");
    let settled = false;
    const review = engine
      .review(
        {
          reference: parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
          pullRequest,
          workspace,
        },
        abortController.signal,
      )
      .finally(() => {
        settled = true;
      });
    void review.catch(() => {});
    await runStarted;

    abortController.abort(cancellation);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(abortCalls, 1);
    assert.equal(settled, false);
    finishRun?.('{"version":1,"findings":[]}');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(disposalStarted, false);
    assert.equal(settled, false);

    finishAbort?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(disposalStarted, true);
    assert.equal(abortCalls, 1);
    finishDisposal?.();
    await assert.rejects(review, cancellation);
  });
});
