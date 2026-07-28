import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createConfiguration } from "../src/config/schema.js";
import type {
  GitHubReviewGateway,
  GitHubReviewSession,
  ReviewReaction,
} from "../src/review/github.js";
import { CleanReviewOrchestrator, ReviewTimeoutError } from "../src/review/orchestrator.js";
import type { ReviewEngine } from "../src/review/pi.js";
import { parsePullRequestUrl, type PullRequestSnapshot } from "../src/review/pull-request.js";
import type { PreparedWorkspace, WorkspacePreparer } from "../src/review/workspace.js";
import { TEST_PRIVATE_KEY } from "./helpers.js";

const reference = parsePullRequestUrl("https://github.com/owner/repository/pull/17");

function configuration(reviewMs = 60_000) {
  return createConfiguration({
    github: {
      userId: 42,
      appId: 7,
      installationId: 8,
      privateKey: TEST_PRIVATE_KEY,
      repositories: [{ id: 99, owner: "owner", name: "repository" }],
    },
    cloudflare: {
      accountId: "account",
      queueId: "queue",
      apiToken: "cloudflare-token",
    },
    paths: {
      cacheDir: "/tmp/cache",
      stateDir: "/tmp/state",
      dataDir: "/tmp/data",
    },
    timeouts: { reviewMs },
  });
}

function pullRequest(): PullRequestSnapshot {
  return {
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
}

function harness(
  options: {
    currentSha?: string;
    pullRequest?: PullRequestSnapshot;
    review?: ReviewEngine["review"];
    prepareError?: Error;
    completionError?: Error;
    headError?: Error;
    reviewMs?: number;
  } = {},
) {
  const events: string[] = [];
  const snapshot = options.pullRequest ?? pullRequest();
  let nextReactionId = 10;
  const session: GitHubReviewSession = {
    installationToken: "installation-secret",
    async getPullRequest() {
      events.push("get-pr");
      return snapshot;
    },
    async getHeadSha() {
      events.push("get-head");
      if (options.headError !== undefined) {
        throw options.headError;
      }
      return options.currentSha ?? snapshot.headSha;
    },
    async removeOwnCompletionReaction() {
      events.push("remove-old-thumb");
    },
    async addReaction(_reference, reaction: ReviewReaction) {
      events.push(`add-${reaction}`);
      if (reaction === "+1" && options.completionError !== undefined) {
        throw options.completionError;
      }
      return nextReactionId++;
    },
    async deleteReaction(_reference, id) {
      events.push(`delete-${id}`);
    },
  };
  const github: GitHubReviewGateway = {
    async authenticate() {
      events.push("authenticate");
      return session;
    },
  };
  const workspaces: WorkspacePreparer = {
    async prepare(_reference, _pullRequest, token) {
      events.push(`prepare-${token}`);
      if (options.prepareError !== undefined) {
        throw options.prepareError;
      }
      const workspace: PreparedWorkspace = {
        root: "/tmp/review",
        checkout: "/tmp/review/repository",
        diff: "diff",
        remoteUrl: "https://github.com/owner/repository.git",
        async cleanup() {
          events.push("cleanup");
        },
      };
      return workspace;
    },
  };
  const reviewEngine: ReviewEngine = {
    review:
      options.review ??
      (async () => {
        events.push("review");
      }),
  };
  return {
    events,
    orchestrator: new CleanReviewOrchestrator(configuration(options.reviewMs), {
      github,
      workspaces,
      reviewEngine,
    }),
  };
}

describe("clean review orchestrator", () => {
  it("runs the exact clean lifecycle after eligibility and cleans before completion", async () => {
    const { events, orchestrator } = harness();
    assert.deepEqual(await orchestrator.review(reference), {
      status: "clean",
      reviewedSha: "2".repeat(40),
      currentSha: "2".repeat(40),
    });
    assert.deepEqual(events, [
      "authenticate",
      "get-pr",
      "remove-old-thumb",
      "add-eyes",
      "prepare-installation-secret",
      "review",
      "get-head",
      "cleanup",
      "delete-10",
      "add-+1",
    ]);
  });

  it("removes the active reaction and publishes no completion for stale output", async () => {
    const { events, orchestrator } = harness({ currentSha: "3".repeat(40) });
    assert.equal((await orchestrator.review(reference)).status, "stale");
    assert.deepEqual(events.slice(-3), ["get-head", "cleanup", "delete-10"]);
    assert.equal(events.includes("add-+1"), false);
  });

  it("rejects ineligible work before checkout or any reaction", async () => {
    const cases: PullRequestSnapshot[] = [
      { ...pullRequest(), authorId: 404 },
      { ...pullRequest(), state: "closed" },
      { ...pullRequest(), draft: true },
      {
        ...pullRequest(),
        headRepository: {
          id: 100,
          fullName: "someone/repository",
          cloneUrl: "https://github.com/someone/repository.git",
        },
      },
    ];
    await Promise.all(
      cases.map(async (snapshot) => {
        const { events, orchestrator } = harness({ pullRequest: snapshot });
        await assert.rejects(() => orchestrator.review(reference));
        assert.deepEqual(events, ["authenticate", "get-pr"]);
      }),
    );
  });

  it("cleans the workspace and active reaction after engine and SHA failures", async () => {
    const engineFailure = harness({
      review: async () => {
        throw new Error("model failed");
      },
    });
    await assert.rejects(() => engineFailure.orchestrator.review(reference), /model failed/u);
    assert.deepEqual(engineFailure.events.slice(-2), ["cleanup", "delete-10"]);

    const shaFailure = harness({ headError: new Error("SHA lookup failed") });
    await assert.rejects(() => shaFailure.orchestrator.review(reference), /SHA lookup failed/u);
    assert.deepEqual(shaFailure.events.slice(-2), ["cleanup", "delete-10"]);
  });

  it("cleans after preparation and completion failures", async () => {
    const prepareFailure = harness({ prepareError: new Error("clone failed") });
    await assert.rejects(() => prepareFailure.orchestrator.review(reference), /clone failed/u);
    assert.deepEqual(prepareFailure.events.slice(-2), ["prepare-installation-secret", "delete-10"]);

    const completionFailure = harness({ completionError: new Error("reaction failed") });
    await assert.rejects(
      () => completionFailure.orchestrator.review(reference),
      /reaction failed/u,
    );
    assert.deepEqual(completionFailure.events.slice(-3), ["cleanup", "delete-10", "add-+1"]);
  });

  it("aborts a timed-out review and still cleans every artifact", async () => {
    const timedOut = harness({
      reviewMs: 5,
      review: async (_input, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    });
    await assert.rejects(() => timedOut.orchestrator.review(reference), ReviewTimeoutError);
    assert.deepEqual(timedOut.events.slice(-2), ["cleanup", "delete-10"]);
  });
});
