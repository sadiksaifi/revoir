import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseReviewJob, type ReviewJobV1 } from "@revoir/contracts";

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
  const init: RequestInit = {
    method: options.method ?? "POST",
    headers,
  };
  if (options.method !== "GET") {
    init.body = body;
  }
  return new Request("https://relay.example/github/webhook", init);
}

function environment(
  messages: ReviewJobV1[],
  send: RelayEnvironment["REVIEW_QUEUE"]["send"] = async (body) => {
    messages.push(parseReviewJob(body));
  },
): RelayEnvironment {
  return {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_USER_ID: "42",
    GITHUB_REPOSITORIES: JSON.stringify([{ id: 99, owner: "owner", name: "repository" }]),
    REVIEW_QUEUE: { send },
  };
}

describe("GitHub webhook relay", () => {
  it("durably enqueues one versioned job for an eligible signed delivery", async () => {
    const messages: ReviewJobV1[] = [];
    const worker = createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z"));

    const response = await worker.fetch(signedRequest(await rawFixture()), environment(messages));

    assert.equal(response.status, 202);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], {
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
    });
  });

  it("verifies the signature over the untouched bytes before parsing", async () => {
    const messages: ReviewJobV1[] = [];
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
      assert.equal((await worker.fetch(request, environment(messages))).status, 401);
    }
    assert.deepEqual(messages, []);
  });

  it("accepts every supported action and ignores unsupported request shapes", async () => {
    const messages: ReviewJobV1[] = [];
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
      messages.map((message) => message.action),
      ["opened", "reopened", "ready_for_review", "synchronize"],
    );

    const ignored = [
      signedRequest(JSON.stringify({ ...payload, action: "closed" })),
      signedRequest(JSON.stringify(payload), { event: "push" }),
      signedRequest(JSON.stringify(payload), { deliveryId: null }),
      signedRequest(JSON.stringify(payload), { contentType: "text/plain" }),
      signedRequest(JSON.stringify(payload), { method: "GET" }),
      new Request("https://relay.example/other", { method: "POST" }),
    ];
    for (const request of ignored) {
      // Consume each single-use request against the same observed queue.
      // eslint-disable-next-line no-await-in-loop
      await worker.fetch(request, environment(messages));
    }
    assert.equal(messages.length, 4);
  });

  it("rejects every configured identity and repository policy violation", async () => {
    const worker = createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z"));
    const original = await fixture();
    const rejected = [
      { ...original, sender: { id: 43 } },
      {
        ...original,
        pull_request: { ...original.pull_request, user: { id: 43 } },
      },
      {
        ...original,
        pull_request: { ...original.pull_request, draft: true },
      },
      {
        ...original,
        pull_request: { ...original.pull_request, state: "closed" },
      },
      {
        ...original,
        repository: { ...original.repository, id: 100 },
      },
      {
        ...original,
        repository: { ...original.repository, full_name: "other/repository" },
      },
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
          head: {
            ...original.pull_request.head,
            repo: { id: 100, full_name: "fork/repository" },
          },
        },
      },
    ];

    for (const payload of rejected) {
      const messages: ReviewJobV1[] = [];
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
    const messages: ReviewJobV1[] = [];
    const worker = createWebhookRelay(() => new Date("2026-07-29T00:00:00.000Z"));
    let release!: () => void;
    const published = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const response = worker
      .fetch(
        signedRequest(await rawFixture()),
        environment(messages, async (body) => {
          messages.push(parseReviewJob(body));
          await published;
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
          environment(messages, async () => {
            throw new Error("queue unavailable");
          }),
        )
      ).status,
      503,
    );
  });
});
