import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseReviewJob } from "../src/review-job.js";

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

describe("review job contract v1", () => {
  it("round-trips a complete job across JSON and structured clone", () => {
    const value = reviewJob();

    assert.deepEqual(parseReviewJob(JSON.stringify(structuredClone(value))), value);
  });
});
