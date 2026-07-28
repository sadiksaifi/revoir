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

function signedRequest(body: string): Request {
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  return new Request("https://relay.example/github/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": "2f5f7475-33ee-4f91-9b68-0f8af72f6640",
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": `sha256=${signature}`,
    },
    body,
  });
}

function environment(messages: ReviewJobV1[]): RelayEnvironment {
  return {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_USER_ID: "42",
    GITHUB_REPOSITORIES: JSON.stringify([{ id: 99, owner: "owner", name: "repository" }]),
    REVIEW_QUEUE: {
      async send(body) {
        messages.push(parseReviewJob(body));
      },
    },
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
});
