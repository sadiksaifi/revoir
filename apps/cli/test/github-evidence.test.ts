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

function emptyReviewContextResponse(): Response {
  const emptyConnection = {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  return json({
    data: {
      repository: {
        pullRequest: {
          comments: emptyConnection,
          reviews: emptyConnection,
          reviewThreads: emptyConnection,
          closingIssuesReferences: emptyConnection,
        },
      },
    },
  });
}

function graphQlComment(body: string, suffix: string) {
  return {
    author: suffix === "deleted" ? null : { login: `author-${suffix}` },
    body,
    createdAt: `2026-07-29T00:00:0${suffix === "deleted" ? "4" : suffix}Z`,
    url: `https://github.com/owner/repository/comments/${suffix}`,
  };
}

function graphQlConnection(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    nodes,
    pageInfo: { hasNextPage, endCursor },
  };
}

function streamingTextResponse(value: string): Response {
  const bytes = Buffer.from(value);
  let offset = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const nextOffset = Math.min(offset + 8 * 1024, bytes.length);
        controller.enqueue(bytes.subarray(offset, nextOffset));
        offset = nextOffset;
      },
    }),
  );
  Object.defineProperty(response, "text", {
    value: async () => {
      throw new Error("Actions logs must be consumed through their bounded stream.");
    },
  });
  return response;
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
          title: "Keep review context complete",
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
      if (url.endsWith("/graphql")) {
        return emptyReviewContextResponse();
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

    assert.equal(pullRequest.title, "Keep review context complete");
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
      discussion: { comments: [], reviews: [], threads: [], linkedIssues: [] },
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

  it("matches only the exact Actions job when owner and repository casing differs", async () => {
    const requestedJobIds: string[] = [];
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
          total_count: 4,
          check_runs: [
            {
              name: "mixed case",
              status: "completed",
              conclusion: "failure",
              details_url: "https://github.com/Owner/Repository/actions/runs/500/job/501",
              output: { title: null, summary: null },
            },
            {
              name: "different repository",
              status: "completed",
              conclusion: "failure",
              details_url: "https://github.com/Owner/Repository-Other/actions/runs/500/job/502",
              output: { title: null, summary: null },
            },
            {
              name: "extra path",
              status: "completed",
              conclusion: "failure",
              details_url: "https://github.com/Owner/Repository/actions/runs/500/job/503/extra",
              output: { title: null, summary: null },
            },
            {
              name: "different structure casing",
              status: "completed",
              conclusion: "failure",
              details_url: "https://github.com/Owner/Repository/Actions/runs/500/job/504",
              output: { title: null, summary: null },
            },
          ],
        });
      }
      const jobId = /\/actions\/jobs\/(\d+)\/logs$/u.exec(url)?.[1];
      if (jobId !== undefined) {
        requestedJobIds.push(jobId);
        return new Response(`FAIL job ${jobId}\n`, { status: 200 });
      }
      if (url.endsWith("/graphql")) {
        return emptyReviewContextResponse();
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

    assert.deepEqual(requestedJobIds, ["501"]);
    assert.equal(evidence.completedChecks[0]?.failedActionsLog, "FAIL job 501\n");
    assert.ok(
      evidence.completedChecks
        .slice(1)
        .every(({ failedActionsLog }) => failedActionsLog === undefined),
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
      if (url.endsWith("/graphql")) {
        return emptyReviewContextResponse();
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

  it("bounds streamed Actions logs per entry and across the assembled evidence", async () => {
    const largeLog = [
      "HEAD installation-secret\n",
      "x".repeat(1024 * 1024),
      "\nPRIVATE_MIDDLE_SECRET\n",
      "y".repeat(1024 * 1024),
      "\nTAIL installation-secret",
    ].join("");
    assert.ok(Buffer.byteLength(largeLog) >= 2 * 1024 * 1024);
    const jobIds = Array.from({ length: 10 }, (_, index) => 401 + index);
    const checkRuns = [
      {
        name: "large",
        status: "completed",
        conclusion: "failure",
        details_url: "https://github.com/owner/repository/actions/runs/300/job/400",
        output: { title: null, summary: null },
      },
      ...jobIds.map((jobId) => ({
        name: `job-${jobId}`,
        status: "completed",
        conclusion: "failure",
        details_url: `https://github.com/owner/repository/actions/runs/${jobId}/job/${jobId}`,
        output: { title: null, summary: null },
      })),
    ];
    const fetchImplementation: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.includes("/check-runs?")) {
        return json({ total_count: checkRuns.length, check_runs: checkRuns });
      }
      if (url.endsWith("/actions/jobs/400/logs")) {
        return streamingTextResponse(largeLog);
      }
      const jobId = /\/actions\/jobs\/(\d+)\/logs$/u.exec(url)?.[1];
      if (jobId !== undefined) {
        return streamingTextResponse(
          `HEAD-${jobId} installation-secret\n${"m".repeat(100 * 1024)}\nTAIL-${jobId}`,
        );
      }
      if (url.endsWith("/graphql")) {
        return emptyReviewContextResponse();
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

    const largeEvidence = evidence.completedChecks[0]?.failedActionsLog;
    assert.ok(largeEvidence);
    assert.match(largeEvidence, /^HEAD \[REDACTED\]/u);
    assert.match(largeEvidence, /TAIL \[REDACTED\]$/u);
    assert.match(largeEvidence, /\[Revoir truncated GitHub Actions log\]/u);
    assert.doesNotMatch(largeEvidence, /PRIVATE_MIDDLE_SECRET|installation-secret/u);
    assert.ok(Buffer.byteLength(largeEvidence) <= 64 * 1024);

    const retainedLogs = evidence.completedChecks.flatMap(({ failedActionsLog }) =>
      failedActionsLog === undefined ? [] : [failedActionsLog],
    );
    assert.ok(retainedLogs.length <= 8);
    assert.ok(retainedLogs.reduce((total, log) => total + Buffer.byteLength(log), 0) <= 256 * 1024);
    assert.ok(
      evidence.completedChecks.every(
        ({ failedActionsLog, failedActionsLogUnavailable }) =>
          failedActionsLog !== undefined || failedActionsLogUnavailable !== undefined,
      ),
    );
    assert.ok(
      evidence.completedChecks.some(({ failedActionsLogUnavailable }) =>
        /limit reached/u.test(failedActionsLogUnavailable ?? ""),
      ),
    );
    assert.doesNotMatch(JSON.stringify(evidence), /installation-secret|PRIVATE_MIDDLE_SECRET/u);
  });

  it("loads paginated reviews, comments, thread replies, and linked-issue discussion", async () => {
    const graphQlQueries: string[] = [];
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.includes("/check-runs?")) {
        return json({ total_count: 0, check_runs: [] });
      }
      if (url.endsWith("/graphql")) {
        const request = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        graphQlQueries.push(request.query);
        if (request.query.includes("RevoirReviewThreadComments")) {
          return json({
            data: {
              node: {
                comments: graphQlConnection([
                  graphQlComment("Author replied.", "3"),
                  {
                    ...graphQlComment("Unsubmitted reply.", "5"),
                    pullRequestReview: { state: "PENDING" },
                  },
                ]),
              },
            },
          });
        }
        if (request.query.includes("RevoirLinkedIssueComments")) {
          return json({
            data: {
              node: {
                comments: graphQlConnection([graphQlComment("Issue follow-up.", "4")]),
              },
            },
          });
        }
        if (request.variables.commentsAfter === "PR_COMMENTS_1") {
          assert.equal(request.variables.includeReviews, false);
          assert.equal(request.variables.includeThreads, false);
          assert.equal(request.variables.includeLinkedIssues, false);
          return json({
            data: {
              repository: {
                pullRequest: {
                  comments: graphQlConnection([graphQlComment("Second PR comment.", "2")]),
                },
              },
            },
          });
        }
        return json({
          data: {
            repository: {
              pullRequest: {
                comments: graphQlConnection(
                  [graphQlComment("First PR comment.", "1")],
                  true,
                  "PR_COMMENTS_1",
                ),
                reviews: graphQlConnection([
                  {
                    author: { login: "reviewer" },
                    body: "This behavior was already reported.",
                    state: "COMMENTED",
                    submittedAt: "2026-07-29T00:00:01Z",
                    url: "https://github.com/owner/repository/pull/17#pullrequestreview-1",
                  },
                  {
                    author: { login: "revoir-test[bot]" },
                    body: "Not submitted.",
                    state: "PENDING",
                    submittedAt: null,
                    url: "https://github.com/owner/repository/pull/17#pullrequestreview-2",
                  },
                ]),
                reviewThreads: graphQlConnection([
                  {
                    id: "THREAD_1",
                    isResolved: true,
                    path: "source.ts",
                    line: 12,
                    originalLine: 10,
                    diffSide: "RIGHT",
                    comments: graphQlConnection(
                      [graphQlComment("Existing inline concern.", "2")],
                      true,
                      "T1",
                    ),
                  },
                  {
                    id: "THREAD_PENDING",
                    isResolved: false,
                    path: "draft.ts",
                    line: 1,
                    originalLine: null,
                    diffSide: "RIGHT",
                    comments: graphQlConnection([
                      {
                        ...graphQlComment("Unsubmitted concern.", "5"),
                        pullRequestReview: { state: "PENDING" },
                      },
                    ]),
                  },
                ]),
                closingIssuesReferences: graphQlConnection([
                  {
                    id: "ISSUE_9",
                    number: 9,
                    title: "Preserve the API contract",
                    body: "The linked requirement.",
                    state: "OPEN",
                    url: "https://github.com/owner/repository/issues/9",
                    comments: graphQlConnection(
                      [graphQlComment("Issue context.", "3")],
                      true,
                      "I1",
                    ),
                  },
                ]),
              },
            },
          },
        });
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

    assert.deepEqual(
      evidence.discussion?.comments.map(({ body }) => body),
      ["First PR comment.", "Second PR comment."],
    );
    assert.deepEqual(
      evidence.discussion?.reviews.map(({ body }) => body),
      ["This behavior was already reported."],
    );
    assert.deepEqual(evidence.discussion?.threads, [
      {
        id: "THREAD_1",
        isResolved: true,
        path: "source.ts",
        line: 12,
        originalLine: 10,
        side: "RIGHT",
        comments: [
          {
            author: "author-2",
            body: "Existing inline concern.",
            createdAt: "2026-07-29T00:00:02Z",
            url: "https://github.com/owner/repository/comments/2",
          },
          {
            author: "author-3",
            body: "Author replied.",
            createdAt: "2026-07-29T00:00:03Z",
            url: "https://github.com/owner/repository/comments/3",
          },
        ],
      },
    ]);
    assert.deepEqual(
      evidence.discussion?.linkedIssues[0]?.comments.map(({ body }) => body),
      ["Issue context.", "Issue follow-up."],
    );
    assert.equal(graphQlQueries.length, 4);
    assert.ok(graphQlQueries.every((query) => !query.includes("mutation")));
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
      if (url.endsWith("/graphql")) {
        return emptyReviewContextResponse();
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
