import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REVIEW_JOB_ACTIONS,
  ReviewJobSchemaError,
  parseReviewQueueJob,
} from "../src/review-job.js";

function automaticReviewJob() {
  return {
    version: 1,
    deliveryId: "2f5f7475-33ee-4f91-9b68-0f8af72f6640",
    installationId: 8,
    repository: { id: 99, owner: "owner", name: "repository" },
    pullRequest: { number: 17 },
    trigger: {
      kind: "automatic",
      action: "synchronize",
      authorId: 42,
      senderId: 42,
      baseRepositoryId: 99,
      headRepositoryId: 99,
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
    },
    enqueuedAt: "2026-07-29T00:00:00.000Z",
  };
}

function requestedReviewJob() {
  return {
    version: 1,
    deliveryId: "6e38fcec-d555-474e-8fd2-34620349aa12",
    installationId: 8,
    repository: { id: 99, owner: "owner", name: "repository" },
    pullRequest: { number: 17 },
    trigger: {
      kind: "requested",
      source: "issue_comment",
      commentId: 123456789,
      senderId: 42,
    },
    enqueuedAt: "2026-08-05T00:00:00.000Z",
  };
}

describe("review queue job contract v1", () => {
  it("round-trips automatic and requested triggers across JSON and structured clone", () => {
    for (const value of [automaticReviewJob(), requestedReviewJob()]) {
      assert.deepEqual(parseReviewQueueJob(JSON.stringify(structuredClone(value))), value);
    }
  });

  it("accepts exactly the supported automatic actions", () => {
    for (const action of REVIEW_JOB_ACTIONS) {
      const value = automaticReviewJob();
      value.trigger.action = action;
      assert.equal(parseReviewQueueJob(value).trigger.kind, "automatic");
    }
    const unsupported = automaticReviewJob();
    unsupported.trigger.action = "closed";
    assert.throws(() => parseReviewQueueJob(unsupported), ReviewJobSchemaError);
  });

  it("requires every common and trigger field and rejects unknown fields", () => {
    for (const value of [automaticReviewJob(), requestedReviewJob()]) {
      for (const field of Object.keys(value)) {
        const candidate = structuredClone(value) as Record<string, unknown>;
        delete candidate[field];
        assert.throws(() => parseReviewQueueJob(candidate), ReviewJobSchemaError);
      }
      for (const field of Object.keys(value.repository)) {
        const candidate = structuredClone(value);
        delete (candidate.repository as Record<string, unknown>)[field];
        assert.throws(() => parseReviewQueueJob(candidate), ReviewJobSchemaError);
      }
      for (const field of Object.keys(value.pullRequest)) {
        const candidate = structuredClone(value);
        delete (candidate.pullRequest as Record<string, unknown>)[field];
        assert.throws(() => parseReviewQueueJob(candidate), ReviewJobSchemaError);
      }
      for (const field of Object.keys(value.trigger)) {
        const candidate = structuredClone(value);
        delete (candidate.trigger as Record<string, unknown>)[field];
        assert.throws(() => parseReviewQueueJob(candidate), ReviewJobSchemaError);
      }
    }

    assert.throws(
      () => parseReviewQueueJob({ ...automaticReviewJob(), retryCount: 1 }),
      ReviewJobSchemaError,
    );
    assert.throws(
      () =>
        parseReviewQueueJob({
          ...automaticReviewJob(),
          trigger: { ...automaticReviewJob().trigger, source: "issue_comment" },
        }),
      ReviewJobSchemaError,
    );
  });

  it("rejects malformed common identities, names, delivery IDs, and timestamps", () => {
    const cases = [
      "not json",
      null,
      { ...automaticReviewJob(), version: 2 },
      { ...automaticReviewJob(), deliveryId: "bad delivery" },
      { ...automaticReviewJob(), installationId: 0 },
      { ...automaticReviewJob(), repository: { ...automaticReviewJob().repository, id: 1.5 } },
      {
        ...automaticReviewJob(),
        repository: { ...automaticReviewJob().repository, owner: "bad owner" },
      },
      {
        ...automaticReviewJob(),
        repository: { ...automaticReviewJob().repository, name: "bad/name" },
      },
      { ...automaticReviewJob(), pullRequest: { number: -1 } },
      { ...automaticReviewJob(), enqueuedAt: "yesterday" },
      { ...automaticReviewJob(), enqueuedAt: "2026-07-29T00:00:00Z" },
    ];

    for (const candidate of cases) {
      assert.throws(() => parseReviewQueueJob(candidate), ReviewJobSchemaError);
    }
  });

  it("rejects malformed automatic trigger identities and revisions", () => {
    const cases = [
      { ...automaticReviewJob().trigger, authorId: "42" },
      { ...automaticReviewJob().trigger, senderId: 0 },
      { ...automaticReviewJob().trigger, baseRepositoryId: 100 },
      { ...automaticReviewJob().trigger, headRepositoryId: 100 },
      { ...automaticReviewJob().trigger, baseSha: "ABC" },
      { ...automaticReviewJob().trigger, headSha: "A".repeat(40) },
    ];
    for (const trigger of cases) {
      assert.throws(
        () => parseReviewQueueJob({ ...automaticReviewJob(), trigger }),
        ReviewJobSchemaError,
      );
    }
  });

  it("rejects malformed requested trigger fields", () => {
    const cases = [
      { ...requestedReviewJob().trigger, source: "pull_request_review" },
      { ...requestedReviewJob().trigger, commentId: 0 },
      { ...requestedReviewJob().trigger, senderId: "42" },
    ];
    for (const trigger of cases) {
      assert.throws(
        () => parseReviewQueueJob({ ...requestedReviewJob(), trigger }),
        ReviewJobSchemaError,
      );
    }
  });

  it("rejects both legacy queue schemas", () => {
    const automatic = automaticReviewJob();
    const requested = requestedReviewJob();
    assert.throws(
      () =>
        parseReviewQueueJob({
          ...automatic,
          pullRequest: { ...automatic.pullRequest, ...automatic.trigger },
          action: automatic.trigger.action,
          trigger: undefined,
        }),
      ReviewJobSchemaError,
    );
    assert.throws(
      () =>
        parseReviewQueueJob({
          ...requested,
          version: 2,
          request: {
            kind: requested.trigger.source,
            commentId: requested.trigger.commentId,
            senderId: requested.trigger.senderId,
          },
          trigger: undefined,
        }),
      ReviewJobSchemaError,
    );
  });
});
