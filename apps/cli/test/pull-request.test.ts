import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertPullRequestEligible,
  parsePullRequestUrl,
  PullRequestEligibilityError,
  PullRequestUrlError,
  type PullRequestSnapshot,
} from "../src/review/pull-request.js";
import { createTestConfiguration } from "./helpers.js";

const reference = parsePullRequestUrl("https://github.com/owner/repository/pull/17");
const configuration = createTestConfiguration({
  cacheDir: "/tmp/cache",
  stateDir: "/tmp/state",
  dataDir: "/tmp/data",
});

function eligiblePullRequest(): PullRequestSnapshot {
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

describe("pull request URL and eligibility", () => {
  it("accepts only canonical GitHub pull request URLs", () => {
    assert.deepEqual(reference, {
      owner: "owner",
      repository: "repository",
      number: 17,
      url: "https://github.com/owner/repository/pull/17",
    });

    for (const invalid of [
      "not-a-url",
      "http://github.com/owner/repository/pull/17",
      "https://git.example.com/owner/repository/pull/17",
      "https://github.com/owner/repository/pull/17/",
      "https://github.com/owner/repository/pull/0",
      "https://github.com/owner/repository/pull/17?diff=split",
      "https://github.com/owner/repository/pull/17#discussion",
      "https://github.com/owner/repository/issues/17",
      "https://user@github.com/owner/repository/pull/17",
    ]) {
      assert.throws(() => parsePullRequestUrl(invalid), PullRequestUrlError, invalid);
    }
  });

  it("accepts the configured same-repository open non-draft pull request", () => {
    assert.equal(
      assertPullRequestEligible(reference, eligiblePullRequest(), configuration.github).id,
      99,
    );
  });

  it("rejects every ineligible pull request state", () => {
    const cases: Array<[string, PullRequestSnapshot]> = [
      ["other author", { ...eligiblePullRequest(), authorId: 404 }],
      ["closed", { ...eligiblePullRequest(), state: "closed" }],
      ["draft", { ...eligiblePullRequest(), draft: true }],
      [
        "fork",
        {
          ...eligiblePullRequest(),
          headRepository: {
            id: 100,
            fullName: "someone/repository",
            cloneUrl: "https://github.com/someone/repository.git",
          },
        },
      ],
      [
        "renamed immutable repository",
        {
          ...eligiblePullRequest(),
          baseRepository: {
            ...eligiblePullRequest().baseRepository,
            fullName: "owner/renamed",
          },
        },
      ],
      [
        "wrong immutable repository",
        {
          ...eligiblePullRequest(),
          baseRepository: { ...eligiblePullRequest().baseRepository, id: 100 },
          headRepository: { ...eligiblePullRequest().headRepository, id: 100 },
        },
      ],
      ["invalid base SHA", { ...eligiblePullRequest(), baseSha: "invalid" }],
      ["invalid head SHA", { ...eligiblePullRequest(), headSha: "invalid" }],
    ];

    for (const [name, pullRequest] of cases) {
      assert.throws(
        () => assertPullRequestEligible(reference, pullRequest, configuration.github),
        PullRequestEligibilityError,
        name,
      );
    }

    assert.throws(
      () =>
        assertPullRequestEligible(
          parsePullRequestUrl("https://github.com/owner/other/pull/17"),
          eligiblePullRequest(),
          configuration.github,
        ),
      PullRequestEligibilityError,
    );
  });
});
