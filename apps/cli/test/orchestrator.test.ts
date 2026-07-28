import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createConfiguration } from "../src/config/schema.js";
import type {
  GitHubReviewGateway,
  GitHubReviewSession,
  ReviewReaction,
} from "../src/review/github.js";
import type { ReviewLock } from "../src/review/lock.js";
import { CleanReviewOrchestrator, ReviewTimeoutError } from "../src/review/orchestrator.js";
import {
  PiReviewEngine,
  type PiSession,
  type PiSessionFactory,
  type ReviewEngine,
} from "../src/review/pi.js";
import { parsePullRequestUrl, type PullRequestSnapshot } from "../src/review/pull-request.js";
import type { PreparedWorkspace, WorkspacePreparer } from "../src/review/workspace.js";
import { WorkspacePreparationError } from "../src/review/workspace.js";
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
    reactionError?: ReviewReaction;
    reconciliationNeverSettles?: boolean;
    headError?: Error;
    postcheckError?: Error;
    headNeverSettles?: boolean;
    mutateHeadDuring?: "workspace-cleanup" | "reaction-removal" | "completion-creation";
    reactionDeletionGate?: Promise<void>;
    reactionDeletionError?: Error;
    workspaceCleanupGate?: Promise<void>;
    workspaceCleanupError?: Error;
    lock?: ReviewLock;
    reviewMs?: number;
  } = {},
) {
  const events: string[] = [];
  const snapshot = options.pullRequest ?? pullRequest();
  let currentSha = options.currentSha ?? snapshot.headSha;
  let headRequests = 0;
  let nextReactionId = 10;
  const ownedReactions = new Set<ReviewReaction>();
  const session: GitHubReviewSession = {
    installationToken: "installation-secret",
    async getPullRequest() {
      events.push("get-pr");
      return snapshot;
    },
    async getHeadSha(_reference, signal?: AbortSignal) {
      events.push("get-head");
      headRequests += 1;
      if (options.headError !== undefined) {
        throw options.headError;
      }
      if (headRequests === 2 && options.postcheckError !== undefined) {
        throw options.postcheckError;
      }
      if (options.headNeverSettles) {
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
      return currentSha;
    },
    async removeOwnCompletionReaction() {
      events.push("remove-old-thumb");
    },
    async addReaction(_reference, reaction: ReviewReaction) {
      events.push(`add-${reaction}`);
      ownedReactions.add(reaction);
      if (reaction === options.reactionError) {
        throw new Error(`ambiguous ${reaction} creation`);
      }
      if (reaction === "+1" && options.completionError !== undefined) {
        throw options.completionError;
      }
      if (reaction === "+1" && options.mutateHeadDuring === "completion-creation") {
        currentSha = "3".repeat(40);
      }
      return nextReactionId++;
    },
    async removeOwnReaction(_reference, reaction, signal) {
      events.push(`remove-own-${reaction}`);
      if (options.reconciliationNeverSettles) {
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
      ownedReactions.delete(reaction);
    },
    async deleteReaction(_reference, id) {
      events.push(`delete-${id}`);
      await options.reactionDeletionGate;
      if (options.reactionDeletionError !== undefined) {
        throw options.reactionDeletionError;
      }
      if (id === 10) {
        ownedReactions.delete("eyes");
      }
      if (id === 10 && options.mutateHeadDuring === "reaction-removal") {
        currentSha = "3".repeat(40);
      }
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
          await options.workspaceCleanupGate;
          if (options.workspaceCleanupError !== undefined) {
            throw options.workspaceCleanupError;
          }
          if (options.mutateHeadDuring === "workspace-cleanup") {
            currentSha = "3".repeat(40);
          }
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
    ownedReactions,
    orchestrator: new CleanReviewOrchestrator(configuration(options.reviewMs), {
      github,
      lock: options.lock ?? {
        async acquire() {
          return { async release() {} };
        },
      },
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
      "cleanup",
      "delete-10",
      "get-head",
      "add-+1",
      "get-head",
    ]);
  });

  it("removes the active reaction and publishes no completion for stale output", async () => {
    const { events, orchestrator } = harness({ currentSha: "3".repeat(40) });
    assert.equal((await orchestrator.review(reference)).status, "stale");
    assert.deepEqual(events.slice(-3), ["cleanup", "delete-10", "get-head"]);
    assert.equal(events.includes("add-+1"), false);
  });

  it("publishes no completion when the head changes during final cleanup", async () => {
    await Promise.all(
      (["workspace-cleanup", "reaction-removal"] as const).map(async (mutateHeadDuring) => {
        const { events, orchestrator } = harness({ mutateHeadDuring });
        assert.deepEqual(await orchestrator.review(reference), {
          status: "stale",
          reviewedSha: "2".repeat(40),
          currentSha: "3".repeat(40),
        });
        assert.deepEqual(events.slice(-3), ["cleanup", "delete-10", "get-head"]);
        assert.equal(events.includes("add-+1"), false);
      }),
    );
  });

  it("compensates the exact completion reaction when the head changes during creation", async () => {
    const { events, orchestrator } = harness({ mutateHeadDuring: "completion-creation" });

    assert.deepEqual(await orchestrator.review(reference), {
      status: "stale",
      reviewedSha: "2".repeat(40),
      currentSha: "3".repeat(40),
    });
    assert.deepEqual(events.slice(-3), ["add-+1", "get-head", "delete-11"]);
  });

  it("removes the exact completion reaction when the postcheck fails", async () => {
    const failed = harness({ postcheckError: new Error("postcheck failed") });

    await assert.rejects(() => failed.orchestrator.review(reference), /postcheck failed/u);

    assert.deepEqual(failed.events.slice(-4), ["get-head", "add-+1", "get-head", "delete-11"]);
    assert.equal(failed.events.includes("remove-own-+1"), false);
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
    assert.deepEqual(shaFailure.events.slice(-3), ["cleanup", "delete-10", "get-head"]);
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
    assert.deepEqual(completionFailure.events.slice(-5), [
      "cleanup",
      "delete-10",
      "get-head",
      "add-+1",
      "remove-own-+1",
    ]);
  });

  it("retries retained partial-workspace cleanup without losing preparation failures", async () => {
    let cleanupAttempts = 0;
    const preparationFailure = new WorkspacePreparationError(
      new Error("clone failed with [REDACTED]"),
      new Error("initial cleanup failed"),
      async () => {
        cleanupAttempts += 1;
      },
    );
    const failed = harness({ prepareError: preparationFailure });

    await assert.rejects(
      () => failed.orchestrator.review(reference),
      (error: unknown) => {
        assert.ok(error instanceof WorkspacePreparationError);
        assert.match(error.errors.map(String).join(" "), /clone failed with \[REDACTED\]/u);
        assert.match(error.errors.map(String).join(" "), /initial cleanup failed/u);
        return true;
      },
    );

    assert.equal(cleanupAttempts, 1);
    assert.deepEqual(failed.events.slice(-2), ["prepare-installation-secret", "delete-10"]);
  });

  it("reconciles bot-owned eyes and completion reactions after ambiguous creation", async () => {
    await Promise.all(
      (["eyes", "+1"] as const).map(async (reaction) => {
        const ambiguous = harness({
          reactionError: reaction,
          ...(reaction === "+1"
            ? { completionError: new Error("network failed after creating reaction") }
            : {}),
        });
        await assert.rejects(() => ambiguous.orchestrator.review(reference));
        assert.equal(ambiguous.events.includes(`remove-own-${reaction}`), true);
        assert.equal(ambiguous.ownedReactions.has(reaction), false);
        if (reaction === "eyes") {
          assert.equal(ambiguous.events.includes("prepare-installation-secret"), false);
        }
      }),
    );
  });

  it("bounds ambiguous reaction reconciliation cleanup", async () => {
    const ambiguous = harness({
      reactionError: "eyes",
      reconciliationNeverSettles: true,
      reviewMs: 5,
    });

    await assert.rejects(
      Promise.race([
        ambiguous.orchestrator.review(reference),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("reaction reconciliation did not time out")), 100);
        }),
      ]),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors.some((item) => item instanceof ReviewTimeoutError));
        return true;
      },
    );
    assert.equal(ambiguous.events.includes("remove-own-eyes"), true);
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

  it("starts the review deadline before lock acquisition and never starts a late review", async () => {
    let finishAcquiring: ((lease: { release(): Promise<void> }) => void) | undefined;
    let acquisitionSignal: AbortSignal | undefined;
    let releases = 0;
    const timedOut = harness({
      reviewMs: 5,
      lock: {
        async acquire(signal) {
          acquisitionSignal = signal;
          return new Promise((resolve) => {
            finishAcquiring = resolve;
          });
        },
      },
    });

    await assert.rejects(
      Promise.race([
        timedOut.orchestrator.review(reference),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("lock acquisition did not cancel")), 100);
        }),
      ]),
      ReviewTimeoutError,
    );
    assert.equal(acquisitionSignal?.aborted, true);
    assert.deepEqual(timedOut.events, []);

    assert.ok(finishAcquiring);
    finishAcquiring({
      async release() {
        releases += 1;
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(releases, 1);
    assert.deepEqual(timedOut.events, []);
  });

  it("times out non-settling session creation, cleans artifacts, and disposes a late session", async () => {
    let finishCreatingSession: ((session: PiSession) => void) | undefined;
    let creationSignal: AbortSignal | undefined;
    let disposed = 0;
    let releases = 0;
    const sessions: PiSessionFactory = {
      create: async (_options, signal) =>
        new Promise<PiSession>((resolve) => {
          creationSignal = signal;
          finishCreatingSession = resolve;
        }),
    };
    const engine = new PiReviewEngine(
      { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
      sessions,
    );
    const timedOut = harness({
      reviewMs: 5,
      review: (input, signal) => engine.review(input, signal),
      lock: {
        async acquire() {
          return {
            async release() {
              releases += 1;
            },
          };
        },
      },
    });

    await assert.rejects(
      Promise.race([
        timedOut.orchestrator.review(reference),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("review did not cancel")), 100);
        }),
      ]),
      ReviewTimeoutError,
    );
    assert.equal(creationSignal?.aborted, true);
    assert.deepEqual(timedOut.events.slice(-2), ["cleanup", "delete-10"]);
    assert.equal(releases, 1);

    assert.ok(finishCreatingSession);
    finishCreatingSession({
      async run() {
        throw new Error("late session must not run");
      },
      dispose() {
        disposed += 1;
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(disposed, 1);
  });

  it("aborts a non-settling head request and still cleans every artifact", async () => {
    const timedOut = harness({ reviewMs: 5, headNeverSettles: true });
    await assert.rejects(
      Promise.race([
        timedOut.orchestrator.review(reference),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("review did not cancel")), 100);
        }),
      ]),
      ReviewTimeoutError,
    );
    assert.deepEqual(timedOut.events.slice(-3), ["cleanup", "delete-10", "get-head"]);
  });

  it("bounds non-settling workspace cleanup by the original deadline and continues cleanup", async () => {
    let finishCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let releases = 0;
    const timedOut = harness({
      reviewMs: 30,
      workspaceCleanupGate: cleanupGate,
      lock: {
        async acquire() {
          return {
            async release() {
              releases += 1;
            },
          };
        },
      },
    });
    const started = Date.now();

    await assert.rejects(
      Promise.race([
        timedOut.orchestrator.review(reference),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("workspace cleanup exceeded hard deadline")), 120);
        }),
      ]),
      ReviewTimeoutError,
    );

    assert.ok(Date.now() - started < 100);
    assert.equal(timedOut.events.filter((event) => event === "cleanup").length, 1);
    assert.equal(timedOut.events.includes("delete-10"), true);
    assert.equal(releases, 1);
    finishCleanup?.();
  });

  it("bounds non-settling reaction cleanup without renewing the review timer", async () => {
    let finishDeletion: (() => void) | undefined;
    const deletionGate = new Promise<void>((resolve) => {
      finishDeletion = resolve;
    });
    let releases = 0;
    const timedOut = harness({
      reviewMs: 30,
      reactionDeletionGate: deletionGate,
      lock: {
        async acquire() {
          return {
            async release() {
              releases += 1;
            },
          };
        },
      },
    });
    const started = Date.now();

    await assert.rejects(
      Promise.race([
        timedOut.orchestrator.review(reference),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("reaction cleanup renewed the deadline")), 120);
        }),
      ]),
      ReviewTimeoutError,
    );

    assert.ok(Date.now() - started < 100);
    assert.equal(timedOut.events.filter((event) => event === "delete-10").length, 1);
    assert.equal(releases, 1);
    finishDeletion?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(timedOut.ownedReactions.has("eyes"), false);
  });

  it("bounds lock release by the original deadline while allowing late release", async () => {
    let finishRelease: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    let releases = 0;
    let completedReleases = 0;
    const timedOut = harness({
      reviewMs: 30,
      lock: {
        async acquire() {
          return {
            async release() {
              releases += 1;
              await releaseGate;
              completedReleases += 1;
            },
          };
        },
      },
    });
    const started = Date.now();

    await assert.rejects(
      Promise.race([
        timedOut.orchestrator.review(reference),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("lock release exceeded hard deadline")), 120);
        }),
      ]),
      ReviewTimeoutError,
    );

    assert.ok(Date.now() - started < 100);
    assert.equal(releases, 1);
    assert.equal(completedReleases, 0);
    finishRelease?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(completedReleases, 1);
  });

  it("reports primary, cleanup, and release failures in stable stage order", async () => {
    const failed = harness({
      review: async () => {
        throw new Error("primary review failure");
      },
      workspaceCleanupError: new Error("workspace cleanup failure"),
      reactionDeletionError: new Error("reaction cleanup failure"),
      lock: {
        async acquire() {
          return {
            async release() {
              throw new Error("release failure");
            },
          };
        },
      },
    });

    await assert.rejects(
      () => failed.orchestrator.review(reference),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors.map((failure) => String(failure)),
          [
            "Error: primary review failure",
            "Error: workspace cleanup failure",
            "Error: reaction cleanup failure",
            "Error: release failure",
          ],
        );
        return true;
      },
    );
  });

  it("releases the process lock on every terminal path", async () => {
    let releases = 0;
    const lock: ReviewLock = {
      async acquire() {
        return {
          async release() {
            releases += 1;
          },
        };
      },
    };
    const failed = harness({
      lock,
      review: async () => {
        throw new Error("model failed");
      },
    });

    await assert.rejects(() => failed.orchestrator.review(reference), /model failed/u);
    assert.equal(releases, 1);
  });
});
