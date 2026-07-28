import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PiReviewEngine,
  type PiSession,
  type PiSessionFactory,
  type PiSessionOptions,
} from "../src/review/pi.js";
import { parsePullRequestUrl, type PullRequestSnapshot } from "../src/review/pull-request.js";
import type { PreparedWorkspace } from "../src/review/workspace.js";

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

class FakeSessionFactory implements PiSessionFactory {
  readonly options: PiSessionOptions[] = [];
  readonly prompts: string[] = [];
  disposed = 0;
  result = '{"findings":[]}';

  async create(options: PiSessionOptions): Promise<PiSession> {
    this.options.push(options);
    return {
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
    assert.equal(sessions.prompts.length, 1);
    assert.match(sessions.prompts[0] ?? "", new RegExp(pullRequest.baseSha, "u"));
    assert.match(sessions.prompts[0] ?? "", new RegExp(pullRequest.headSha, "u"));
    assert.match(sessions.prompts[0] ?? "", /\+const current = true/u);
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
});
