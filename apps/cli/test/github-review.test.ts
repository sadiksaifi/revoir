import assert from "node:assert/strict";
import { createPublicKey, createVerify } from "node:crypto";
import { describe, it } from "node:test";

import type { ReviewFindingV1 } from "../src/review/findings.js";
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
        url.endsWith("/reactions/31") ||
        url.endsWith("/reactions/33") ||
        url.endsWith("/reactions/34") ||
        url.endsWith("/reactions/36")
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
    assert.equal(requests.filter((request) => request.url.endsWith("/reactions/31")).length, 1);
    assert.equal(requests.filter((request) => request.url.endsWith("/reactions/32")).length, 0);
    assert.equal(requests.filter((request) => request.url.endsWith("/reactions/34")).length, 1);
    assert.equal(requests.filter((request) => request.url.endsWith("/reactions/35")).length, 0);
    assert.equal(requests.filter((request) => request.url.endsWith("/reactions/36")).length, 1);
    assert.equal(requests.filter((request) => request.url.endsWith("/reactions/37")).length, 0);
    assert.ok(requests.every((request) => request.init?.signal === abortController.signal));
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
    const candidate: ReviewFindingV1 = {
      version: 1,
      fingerprint: "a".repeat(64),
      priority: "P1",
      path: "source.ts",
      range: { start: 2, end: 2, side: "RIGHT" },
      defectKind: "concurrency",
      impactKind: "execution-stall",
      fixAction: "propagate",
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
      version: 1,
      fingerprint: ownThreadFingerprint,
      fingerprintAliases: ["9".repeat(64)],
      priority: "P1",
      path: markerShapedSource,
      range: null,
      defectKind: "correctness",
      impactKind: "incorrect-result",
      fixAction: "restore",
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
    const latestFinding: ReviewFindingV1 = {
      version: 1,
      fingerprint: latestFingerprint,
      priority: "P1",
      path: "source.ts",
      range: null,
      defectKind: "correctness",
      impactKind: "incorrect-result",
      fixAction: "restore",
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

  it("discovers full body snapshots across delta, retirement, and clean runs", async () => {
    const historicalFingerprint = "a".repeat(64);
    const latestFingerprint = "b".repeat(64);
    const fileFinding: ReviewFindingV1 = {
      version: 1,
      fingerprint: historicalFingerprint,
      priority: "P1",
      path: "source.ts",
      range: null,
      defectKind: "correctness",
      impactKind: "incorrect-result",
      fixAction: "restore",
      anchor: "source.ts",
      attachment: { kind: "file", path: "source.ts" },
    };
    const fallbackFinding: ReviewFindingV1 = {
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
    const latestFinding: ReviewFindingV1 = {
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
