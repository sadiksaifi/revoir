import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REVIEW_JOB_ACTIONS,
  ReviewJobSchemaError,
  parseRequestedReviewJob,
  parseReviewJob,
  parseReviewQueueJob,
} from "../src/review-job.js";

function reviewJob() {
  return {
    version: 1,
    deliveryId: "2f5f7475-33ee-4f91-9b68-0f8af72f6640",
    installationId: 8,
    repository: {
      id: 99,
      owner: "owner",
      name: "repository",
    },
    pullRequest: {
      number: 17,
      authorId: 42,
      senderId: 42,
      baseRepositoryId: 99,
      headRepositoryId: 99,
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
    },
    action: "synchronize",
    enqueuedAt: "2026-07-29T00:00:00.000Z",
  };
}

function requestedReviewJob() {
  return {
    version: 2,
    deliveryId: "6e38fcec-d555-474e-8fd2-34620349aa12",
    installationId: 8,
    repository: {
      id: 99,
      owner: "owner",
      name: "repository",
    },
    pullRequest: {
      number: 17,
    },
    request: {
      kind: "issue_comment",
      commentId: 123456789,
      senderId: 42,
    },
    enqueuedAt: "2026-08-05T00:00:00.000Z",
  };
}

describe("review job contract v1", () => {
  it("round-trips a complete job across JSON and structured clone", () => {
    const value = reviewJob();

    assert.deepEqual(parseReviewJob(JSON.stringify(structuredClone(value))), value);
  });

  it("accepts exactly the supported pull-request trigger actions", () => {
    for (const action of REVIEW_JOB_ACTIONS) {
      assert.equal(parseReviewJob({ ...reviewJob(), action }).action, action);
    }
    assert.throws(() => parseReviewJob({ ...reviewJob(), action: "closed" }), ReviewJobSchemaError);
  });

  it("requires every field and rejects unknown contract fields", () => {
    for (const field of Object.keys(reviewJob())) {
      const candidate = structuredClone(reviewJob()) as Record<string, unknown>;
      delete candidate[field];
      assert.throws(() => parseReviewJob(candidate), ReviewJobSchemaError);
    }
    for (const field of Object.keys(reviewJob().repository)) {
      const candidate = structuredClone(reviewJob());
      delete (candidate.repository as Record<string, unknown>)[field];
      assert.throws(() => parseReviewJob(candidate), ReviewJobSchemaError);
    }
    for (const field of Object.keys(reviewJob().pullRequest)) {
      const candidate = structuredClone(reviewJob());
      delete (candidate.pullRequest as Record<string, unknown>)[field];
      assert.throws(() => parseReviewJob(candidate), ReviewJobSchemaError);
    }

    assert.throws(() => parseReviewJob({ ...reviewJob(), retryCount: 1 }), ReviewJobSchemaError);
    assert.throws(
      () =>
        parseReviewJob({
          ...reviewJob(),
          repository: { ...reviewJob().repository, fullName: "owner/repository" },
        }),
      ReviewJobSchemaError,
    );
    assert.throws(
      () =>
        parseReviewJob({
          ...reviewJob(),
          pullRequest: { ...reviewJob().pullRequest, draft: false },
        }),
      ReviewJobSchemaError,
    );
  });

  it("rejects malformed versions, identities, revisions, names, delivery IDs, and timestamps", () => {
    const cases = [
      "not json",
      null,
      { ...reviewJob(), version: 2 },
      { ...reviewJob(), deliveryId: "bad delivery" },
      { ...reviewJob(), installationId: 0 },
      { ...reviewJob(), repository: { ...reviewJob().repository, id: 1.5 } },
      { ...reviewJob(), repository: { ...reviewJob().repository, owner: "bad owner" } },
      { ...reviewJob(), repository: { ...reviewJob().repository, name: "bad/name" } },
      { ...reviewJob(), pullRequest: { ...reviewJob().pullRequest, number: -1 } },
      { ...reviewJob(), pullRequest: { ...reviewJob().pullRequest, authorId: "42" } },
      { ...reviewJob(), pullRequest: { ...reviewJob().pullRequest, senderId: 0 } },
      {
        ...reviewJob(),
        pullRequest: { ...reviewJob().pullRequest, baseRepositoryId: 100 },
      },
      {
        ...reviewJob(),
        pullRequest: { ...reviewJob().pullRequest, headRepositoryId: 100 },
      },
      { ...reviewJob(), pullRequest: { ...reviewJob().pullRequest, baseSha: "ABC" } },
      { ...reviewJob(), pullRequest: { ...reviewJob().pullRequest, headSha: "A".repeat(40) } },
      { ...reviewJob(), enqueuedAt: "yesterday" },
      { ...reviewJob(), enqueuedAt: "2026-07-29T00:00:00Z" },
    ];

    for (const candidate of cases) {
      assert.throws(() => parseReviewJob(candidate), ReviewJobSchemaError);
    }
  });
});

describe("requested review job contract v2", () => {
  it("round-trips an issue-comment request and dispatches both contract versions", () => {
    const requested = requestedReviewJob();

    assert.deepEqual(
      parseRequestedReviewJob(JSON.stringify(structuredClone(requested))),
      requested,
    );
    assert.deepEqual(parseReviewQueueJob(requested), requested);
    assert.deepEqual(parseReviewQueueJob(reviewJob()), reviewJob());
  });

  it("requires every field and rejects unknown or malformed request fields", () => {
    for (const field of Object.keys(requestedReviewJob())) {
      const candidate = structuredClone(requestedReviewJob()) as Record<string, unknown>;
      delete candidate[field];
      assert.throws(() => parseRequestedReviewJob(candidate), ReviewJobSchemaError);
    }
    for (const field of Object.keys(requestedReviewJob().request)) {
      const candidate = structuredClone(requestedReviewJob());
      delete (candidate.request as Record<string, unknown>)[field];
      assert.throws(() => parseRequestedReviewJob(candidate), ReviewJobSchemaError);
    }

    const cases = [
      { ...requestedReviewJob(), version: 1 },
      { ...requestedReviewJob(), retryCount: 1 },
      {
        ...requestedReviewJob(),
        pullRequest: { ...requestedReviewJob().pullRequest, headSha: "2".repeat(40) },
      },
      {
        ...requestedReviewJob(),
        request: { ...requestedReviewJob().request, kind: "pull_request_review" },
      },
      {
        ...requestedReviewJob(),
        request: { ...requestedReviewJob().request, commentId: 0 },
      },
      {
        ...requestedReviewJob(),
        request: { ...requestedReviewJob().request, senderId: "42" },
      },
    ];
    for (const candidate of cases) {
      assert.throws(() => parseRequestedReviewJob(candidate), ReviewJobSchemaError);
    }
    assert.throws(() => parseReviewQueueJob({ ...reviewJob(), version: 3 }), ReviewJobSchemaError);
  });
});
