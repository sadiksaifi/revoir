import assert from "node:assert/strict";
import { access, link, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createConfiguration } from "../src/config/schema.js";
import type { ReviewFindingV1 } from "../src/review/findings.js";
import type {
  GitHubReviewGateway,
  GitHubReviewSession,
  ReviewReaction,
} from "../src/review/github.js";
import { ReviewSubmissionUncertainError } from "../src/review/github.js";
import { FileReviewLock, ReviewInProgressError, type ReviewLock } from "../src/review/lock.js";
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const expiresAt = Date.now() + 1_000;
  // Test predicates may observe asynchronous filesystem state.
  // eslint-disable-next-line no-await-in-loop
  while (!(await predicate())) {
    if (Date.now() >= expiresAt) {
      throw new Error(message);
    }
    // Poll only test-owned terminal work.
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function fileIsMissing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  }
}

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
    reactionReconciliationGate?: Promise<void>;
    headError?: Error;
    postcheckError?: Error;
    headNeverSettles?: boolean;
    mutateHeadDuring?:
      | "workspace-cleanup"
      | "reaction-removal"
      | "completion-creation"
      | "review-creation";
    pendingCreationError?: Error;
    pendingDeletionGate?: Promise<void>;
    pendingDeletionError?: Error;
    pendingSubmissionRace?: boolean;
    pendingSubmissionStarted?: () => void;
    pendingSubmissionError?: Error;
    pendingSubmissionUncertain?: boolean;
    pendingReviewState?: Set<number>;
    reactionDeletionGate?: Promise<void>;
    reactionDeletionError?: Error;
    reactionDeletionErrorAttempts?: number;
    workspaceCleanupGate?: Promise<void>;
    workspaceCleanupError?: Error;
    workspaceCleanupErrorAttempts?: number;
    lock?: ReviewLock;
    workspaces?: WorkspacePreparer;
    reviewMs?: number;
  } = {},
) {
  const events: string[] = [];
  const snapshot = options.pullRequest ?? pullRequest();
  let currentSha = options.currentSha ?? snapshot.headSha;
  let headRequests = 0;
  let nextReactionId = 10;
  let reactionDeletionFailures =
    options.reactionDeletionError === undefined
      ? 0
      : (options.reactionDeletionErrorAttempts ?? Number.POSITIVE_INFINITY);
  let workspaceCleanupFailures =
    options.workspaceCleanupError === undefined
      ? 0
      : (options.workspaceCleanupErrorAttempts ?? Number.POSITIVE_INFINITY);
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
    async removeOwnPendingReview() {
      events.push("remove-pending-review");
      options.pendingReviewState?.clear();
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
      await options.reactionReconciliationGate;
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
      if (options.reactionDeletionError !== undefined && reactionDeletionFailures > 0) {
        reactionDeletionFailures -= 1;
        throw options.reactionDeletionError;
      }
      if (id === 10) {
        ownedReactions.delete("eyes");
      }
      if (id === 10 && options.mutateHeadDuring === "reaction-removal") {
        currentSha = "3".repeat(40);
      }
    },
    async createPendingReview() {
      events.push("create-review");
      if (options.pendingCreationError !== undefined) {
        throw options.pendingCreationError;
      }
      if (options.mutateHeadDuring === "review-creation") {
        currentSha = "3".repeat(40);
      }
      options.pendingReviewState?.add(20);
      return {
        id: 20,
        async delete() {
          events.push("delete-review-20");
          await options.pendingDeletionGate;
          if (options.pendingDeletionError !== undefined) {
            throw options.pendingDeletionError;
          }
          options.pendingReviewState?.delete(20);
        },
        async submit(submitSignal, reconciliationSignal) {
          events.push("submit-review-20");
          options.pendingSubmissionStarted?.();
          if (options.pendingSubmissionUncertain === true) {
            if (!submitSignal.aborted) {
              await new Promise<void>((resolve) => {
                submitSignal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
            throw new ReviewSubmissionUncertainError();
          }
          if (options.pendingSubmissionRace === true) {
            if (!submitSignal.aborted) {
              await new Promise<void>((resolve) => {
                submitSignal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
            if (reconciliationSignal === undefined || reconciliationSignal.aborted) {
              throw submitSignal.reason;
            }
            options.pendingReviewState?.delete(20);
            return;
          }
          if (options.pendingSubmissionError !== undefined) {
            throw options.pendingSubmissionError;
          }
          options.pendingReviewState?.delete(20);
        },
      };
    },
  };
  const github: GitHubReviewGateway = {
    async authenticate() {
      events.push("authenticate");
      return session;
    },
  };
  const workspaces: WorkspacePreparer = options.workspaces ?? {
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
          if (options.workspaceCleanupError !== undefined && workspaceCleanupFailures > 0) {
            workspaceCleanupFailures -= 1;
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

function validatedFinding(): ReviewFindingV1 {
  return {
    version: 1,
    fingerprint: "a".repeat(64),
    priority: "P1",
    title: "Cancellation is dropped",
    path: "source.ts",
    range: { start: 2, end: 2, side: "RIGHT" },
    issue: "The added operation does not receive cancellation.",
    impact: "Timed-out work continues consuming resources.",
    evidence: "The added call has no signal argument.",
    fixDirection: "Pass the active signal to the call.",
    attachment: {
      kind: "inline",
      path: "source.ts",
      startLine: 2,
      endLine: 2,
      side: "RIGHT",
    },
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
      "remove-pending-review",
      "add-+1",
      "get-head",
    ]);
  });

  it("publishes findings through one current non-blocking review and never adds a thumb", async () => {
    const { events, orchestrator } = harness({
      review: async () => ({
        findings: [validatedFinding()],
        diagnostics: [
          {
            index: 1,
            code: "invalid" as const,
            message: "findings[1].priority must be supported.",
          },
        ],
      }),
    });
    assert.deepEqual(await orchestrator.review(reference), {
      status: "findings",
      reviewedSha: "2".repeat(40),
      currentSha: "2".repeat(40),
      publishedFindings: 1,
      rejectedFindings: 1,
      diagnostics: [
        {
          index: 1,
          code: "invalid",
          message: "findings[1].priority must be supported.",
        },
      ],
    });
    assert.deepEqual(events.slice(-6), [
      "delete-10",
      "get-head",
      "remove-pending-review",
      "create-review",
      "get-head",
      "submit-review-20",
    ]);
    assert.equal(events.filter((event) => event === "create-review").length, 1);
    assert.equal(events.includes("add-+1"), false);
  });

  it("deletes a pending findings review when the head changes before submission", async () => {
    const { events, orchestrator } = harness({
      mutateHeadDuring: "review-creation",
      review: async () => ({ findings: [validatedFinding()], diagnostics: [] }),
    });
    assert.deepEqual(await orchestrator.review(reference), {
      status: "stale",
      reviewedSha: "2".repeat(40),
      currentSha: "3".repeat(40),
    });
    assert.deepEqual(events.slice(-3), ["create-review", "get-head", "delete-review-20"]);
    assert.equal(events.includes("submit-review-20"), false);
    assert.equal(events.includes("add-+1"), false);
  });

  it("cleans pending review state after creation and submission failures", async () => {
    const creation = harness({
      pendingCreationError: new Error("draft failed"),
      review: async () => ({ findings: [validatedFinding()], diagnostics: [] }),
    });
    await assert.rejects(() => creation.orchestrator.review(reference), /draft failed/u);
    assert.equal(creation.events.includes("delete-review-20"), false);
    assert.equal(creation.events.includes("add-+1"), false);

    const submission = harness({
      pendingSubmissionError: new Error("submit failed"),
      review: async () => ({ findings: [validatedFinding()], diagnostics: [] }),
    });
    await assert.rejects(() => submission.orchestrator.review(reference), /submit failed/u);
    assert.deepEqual(submission.events.slice(-3), [
      "get-head",
      "submit-review-20",
      "delete-review-20",
    ]);
    assert.equal(submission.events.includes("add-+1"), false);
  });

  it("reconciles a remotely submitted review after cancellation and releases the process lock", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-submit-race-lock-"));
    let allowSubmittedDeletion: (() => void) | undefined;
    const submittedDeletionGate = new Promise<void>((resolve) => {
      allowSubmittedDeletion = resolve;
    });
    let observeSubmission!: () => void;
    const submissionStarted = new Promise<void>((resolve) => {
      observeSubmission = resolve;
    });
    const first = harness({
      reviewMs: 20,
      lock: new FileReviewLock(stateDirectory),
      pendingDeletionGate: submittedDeletionGate,
      pendingSubmissionRace: true,
      pendingSubmissionStarted: observeSubmission,
      review: async () => ({ findings: [validatedFinding()], diagnostics: [] }),
    });
    const second = harness({ lock: new FileReviewLock(stateDirectory) });
    const lockPath = join(stateDirectory, "manual-review.lock");

    try {
      const firstReview = assert.rejects(first.orchestrator.review(reference), ReviewTimeoutError);
      await submissionStarted;
      context.mock.timers.tick(20);
      await firstReview;
      await waitFor(
        () => fileIsMissing(lockPath),
        "submitted-review reconciliation did not release the process lock",
      );

      assert.equal(first.events.includes("delete-review-20"), false);
      assert.equal((await second.orchestrator.review(reference)).status, "clean");
    } finally {
      allowSubmittedDeletion?.();
      await waitFor(() => fileIsMissing(lockPath), "test cleanup did not release the process lock");
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("reconciles an ambiguously submitted pending review on a later clean run", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-submit-unknown-lock-"));
    let allowPendingDeletion: (() => void) | undefined;
    const pendingDeletionGate = new Promise<void>((resolve) => {
      allowPendingDeletion = resolve;
    });
    let observeSubmission!: () => void;
    const submissionStarted = new Promise<void>((resolve) => {
      observeSubmission = resolve;
    });
    const pendingReviewState = new Set<number>();
    const first = harness({
      reviewMs: 20,
      lock: new FileReviewLock(stateDirectory),
      pendingDeletionGate,
      pendingReviewState,
      pendingSubmissionUncertain: true,
      pendingSubmissionStarted: observeSubmission,
      review: async () => ({ findings: [validatedFinding()], diagnostics: [] }),
    });
    const second = harness({
      lock: new FileReviewLock(stateDirectory),
      pendingReviewState,
    });
    const lockPath = join(stateDirectory, "manual-review.lock");

    try {
      const firstReview = assert.rejects(first.orchestrator.review(reference), ReviewTimeoutError);
      await submissionStarted;
      context.mock.timers.tick(20);
      await firstReview;
      await waitFor(
        () => fileIsMissing(lockPath),
        "ambiguous review submission retained the process lock",
      );

      assert.equal(first.events.includes("delete-review-20"), false);
      assert.deepEqual([...pendingReviewState], [20]);
      assert.equal((await second.orchestrator.review(reference)).status, "clean");
      assert.equal(second.events.includes("remove-pending-review"), true);
      assert.equal(pendingReviewState.size, 0);
    } finally {
      allowPendingDeletion?.();
      await waitFor(() => fileIsMissing(lockPath), "test cleanup did not release the process lock");
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("removes the active reaction and publishes no completion for stale output", async () => {
    const { events, orchestrator } = harness({ currentSha: "3".repeat(40) });
    assert.equal((await orchestrator.review(reference)).status, "stale");
    assert.deepEqual(events.slice(-4), [
      "cleanup",
      "delete-10",
      "get-head",
      "remove-pending-review",
    ]);
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
        assert.deepEqual(events.slice(-4), [
          "cleanup",
          "delete-10",
          "get-head",
          "remove-pending-review",
        ]);
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

    assert.deepEqual(failed.events.slice(-5), [
      "get-head",
      "remove-pending-review",
      "add-+1",
      "get-head",
      "delete-11",
    ]);
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
    assert.deepEqual(completionFailure.events.slice(-6), [
      "cleanup",
      "delete-10",
      "get-head",
      "remove-pending-review",
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
      ReviewTimeoutError,
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
    await waitFor(
      () => timedOut.events.includes("delete-10"),
      "timed-out review did not finish terminal cleanup",
    );
    assert.deepEqual(timedOut.events.slice(-2), ["cleanup", "delete-10"]);
  });

  it("keeps the process lock while a timed-out review engine is still active", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-orchestrator-lock-"));
    let finishReview: (() => void) | undefined;
    const reviewGate = new Promise<void>((resolve) => {
      finishReview = resolve;
    });
    let markReviewStarted: (() => void) | undefined;
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve;
    });
    const first = harness({
      reviewMs: 50,
      lock: new FileReviewLock(stateDirectory),
      review: async () => {
        markReviewStarted?.();
        await reviewGate;
      },
    });
    const second = harness({
      lock: new FileReviewLock(stateDirectory),
    });

    try {
      const firstReview = first.orchestrator.review(reference);
      await reviewStarted;
      await assert.rejects(firstReview, ReviewTimeoutError);
      await assert.rejects(() => second.orchestrator.review(reference), ReviewInProgressError);

      finishReview?.();
      await waitFor(
        () => fileIsMissing(join(stateDirectory, "manual-review.lock")),
        "the timed-out review did not finish terminal finalization",
      );
      assert.deepEqual(await second.orchestrator.review(reference), {
        status: "clean",
        reviewedSha: "2".repeat(40),
        currentSha: "2".repeat(40),
      });
    } finally {
      finishReview?.();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the process lock for work that never settles in the live owner process", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-orchestrator-lock-"));
    let markReviewStarted: (() => void) | undefined;
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve;
    });
    const first = harness({
      reviewMs: 50,
      lock: new FileReviewLock(stateDirectory),
      review: async () => {
        markReviewStarted?.();
        return new Promise<void>(() => {});
      },
    });
    const second = harness({ lock: new FileReviewLock(stateDirectory) });

    try {
      const firstReview = first.orchestrator.review(reference);
      await reviewStarted;
      await assert.rejects(firstReview, ReviewTimeoutError);
      await assert.rejects(() => second.orchestrator.review(reference), ReviewInProgressError);
      assert.equal(await fileIsMissing(join(stateDirectory, "manual-review.lock")), false);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the process lock while timed-out workspace preparation is still active", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-orchestrator-lock-"));
    let finishPreparation: ((workspace: PreparedWorkspace) => void) | undefined;
    const first = harness({
      reviewMs: 50,
      lock: new FileReviewLock(stateDirectory),
      workspaces: {
        prepare: async () =>
          new Promise<PreparedWorkspace>((resolve) => {
            finishPreparation = resolve;
          }),
      },
    });
    const second = harness({ lock: new FileReviewLock(stateDirectory) });

    try {
      const firstReview = first.orchestrator.review(reference);
      await waitFor(() => finishPreparation !== undefined, "workspace preparation did not start");
      await assert.rejects(firstReview, ReviewTimeoutError);
      await assert.rejects(() => second.orchestrator.review(reference), ReviewInProgressError);

      finishPreparation?.({
        root: "/tmp/late-review",
        checkout: "/tmp/late-review/repository",
        diff: "diff",
        remoteUrl: "https://github.com/owner/repository.git",
        async cleanup() {},
      });
      await waitFor(
        () => fileIsMissing(join(stateDirectory, "manual-review.lock")),
        "late workspace finalization did not finish",
      );
      assert.equal((await second.orchestrator.review(reference)).status, "clean");
    } finally {
      finishPreparation?.({
        root: "/tmp/late-review",
        checkout: "/tmp/late-review/repository",
        diff: "diff",
        remoteUrl: "https://github.com/owner/repository.git",
        async cleanup() {},
      });
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("keeps generic reaction compensation ahead of the next review", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-orchestrator-lock-"));
    let finishReconciliation: (() => void) | undefined;
    const reconciliationGate = new Promise<void>((resolve) => {
      finishReconciliation = resolve;
    });
    const first = harness({
      reviewMs: 50,
      lock: new FileReviewLock(stateDirectory),
      reactionError: "eyes",
      reactionReconciliationGate: reconciliationGate,
    });
    const second = harness({ lock: new FileReviewLock(stateDirectory) });

    try {
      const firstReview = first.orchestrator.review(reference);
      await waitFor(
        () => first.events.includes("remove-own-eyes"),
        "generic reconciliation did not start",
      );
      await assert.rejects(firstReview, ReviewTimeoutError);
      await assert.rejects(() => second.orchestrator.review(reference), ReviewInProgressError);
      assert.deepEqual(second.events, []);

      finishReconciliation?.();
      await waitFor(
        () => fileIsMissing(join(stateDirectory, "manual-review.lock")),
        "generic reconciliation did not release the process lock",
      );
      assert.equal((await second.orchestrator.review(reference)).status, "clean");
    } finally {
      finishReconciliation?.();
      await rm(stateDirectory, { recursive: true, force: true });
    }
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

  it("retains a lock committed after timeout and retries release until it is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-late-lock-test-"));
    const stateDirectory = join(root, "state", "revoir");
    const lockPath = join(stateDirectory, "manual-review.lock");
    let linkCommitted = false;
    let resumeLink: (() => void) | undefined;
    const linkGate = new Promise<void>((resolve) => {
      resumeLink = resolve;
    });
    let releaseReads = 0;
    let releaseUnlinks = 0;
    const timedOut = harness({
      reviewMs: 50,
      lock: new FileReviewLock(stateDirectory, {
        async link(existingPath, newPath) {
          await link(existingPath, newPath);
          if (newPath === lockPath) {
            linkCommitted = true;
            await linkGate;
          }
        },
        async readFile(path, encoding) {
          if (path === lockPath) {
            releaseReads += 1;
            if (releaseReads === 1) {
              throw new Error("transient late release read failure");
            }
          }
          return readFile(path, encoding);
        },
        async unlink(path) {
          if (path === lockPath) {
            releaseUnlinks += 1;
            if (releaseUnlinks === 1) {
              throw new Error("transient late release unlink failure");
            }
          }
          await unlink(path);
        },
      }),
    });

    try {
      const foreground = timedOut.orchestrator.review(reference).then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitFor(() => linkCommitted, "lock did not reach the committed boundary");
      const failure = await foreground;

      assert.ok(failure instanceof ReviewTimeoutError);
      assert.deepEqual(timedOut.events, []);
      assert.equal(await fileIsMissing(lockPath), false);

      resumeLink?.();
      await waitFor(
        () => fileIsMissing(lockPath),
        "late committed lock was not released after transient failures",
      );
      assert.equal(releaseReads, 3);
      assert.equal(releaseUnlinks, 2);
      assert.deepEqual(timedOut.events, []);
    } finally {
      resumeLink?.();
      await rm(root, { recursive: true, force: true });
    }
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
    assert.equal(timedOut.events.includes("cleanup"), false);
    assert.equal(timedOut.events.includes("delete-10"), false);
    assert.equal(releases, 0);

    assert.ok(finishCreatingSession);
    finishCreatingSession({
      async abort() {},
      async run() {
        throw new Error("late session must not run");
      },
      async dispose() {
        disposed += 1;
      },
    });
    await waitFor(() => releases === 1, "late Pi finalization did not release the lock");
    assert.equal(disposed, 1);
    assert.deepEqual(timedOut.events.slice(-2), ["cleanup", "delete-10"]);
  });

  it("retries late workspace cleanup to success before releasing the process lock", async () => {
    let finishPreparation: ((workspace: PreparedWorkspace) => void) | undefined;
    let cleanupCalls = 0;
    let releases = 0;
    let engineCalls = 0;
    const timedOut = harness({
      reviewMs: 5,
      workspaces: {
        prepare: async () =>
          new Promise<PreparedWorkspace>((resolve) => {
            finishPreparation = resolve;
          }),
      },
      review: async () => {
        engineCalls += 1;
      },
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

    await assert.rejects(() => timedOut.orchestrator.review(reference), ReviewTimeoutError);
    assert.equal(releases, 0);
    assert.equal(engineCalls, 0);

    assert.ok(finishPreparation);
    finishPreparation({
      root: "/tmp/late-review",
      checkout: "/tmp/late-review/repository",
      diff: "diff",
      remoteUrl: "https://github.com/owner/repository.git",
      async cleanup() {
        cleanupCalls += 1;
        if (cleanupCalls === 1) {
          throw new Error("transient late cleanup failure");
        }
      },
    });
    await waitFor(() => releases === 1, "late workspace finalization did not release the lock");
    assert.equal(cleanupCalls, 2);
    assert.equal(timedOut.events.includes("delete-10"), true);
  });

  it("cleans a workspace that finishes synchronously at the abort boundary", async () => {
    let cleanupCalls = 0;
    let releases = 0;
    let engineCalls = 0;
    const workspace: PreparedWorkspace = {
      root: "/tmp/abort-boundary-review",
      checkout: "/tmp/abort-boundary-review/repository",
      diff: "diff",
      remoteUrl: "https://github.com/owner/repository.git",
      async cleanup() {
        cleanupCalls += 1;
      },
    };
    const timedOut = harness({
      reviewMs: 5,
      workspaces: {
        prepare: async (_reference, _pullRequest, _token, signal) =>
          new Promise<PreparedWorkspace>((resolve) => {
            signal.addEventListener("abort", () => resolve(workspace), { once: true });
          }),
      },
      review: async () => {
        engineCalls += 1;
      },
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

    await assert.rejects(() => timedOut.orchestrator.review(reference), ReviewTimeoutError);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(cleanupCalls, 1);
    assert.equal(releases, 1);
    assert.equal(engineCalls, 0);
  });

  it("retains and retries late workspace cleanup after the original timeout", async () => {
    let finishPreparation: ((workspace: PreparedWorkspace) => void) | undefined;
    let cleanupCalls = 0;
    let releases = 0;
    const timedOut = harness({
      reviewMs: 5,
      workspaces: {
        prepare: async () =>
          new Promise<PreparedWorkspace>((resolve) => {
            finishPreparation = resolve;
          }),
      },
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

    const failure = await timedOut.orchestrator.review(reference).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof ReviewTimeoutError);

    const unhandledRejections: unknown[] = [];
    const captureUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", captureUnhandledRejection);
    try {
      assert.ok(finishPreparation);
      finishPreparation({
        root: "/tmp/rejected-late-cleanup",
        checkout: "/tmp/rejected-late-cleanup/repository",
        diff: "diff",
        remoteUrl: "https://github.com/owner/repository.git",
        async cleanup() {
          cleanupCalls += 1;
          if (cleanupCalls === 1) {
            throw new Error("transient late cleanup failure");
          }
        },
      });
      await waitFor(() => releases === 1, "retrying late cleanup did not release the lock");
    } finally {
      process.removeListener("unhandledRejection", captureUnhandledRejection);
    }

    assert.equal(cleanupCalls, 2);
    assert.deepEqual(unhandledRejections, []);
  });

  it("retains late partial-workspace cleanup after the review times out", async () => {
    let failPreparation: ((error: Error) => void) | undefined;
    let cleanupCalls = 0;
    const timedOut = harness({
      reviewMs: 5,
      workspaces: {
        prepare: async () =>
          new Promise<PreparedWorkspace>((_resolve, reject) => {
            failPreparation = reject;
          }),
      },
    });

    await assert.rejects(() => timedOut.orchestrator.review(reference), ReviewTimeoutError);

    assert.ok(failPreparation);
    failPreparation(
      new WorkspacePreparationError(
        new Error("late preparation failed"),
        new Error("initial late cleanup failed"),
        async () => {
          cleanupCalls += 1;
        },
      ),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(cleanupCalls, 1);
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
    assert.equal(timedOut.events.includes("delete-10"), false);
    assert.equal(releases, 0);
    finishCleanup?.();
    await waitFor(() => releases === 1, "workspace cleanup did not finish before release");
    assert.equal(timedOut.events.includes("delete-10"), true);
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
    assert.equal(releases, 0);
    finishDeletion?.();
    await waitFor(() => releases === 1, "reaction cleanup did not finish before release");
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
      workspaceCleanupErrorAttempts: 1,
      reactionDeletionError: new Error("reaction cleanup failure"),
      reactionDeletionErrorAttempts: 1,
      lock: {
        async acquire() {
          let releaseAttempts = 0;
          return {
            async release() {
              releaseAttempts += 1;
              if (releaseAttempts === 1) {
                throw new Error("release failure");
              }
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
