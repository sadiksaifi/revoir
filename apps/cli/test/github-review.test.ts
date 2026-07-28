import assert from "node:assert/strict";
import { createPublicKey, createVerify } from "node:crypto";
import { describe, it } from "node:test";

import {
  createGitHubAppJwt,
  GitHubAppReviewGateway,
  type FetchLike,
} from "../src/review/github.js";
import { parsePullRequestUrl } from "../src/review/pull-request.js";
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
      if (url.endsWith("/issues/17/reactions?per_page=100")) {
        return json([
          {
            id: 31,
            content: "+1",
            user: { login: "revoir-test[bot]" },
          },
          { id: 32, content: "+1", user: { login: "human" } },
          { id: 34, content: "eyes", user: { login: "revoir-test[bot]" } },
          { id: 35, content: "eyes", user: { login: "human" } },
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
        url.endsWith("/reactions/34")
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
    assert.ok(requests.every((request) => request.init?.signal === abortController.signal));
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
          if (url.endsWith("/issues/17/reactions?per_page=100")) {
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

  it("cancels non-settling authentication requests", async () => {
    const abortController = new AbortController();
    const gateway = new GitHubAppReviewGateway(
      async () => new Promise<Response>(() => {}),
      "https://api.test",
      () => 1_000,
    );
    const cancellation = new Error("cancel HTTP");
    const authentication = gateway.authenticate(
      configuration.github,
      reference,
      abortController.signal,
    );
    abortController.abort(cancellation);

    await assert.rejects(
      Promise.race([
        authentication,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("authentication did not cancel")), 100);
        }),
      ]),
      cancellation,
    );
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
