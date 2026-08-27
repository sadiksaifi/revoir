import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseReviewQueueJob, type ReviewQueueJob } from "@revoir/contracts";

import { createWebhookRelay, type RelayEnvironment } from "../src/index.js";

const WEBHOOK_SECRET = "relay-webhook-secret";

async function rawFixture(): Promise<string> {
  return readFile(join(import.meta.dirname, "fixtures/pull-request.synchronize.json"), "utf8");
}

interface WebhookFixture {
  action: string;
  number: number;
  installation: { id: number };
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: { login: string };
  };
  pull_request: {
    number: number;
    state: string;
    draft: boolean;
    user: { id: number };
    base: { sha: string; repo: { id: number; full_name: string } };
    head: { sha: string; repo: { id: number; full_name: string } };
  };
  sender: { id: number };
}

async function fixture(): Promise<WebhookFixture> {
  return JSON.parse(await rawFixture()) as WebhookFixture;
}

function signedRequest(
  body: string,
  options: {
    deliveryId?: string | null;
    event?: string;
    method?: string;
    signatureBody?: string;
    signatureHeader?: string | null;
    contentType?: string;
    path?: string;
  } = {},
): Request {
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(options.signatureBody ?? body)
    .digest("hex");
  const headers = new Headers({
    "Content-Type": options.contentType ?? "application/json",
    "X-GitHub-Event": options.event ?? "pull_request",
  });
  const deliveryId =
    options.deliveryId === undefined ? "2f5f7475-33ee-4f91-9b68-0f8af72f6640" : options.deliveryId;
  if (deliveryId !== null) {
    headers.set("X-GitHub-Delivery", deliveryId);
  }
  const signatureHeader =
    options.signatureHeader === undefined ? `sha256=${signature}` : options.signatureHeader;
  if (signatureHeader !== null) {
    headers.set("X-Hub-Signature-256", signatureHeader);
  }
  const init: RequestInit = { method: options.method ?? "POST", headers };
  if (options.method !== "GET") {
    init.body = body;
  }
  return new Request(`https://relay.example${options.path ?? "/github/webhook"}`, init);
}

function policy(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    revision: 1,
    userId: 42,
    installations: [
      {
        id: 8,
        repositories: [{ id: 99, owner: "owner", name: "repository" }],
      },
    ],
    ...overrides,
  });
}

function environment(
  messages: ReviewQueueJob[],
  options: {
    policy?: string | null;
    readPolicy?: RelayEnvironment["POLICY_KV"]["get"];
    send?: RelayEnvironment["REVIEW_QUEUE"]["send"];
  } = {},
): RelayEnvironment {
  return {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    POLICY_KV: {
      get: options.readPolicy ?? (async () => options.policy ?? policy()),
    },
    REVIEW_QUEUE: {
      send:
        options.send ??
        (async (body) => {
          messages.push(parseReviewQueueJob(body));
        }),
    },
  };
}

async function issueCommentPayload(overrides: Record<string, unknown> = {}) {
  const pullRequest = await fixture();
  return {
    action: "created",
    installation: pullRequest.installation,
    repository: pullRequest.repository,
    sender: { id: 42 },
    issue: {
      number: pullRequest.number,
      pull_request: { url: "https://api.github.com/repos/owner/repository/pulls/17" },
    },
    comment: {
      id: 123456789,
      body: "@revoirapp review",
      user: { id: 42 },
    },
    ...overrides,
  };
}

describe("GitHub webhook relay", () => {
  it("durably enqueues one unified automatic job for an eligible signed delivery", async () => {
    const messages: ReviewQueueJob[] = [];
    const worker = createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z"));

    const response = await worker.fetch(signedRequest(await rawFixture()), environment(messages));

    assert.equal(response.status, 202);
    assert.deepEqual(messages, [
      {
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
      },
    ]);
  });

  it("enqueues an authorized requested trigger using the same queue contract", async () => {
    const messages: ReviewQueueJob[] = [];
    const worker = createWebhookRelay(() => new Date("2026-08-05T00:00:00.000Z"));
    const body = JSON.stringify(await issueCommentPayload());

    const response = await worker.fetch(
      signedRequest(body, {
        deliveryId: "6e38fcec-d555-474e-8fd2-34620349aa12",
        event: "issue_comment",
      }),
      environment(messages),
    );

    assert.equal(response.status, 202);
    assert.deepEqual(messages, [
      {
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
      },
    ]);
  });

  it("verifies the signature over untouched bytes before policy reads or JSON parsing", async () => {
    const messages: ReviewQueueJob[] = [];
    let policyReads = 0;
    const worker = createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z"));
    const raw = await rawFixture();
    const cases = [
      signedRequest(raw, { signatureHeader: null }),
      signedRequest(raw, { signatureHeader: "sha256=malformed" }),
      signedRequest(raw, { signatureHeader: `sha256=${"0".repeat(64)}` }),
      signedRequest(`${raw}\n`, { signatureBody: raw }),
      signedRequest("{ definitely not json", { signatureHeader: `sha256=${"0".repeat(64)}` }),
    ];

    for (const request of cases) {
      // Keep each single-use request and its assertion together.
      // eslint-disable-next-line no-await-in-loop
      const response = await worker.fetch(
        request,
        environment(messages, {
          readPolicy: async () => {
            policyReads += 1;
            return policy();
          },
        }),
      );
      assert.equal(response.status, 401);
    }
    assert.equal(policyReads, 0);
    assert.deepEqual(messages, []);
  });

  it("reads and validates the KV policy for every eligible delivery", async () => {
    const worker = createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z"));
    const body = await rawFixture();
    let policyReads = 0;
    const messages: ReviewQueueJob[] = [];
    const env = environment(messages, {
      readPolicy: async (key) => {
        assert.equal(key, "policy");
        policyReads += 1;
        return policy({ revision: policyReads });
      },
    });

    assert.equal((await worker.fetch(signedRequest(body), env)).status, 202);
    assert.equal((await worker.fetch(signedRequest(body), env)).status, 202);
    assert.equal(policyReads, 2);
    assert.equal(messages.length, 2);
  });

  it("fails closed when the KV policy is missing, invalid, or unavailable", async () => {
    const worker = createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z"));
    const body = await rawFixture();
    const cases: RelayEnvironment["POLICY_KV"]["get"][] = [
      async () => null,
      async () => "not json",
      async () => JSON.stringify({ version: 2 }),
      async () => {
        throw new Error("KV unavailable");
      },
    ];

    for (const readPolicy of cases) {
      const messages: ReviewQueueJob[] = [];
      // Exercise one independent fail-closed policy read.
      // eslint-disable-next-line no-await-in-loop
      const response = await worker.fetch(
        signedRequest(body),
        environment(messages, { readPolicy }),
      );
      assert.equal(response.status, 503);
      assert.deepEqual(messages, []);
    }
  });

  it("keeps a valid empty policy inert and healthy", async () => {
    const messages: ReviewQueueJob[] = [];
    const worker = createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z"));
    const response = await worker.fetch(
      signedRequest(await rawFixture()),
      environment(messages, { policy: policy({ installations: [] }) }),
    );
    assert.equal(response.status, 202);
    assert.deepEqual(messages, []);
  });

  it("accepts every automatic action and ignores unsupported request shapes", async () => {
    const messages: ReviewQueueJob[] = [];
    const worker = createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z"));
    const payload = await fixture();
    for (const action of ["opened", "reopened", "ready_for_review", "synchronize"]) {
      // Preserve action enqueue order in the shared fixture queue.
      // eslint-disable-next-line no-await-in-loop
      const response = await worker.fetch(
        signedRequest(JSON.stringify({ ...payload, action })),
        environment(messages),
      );
      assert.equal(response.status, 202);
    }
    assert.deepEqual(
      messages.map((message) =>
        message.trigger.kind === "automatic" ? message.trigger.action : undefined,
      ),
      ["opened", "reopened", "ready_for_review", "synchronize"],
    );

    const ignored = [
      signedRequest(JSON.stringify({ ...payload, action: "closed" })),
      signedRequest(JSON.stringify(payload), { event: "push" }),
      signedRequest(JSON.stringify(payload), { deliveryId: null }),
      signedRequest(JSON.stringify(payload), { contentType: "text/plain" }),
      signedRequest(JSON.stringify(payload), { method: "GET" }),
      signedRequest(JSON.stringify(payload), { path: "/other" }),
    ];
    for (const request of ignored) {
      // Consume each single-use request against the same observed queue.
      // eslint-disable-next-line no-await-in-loop
      await worker.fetch(request, environment(messages));
    }
    assert.equal(messages.length, 4);
  });

  it("ignores requested triggers that are not exact, authorized, created PR commands", async () => {
    const worker = createWebhookRelay(() => new Date("2026-08-05T00:00:00.000Z"));
    const original = await issueCommentPayload();
    const cases = [
      { ...original, action: "edited" },
      { ...original, issue: { number: 17 } },
      { ...original, sender: { id: 43 } },
      { ...original, comment: { ...original.comment, user: { id: 43 } } },
      { ...original, comment: { ...original.comment, body: "@revoirapp review this" } },
      { ...original, comment: { ...original.comment, body: "please @revoirapp review" } },
      { ...original, comment: { ...original.comment, body: "@otherapp review" } },
      { ...original, comment: { ...original.comment, id: 0 } },
    ];

    for (const payload of cases) {
      const messages: ReviewQueueJob[] = [];
      // Validate one ignored command shape per isolated queue.
      // eslint-disable-next-line no-await-in-loop
      const response = await worker.fetch(
        signedRequest(JSON.stringify(payload), { event: "issue_comment" }),
        environment(messages),
      );
      assert.equal(response.status, 202);
      assert.deepEqual(messages, []);
    }
  });

  it("rejects identity, installation, repository, draft, state, and fork violations", async () => {
    const worker = createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z"));
    const original = await fixture();
    const rejected = [
      { ...original, installation: { id: 9 } },
      { ...original, sender: { id: 43 } },
      { ...original, pull_request: { ...original.pull_request, user: { id: 43 } } },
      { ...original, pull_request: { ...original.pull_request, draft: true } },
      { ...original, pull_request: { ...original.pull_request, state: "closed" } },
      { ...original, repository: { ...original.repository, id: 100 } },
      { ...original, repository: { ...original.repository, full_name: "other/repository" } },
      {
        ...original,
        pull_request: {
          ...original.pull_request,
          base: {
            ...original.pull_request.base,
            repo: { ...original.pull_request.base.repo, id: 100 },
          },
        },
      },
      {
        ...original,
        pull_request: {
          ...original.pull_request,
          head: { ...original.pull_request.head, repo: { id: 100, full_name: "fork/repository" } },
        },
      },
    ];

    for (const payload of rejected) {
      const messages: ReviewQueueJob[] = [];
      // Isolate one policy violation per request and queue.
      // eslint-disable-next-line no-await-in-loop
      const response = await worker.fetch(
        signedRequest(JSON.stringify(payload)),
        environment(messages),
      );
      assert.equal(response.status, 202);
      assert.deepEqual(messages, []);
    }
  });

  it("acknowledges an eligible delivery only after durable publication", async () => {
    const messages: ReviewQueueJob[] = [];
    const worker = createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z"));
    let release!: () => void;
    const published = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const response = worker
      .fetch(
        signedRequest(await rawFixture()),
        environment(messages, {
          send: async (body) => {
            messages.push(parseReviewQueueJob(body));
            await published;
          },
        }),
      )
      .then((value) => {
        settled = true;
        return value;
      });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false);
    release();
    assert.equal((await response).status, 202);

    assert.equal(
      (
        await worker.fetch(
          signedRequest(await rawFixture()),
          environment(messages, {
            send: async () => {
              throw new Error("queue unavailable");
            },
          }),
        )
      ).status,
      503,
    );
  });
});
