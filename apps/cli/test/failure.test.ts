import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GitHubReviewFailureReporter,
  type ReviewFailureGateway,
} from "../src/review/failure-reporter.js";
import { classifyReviewFailure, renderReviewFailureComment } from "../src/review/failure.js";
import { FindingContractError } from "../src/review/findings.js";
import { ReviewTimeoutError } from "../src/review/orchestrator.js";
import { parsePullRequestUrl } from "../src/review/pull-request.js";
import { WorkspacePreparationError } from "../src/review/workspace.js";

const reference = parsePullRequestUrl("https://github.com/owner/repository/pull/17");

describe("review failure classification", () => {
  it("classifies provider, process, model-output, timeout, and filesystem failures safely", () => {
    const filesystemError = Object.assign(new Error("token-secret could not be written"), {
      code: "ENOSPC",
    });
    const cases = [
      [new ReviewTimeoutError(1_200_000), "timeout"],
      [new Error("GitHub pull request lookup failed with HTTP 503."), "github"],
      [new Error("Cloudflare Queue retry request failed with HTTP 503."), "cloudflare"],
      [
        new WorkspacePreparationError(
          new Error("git failed: token-secret"),
          new Error("cleanup failed"),
          async () => {},
        ),
        "git",
      ],
      [new Error("Configured Pi model is unavailable: token-secret"), "pi"],
      [new FindingContractError("Pi returned an invalid finding envelope: token-secret"), "model"],
      [filesystemError, "filesystem"],
      [new Error("token-secret"), "unknown"],
    ] as const;

    for (const [error, expectedCategory] of cases) {
      const failure = classifyReviewFailure(error);
      assert.equal(failure.category, expectedCategory);
      assert.doesNotMatch(failure.reason, /token-secret/u);
    }
  });

  it("renders retry and terminal guidance without including raw failure details", () => {
    const failure = classifyReviewFailure(
      new Error("GitHub request failed with bearer token-secret and source contents"),
    );
    const retrying = renderReviewFailureComment(failure, 2, 3, reference);
    const terminal = renderReviewFailureComment(failure, 3, 3, reference);

    assert.match(retrying, /<!-- revoir:failure:v1 -->/u);
    assert.match(retrying, /Attempt 2 of 3/u);
    assert.match(retrying, /retry automatically/u);
    assert.doesNotMatch(retrying, /token-secret|source contents/u);
    assert.match(terminal, /Attempt 3 of 3/u);
    assert.match(terminal, /revoir review https:\/\/github\.com\/owner\/repository\/pull\/17/u);
  });

  it("reconciles reactions and reuses the owned failure comment", async () => {
    const reactions = new Set(["eyes", "+1", "confused"]);
    const comments: string[] = [];
    const gateway: ReviewFailureGateway = {
      async authenticate() {
        return {
          async removeOwnCompletionReaction() {
            reactions.delete("+1");
            reactions.delete("confused");
          },
          async removeOwnReaction(_reference, reaction) {
            reactions.delete(reaction);
          },
          async addReaction(_reference, reaction) {
            reactions.add(reaction);
          },
          async upsertFailureComment(_reference, body) {
            comments[0] = body;
          },
        };
      },
    };
    const reporter = new GitHubReviewFailureReporter(
      {
        userId: 42,
        appId: 7,
        privateKey: "private",
        installations: [
          {
            id: 8,
            repositories: [{ id: 99, owner: "owner", name: "repository" }],
          },
        ],
      },
      gateway,
    );

    await reporter.report(
      reference,
      new Error("GitHub request exposed token-secret"),
      2,
      3,
      new AbortController().signal,
    );

    assert.deepEqual([...reactions], ["confused"]);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!, /Attempt 2 of 3/u);
    assert.doesNotMatch(comments[0]!, /token-secret/u);
  });
});
