import assert from "node:assert/strict";
import { access, link, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { withRepository, type RevoirPolicy } from "../src/config/policy.js";
import { createConfiguration } from "../src/config/schema.js";
import type { GitHubReviewEvidence } from "../src/review/evidence.js";
import type { ReviewFindingV2 } from "../src/review/findings.js";
import type {
  GitHubReviewCheckCompletion,
  GitHubReviewGateway,
  GitHubReviewSession,
  ReviewReaction,
} from "../src/review/github.js";
import {
  PendingReviewUncertainError,
  ReviewSubmissionUncertainError,
} from "../src/review/github.js";
import { FileReviewLock, ReviewInProgressError, type ReviewLock } from "../src/review/lock.js";
import { CleanReviewOrchestrator, ReviewTimeoutError } from "../src/review/orchestrator.js";
import {
  PiReviewEngine,
  type PiSession,
  type PiSessionFactory,
  type ReviewEngine,
} from "../src/review/pi.js";
import type { ReviewPublication } from "../src/review/publication.js";
import { parsePullRequestUrl, type PullRequestSnapshot } from "../src/review/pull-request.js";
import {
  bodyStateFindingIdentities,
  planFindingReconciliation,
  type PriorReviewState,
} from "../src/review/reconciliation.js";
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

async function settleWithin<T>(operation: Promise<T>, message: string): Promise<T> {
  let hardDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        hardDeadline = setTimeout(() => {
          reject(new Error(message));
        }, 250);
      }),
    ]);
  } finally {
    clearTimeout(hardDeadline);
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
  const value = createConfiguration({
    github: {
      appId: 7,
      appSlug: "revoir-test",
      privateKey: TEST_PRIVATE_KEY,
      webhookSecret: "test-webhook-secret",
    },
    cloudflare: {
      accountId: "account",
      queueId: "queue",
      queueName: "revoir-review-jobs",
      kvNamespaceId: "kv-namespace",
      workerName: "revoir-relay",
      relayUrl: "https://revoir-relay.example.workers.dev/github/webhook",
      apiToken: "cloudflare-token",
    },
    paths: {
      cacheDir: "/tmp/cache",
      stateDir: "/tmp/state",
      dataDir: "/tmp/data",
    },
    timeouts: { reviewMs },
  });
  return Object.assign(value, {
    policy: withRepository({ version: 1, revision: 0, userId: 42, installations: [] }, 8, {
      id: 99,
      owner: "owner",
      name: "repository",
    }),
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
    checkCompletionError?: Error;
    checkCompletionErrorAttempts?: number;
    checkCompletionAttempted?: (attempt: number) => void;
    checkCreationError?: Error;
    evidence?: GitHubReviewEvidence;
    pullRequest?: PullRequestSnapshot;
    review?: ReviewEngine["review"];
    priorReviewState?: PriorReviewState;
    priorReviewStateAfterPendingRemoval?: PriorReviewState;
    threadResolutionStaleSha?: string;
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
      | "workspace-prepare"
      | "pending-review-removal"
      | "reaction-removal"
      | "completion-creation"
      | "review-creation";
    pendingCreationError?: Error;
    pendingDeletionGate?: Promise<void>;
    pendingDeletionError?: Error;
    pendingDeletionErrorAttempts?: number;
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
    loadPolicy?: (signal?: AbortSignal) => Promise<RevoirPolicy>;
    workspaces?: WorkspacePreparer;
    reviewMs?: number;
  } = {},
) {
  const events: string[] = [];
  const checkCompletions: GitHubReviewCheckCompletion[] = [];
  const checkStartedShas: string[] = [];
  const createdPublications: ReviewPublication[] = [];
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
  let pendingDeletionFailures =
    options.pendingDeletionError === undefined
      ? 0
      : (options.pendingDeletionErrorAttempts ?? Number.POSITIVE_INFINITY);
  let checkCompletionFailures =
    options.checkCompletionError === undefined
      ? 0
      : (options.checkCompletionErrorAttempts ?? Number.POSITIVE_INFINITY);
  const ownedReactions = new Set<ReviewReaction>();
  let pendingReviewRemoved = false;
  const session: GitHubReviewSession = {
    installationToken: "installation-secret",
    async startReviewCheck(_reference, headSha) {
      checkStartedShas.push(headSha);
      if (options.checkCreationError !== undefined) {
        throw options.checkCreationError;
      }
      return {
        id: 30,
        async complete(completion) {
          checkCompletions.push(completion);
          options.checkCompletionAttempted?.(checkCompletions.length);
          if (options.checkCompletionError !== undefined && checkCompletionFailures > 0) {
            checkCompletionFailures -= 1;
            throw options.checkCompletionError;
          }
        },
      };
    },
    async getPullRequest() {
      events.push("get-pr");
      return snapshot;
    },
    async getReviewEvidence() {
      events.push("get-evidence");
      return options.evidence ?? { completedChecks: [] };
    },
    async getHeadSha(_reference, signal?: AbortSignal) {
      events.push("get-head");
      headRequests += 1;
      if (headRequests === 3 && options.headError !== undefined) {
        throw options.headError;
      }
      if (headRequests === 5 && options.postcheckError !== undefined) {
        throw options.postcheckError;
      }
      if (options.headNeverSettles && headRequests === 3) {
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
    async upsertFailureComment() {
      events.push("upsert-failure-comment");
    },
    async removeOwnFailureComment() {
      events.push("remove-failure-comment");
    },
    async removeOwnPendingReview() {
      events.push("remove-pending-review");
      options.pendingReviewState?.clear();
      pendingReviewRemoved = true;
      if (options.mutateHeadDuring === "pending-review-removal") {
        currentSha = "3".repeat(40);
      }
    },
    async getPriorReviewState() {
      events.push("get-prior-review-state");
      return (
        (pendingReviewRemoved ? options.priorReviewStateAfterPendingRemoval : undefined) ??
        options.priorReviewState ?? {
          ownedOpenThreads: [],
          runHeadShas: [],
        }
      );
    },
    async resolveReviewThreads(_reference, threadIds, _expectedHeadSha, _signal) {
      events.push(`resolve-threads-${threadIds.join(",")}`);
      return options.threadResolutionStaleSha === undefined
        ? { status: "resolved" as const }
        : { status: "stale" as const, currentSha: options.threadResolutionStaleSha };
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
    async createPendingReview(_reference, publication) {
      events.push("create-review");
      createdPublications.push(publication);
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
          if (options.pendingDeletionError !== undefined && pendingDeletionFailures > 0) {
            pendingDeletionFailures -= 1;
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
      if (options.mutateHeadDuring === "workspace-prepare") {
        currentSha = "3".repeat(40);
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
    checkCompletions,
    checkStartedShas,
    createdPublications,
    events,
    ownedReactions,
    orchestrator: new CleanReviewOrchestrator(configuration(options.reviewMs), {
      github,
      lock: options.lock ?? {
        async acquire() {
          return { async release() {} };
        },
      },
      loadPolicy:
        options.loadPolicy ?? (async () => configuration(options.reviewMs).policy),
      workspaces,
      reviewEngine,
    }),
  };
}

function validatedFinding(): ReviewFindingV2 {
  return {
    version: 2,
    fingerprint: "a".repeat(64),
    priority: "P1",
    path: "source.ts",
    range: { start: 2, end: 2, side: "RIGHT" },
    defectKind: "concurrency",
    impactKind: "execution-stall",
    fixAction: "propagate",
    reason: "The cancellation signal is not propagated, so the active review cannot stop.",
    anchor: "signal",
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
    const { checkCompletions, checkStartedShas, events, orchestrator } = harness();
    assert.deepEqual(await orchestrator.review(reference), {
      status: "clean",
      reviewedSha: "2".repeat(40),
      currentSha: "2".repeat(40),
    });
    assert.deepEqual(checkStartedShas, ["2".repeat(40)]);
    assert.deepEqual(checkCompletions, [
      {
        conclusion: "success",
        title: "Review completed",
        summary: "Revoir completed the review and found no actionable issues.",
      },
    ]);
    assert.deepEqual(events, [
      "authenticate",
      "get-pr",
      "get-head",
      "remove-old-thumb",
      "add-eyes",
      "prepare-installation-secret",
      "get-head",
      "get-evidence",
      "review",
      "cleanup",
      "delete-10",
      "get-head",
      "remove-pending-review",
      "get-prior-review-state",
      "get-head",
      "add-+1",
      "get-head",
      "remove-failure-comment",
    ]);
  });

  it("completes the execution check successfully when review findings are published", async () => {
    const reviewed = harness({
      review: async () => ({ findings: [validatedFinding()], diagnostics: [] }),
    });

    assert.equal((await reviewed.orchestrator.review(reference)).status, "findings");
    assert.deepEqual(reviewed.checkCompletions, [
      {
        conclusion: "success",
        title: "Review completed with findings",
        summary:
          "Revoir completed the review and published 1 new finding. Review threads contain the details.",
      },
    ]);
  });

  it("cancels the execution check when a newer pull request head supersedes the review", async () => {
    const reviewed = harness({ mutateHeadDuring: "workspace-prepare" });

    assert.equal((await reviewed.orchestrator.review(reference)).status, "stale");
    assert.deepEqual(reviewed.checkCompletions, [
      {
        conclusion: "cancelled",
        title: "Review superseded",
        summary:
          "The pull request head changed from 2222222 to 3333333 before the review completed.",
      },
    ]);
  });

  it("fails the execution check when the review engine fails", async () => {
    const reviewed = harness({
      review: async () => {
        throw new Error("Pi failed");
      },
    });

    await assert.rejects(() => reviewed.orchestrator.review(reference), /Pi failed/u);
    assert.deepEqual(reviewed.checkCompletions, [
      {
        conclusion: "failure",
        title: "Review failed",
        summary:
          "Revoir could not complete this review. See the failure comment or service logs for details.",
      },
    ]);
  });

  it("retries transient execution-check completion failures", async () => {
    const reviewed = harness({
      checkCompletionError: new Error("GitHub check update failed"),
      checkCompletionErrorAttempts: 2,
    });

    assert.equal((await reviewed.orchestrator.review(reference)).status, "clean");
    assert.equal(reviewed.checkCompletions.length, 3);
    assert.equal(
      reviewed.checkCompletions.every((completion) => completion.conclusion === "success"),
      true,
    );
  });

  it("keeps a failed check conclusion stable when cancellation arrives between retries", async () => {
    const controller = new AbortController();
    const reviewFailure = new Error("Pi failed");
    const reviewed = harness({
      review: async () => {
        throw reviewFailure;
      },
      checkCompletionError: new Error("GitHub check update failed"),
      checkCompletionErrorAttempts: 1,
      checkCompletionAttempted(attempt) {
        if (attempt === 1) {
          controller.abort(new Error("daemon stopped"));
        }
      },
    });

    await assert.rejects(
      reviewed.orchestrator.review(reference, { signal: controller.signal }),
      reviewFailure,
    );
    assert.equal(reviewed.checkCompletions.length, 2);
    assert.equal(
      reviewed.checkCompletions.every((completion) => completion.conclusion === "failure"),
      true,
    );
  });

  it("publishes a finding supported by failed CI evidence without waiting for pending CI", async () => {
    const evidence: GitHubReviewEvidence = {
      completedChecks: [
        {
          name: "unit",
          conclusion: "failure",
          failedActionsLog: "FAIL API returned 200 instead of 404",
        },
      ],
    };
    const { events, orchestrator } = harness({
      evidence,
      review: async (input) => {
        assert.deepEqual(input.evidence, evidence);
        return { findings: [validatedFinding()], diagnostics: [] };
      },
    });

    assert.deepEqual(await orchestrator.review(reference), {
      status: "findings",
      reviewedSha: "2".repeat(40),
      currentSha: "2".repeat(40),
      publishedFindings: 1,
      rejectedFindings: 0,
      diagnostics: [],
    });
    assert.ok(events.indexOf("get-evidence") < events.indexOf("create-review"));
    assert.equal(events.includes("submit-review-20"), true);
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
    assert.deepEqual(events.slice(-9), [
      "delete-10",
      "get-head",
      "remove-pending-review",
      "get-prior-review-state",
      "get-head",
      "create-review",
      "get-head",
      "submit-review-20",
      "remove-failure-comment",
    ]);
    assert.equal(events.filter((event) => event === "create-review").length, 1);
    assert.equal(events.includes("add-+1"), false);
  });

  it("skips Pi and lifecycle reactions when queued work is stale before review starts", async () => {
    const { events, orchestrator } = harness({ currentSha: "3".repeat(40) });

    assert.deepEqual(await orchestrator.review(reference), {
      status: "stale",
      reviewedSha: "2".repeat(40),
      currentSha: "3".repeat(40),
    });
    assert.deepEqual(events, ["authenticate", "get-pr", "get-head"]);
  });

  it("settles an obsolete queued head before reading live lifecycle state", async () => {
    const { events, orchestrator } = harness();

    assert.deepEqual(
      await orchestrator.review(reference, {
        expectedHeadSha: "3".repeat(40),
      }),
      {
        status: "stale",
        reviewedSha: "3".repeat(40),
        currentSha: "2".repeat(40),
      },
    );
    assert.deepEqual(events, ["authenticate", "get-pr"]);
  });

  it("skips Pi when the head changes while preparing the complete current diff", async () => {
    const { events, orchestrator } = harness({ mutateHeadDuring: "workspace-prepare" });

    assert.equal((await orchestrator.review(reference)).status, "stale");
    assert.equal(events.includes("review"), false);
    assert.equal(events.includes("create-review"), false);
    assert.equal(events.includes("add-+1"), false);
  });

  it("publishes only net-new findings and resolves only obsolete owned threads", async () => {
    const unchanged = validatedFinding();
    const netNew = {
      ...validatedFinding(),
      fingerprint: "b".repeat(64),
      anchor: "otherSignal",
    };
    const { createdPublications, events, orchestrator } = harness({
      priorReviewState: {
        ownedOpenThreads: [
          { id: "THREAD_OLD", fingerprint: "c".repeat(64) },
          { id: "THREAD_CURRENT", fingerprint: unchanged.fingerprint },
        ],
        runHeadShas: ["1".repeat(40)],
      },
      review: async () => ({ findings: [unchanged, netNew], diagnostics: [] }),
    });

    assert.deepEqual(await orchestrator.review(reference), {
      status: "findings",
      reviewedSha: "2".repeat(40),
      currentSha: "2".repeat(40),
      publishedFindings: 1,
      rejectedFindings: 0,
      diagnostics: [],
    });
    assert.equal(events.includes("resolve-threads-THREAD_OLD"), true);
    assert.equal(createdPublications.length, 1);
    assert.equal(createdPublications[0]?.payload.comments?.length, 1);
    assert.match(
      createdPublications[0]?.payload.comments?.[0]?.body ?? "",
      new RegExp(netNew.fingerprint, "u"),
    );
    assert.doesNotMatch(
      createdPublications[0]?.payload.comments?.[0]?.body ?? "",
      new RegExp(unchanged.fingerprint, "u"),
    );
  });

  it("does not repost an unchanged finding on a repeated review", async () => {
    const unchanged = validatedFinding();
    const { createdPublications, events, orchestrator } = harness({
      priorReviewState: {
        ownedOpenThreads: [{ id: "THREAD_CURRENT", fingerprint: unchanged.fingerprint }],
        runHeadShas: ["1".repeat(40)],
      },
      review: async () => ({ findings: [unchanged], diagnostics: [] }),
    });

    assert.equal((await orchestrator.review(reference)).status, "findings");
    assert.equal(createdPublications.length, 0);
    assert.equal(events.includes("resolve-threads-THREAD_CURRENT"), false);
    assert.equal(events.includes("add-+1"), false);
  });

  it("publishes a state-only review when a body finding disappears", async () => {
    const unchangedInline = validatedFinding();
    const disappearedBody = {
      ...validatedFinding(),
      fingerprint: "b".repeat(64),
      range: null,
      anchor: "source.ts",
      attachment: { kind: "file", path: "source.ts" } as const,
    };
    const { createdPublications, orchestrator } = harness({
      priorReviewState: {
        bodyFindings: [{ fingerprint: disappearedBody.fingerprint }],
        ownedOpenThreads: [{ id: "THREAD_CURRENT", fingerprint: unchangedInline.fingerprint }],
        runHeadShas: ["1".repeat(40)],
      },
      review: async () => ({ findings: [unchangedInline], diagnostics: [] }),
    });

    assert.deepEqual(await orchestrator.review(reference), {
      status: "findings",
      reviewedSha: "2".repeat(40),
      currentSha: "2".repeat(40),
      publishedFindings: 0,
      rejectedFindings: 0,
      diagnostics: [],
    });
    assert.equal(createdPublications.length, 1);
    assert.equal(createdPublications[0]?.payload.comments, undefined);
    assert.match(createdPublications[0]?.payload.body ?? "", /<!-- revoir:body-state:v1 -->/u);
    assert.doesNotMatch(createdPublications[0]?.payload.body ?? "", /revoir:body-finding/u);
  });

  it("persists clean body retirement before a stale successor consumes the completion reaction", async () => {
    const returnedBodyFinding = {
      ...validatedFinding(),
      range: null,
      anchor: "source.ts",
      attachment: { kind: "file", path: "source.ts" } as const,
    };
    const cleanRun = harness({
      priorReviewState: {
        bodyFindings: [{ fingerprint: returnedBodyFinding.fingerprint }],
        ownedOpenThreads: [],
        runHeadShas: ["1".repeat(40)],
      },
    });

    assert.equal((await cleanRun.orchestrator.review(reference)).status, "clean");
    assert.equal(cleanRun.createdPublications.length, 1);
    const persistedBodyFindings = bodyStateFindingIdentities(
      cleanRun.createdPublications[0]?.payload.body ?? "",
    );
    assert.deepEqual(persistedBodyFindings, []);
    assert.ok(
      cleanRun.events.indexOf("submit-review-20") < cleanRun.events.indexOf("add-+1"),
      JSON.stringify(cleanRun.events),
    );

    const staleSuccessor = harness({ mutateHeadDuring: "workspace-cleanup" });
    assert.equal((await staleSuccessor.orchestrator.review(reference)).status, "stale");
    assert.equal(staleSuccessor.createdPublications.length, 0);
    assert.deepEqual(
      planFindingReconciliation([returnedBodyFinding], {
        bodyFindings: persistedBodyFindings,
        ownedOpenThreads: [],
        runHeadShas: ["2".repeat(40)],
      }).netNewFindings,
      [returnedBodyFinding],
    );
  });

  it("refreshes prior state after an uncertain pending review becomes submitted", async () => {
    const unchanged = validatedFinding();
    const publishedState: PriorReviewState = {
      ownedOpenThreads: [{ id: "THREAD_SUBMITTED", fingerprint: unchanged.fingerprint }],
      runHeadShas: ["1".repeat(40)],
    };
    const { createdPublications, events, orchestrator } = harness({
      priorReviewStateAfterPendingRemoval: publishedState,
      review: async () => ({ findings: [unchanged], diagnostics: [] }),
    });

    assert.equal((await orchestrator.review(reference)).status, "findings");
    assert.equal(createdPublications.length, 0);
    assert.equal(events.includes("resolve-threads-THREAD_SUBMITTED"), false);
    assert.ok(
      events.indexOf("remove-pending-review") < events.lastIndexOf("get-prior-review-state"),
      JSON.stringify(events),
    );
  });

  it("resolves a disappeared owned finding before completing the clean review", async () => {
    const { events, orchestrator } = harness({
      priorReviewState: {
        ownedOpenThreads: [{ id: "THREAD_FIXED", fingerprint: "c".repeat(64) }],
        runHeadShas: ["1".repeat(40)],
      },
    });

    assert.equal((await orchestrator.review(reference)).status, "clean");
    assert.equal(events.includes("create-review"), false);
    assert.ok(
      events.indexOf("resolve-threads-THREAD_FIXED") < events.indexOf("add-+1"),
      JSON.stringify(events),
    );
  });

  it("discards stale reviewed output before any reconciliation or publication mutation", async () => {
    const { events, orchestrator } = harness({
      mutateHeadDuring: "workspace-cleanup",
      priorReviewState: {
        ownedOpenThreads: [{ id: "THREAD_OLD", fingerprint: "c".repeat(64) }],
        runHeadShas: [],
      },
      review: async () => ({ findings: [validatedFinding()], diagnostics: [] }),
    });

    assert.equal((await orchestrator.review(reference)).status, "stale");
    assert.equal(events.includes("resolve-threads-THREAD_OLD"), false);
    assert.equal(events.includes("remove-pending-review"), false);
    assert.equal(events.includes("create-review"), false);
    assert.equal(events.includes("add-+1"), false);
  });

  it("does not resolve obsolete threads when the head changes during pending review reconciliation", async () => {
    const { events, orchestrator } = harness({
      mutateHeadDuring: "pending-review-removal",
      priorReviewState: {
        ownedOpenThreads: [{ id: "THREAD_OLD", fingerprint: "c".repeat(64) }],
        runHeadShas: [],
      },
      review: async () => ({ findings: [validatedFinding()], diagnostics: [] }),
    });

    assert.deepEqual(await orchestrator.review(reference), {
      status: "stale",
      reviewedSha: "2".repeat(40),
      currentSha: "3".repeat(40),
    });
    assert.equal(events.includes("resolve-threads-THREAD_OLD"), false);
    assert.equal(events.includes("create-review"), false);
    assert.equal(events.includes("add-+1"), false);
  });

  it("stops reconciliation and completion when thread resolution reports a stale head", async () => {
    const staleHeadSha = "3".repeat(40);
    const current = validatedFinding();
    const { createdPublications, events, orchestrator } = harness({
      threadResolutionStaleSha: staleHeadSha,
      priorReviewState: {
        ownedOpenThreads: [
          { id: "THREAD_A", fingerprint: "b".repeat(64) },
          { id: "THREAD_B", fingerprint: "c".repeat(64) },
        ],
        runHeadShas: ["1".repeat(40)],
      },
      review: async () => ({ findings: [current], diagnostics: [] }),
    });

    assert.deepEqual(await orchestrator.review(reference), {
      status: "stale",
      reviewedSha: "2".repeat(40),
      currentSha: staleHeadSha,
    });
    assert.deepEqual(createdPublications, []);
    assert.equal(events.includes("add-+1"), false);
    assert.deepEqual(events.slice(events.indexOf("resolve-threads-THREAD_A,THREAD_B")), [
      "resolve-threads-THREAD_A,THREAD_B",
    ]);
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

  it("bounds persistent pending-review cleanup and reconciles the stale draft next run", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-pending-cleanup-lock-"));
    const lockPath = join(stateDirectory, "manual-review.lock");
    const pendingReviewState = new Set<number>();
    const first = harness({
      lock: new FileReviewLock(stateDirectory),
      mutateHeadDuring: "review-creation",
      pendingDeletionError: new Error("persistent pending-review cleanup failure"),
      pendingReviewState,
      review: async () => ({ findings: [validatedFinding()], diagnostics: [] }),
    });
    const second = harness({
      lock: new FileReviewLock(stateDirectory),
      pendingReviewState,
    });

    try {
      await assert.rejects(
        settleWithin(
          first.orchestrator.review(reference),
          "persistent pending-review cleanup did not settle",
        ),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.match(error.message, /Pending review cleanup required retries/u);
          return true;
        },
      );

      assert.equal(first.events.filter((event) => event === "delete-review-20").length, 3);
      assert.deepEqual([...pendingReviewState], [20]);
      assert.equal(await fileIsMissing(lockPath), true);
      assert.equal((await second.orchestrator.review(reference)).status, "clean");
      assert.equal(second.events.includes("remove-pending-review"), true);
      assert.equal(pendingReviewState.size, 0);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
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

  it("disarms uncertain exact-review cleanup and releases the lease for a second run", async (context) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-pending-fence-lock-"));
    context.after(async () => {
      await rm(stateDirectory, { recursive: true, force: true });
    });
    const first = harness({
      lock: new FileReviewLock(stateDirectory),
      mutateHeadDuring: "review-creation",
      pendingDeletionError: new PendingReviewUncertainError(),
      pendingDeletionErrorAttempts: 1,
      review: async () => ({ findings: [validatedFinding()], diagnostics: [] }),
    });
    const second = harness({ lock: new FileReviewLock(stateDirectory) });
    const lockPath = join(stateDirectory, "manual-review.lock");

    await assert.rejects(() => first.orchestrator.review(reference), PendingReviewUncertainError);
    await waitFor(
      () => fileIsMissing(lockPath),
      "uncertain exact-review cleanup retained the process lock",
    );
    assert.equal(first.events.filter((event) => event === "delete-review-20").length, 1);
    assert.equal((await second.orchestrator.review(reference)).status, "clean");
  });

  it("removes the active reaction and publishes no completion for stale output", async () => {
    const { events, orchestrator } = harness({ currentSha: "3".repeat(40) });
    assert.equal((await orchestrator.review(reference)).status, "stale");
    assert.deepEqual(events, ["authenticate", "get-pr", "get-head"]);
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
        assert.deepEqual(events.slice(-4), ["review", "cleanup", "delete-10", "get-head"]);
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

    assert.deepEqual(failed.events.slice(-6), [
      "remove-pending-review",
      "get-prior-review-state",
      "get-head",
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
    assert.deepEqual(shaFailure.events.slice(-4), ["review", "cleanup", "delete-10", "get-head"]);
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
    assert.deepEqual(completionFailure.events.slice(-7), [
      "delete-10",
      "get-head",
      "remove-pending-review",
      "get-prior-review-state",
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
    await waitFor(
      () => timedOut.checkCompletions.length === 1,
      "timed-out review did not complete its check run",
    );
    assert.equal(timedOut.checkCompletions[0]?.conclusion, "timed_out");
    assert.deepEqual(timedOut.events.slice(-2), ["cleanup", "delete-10"]);
  });

  it("cancels policy loading at the review deadline and releases the lock", async () => {
    let policySignal: AbortSignal | undefined;
    let releases = 0;
    const timedOut = harness({
      reviewMs: 5,
      loadPolicy: async (signal) => {
        policySignal = signal;
        return new Promise<RevoirPolicy>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
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

    await assert.rejects(timedOut.orchestrator.review(reference), ReviewTimeoutError);
    assert.equal(policySignal?.aborted, true);
    await waitFor(() => releases === 1, "timed-out policy loading retained the process lock");
  });

  it("propagates caller cancellation before releasing the worker slot", async () => {
    const controller = new AbortController();
    const cancellation = new Error("daemon stopped");
    let markReviewStarted: (() => void) | undefined;
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve;
    });
    let releases = 0;
    const cancelled = harness({
      reviewMs: 50,
      review: async (_input, signal) => {
        markReviewStarted?.();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
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
    const review = cancelled.orchestrator.review(reference, { signal: controller.signal });
    await reviewStarted;
    controller.abort(cancellation);

    await assert.rejects(
      Promise.race([
        review,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("caller cancellation did not reach the review")), 100);
        }),
      ]),
      cancellation,
    );
    assert.equal(cancelled.events.includes("cleanup"), true);
    assert.equal(cancelled.ownedReactions.has("eyes"), false);
    assert.equal(releases, 1);
  });

  it("releases a lock acquired at the caller cancellation boundary", async () => {
    const controller = new AbortController();
    const cancellation = new Error("daemon stopped during lock acquisition");
    let releases = 0;
    const cancelled = harness({
      lock: {
        async acquire() {
          controller.abort(cancellation);
          return {
            async release() {
              releases += 1;
            },
          };
        },
      },
    });

    await assert.rejects(
      cancelled.orchestrator.review(reference, { signal: controller.signal }),
      cancellation,
    );
    assert.equal(releases, 1);
    assert.deepEqual(cancelled.events, []);
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

  it("bounds persistent terminal cleanup before releasing the process lock", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-terminal-cleanup-lock-"));
    const lockPath = join(stateDirectory, "manual-review.lock");
    let cleanupAttempts = 0;
    const first = harness({
      lock: new FileReviewLock(stateDirectory),
      workspaces: {
        async prepare() {
          return {
            root: "/tmp/persistent-cleanup-review",
            checkout: "/tmp/persistent-cleanup-review/repository",
            diff: "diff",
            remoteUrl: "https://github.com/owner/repository.git",
            async cleanup() {
              cleanupAttempts += 1;
              throw new Error("persistent workspace cleanup failure");
            },
          };
        },
      },
    });
    const second = harness({ lock: new FileReviewLock(stateDirectory) });

    try {
      await assert.rejects(
        settleWithin(
          first.orchestrator.review(reference),
          "persistent terminal cleanup did not settle",
        ),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.match(error.message, /Workspace cleanup required retries/u);
          return true;
        },
      );

      assert.equal(cleanupAttempts, 3);
      assert.equal(await fileIsMissing(lockPath), true);
      assert.equal((await second.orchestrator.review(reference)).status, "clean");
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
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
    assert.deepEqual(timedOut.events.slice(-4), ["review", "cleanup", "delete-10", "get-head"]);
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
