import assert from "node:assert/strict";
import { createPublicKey, createVerify } from "node:crypto";
import { describe, it } from "node:test";

import type { ReviewFindingV2 } from "../src/review/findings.js";
import {
  createGitHubAppJwt,
  GitHubAppReviewGateway,
  ReviewSubmissionUncertainError,
  type FetchLike,
} from "../src/review/github.js";
import { createReviewPublication, renderFileFinding } from "../src/review/publication.js";
import { parsePullRequestUrl } from "../src/review/pull-request.js";
import { planFindingReconciliation } from "../src/review/reconciliation.js";
import { createTestConfiguration, TEST_PRIVATE_KEY } from "./helpers.js";

const reference = parsePullRequestUrl("https://github.com/owner/repository/pull/17");
const configuration = createTestConfiguration({
  cacheDir: "/tmp/cache",
  stateDir: "/tmp/state",
  dataDir: "/tmp/data",
});
const reactionDeleteUrl = (reactionId: number) =>
  `https://api.test/repos/owner/repository/issues/17/reactions/${reactionId}`;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pullRequestResponse(headSha = "2".repeat(40)) {
  return {
    number: 17,
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
      sha: headSha,
      repo: {
        id: 99,
        full_name: "owner/repository",
        clone_url: "https://github.com/owner/repository.git",
      },
    },
  };
}

function ownedReviewThreadResponse(id: string, fingerprint: string) {
  return {
    id,
    isResolved: false,
    comments: {
      nodes: [
        {
          body: `<!-- revoir:finding:v1:${fingerprint} -->`,
          author: { login: "revoir-test[bot]" },
        },
      ],
    },
  };
}

function reviewFileFinding(fingerprint: string, path: string): ReviewFindingV2 {
  return {
    version: 2,
    fingerprint,
    priority: "P1",
    path,
    range: null,
    defectKind: "correctness",
    impactKind: "incorrect-result",
    fixAction: "restore",
    reason: "The changed file produces an incorrect result for supported callers.",
    anchor: path,
    attachment: { kind: "file", path },
  };
}

function ownReview(id: number, body: string | null, state = "COMMENTED") {
  return {
    id,
    state,
    body,
    user: { login: "revoir-test[bot]" },
  };
}

function legacyReviewBody(candidate: ReviewFindingV2): string {
  return renderFileFinding(candidate);
}

function explicitReviewBody(candidates: readonly ReviewFindingV2[]): string {
  return createReviewPublication("2".repeat(40), [], candidates).payload.body!;
}

function markerOnlyExplicitReviewBody(candidate: ReviewFindingV2): string {
  return `<!-- revoir:body-state:v1 -->\n<!-- revoir:body-finding:v1:${candidate.fingerprint} -->`;
}

describe("GitHub App review gateway", () => {
  it("signs a short-lived RS256 GitHub App JWT", () => {
    const jwt = createGitHubAppJwt(7, TEST_PRIVATE_KEY, 1_000);
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");
    assert.ok(encodedHeader);
    assert.ok(encodedPayload);
    assert.ok(encodedSignature);
    assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, "base64url").toString()), {
      alg: "RS256",
      typ: "JWT",
    });
    assert.deepEqual(JSON.parse(Buffer.from(encodedPayload, "base64url").toString()), {
      iat: 940,
      exp: 1_540,
      iss: "7",
    });
    assert.equal(
      createVerify("RSA-SHA256")
        .update(`${encodedHeader}.${encodedPayload}`)
        .verify(createPublicKey(TEST_PRIVATE_KEY), Buffer.from(encodedSignature, "base64url")),
      true,
    );
  });

  it("mints the token for every configured repository in the owning installation", async () => {
    const requestedUrls: string[] = [];
    let tokenRequestBody: unknown;
    const secondReference = parsePullRequestUrl("https://github.com/other/second/pull/18");
    const github = {
      ...configuration.github,
      installations: [
        ...configuration.github.installations,
        {
          id: 9,
          repositories: [
            { id: 101, owner: "other", name: "linked-issues" },
            { id: 100, owner: "other", name: "second" },
          ],
        },
      ],
    };
    const session = await new GitHubAppReviewGateway(
      async (input, init) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.endsWith("/access_tokens")) {
          tokenRequestBody = JSON.parse(String(init?.body));
        }
        return url.endsWith("/app")
          ? json({ slug: "revoir-test" })
          : json({ token: "installation-9-secret" });
      },
      "https://api.test",
      () => 1_000,
    ).authenticate(github, secondReference, new AbortController().signal);

    assert.equal(session.installationToken, "installation-9-secret");
    assert.equal(
      requestedUrls.some((url) => url.endsWith("/app/installations/9/access_tokens")),
      true,
    );
    assert.equal(
      requestedUrls.some((url) => url.endsWith("/app/installations/8/access_tokens")),
      false,
    );
    assert.deepEqual(tokenRequestBody, { repository_ids: [100, 101] });
  });

  it("uses an installation token for PR lookup and exact reaction reconciliation", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const abortController = new AbortController();
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17")) {
        return json(pullRequestResponse());
      }
      if (url.endsWith("/issues/17/reactions?per_page=100&page=1")) {
        return json([
          {
            id: 31,
            content: "+1",
            user: { login: "revoir-test[bot]" },
          },
          { id: 32, content: "+1", user: { login: "human" } },
          { id: 34, content: "eyes", user: { login: "revoir-test[bot]" } },
          { id: 35, content: "eyes", user: { login: "human" } },
          { id: 36, content: "confused", user: { login: "revoir-test[bot]" } },
          { id: 37, content: "confused", user: { login: "human" } },
        ]);
      }
      if (url.endsWith("/issues/17/reactions") && init?.method === "POST") {
        return json({
          id: 33,
          content: JSON.parse(String(init.body)).content,
          user: { login: "revoir-test[bot]" },
        });
      }
      if (
        url === reactionDeleteUrl(31) ||
        url === reactionDeleteUrl(33) ||
        url === reactionDeleteUrl(34) ||
        url === reactionDeleteUrl(36)
      ) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${url}`);
    };

    const gateway = new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    );
    const session = await gateway.authenticate(
      configuration.github,
      reference,
      abortController.signal,
    );
    assert.equal(session.installationToken, "installation-secret");
    assert.equal(
      (await session.getPullRequest(reference, abortController.signal)).headSha,
      "2".repeat(40),
    );
    await session.removeOwnCompletionReaction(reference, abortController.signal);
    await session.removeOwnReaction(reference, "eyes", abortController.signal);
    assert.equal(await session.addReaction(reference, "eyes", abortController.signal), 33);
    await session.deleteReaction(reference, 33, abortController.signal);

    const tokenRequest = requests.find((request) => request.url.endsWith("/access_tokens"));
    assert.ok(tokenRequest);
    assert.deepEqual(JSON.parse(String(tokenRequest.init?.body)), {
      repository_ids: [99],
    });
    assert.match(
      String(
        tokenRequest.init?.headers &&
          (tokenRequest.init.headers as Record<string, string>).Authorization,
      ),
      /Bearer/u,
    );
    const installationRequests = requests.filter((request) => request.url.includes("/repos/"));
    assert.ok(
      installationRequests.every(
        (request) =>
          request.init !== undefined &&
          (request.init.headers as Record<string, string>).Authorization ===
            "Bearer installation-secret",
      ),
    );
    assert.equal(requests.filter((request) => request.url === reactionDeleteUrl(31)).length, 1);
    assert.equal(requests.filter((request) => request.url === reactionDeleteUrl(32)).length, 0);
    assert.equal(requests.filter((request) => request.url === reactionDeleteUrl(34)).length, 1);
    assert.equal(requests.filter((request) => request.url === reactionDeleteUrl(35)).length, 0);
    assert.equal(requests.filter((request) => request.url === reactionDeleteUrl(36)).length, 1);
    assert.equal(requests.filter((request) => request.url === reactionDeleteUrl(37)).length, 0);
    assert.ok(requests.every((request) => request.init?.signal === abortController.signal));
  });

  it("creates, completes, and reconciles exact App-owned review checks", async () => {
    const headSha = "2".repeat(40);
    const externalId = `revoir:ai-review:v1:owner/repository#17@${headSha}`;
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const checkRun = (
      id: number,
      status: "completed" | "in_progress",
      appSlug = "revoir-test",
      runExternalId = externalId,
    ) => ({
      id,
      name: "RevoirAI Review",
      head_sha: headSha,
      status,
      external_id: runExternalId,
      app: { slug: appSlug },
    });
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (
        url.endsWith(
          `/commits/${headSha}/check-runs?check_name=RevoirAI%20Review&filter=all&per_page=100&page=1`,
        )
      ) {
        return json({
          total_count: 4,
          check_runs: [
            checkRun(70, "in_progress"),
            checkRun(71, "in_progress", "another-app"),
            checkRun(72, "completed"),
            checkRun(73, "in_progress", "revoir-test", "another-execution"),
          ],
        });
      }
      if (url.endsWith("/check-runs/70") && init?.method === "PATCH") {
        return json(checkRun(70, "completed"));
      }
      if (url.endsWith("/check-runs") && init?.method === "POST") {
        return json(checkRun(80, "in_progress"), 201);
      }
      if (url.endsWith("/check-runs/80") && init?.method === "PATCH") {
        return json(checkRun(80, "completed"));
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);

    const check = await session.startReviewCheck(reference, headSha, new AbortController().signal);
    assert.equal(check.id, 80);
    await check.complete(
      {
        conclusion: "success",
        title: "Review completed",
        summary: "Revoir completed the review.",
      },
      new AbortController().signal,
    );

    const reconciliation = requests.find(({ url }) => url.endsWith("/check-runs/70"));
    assert.deepEqual(JSON.parse(String(reconciliation?.init?.body)), {
      name: "RevoirAI Review",
      status: "completed",
      conclusion: "cancelled",
      completed_at: "1970-01-01T00:16:40.000Z",
      output: {
        title: "Review superseded",
        summary: "A new Revoir execution replaced an incomplete review for this commit.",
      },
    });
    assert.equal(
      requests.some(({ url }) => url.endsWith("/check-runs/71")),
      false,
    );
    assert.equal(
      requests.some(({ url }) => url.endsWith("/check-runs/72")),
      false,
    );
    assert.equal(
      requests.some(({ url }) => url.endsWith("/check-runs/73")),
      false,
    );
    const creation = requests.find(
      ({ url, init }) => url.endsWith("/check-runs") && init?.method === "POST",
    );
    assert.deepEqual(JSON.parse(String(creation?.init?.body)), {
      name: "RevoirAI Review",
      head_sha: headSha,
      status: "in_progress",
      external_id: externalId,
      started_at: "1970-01-01T00:16:40.000Z",
      output: {
        title: "Review in progress",
        summary: "Revoir is reviewing pull request #17 at 2222222.",
      },
    });
    const completion = requests.find(({ url }) => url.endsWith("/check-runs/80"));
    assert.deepEqual(JSON.parse(String(completion?.init?.body)), {
      name: "RevoirAI Review",
      status: "completed",
      conclusion: "success",
      completed_at: "1970-01-01T00:16:40.000Z",
      output: {
        title: "Review completed",
        summary: "Revoir completed the review.",
      },
    });
  });

  it("creates, updates, and removes one bot-owned failure comment without touching humans", async () => {
    const comments = [
      {
        id: 40,
        body: "<!-- revoir:failure:v1 --> human-owned",
        user: { login: "human" },
      },
    ];
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/issues/17/comments?per_page=100&page=1")) {
        return json(comments);
      }
      if (url.endsWith("/issues/17/comments") && init?.method === "POST") {
        const created = {
          id: 41,
          body: (JSON.parse(String(init.body)) as { body: string }).body,
          user: { login: "revoir-test[bot]" },
        };
        comments.push(created);
        return json(created, 201);
      }
      if (url.endsWith("/issues/comments/41") && init?.method === "PATCH") {
        comments[1]!.body = (JSON.parse(String(init.body)) as { body: string }).body;
        return json(comments[1]);
      }
      if (url.endsWith("/issues/comments/41") && init?.method === "DELETE") {
        comments.splice(1, 1);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const first = "<!-- revoir:failure:v1 --> first failure";
    const second = "<!-- revoir:failure:v1 --> second failure";

    await session.upsertFailureComment(reference, first, new AbortController().signal);
    await session.upsertFailureComment(reference, second, new AbortController().signal);
    assert.deepEqual(comments, [
      {
        id: 40,
        body: "<!-- revoir:failure:v1 --> human-owned",
        user: { login: "human" },
      },
      {
        id: 41,
        body: second,
        user: { login: "revoir-test[bot]" },
      },
    ]);

    await session.removeOwnFailureComment(reference, new AbortController().signal);
    assert.deepEqual(comments, [
      {
        id: 40,
        body: "<!-- revoir:failure:v1 --> human-owned",
        user: { login: "human" },
      },
    ]);
    assert.equal(
      requests.filter(
        (request) => request.url.endsWith("/issues/17/comments") && request.init?.method === "POST",
      ).length,
      1,
    );
    assert.equal(
      requests.filter(
        (request) =>
          request.url.endsWith("/issues/comments/41") && request.init?.method === "PATCH",
      ).length,
      1,
    );
  });

  it("creates, submits, and deletes exact non-blocking pending reviews", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    let reviewId = 80;
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews") && init?.method === "POST") {
        reviewId += 1;
        return json({ id: reviewId });
      }
      if (url.endsWith("/reviews/81/events") && init?.method === "POST") {
        return json({ id: 81, state: "COMMENTED" });
      }
      if (url.endsWith("/reviews/82") && init?.method === "DELETE") {
        return json({ id: 82, state: "PENDING" });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const candidate: ReviewFindingV2 = {
      version: 2,
      fingerprint: "a".repeat(64),
      priority: "P1",
      path: "source.ts",
      range: { start: 2, end: 2, side: "RIGHT" },
      defectKind: "concurrency",
      impactKind: "execution-stall",
      fixAction: "propagate",
      reason: "The signal is not propagated, so the active review cannot stop.",
      anchor: "signal",
      attachment: {
        kind: "inline",
        path: "source.ts",
        startLine: 2,
        endLine: 2,
        side: "RIGHT",
      },
    };
    const publication = createReviewPublication("2".repeat(40), [candidate]);
    const submitted = await session.createPendingReview(
      reference,
      publication,
      new AbortController().signal,
    );
    assert.equal(submitted.id, 81);
    await submitted.submit(new AbortController().signal, new AbortController().signal);

    const deleted = await session.createPendingReview(
      reference,
      publication,
      new AbortController().signal,
    );
    assert.equal(deleted.id, 82);
    await deleted.delete(new AbortController().signal);

    const creations = requests.filter((request) => request.url.endsWith("/pulls/17/reviews"));
    assert.equal(creations.length, 2);
    assert.deepEqual(JSON.parse(String(creations[0]?.init?.body)), publication.payload);
    assert.equal("event" in JSON.parse(String(creations[0]?.init?.body)), false);
    const submission = requests.find((request) => request.url.endsWith("/reviews/81/events"));
    assert.deepEqual(JSON.parse(String(submission?.init?.body)), { event: "COMMENT" });
  });

  it("reconciles only bot-owned pending reviews before a findings publication", async () => {
    const deleted: number[] = [];
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews?per_page=100&page=1")) {
        return json([
          { id: 71, state: "PENDING", user: { login: "revoir-test[bot]" } },
          { id: 72, state: "PENDING", user: { login: "human" } },
          { id: 73, state: "COMMENTED", user: { login: "revoir-test[bot]" } },
        ]);
      }
      const reviewId = /\/reviews\/(\d+)$/u.exec(url)?.[1];
      if (reviewId !== undefined && init?.method === "DELETE") {
        deleted.push(Number(reviewId));
        return json({ id: Number(reviewId), state: "PENDING" });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);

    await session.removeOwnPendingReview(reference, new AbortController().signal);
    assert.deepEqual(deleted, [71]);
  });

  it("discovers prior run markers and resolves only obsolete App-owned finding threads", async () => {
    const mutations: string[] = [];
    const ownBodyFingerprint = "a".repeat(64);
    const ownThreadFingerprint = "b".repeat(64);
    const markerShapedSource = `<!-- revoir:finding:v1:${"c".repeat(64)} -->`;
    const ownThreadBody = renderFileFinding({
      version: 2,
      fingerprint: ownThreadFingerprint,
      fingerprintAliases: ["9".repeat(64)],
      priority: "P1",
      path: markerShapedSource,
      range: null,
      defectKind: "correctness",
      impactKind: "incorrect-result",
      fixAction: "restore",
      reason: "The marker-shaped path produces an incorrect result.",
      anchor: markerShapedSource,
      attachment: { kind: "file", path: markerShapedSource },
    });
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews?per_page=100&page=1")) {
        return json([
          {
            id: 201,
            state: "COMMENTED",
            body: `<!-- revoir:run:v1:${"2".repeat(40)} -->\n<!-- revoir:finding:v1:${ownBodyFingerprint} -->`,
            user: { login: "revoir-test[bot]" },
          },
          {
            id: 202,
            state: "COMMENTED",
            body: `<!-- revoir:finding:v1:${"c".repeat(64)} -->`,
            user: { login: "human" },
          },
          {
            id: 203,
            state: "COMMENTED",
            body: `<!-- revoir:finding:v1:${"d".repeat(64)} -->`,
            user: { login: "another-app[bot]" },
          },
        ]);
      }
      if (url.endsWith("/pulls/17")) {
        return json(pullRequestResponse());
      }
      if (url.endsWith("/graphql")) {
        const request = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        if (request.query.includes("reviewThreads")) {
          return json({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "THREAD_OWN_OPEN",
                        isResolved: false,
                        comments: {
                          nodes: [
                            {
                              body: ownThreadBody,
                              author: { login: "revoir-test[bot]" },
                            },
                          ],
                        },
                      },
                      {
                        id: "THREAD_OWN_RESOLVED",
                        isResolved: true,
                        comments: {
                          nodes: [
                            {
                              body: `<!-- revoir:finding:v1:${"e".repeat(64)} -->`,
                              author: { login: "revoir-test[bot]" },
                            },
                          ],
                        },
                      },
                      {
                        id: "THREAD_HUMAN",
                        isResolved: false,
                        comments: {
                          nodes: [
                            {
                              body: `<!-- revoir:finding:v1:${"f".repeat(64)} -->`,
                              author: { login: "human" },
                            },
                          ],
                        },
                      },
                      {
                        id: "THREAD_OTHER_APP",
                        isResolved: false,
                        comments: {
                          nodes: [
                            {
                              body: `<!-- revoir:finding:v1:${"0".repeat(64)} -->`,
                              author: { login: "another-app[bot]" },
                            },
                          ],
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        mutations.push(String(request.variables.threadId));
        return json({
          data: {
            resolveReviewThread: {
              thread: { id: request.variables.threadId, isResolved: true },
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

    assert.deepEqual(await session.getPriorReviewState(reference, new AbortController().signal), {
      activeFingerprints: [ownBodyFingerprint, ownThreadFingerprint],
      bodyFindings: [{ fingerprint: ownBodyFingerprint }],
      bodyStateMigrationRequired: true,
      ownedOpenThreads: [
        {
          id: "THREAD_OWN_OPEN",
          fingerprint: ownThreadFingerprint,
          aliases: ["9".repeat(64)],
        },
      ],
      runHeadShas: ["2".repeat(40)],
    });
    await assert.rejects(
      () =>
        session.resolveReviewThreads(
          reference,
          ["THREAD_HUMAN"],
          "2".repeat(40),
          new AbortController().signal,
        ),
      /not owned by this GitHub App/u,
    );
    assert.deepEqual(
      await session.resolveReviewThreads(
        reference,
        ["THREAD_OWN_OPEN"],
        "2".repeat(40),
        new AbortController().signal,
      ),
      { status: "resolved" },
    );
    assert.deepEqual(mutations, ["THREAD_OWN_OPEN"]);
  });

  it("prevalidates ownership and fences every thread resolution with the expected head", async () => {
    const expectedHeadSha = "2".repeat(40);
    const staleHeadSha = "3".repeat(40);
    const mutations: string[] = [];
    let headReads = 0;
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews?per_page=100&page=1")) {
        return json([]);
      }
      if (url.endsWith("/pulls/17")) {
        headReads += 1;
        return json(pullRequestResponse(headReads === 1 ? expectedHeadSha : staleHeadSha));
      }
      if (url.endsWith("/graphql")) {
        const request = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        if (request.query.includes("reviewThreads")) {
          return json({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      ownedReviewThreadResponse("THREAD_A", "a".repeat(64)),
                      ownedReviewThreadResponse("THREAD_B", "b".repeat(64)),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        mutations.push(String(request.variables.threadId));
        return json({
          data: {
            resolveReviewThread: {
              thread: { id: request.variables.threadId, isResolved: true },
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
    const signal = new AbortController().signal;
    await session.getPriorReviewState(reference, signal);

    await assert.rejects(
      () =>
        session.resolveReviewThreads(
          reference,
          ["THREAD_A", "THREAD_FOREIGN"],
          expectedHeadSha,
          signal,
        ),
      /not owned by this GitHub App/u,
    );
    assert.equal(headReads, 0);
    assert.deepEqual(mutations, []);

    assert.deepEqual(
      await session.resolveReviewThreads(
        reference,
        ["THREAD_A", "THREAD_B"],
        expectedHeadSha,
        signal,
      ),
      { status: "stale", currentSha: staleHeadSha },
    );
    assert.equal(headReads, 2);
    assert.deepEqual(mutations, ["THREAD_A"]);
  });

  it("migrates the latest legacy body-marker review until a versioned snapshot exists", async () => {
    const olderFingerprint = "a".repeat(64);
    const latestFingerprint = "b".repeat(64);
    const ignoredFingerprint = "c".repeat(64);
    const latestFinding: ReviewFindingV2 = {
      version: 2,
      fingerprint: latestFingerprint,
      priority: "P1",
      path: "source.ts",
      range: null,
      defectKind: "correctness",
      impactKind: "incorrect-result",
      fixAction: "restore",
      reason: "The changed source file produces an incorrect result.",
      anchor: "source.ts",
      attachment: { kind: "file", path: "source.ts" },
    };
    const legacyBody = (fingerprint: string): string =>
      renderFileFinding({ ...latestFinding, fingerprint });

    for (const hasVersionedSnapshot of [false, true]) {
      const fetchImplementation: FetchLike = async (input) => {
        const url = String(input);
        if (url.endsWith("/app")) {
          return json({ slug: "revoir-test" });
        }
        if (url.endsWith("/app/installations/8/access_tokens")) {
          return json({ token: "installation-secret" });
        }
        if (url.endsWith("/pulls/17/reviews?per_page=100&page=1")) {
          return json([
            {
              id: 201,
              state: "COMMENTED",
              body: legacyBody(olderFingerprint),
              user: { login: "revoir-test[bot]" },
            },
            {
              id: 202,
              state: "COMMENTED",
              body: legacyBody(latestFingerprint),
              user: { login: "revoir-test[bot]" },
            },
            ...(hasVersionedSnapshot
              ? [
                  {
                    id: 203,
                    state: "COMMENTED",
                    body: createReviewPublication("2".repeat(40), [], []).payload.body!,
                    user: { login: "revoir-test[bot]" },
                  },
                  {
                    id: 204,
                    state: "COMMENTED",
                    body: legacyBody(ignoredFingerprint),
                    user: { login: "revoir-test[bot]" },
                  },
                ]
              : []),
          ]);
        }
        if (url.endsWith("/graphql")) {
          return json({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        throw new Error(`Unexpected request ${url}`);
      };
      // Sequential cases reuse no gateway state.
      // eslint-disable-next-line no-await-in-loop
      const session = await new GitHubAppReviewGateway(
        fetchImplementation,
        "https://api.test",
        () => 1_000,
      ).authenticate(configuration.github, reference, new AbortController().signal);
      // eslint-disable-next-line no-await-in-loop
      const prior = await session.getPriorReviewState(reference, new AbortController().signal);

      assert.deepEqual(
        prior.bodyFindings,
        hasVersionedSnapshot ? [] : [{ fingerprint: latestFingerprint }],
      );
      assert.equal(prior.bodyStateMigrationRequired === true, !hasVersionedSnapshot);
      assert.deepEqual(
        planFindingReconciliation([latestFinding], prior).netNewFindings,
        hasVersionedSnapshot ? [latestFinding] : [],
      );
      assert.equal(planFindingReconciliation([latestFinding], prior).bodyStateChanged, true);
    }
  });

  it("folds submitted App review bodies into the latest authoritative snapshot", async () => {
    const fingerprints = {
      older: "a".repeat(64),
      latest: "b".repeat(64),
      ignored: "c".repeat(64),
      other: "d".repeat(64),
    };
    const findings = {
      older: reviewFileFinding(fingerprints.older, "older.ts"),
      latest: reviewFileFinding(fingerprints.latest, "latest.ts"),
      ignored: reviewFileFinding(fingerprints.ignored, "ignored.ts"),
      other: reviewFileFinding(fingerprints.other, "other.ts"),
    };
    const scenarios = [
      {
        name: "latest legacy marker set",
        reviews: [
          ownReview(201, legacyReviewBody(findings.older)),
          ownReview(202, legacyReviewBody(findings.latest)),
        ],
        expectedBodyFingerprints: [fingerprints.latest],
        migrationRequired: true,
        candidate: findings.latest,
        expectedNetNew: [],
        bodyStateChanged: true,
        runHeadShas: [],
      },
      {
        name: "empty legacy body",
        reviews: [ownReview(201, legacyReviewBody(findings.older)), ownReview(202, "")],
        expectedBodyFingerprints: [],
        migrationRequired: true,
        candidate: findings.older,
        expectedNetNew: [fingerprints.older],
        bodyStateChanged: true,
        runHeadShas: [],
      },
      {
        name: "null inline-only legacy body",
        reviews: [ownReview(201, legacyReviewBody(findings.older)), ownReview(202, null)],
        expectedBodyFingerprints: [],
        migrationRequired: true,
        candidate: findings.older,
        expectedNetNew: [fingerprints.older],
        bodyStateChanged: true,
        runHeadShas: [],
      },
      {
        name: "run-only legacy body",
        reviews: [
          ownReview(201, legacyReviewBody(findings.older)),
          ownReview(202, `<!-- revoir:run:v1:${"3".repeat(40)} -->`),
        ],
        expectedBodyFingerprints: [],
        migrationRequired: true,
        candidate: findings.older,
        expectedNetNew: [fingerprints.older],
        bodyStateChanged: true,
        runHeadShas: ["3".repeat(40)],
      },
      {
        name: "pending and non-App reviews are ignored",
        reviews: [
          ownReview(201, legacyReviewBody(findings.latest)),
          ownReview(202, legacyReviewBody(findings.ignored), "PENDING"),
          {
            id: 203,
            state: "COMMENTED",
            body: legacyReviewBody(findings.other),
            user: { login: "human" },
          },
        ],
        expectedBodyFingerprints: [fingerprints.latest],
        migrationRequired: true,
        candidate: findings.latest,
        expectedNetNew: [],
        bodyStateChanged: true,
        runHeadShas: [],
      },
      {
        name: "legacy cannot override an explicit snapshot",
        reviews: [
          ownReview(201, legacyReviewBody(findings.older)),
          ownReview(202, explicitReviewBody([findings.latest])),
          ownReview(203, legacyReviewBody(findings.ignored)),
        ],
        expectedBodyFingerprints: [fingerprints.latest],
        migrationRequired: false,
        candidate: findings.latest,
        expectedNetNew: [],
        bodyStateChanged: false,
        runHeadShas: ["2".repeat(40)],
      },
      {
        name: "explicit state without a run marker remains authoritative",
        reviews: [
          ownReview(201, legacyReviewBody(findings.older)),
          ownReview(202, markerOnlyExplicitReviewBody(findings.latest)),
          ownReview(203, legacyReviewBody(findings.ignored)),
        ],
        expectedBodyFingerprints: [fingerprints.latest],
        migrationRequired: false,
        candidate: findings.latest,
        expectedNetNew: [],
        bodyStateChanged: false,
        runHeadShas: [],
      },
      {
        name: "latest explicit empty snapshot wins",
        reviews: [
          ownReview(201, explicitReviewBody([findings.latest])),
          ownReview(202, explicitReviewBody([])),
          ownReview(203, legacyReviewBody(findings.ignored)),
        ],
        expectedBodyFingerprints: [],
        migrationRequired: false,
        candidate: findings.latest,
        expectedNetNew: [fingerprints.latest],
        bodyStateChanged: true,
        runHeadShas: ["2".repeat(40)],
      },
    ];

    await Promise.all(
      scenarios.map(async (scenario) => {
        const fetchImplementation: FetchLike = async (input) => {
          const url = String(input);
          if (url.endsWith("/app")) {
            return json({ slug: "revoir-test" });
          }
          if (url.endsWith("/app/installations/8/access_tokens")) {
            return json({ token: "installation-secret" });
          }
          if (url.endsWith("/pulls/17/reviews?per_page=100&page=1")) {
            return json(scenario.reviews);
          }
          if (url.endsWith("/graphql")) {
            return json({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
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
        const prior = await session.getPriorReviewState(reference, new AbortController().signal);
        const plan = planFindingReconciliation([scenario.candidate], prior);

        assert.deepEqual(
          prior.bodyFindings?.map(({ fingerprint }) => fingerprint),
          scenario.expectedBodyFingerprints,
          scenario.name,
        );
        assert.equal(
          prior.bodyStateMigrationRequired === true,
          scenario.migrationRequired,
          scenario.name,
        );
        assert.deepEqual(
          plan.netNewFindings.map(({ fingerprint }) => fingerprint),
          scenario.expectedNetNew,
          scenario.name,
        );
        assert.equal(plan.bodyStateChanged, scenario.bodyStateChanged, scenario.name);
        assert.deepEqual(prior.runHeadShas, scenario.runHeadShas, scenario.name);
      }),
    );
  });

  it("folds legacy snapshots across a review-page boundary and unions open App threads", async () => {
    const retiredFingerprint = "a".repeat(64);
    const threadFingerprint = "b".repeat(64);
    const ignoredFingerprint = "c".repeat(64);
    const retiredFinding = reviewFileFinding(retiredFingerprint, "returned.ts");
    const threadFinding = reviewFileFinding(threadFingerprint, "unchanged.ts");
    const firstPage = [
      ...Array.from({ length: 99 }, (_, index) => ({
        id: index + 1,
        state: "COMMENTED",
        body: "",
        user: { login: "human" },
      })),
      {
        id: 100,
        state: "COMMENTED",
        body: renderFileFinding(retiredFinding),
        user: { login: "revoir-test[bot]" },
      },
    ];
    const fetchImplementation: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews?per_page=100&page=1")) {
        return json(firstPage);
      }
      if (url.endsWith("/pulls/17/reviews?per_page=100&page=2")) {
        return json([
          {
            id: 101,
            state: "COMMENTED",
            body: null,
            user: { login: "revoir-test[bot]" },
          },
          {
            id: 102,
            state: "PENDING",
            body: renderFileFinding(reviewFileFinding(ignoredFingerprint, "pending.ts")),
            user: { login: "revoir-test[bot]" },
          },
        ]);
      }
      if (url.endsWith("/graphql")) {
        return json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [ownedReviewThreadResponse("THREAD_OPEN", threadFingerprint)],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
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
    const prior = await session.getPriorReviewState(reference, new AbortController().signal);
    const plan = planFindingReconciliation([retiredFinding, threadFinding], prior);

    assert.deepEqual(prior.bodyFindings, []);
    assert.equal(prior.bodyStateMigrationRequired, true);
    assert.deepEqual(prior.activeFingerprints, [threadFingerprint]);
    assert.deepEqual(prior.ownedOpenThreads, [
      { id: "THREAD_OPEN", fingerprint: threadFingerprint },
    ]);
    assert.deepEqual(
      plan.netNewFindings.map(({ fingerprint }) => fingerprint),
      [retiredFingerprint],
    );
    assert.equal(plan.bodyStateChanged, true);
  });

  it("discovers full body snapshots across delta, retirement, and clean runs", async () => {
    const historicalFingerprint = "a".repeat(64);
    const latestFingerprint = "b".repeat(64);
    const fileFinding: ReviewFindingV2 = {
      version: 2,
      fingerprint: historicalFingerprint,
      priority: "P1",
      path: "source.ts",
      range: null,
      defectKind: "correctness",
      impactKind: "incorrect-result",
      fixAction: "restore",
      reason: "The changed source file produces an incorrect result.",
      anchor: "source.ts",
      attachment: { kind: "file", path: "source.ts" },
    };
    const fallbackFinding: ReviewFindingV2 = {
      ...fileFinding,
      range: { start: 2, end: 2, side: "RIGHT" },
      attachment: {
        kind: "inline",
        path: "source.ts",
        startLine: 2,
        endLine: 2,
        side: "RIGHT",
      },
    };
    const latestFinding: ReviewFindingV2 = {
      ...fileFinding,
      fingerprint: latestFingerprint,
      path: "latest.ts",
      anchor: "latest.ts",
      attachment: { kind: "file", path: "latest.ts" },
    };
    const historicalBodies = [
      createReviewPublication("1".repeat(40), [fileFinding]).payload.body!,
      createReviewPublication("1".repeat(40), [fallbackFinding]).fallbackPayload.body!,
    ];

    await Promise.all(
      historicalBodies.flatMap((historicalBody, index) =>
        (["findings", "retired", "clean"] as const).map(async (priorRun) => {
          const returnedFinding = index === 0 ? fileFinding : fallbackFinding;
          const laterBody =
            priorRun === "findings"
              ? createReviewPublication(
                  "2".repeat(40),
                  [latestFinding],
                  [returnedFinding, latestFinding],
                ).payload.body!
              : createReviewPublication("2".repeat(40), [], []).payload.body!;
          const fetchImplementation: FetchLike = async (input, init) => {
            const url = String(input);
            if (url.endsWith("/app")) {
              return json({ slug: "revoir-test" });
            }
            if (url.endsWith("/app/installations/8/access_tokens")) {
              return json({ token: "installation-secret" });
            }
            if (url.includes("/reactions?per_page=100&page=1")) {
              return json(
                priorRun === "clean"
                  ? [
                      {
                        id: 301,
                        content: "+1",
                        user: { login: "revoir-test[bot]" },
                      },
                    ]
                  : [],
              );
            }
            if (url.endsWith("/reactions/301") && init?.method === "DELETE") {
              return new Response(null, { status: 204 });
            }
            if (url.endsWith("/pulls/17/reviews?per_page=100&page=1")) {
              return json([
                {
                  id: 201,
                  state: "COMMENTED",
                  body: historicalBody,
                  user: { login: "revoir-test[bot]" },
                },
                ...(priorRun === "clean"
                  ? []
                  : [
                      {
                        id: 202,
                        state: "COMMENTED",
                        body: laterBody,
                        user: { login: "revoir-test[bot]" },
                      },
                    ]),
              ]);
            }
            if (url.endsWith("/graphql")) {
              return json({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes: [],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
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

          await session.removeOwnCompletionReaction(reference, new AbortController().signal);
          const prior = await session.getPriorReviewState(reference, new AbortController().signal);
          assert.deepEqual(
            prior.activeFingerprints,
            priorRun === "findings" ? [historicalFingerprint, latestFingerprint] : [],
          );
          assert.deepEqual(
            planFindingReconciliation([returnedFinding], prior).netNewFindings,
            priorRun === "findings" ? [] : [returnedFinding],
          );
        }),
      ),
    );
  });

  it("uses the bounded state-aware fence while reconciling an owned pending review", async () => {
    const events: string[] = [];
    let deletionAttempt = 0;
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews?per_page=100&page=1")) {
        return json([{ id: 74, state: "PENDING", user: { login: "revoir-test[bot]" } }]);
      }
      if (url.endsWith("/reviews/74") && init?.method === "DELETE") {
        deletionAttempt += 1;
        events.push(`DELETE ${deletionAttempt}`);
        return deletionAttempt === 1
          ? json({ message: "review transition in progress" }, 422)
          : json({ id: 74, state: "PENDING" });
      }
      if (url.endsWith("/reviews/74") && init?.method === undefined) {
        events.push("GET PENDING");
        return json({
          id: 74,
          state: "PENDING",
          user: { login: "revoir-test[bot]" },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
      5,
    ).authenticate(configuration.github, reference, new AbortController().signal);

    await session.removeOwnPendingReview(reference, new AbortController().signal);
    assert.deepEqual(events, ["DELETE 1", "GET PENDING", "DELETE 2"]);
  });

  it("falls back from rejected inline anchors to one file-level pending review", async () => {
    const creationBodies: unknown[] = [];
    let attempts = 0;
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews") && init?.method === "POST") {
        attempts += 1;
        creationBodies.push(JSON.parse(String(init.body)));
        return attempts === 1 ? json({ message: "invalid line" }, 422) : json({ id: 91 });
      }
      if (url.endsWith("/reviews/91") && init?.method === "DELETE") {
        return json({ message: "Not Found" }, 404);
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const publication = {
      payload: {
        commit_id: "2".repeat(40),
        comments: [
          {
            path: "source.ts",
            line: 2,
            side: "RIGHT" as const,
            body: "validated finding",
          },
        ],
      },
      fallbackPayload: {
        commit_id: "2".repeat(40),
        body: "validated finding with explicit location",
      },
    };
    const pending = await session.createPendingReview(
      reference,
      publication,
      new AbortController().signal,
    );
    await pending.delete(new AbortController().signal);

    assert.deepEqual(creationBodies, [publication.payload, publication.fallbackPayload]);
  });

  it("rejects invalid pending-review responses and submission states", async () => {
    let mode: "missing-id" | "submit-rejected" = "missing-id";
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews") && init?.method === "POST") {
        return mode === "missing-id" ? json({}) : json({ id: 101 });
      }
      if (url.endsWith("/reviews/101/events") && init?.method === "POST") {
        return json({ message: "not pending" }, 422);
      }
      if (url.endsWith("/reviews/101") && init?.method === undefined) {
        return json({
          id: 101,
          state: "PENDING",
          user: { login: "revoir-test[bot]" },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const publication = {
      payload: { commit_id: "2".repeat(40), body: "finding" },
      fallbackPayload: { commit_id: "2".repeat(40), body: "finding" },
    };
    await assert.rejects(
      () => session.createPendingReview(reference, publication, new AbortController().signal),
      /pending review id/u,
    );
    mode = "submit-rejected";
    const pending = await session.createPendingReview(
      reference,
      publication,
      new AbortController().signal,
    );
    await assert.rejects(
      () => pending.submit(new AbortController().signal, new AbortController().signal),
      /rejected the non-blocking review/u,
    );
  });

  it("reconciles a deadline-cancelled submit when GitHub confirms publication", async () => {
    const submitController = new AbortController();
    const reconciliationController = new AbortController();
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews") && init?.method === "POST") {
        return json({ id: 111 });
      }
      if (url.endsWith("/reviews/111/events") && init?.method === "POST") {
        submitController.abort(new Error("deadline elapsed after submission"));
        return json({ id: 111, state: "COMMENTED" });
      }
      if (url.endsWith("/reviews/111") && init?.method === undefined) {
        assert.equal(init?.signal?.aborted, false);
        assert.notEqual(init?.signal, submitController.signal);
        return json({
          id: 111,
          state: "COMMENTED",
          user: { login: "revoir-test[bot]" },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const publication = {
      payload: { commit_id: "2".repeat(40), body: "finding" },
      fallbackPayload: { commit_id: "2".repeat(40), body: "finding" },
    };
    const pending = await session.createPendingReview(
      reference,
      publication,
      new AbortController().signal,
    );
    await pending.submit(submitController.signal, reconciliationController.signal);
  });

  it("retries a transient read while reconciling an ambiguous submission", async () => {
    const submitController = new AbortController();
    const reconciliationController = new AbortController();
    let reconciliationReads = 0;
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews") && init?.method === "POST") {
        return json({ id: 112 });
      }
      if (url.endsWith("/reviews/112/events") && init?.method === "POST") {
        submitController.abort(new Error("deadline elapsed after submission"));
        return json({ id: 112, state: "COMMENTED" });
      }
      if (url.endsWith("/reviews/112") && init?.method === undefined) {
        assert.equal(init?.signal?.aborted, false);
        assert.notEqual(init?.signal, submitController.signal);
        reconciliationReads += 1;
        if (reconciliationReads === 1) {
          throw new Error("transient reconciliation failure");
        }
        return json({
          id: 112,
          state: "COMMENTED",
          user: { login: "revoir-test[bot]" },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const publication = {
      payload: { commit_id: "2".repeat(40), body: "finding" },
      fallbackPayload: { commit_id: "2".repeat(40), body: "finding" },
    };
    const pending = await session.createPendingReview(
      reference,
      publication,
      new AbortController().signal,
    );

    await pending.submit(submitController.signal, reconciliationController.signal);
    assert.equal(reconciliationReads, 2);
  });

  it("lets exact deletion win after an ambiguous submit still reads PENDING", async () => {
    const submitController = new AbortController();
    const events: string[] = [];
    const deadline = new Error("deadline elapsed while submission was in flight");
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews") && init?.method === "POST") {
        return json({ id: 113 });
      }
      if (url.endsWith("/reviews/113/events") && init?.method === "POST") {
        events.push("POST");
        submitController.abort(deadline);
        return json({ id: 113, state: "PENDING" });
      }
      if (url.endsWith("/reviews/113") && init?.method === undefined) {
        events.push("GET PENDING");
        return json({
          id: 113,
          state: "PENDING",
          user: { login: "revoir-test[bot]" },
        });
      }
      if (url.endsWith("/reviews/113") && init?.method === "DELETE") {
        events.push("DELETE 200");
        return json({ id: 113, state: "PENDING" });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
      5,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const publication = {
      payload: { commit_id: "2".repeat(40), body: "finding" },
      fallbackPayload: { commit_id: "2".repeat(40), body: "finding" },
    };
    const pending = await session.createPendingReview(
      reference,
      publication,
      new AbortController().signal,
    );

    await assert.rejects(
      () => pending.submit(submitController.signal, new AbortController().signal),
      deadline,
    );
    assert.deepEqual(events, ["POST", "GET PENDING", "DELETE 200"]);
  });

  it("lets a late COMMENT win the compensating fence after a PENDING read", async () => {
    const submitController = new AbortController();
    const events: string[] = [];
    let state = "PENDING";
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews") && init?.method === "POST") {
        return json({ id: 114 });
      }
      if (url.endsWith("/reviews/114/events") && init?.method === "POST") {
        events.push("POST");
        submitController.abort(new Error("deadline elapsed while submission was in flight"));
        return json({ id: 114, state: "PENDING" });
      }
      if (url.endsWith("/reviews/114") && init?.method === undefined) {
        events.push(`GET ${state}`);
        const observed = state;
        if (state === "PENDING") {
          state = "COMMENTED";
        }
        return json({
          id: 114,
          state: observed,
          user: { login: "revoir-test[bot]" },
        });
      }
      if (url.endsWith("/reviews/114") && init?.method === "DELETE") {
        events.push("DELETE 422");
        return json({ message: "review is already submitted" }, 422);
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
      5,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const publication = {
      payload: { commit_id: "2".repeat(40), body: "finding" },
      fallbackPayload: { commit_id: "2".repeat(40), body: "finding" },
    };
    const pending = await session.createPendingReview(
      reference,
      publication,
      new AbortController().signal,
    );

    await pending.submit(submitController.signal, new AbortController().signal);
    assert.deepEqual(events, ["POST", "GET PENDING", "DELETE 422", "GET COMMENTED"]);
  });

  it("bounds never-settling reads and deletion while preserving typed submission uncertainty", async () => {
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/pulls/17/reviews") && init?.method === "POST") {
        return json({ id: 115 });
      }
      if (url.endsWith("/reviews/115/events") && init?.method === "POST") {
        throw new Error("network connection reset");
      }
      if (url.endsWith("/reviews/115")) {
        return new Promise<Response>(() => {});
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
      2,
    ).authenticate(configuration.github, reference, new AbortController().signal);
    const publication = {
      payload: { commit_id: "2".repeat(40), body: "finding" },
      fallbackPayload: { commit_id: "2".repeat(40), body: "finding" },
    };
    const pending = await session.createPendingReview(
      reference,
      publication,
      new AbortController().signal,
    );

    await assert.rejects(
      () =>
        Promise.race([
          pending.submit(new AbortController().signal, new AbortController().signal),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("pending-review fence did not terminate")), 250);
          }),
        ]),
      ReviewSubmissionUncertainError,
    );
  });

  it("treats only deleted and already-absent reaction responses as successful", async () => {
    const statuses = [200, 201, 202, 206, 401, 403, 429, 500];
    let deleteAttempt = 0;
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.includes("/reactions/") && init?.method === "DELETE") {
        const status = statuses[deleteAttempt];
        deleteAttempt += 1;
        assert.ok(status !== undefined);
        return status === 204
          ? new Response(null, { status })
          : new Response(JSON.stringify({ message: "delete failed" }), { status });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);

    for (const status of statuses) {
      // Every unexpected status, including otherwise-successful 2xx responses, is a failure.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () => session.deleteReaction(reference, 91, new AbortController().signal),
        new RegExp(`HTTP ${status}`, "u"),
      );
    }
  });

  it("accepts a missing reaction directly and after a lost successful deletion response", async () => {
    let directMissing = true;
    let retryAttempts = 0;
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/reactions/91") && init?.method === "DELETE") {
        assert.equal(directMissing, true);
        directMissing = false;
        return json({ message: "Not Found" }, 404);
      }
      if (url.endsWith("/reactions/92") && init?.method === "DELETE") {
        retryAttempts += 1;
        if (retryAttempts === 1) {
          throw new Error("network failed after GitHub deleted the reaction");
        }
        return json({ message: "Not Found" }, 404);
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);

    await session.deleteReaction(reference, 91, new AbortController().signal);
    await assert.rejects(
      () => session.deleteReaction(reference, 92, new AbortController().signal),
      /network failed/u,
    );
    await session.deleteReaction(reference, 92, new AbortController().signal);
    assert.equal(retryAttempts, 2);
  });

  it("accepts a reaction disappearing between reconciliation lookup and deletion", async () => {
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/issues/17/reactions?per_page=100&page=1")) {
        return json([{ id: 93, content: "eyes", user: { login: "revoir-test[bot]" } }]);
      }
      if (url.endsWith("/reactions/93") && init?.method === "DELETE") {
        return json({ message: "Not Found" }, 404);
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);

    await session.removeOwnReaction(reference, "eyes", new AbortController().signal);
  });

  it("can reconcile created reactions after invalid JSON and network ambiguity", async () => {
    await Promise.all(
      (["eyes", "+1"] as const).map(async (reaction) => {
        const requests: Array<{ url: string; method: string | undefined }> = [];
        const reactions = [{ id: 40, content: reaction, user: { login: "human" } }];
        const fetchImplementation: FetchLike = async (input, init) => {
          const url = String(input);
          requests.push({ url, method: init?.method });
          if (url.endsWith("/app")) {
            return json({ slug: "revoir-test" });
          }
          if (url.endsWith("/app/installations/8/access_tokens")) {
            return json({ token: "installation-secret" });
          }
          if (url.endsWith("/issues/17/reactions") && init?.method === "POST") {
            reactions.push({
              id: 41,
              content: reaction,
              user: { login: "revoir-test[bot]" },
            });
            if (reaction === "eyes") {
              return new Response("not json", {
                status: 201,
                headers: { "Content-Type": "application/json" },
              });
            }
            throw new Error("network failed after reaction creation");
          }
          if (url.endsWith("/issues/17/reactions?per_page=100&page=1")) {
            return json(reactions);
          }
          if (url.endsWith("/reactions/41") && init?.method === "DELETE") {
            reactions.splice(
              reactions.findIndex((candidate) => candidate.id === 41),
              1,
            );
            return new Response(null, { status: 204 });
          }
          throw new Error(`Unexpected request ${url}`);
        };
        const session = await new GitHubAppReviewGateway(
          fetchImplementation,
          "https://api.test",
          () => 1_000,
        ).authenticate(configuration.github, reference, new AbortController().signal);

        await assert.rejects(() =>
          session.addReaction(reference, reaction, new AbortController().signal),
        );
        await session.removeOwnReaction(reference, reaction, new AbortController().signal);

        assert.deepEqual(reactions, [{ id: 40, content: reaction, user: { login: "human" } }]);
        assert.equal(requests.filter((request) => request.url.endsWith("/reactions/40")).length, 0);
      }),
    );
  });

  it("validates every reaction page before deleting deduplicated bot reactions", async () => {
    const requests: string[] = [];
    const deleted: number[] = [];
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      content: index === 0 ? "+1" : "eyes",
      user: { login: index === 0 ? "revoir-test[bot]" : "human" },
    }));
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/issues/17/reactions?per_page=100&page=1")) {
        return json(pageOne);
      }
      if (url.endsWith("/issues/17/reactions?per_page=100&page=2")) {
        return json([
          { id: 1, content: "+1", user: { login: "revoir-test[bot]" } },
          { id: 101, content: "+1", user: { login: "REVOIR-TEST[BOT]" } },
          { id: 102, content: "+1", user: { login: "human" } },
        ]);
      }
      const reactionId = /\/reactions\/(\d+)$/u.exec(url)?.[1];
      if (reactionId !== undefined && init?.method === "DELETE") {
        deleted.push(Number(reactionId));
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);

    await session.removeOwnCompletionReaction(reference, new AbortController().signal);

    assert.deepEqual(
      deleted.toSorted((left, right) => left - right),
      [1, 101],
    );
    assert.equal(
      requests.some((url) => url.endsWith("/issues/17/reactions?per_page=100&page=2")),
      true,
    );
    assert.equal(
      requests.some((url) => url.endsWith("/reactions/102")),
      false,
    );
  });

  it("requests an empty page after exactly 100 reactions", async () => {
    const requestedPages: number[] = [];
    const fetchImplementation: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      const page = /reactions\?per_page=100&page=(\d+)$/u.exec(url)?.[1];
      if (page !== undefined) {
        requestedPages.push(Number(page));
        return json(
          page === "1"
            ? Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                content: "eyes",
                user: { login: "human" },
              }))
            : [],
        );
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);

    await session.removeOwnReaction(reference, "eyes", new AbortController().signal);

    assert.deepEqual(requestedPages, [1, 2]);
  });

  it("does not delete earlier reactions when a later page is malformed", async () => {
    const deleted: number[] = [];
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/issues/17/reactions?per_page=100&page=1")) {
        return json(
          Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            content: "+1",
            user: { login: "revoir-test[bot]" },
          })),
        );
      }
      if (url.endsWith("/issues/17/reactions?per_page=100&page=2")) {
        return json([{ id: "invalid", content: "+1", user: { login: "revoir-test[bot]" } }]);
      }
      if (init?.method === "DELETE") {
        deleted.push(Number(url.split("/").at(-1)));
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, new AbortController().signal);

    await assert.rejects(() =>
      session.removeOwnCompletionReaction(reference, new AbortController().signal),
    );

    assert.deepEqual(deleted, []);
  });

  it("bounds an endless sequence of full reaction pages by cancellation", async () => {
    const abortController = new AbortController();
    let pages = 0;
    const fetchImplementation: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.includes("/issues/17/reactions?")) {
        pages += 1;
        return json(
          Array.from({ length: 100 }, (_, index) => ({
            id: pages * 1_000 + index,
            content: "eyes",
            user: { login: "human" },
          })),
        );
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, abortController.signal);
    const reconciliation = session.removeOwnReaction(reference, "eyes", abortController.signal);
    setTimeout(() => {
      abortController.abort(new Error("stop pagination"));
    }, 5);

    await assert.rejects(
      Promise.race([
        reconciliation,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("pagination did not cancel")), 100);
        }),
      ]),
      /stop pagination/u,
    );
    assert.ok(pages > 0);
  });

  it("joins authentication fetch settlement after cancellation", async () => {
    const completions: Array<(response: Response) => void> = [];
    const abortController = new AbortController();
    const gateway = new GitHubAppReviewGateway(
      async () =>
        new Promise<Response>((resolve) => {
          completions.push(resolve);
        }),
      "https://api.test",
      () => 1_000,
    );
    const cancellation = new Error("cancel HTTP");
    const authentication = gateway.authenticate(
      configuration.github,
      reference,
      abortController.signal,
    );
    let settled = false;
    void authentication
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(completions.length, 2);
    abortController.abort(cancellation);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false);

    completions[0]?.(json({ slug: "revoir-test" }));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false);
    completions[1]?.(json({ token: "installation-secret" }));
    await assert.rejects(authentication, cancellation);
  });

  it("joins response body settlement after cancellation", async () => {
    let finishAppBody: ((value: unknown) => void) | undefined;
    let markBodyStarted: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    const appResponse = {
      ok: true,
      status: 200,
      json: async () => {
        markBodyStarted?.();
        return new Promise<unknown>((resolve) => {
          finishAppBody = resolve;
        });
      },
    } as Response;
    const gateway = new GitHubAppReviewGateway(
      async (input) =>
        String(input).endsWith("/app") ? appResponse : json({ token: "installation-secret" }),
      "https://api.test",
      () => 1_000,
    );
    const abortController = new AbortController();
    const cancellation = new Error("cancel response body");
    let settled = false;
    const authentication = gateway
      .authenticate(configuration.github, reference, abortController.signal)
      .finally(() => {
        settled = true;
      });
    void authentication.catch(() => {});
    await bodyStarted;

    abortController.abort(cancellation);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false);
    finishAppBody?.({ slug: "revoir-test" });
    await assert.rejects(authentication, cancellation);
  });

  it("joins every in-flight reaction deletion after cancellation", async () => {
    const deletionCompletions: Array<(response: Response) => void> = [];
    const fetchImplementation: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      if (url.endsWith("/app/installations/8/access_tokens")) {
        return json({ token: "installation-secret" });
      }
      if (url.endsWith("/issues/17/reactions?per_page=100&page=1")) {
        return json([
          { id: 71, content: "eyes", user: { login: "revoir-test[bot]" } },
          { id: 72, content: "eyes", user: { login: "revoir-test[bot]" } },
        ]);
      }
      if (init?.method === "DELETE") {
        return new Promise<Response>((resolve) => {
          deletionCompletions.push(resolve);
        });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const abortController = new AbortController();
    const session = await new GitHubAppReviewGateway(
      fetchImplementation,
      "https://api.test",
      () => 1_000,
    ).authenticate(configuration.github, reference, abortController.signal);
    let settled = false;
    const reconciliation = session
      .removeOwnReaction(reference, "eyes", abortController.signal)
      .finally(() => {
        settled = true;
      });
    void reconciliation.catch(() => {});
    while (deletionCompletions.length < 2) {
      // Wait only for both controlled deletes to begin.
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    const cancellation = new Error("cancel reaction deletes");
    abortController.abort(cancellation);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false);
    deletionCompletions[0]?.(new Response(null, { status: 204 }));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false);
    deletionCompletions[1]?.(new Response(null, { status: 204 }));
    await assert.rejects(reconciliation, (error: unknown) => {
      assert.match(String(error), /cancel reaction deletes/u);
      return true;
    });
  });

  it("rejects disallowed repositories before authentication", async () => {
    let calls = 0;
    const gateway = new GitHubAppReviewGateway(async () => {
      calls += 1;
      return json({});
    });
    await assert.rejects(
      () =>
        gateway.authenticate(
          configuration.github,
          parsePullRequestUrl("https://github.com/owner/other/pull/17"),
          new AbortController().signal,
        ),
      /allowlist/u,
    );
    assert.equal(calls, 0);
  });

  it("does not expose response bodies or credentials in authentication errors", async () => {
    const gateway = new GitHubAppReviewGateway(async (input) => {
      if (String(input).endsWith("/app")) {
        return json({ slug: "revoir-test" });
      }
      return json({ token: "server-secret" }, 403);
    });
    await assert.rejects(
      () => gateway.authenticate(configuration.github, reference, new AbortController().signal),
      (error: unknown) => {
        assert.match(String(error), /HTTP 403/u);
        assert.doesNotMatch(String(error), /server-secret|PRIVATE KEY/u);
        return true;
      },
    );
  });
});
