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
    assert.equal(
      requests.some(({ url }) => url.endsWith("/actions/jobs/200/logs")),
      false,
    );
    assert.equal(
      requests.some(({ url }) => url.endsWith("/actions/jobs/202/logs")),
      false,
    );
    const evidenceRequests = requests.filter(
      ({ url }) => url.includes("/check-runs") || url.includes("/actions/jobs/"),
    );
    assert.ok(evidenceRequests.every(({ method }) => method === undefined || method === "GET"));
    assert.equal(
      requests.some(({ url }) =>
        /\/actions\/(?:runs|workflows)\/.+\/(?:rerun|cancel|dispatches)$/u.test(url),
      ),
      false,
    );
  });

  it("retains mixed completed checks when individual Actions logs are unavailable", async () => {
    const privateFailure = `socket failed with ${"PRIVATE_TRANSIENT_DETAIL_".repeat(20)}`;
    const fetchImplementation: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.includes("/check-runs?")) {
        return json({
          total_count: 5,
          check_runs: [
            {
              name: "successful log",
              status: "completed",
              conclusion: "failure",
              details_url: "https://github.com/owner/repository/actions/runs/201/job/301",
              output: { title: "Tests failed", summary: "One test failed." },
            },
            {
              name: "permission denied log",
              status: "completed",
              conclusion: "failure",
              details_url: "https://github.com/owner/repository/actions/runs/202/job/302",
              output: { title: null, summary: null },
            },
            {
              name: "expired log",
              status: "completed",
              conclusion: "timed_out",
              details_url: "https://github.com/owner/repository/actions/runs/203/job/303",
              output: { title: null, summary: null },
            },
            {
              name: "transient log failure",
              status: "completed",
              conclusion: "startup_failure",
              details_url: "https://github.com/owner/repository/actions/runs/204/job/304",
              output: { title: null, summary: null },
            },
            {
              name: "completed metadata only",
              status: "completed",
              conclusion: "success",
              details_url: "https://checks.test/completed",
              output: { title: "Complete", summary: "No log required." },
            },
          ],
        });
      }
      if (url.endsWith("/actions/jobs/301/logs")) {
        return new Response("FAIL expected 404\n", { status: 200 });
      }
      if (url.endsWith("/actions/jobs/302/logs")) {
        return new Response("PRIVATE_FORBIDDEN_BODY", { status: 403 });
      }
      if (url.endsWith("/actions/jobs/303/logs")) {
        return new Response("PRIVATE_MISSING_BODY", { status: 404 });
      }
      if (url.endsWith("/actions/jobs/304/logs")) {
        throw new Error(privateFailure);
      }
      throw new Error(`Unexpected request ${url}`);
    };

    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const evidence = await session.getReviewEvidence(
      reference,
      "2".repeat(40),
      new AbortController().signal,
    );

    assert.deepEqual(evidence.completedChecks, [
      {
        name: "successful log",
        conclusion: "failure",
        detailsUrl: "https://github.com/owner/repository/actions/runs/201/job/301",
        title: "Tests failed",
        summary: "One test failed.",
        failedActionsLog: "FAIL expected 404\n",
      },
      {
        name: "permission denied log",
        conclusion: "failure",
        detailsUrl: "https://github.com/owner/repository/actions/runs/202/job/302",
        failedActionsLogUnavailable: "GitHub Actions job log unavailable (HTTP 403).",
      },
      {
        name: "expired log",
        conclusion: "timed_out",
        detailsUrl: "https://github.com/owner/repository/actions/runs/203/job/303",
        failedActionsLogUnavailable: "GitHub Actions job log unavailable (HTTP 404).",
      },
      {
        name: "transient log failure",
        conclusion: "startup_failure",
        detailsUrl: "https://github.com/owner/repository/actions/runs/204/job/304",
        failedActionsLogUnavailable: "GitHub Actions job log unavailable (request failed).",
      },
      {
        name: "completed metadata only",
        conclusion: "success",
        detailsUrl: "https://checks.test/completed",
        title: "Complete",
        summary: "No log required.",
      },
    ]);
    const rendered = JSON.stringify(evidence);
    assert.doesNotMatch(
      rendered,
      /PRIVATE_(?:TRANSIENT_DETAIL|FORBIDDEN_BODY|MISSING_BODY)|installation-secret/u,
    );
    for (const check of evidence.completedChecks) {
      if (check.failedActionsLogUnavailable !== undefined) {
        assert.ok(check.failedActionsLogUnavailable.length <= 80);
      }
    }
  });

  it("still fails when required completed-check context is unavailable", async () => {
    const fetchImplementation: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.includes("/check-runs?")) {
        return json({ token: "PRIVATE_CHECK_BODY" }, 403);
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);

    await assert.rejects(
      () => session.getReviewEvidence(reference, "2".repeat(40), new AbortController().signal),
      (error: unknown) => {
        assert.match(String(error), /check run lookup failed with HTTP 403/u);
        assert.doesNotMatch(String(error), /PRIVATE_CHECK_BODY/u);
        return true;
      },
    );
  });

  it("propagates cancellation while an optional Actions log is loading", async () => {
    let markLogStarted!: () => void;
    const logStarted = new Promise<void>((resolve) => {
      markLogStarted = resolve;
    });
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.includes("/check-runs?")) {
        return json({
          total_count: 1,
          check_runs: [
            {
              name: "unit",
              status: "completed",
              conclusion: "failure",
              details_url: "https://github.com/owner/repository/actions/runs/205/job/305",
              output: { title: null, summary: null },
            },
          ],
        });
      }
      if (url.endsWith("/actions/jobs/305/logs")) {
        markLogStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const controller = new AbortController();
    const evidence = session.getReviewEvidence(reference, "2".repeat(40), controller.signal);
    const cancellation = new Error("cancel optional evidence");
    await logStarted;
    controller.abort(cancellation);

    await assert.rejects(evidence, (error: unknown) => error === cancellation);
  });
});
