import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHubAppReviewGateway, type FetchLike } from "../src/review/github.js";
import { parsePullRequestUrl } from "../src/review/pull-request.js";
import { createTestConfiguration } from "./helpers.js";

const reference = parsePullRequestUrl("https://github.com/owner/repository/pull/17");
const configuration = createTestConfiguration({
  cacheDir: "/tmp/cache",
  stateDir: "/tmp/state",
  dataDir: "/tmp/data",
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub review evidence", () => {
  it("loads PR metadata, completed checks, and only relevant failed Actions logs", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    let pendingObserved = false;
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init?.method === undefined ? {} : { method: init.method }) });
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17")) {
        return json({
          number: 17,
          body: "Keep the public response format stable.",
          state: "open",
          draft: false,
          user: { id: 42 },
          base: {
            sha: "1".repeat(40),
            repo: {
              id: 99,
              full_name: "owner/repository",
              clone_url: "https://github.com/owner/repository.git",
            },
          },
          head: {
            sha: "2".repeat(40),
            repo: {
              id: 99,
              full_name: "owner/repository",
              clone_url: "https://github.com/owner/repository.git",
            },
          },
        });
      }
      if (url.endsWith(`/commits/${"2".repeat(40)}/check-runs?per_page=100&page=1`)) {
        pendingObserved = true;
        return json({
          total_count: 3,
          check_runs: [
            {
              name: "lint",
              status: "completed",
              conclusion: "success",
              details_url: "https://github.com/owner/repository/actions/runs/100/job/200",
              output: { title: "Lint", summary: "No errors." },
            },
            {
              name: "unit",
              status: "completed",
              conclusion: "failure",
              details_url: "https://github.com/owner/repository/actions/runs/101/job/201",
              output: { title: "Tests failed", summary: "One assertion failed." },
            },
            {
              name: "integration",
              status: "in_progress",
              conclusion: null,
              details_url: "https://github.com/owner/repository/actions/runs/102/job/202",
              output: { title: null, summary: null },
            },
          ],
        });
      }
      if (url.endsWith("/actions/jobs/201/logs")) {
        return new Response("FAIL api returns the wrong status\n", { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    };

    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const pullRequest = await session.getPullRequest(reference, new AbortController().signal);
    const evidence = await session.getReviewEvidence(
      reference,
      pullRequest.headSha,
      new AbortController().signal,
    );

    assert.equal(pullRequest.description, "Keep the public response format stable.");
    assert.deepEqual(evidence, {
      completedChecks: [
        {
          name: "lint",
          conclusion: "success",
          detailsUrl: "https://github.com/owner/repository/actions/runs/100/job/200",
          title: "Lint",
          summary: "No errors.",
        },
        {
          name: "unit",
          conclusion: "failure",
          detailsUrl: "https://github.com/owner/repository/actions/runs/101/job/201",
          title: "Tests failed",
          summary: "One assertion failed.",
          failedActionsLog: "FAIL api returns the wrong status\n",
        },
      ],
    });
    assert.equal(pendingObserved, true);
    assert.equal(requests.some(({ url }) => url.endsWith("/actions/jobs/200/logs")), false);
    assert.equal(requests.some(({ url }) => url.endsWith("/actions/jobs/202/logs")), false);
    const evidenceRequests = requests.filter(
      ({ url }) => url.includes("/check-runs") || url.includes("/actions/jobs/"),
    );
    assert.ok(evidenceRequests.every(({ method }) => method === undefined || method === "GET"));
    assert.equal(
      requests.some(({ url }) => /\/actions\/(?:runs|workflows)\/.+\/(?:rerun|cancel|dispatches)$/u.test(url)),
      false,
    );
  });
});
