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
  title: "Keep review context complete",
  description: "Preserve the public API while changing the implementation.",
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
        evidence: {
          completedChecks: [
            {
              name: "unit",
              conclusion: "failure",
              failedActionsLog: "FAIL api contract changed",
            },
          ],
          discussion: {
            comments: [
              {
                author: "maintainer",
                body: "The retry concern was already raised.",
                createdAt: "2026-07-29T00:00:00Z",
                url: "https://github.com/owner/repository/pull/17#issuecomment-1",
              },
            ],
            reviews: [],
            threads: [
              {
                id: "THREAD_1",
                isResolved: true,
                path: "source.ts",
                line: 1,
                side: "RIGHT",
                comments: [
                  {
                    author: "author",
                    body: "Fixed in the latest revision.",
                    createdAt: "2026-07-29T00:01:00Z",
                    url: "https://github.com/owner/repository/pull/17#discussion_r1",
                  },
                ],
              },
            ],
            linkedIssues: [
              {
                number: 9,
                title: "Preserve retry behavior",
                body: "Retries must remain bounded.",
                state: "OPEN",
                url: "https://github.com/owner/repository/issues/9",
                comments: [],
              },
            ],
          },
        },
      },
      new AbortController().signal,
    );

    assert.equal(sessions.options.length, 1);
    assert.equal(sessions.options[0]?.cwd, workspace.checkout);
    assert.equal(sessions.options[0]?.model, "openai-codex/gpt-5.6-sol");
    assert.equal(sessions.options[0]?.reasoning, "high");
    assert.equal(sessions.options[0]?.shellCommandMs, 120_000);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /read, grep, find, ls, and bash/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /login and interactive shell/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /full local/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /AGENTS\.md takes/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /install dependencies/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /project-native verification/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /Do not push commits/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /"version":1/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /P0\|P1\|P2\|P3/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /"defectKind"/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /renders all review prose locally/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /formatting or lint automation/u);
    assert.match(
      sessions.options[0]?.systemPrompt ?? "",
      /Do not repeat a concern already raised as review feedback/u,
    );
    assert.match(sessions.options[0]?.systemPrompt ?? "", /replies and thread resolution/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /linked issue bodies as requirements/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /do not suppress a defect/u);
    assert.match(sessions.options[0]?.systemPrompt ?? "", /Do not include a fingerprint/u);
    assert.equal(sessions.prompts.length, 1);
    assert.match(sessions.prompts[0] ?? "", new RegExp(pullRequest.baseSha, "u"));
    assert.match(sessions.prompts[0] ?? "", new RegExp(pullRequest.headSha, "u"));
    assert.match(sessions.prompts[0] ?? "", /Keep review context complete/u);
    assert.match(sessions.prompts[0] ?? "", /Preserve the public API/u);
    assert.match(sessions.prompts[0] ?? "", /The retry concern was already raised/u);
    assert.match(sessions.prompts[0] ?? "", /Fixed in the latest revision/u);
    assert.match(sessions.prompts[0] ?? "", /Preserve retry behavior/u);
    assert.match(sessions.prompts[0] ?? "", /FAIL api contract changed/u);
    assert.match(sessions.prompts[0] ?? "", /Applicable repository instructions/u);
    assert.match(sessions.prompts[0] ?? "", /Files eligible for detailed line review/u);
    assert.match(sessions.prompts[0] ?? "", /\+const current = true/u);
    assert.ok(
      (sessions.prompts[0] ?? "").indexOf("Applicable repository instructions") <
        (sessions.prompts[0] ?? "").indexOf("Pull request description"),
    );
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
            path: "source.ts",
            range: { start: 1, end: 1, side: "RIGHT" },
            defectKind: "concurrency",
            impactKind: "execution-stall",
            fixAction: "synchronize",
            anchor: "const current = true;",
          },
          {
            priority: "P9",
            path: "source.ts",
            range: null,
            defectKind: "correctness",
            impactKind: "incorrect-result",
            fixAction: "guard",
            anchor: "source.ts",
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
            path: "source.ts",
            range: null,
            defectKind: sourceSecret,
            impactKind: "incorrect-result",
            fixAction: "guard",
            anchor: "source.ts",
          },
          {
            priority: "P1",
            path: `../${sourceSecret}.ts`,
            range: null,
            defectKind: "correctness",
            impactKind: "incorrect-result",
            fixAction: "guard",
            anchor: "source.ts",
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

  it("force-disposes a late-created session without waiting for abort", async () => {
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
    assert.equal(disposalStarted, true);
    assert.equal(settled, false);
    finishAbort?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false);
    assert.equal(runCalls, 0);

    finishDisposal?.();
    await assert.rejects(review, cancellation);
  });

  it("memoizes abort and force-disposes an active session without waiting for abort", async () => {
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
    assert.equal(disposalStarted, true);
    assert.equal(settled, false);
    finishRun?.('{"version":1,"findings":[]}');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false);

    finishAbort?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(abortCalls, 1);
    finishDisposal?.();
    await assert.rejects(review, cancellation);
  });

  it("settles cancellation when an active Pi run and abort never settle", async () => {
    let markRunStarted: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    let abortCalls = 0;
    let disposed = 0;
    const sessions: PiSessionFactory = {
      async create() {
        return {
          async abort() {
            abortCalls += 1;
            return new Promise<void>(() => {});
          },
          async run() {
            markRunStarted?.();
            return new Promise<string>(() => {});
          },
          async dispose() {
            disposed += 1;
          },
        };
      },
    };
    const engine = new PiReviewEngine(
      { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
      sessions,
    );
    const abortController = new AbortController();
    const cancellation = new Error("cancel stalled Pi session");
    const review = engine.review(
      {
        reference: parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
        pullRequest,
        workspace,
      },
      abortController.signal,
    );
    void review.catch(() => {});
    await runStarted;

    abortController.abort(cancellation);

    await assert.rejects(
      Promise.race([
        review,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("stalled Pi cancellation did not settle")), 100);
        }),
      ]),
      cancellation,
    );
    assert.equal(abortCalls, 1);
    assert.equal(disposed, 1);
  });
});
