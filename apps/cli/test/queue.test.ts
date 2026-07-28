import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseReviewJob } from "@revoir/contracts";

import { CloudflareQueueClient } from "../src/queue/client.js";

function reviewJob() {
  return {
    version: 1,
    deliveryId: "2f5f7475-33ee-4f91-9b68-0f8af72f6640",
    installationId: 8,
    repository: { id: 99, owner: "owner", name: "repository" },
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
  };
}

describe("Cloudflare Queue pull client", () => {
  it("authenticates empty pulls, decodes one JSON job, and acknowledges its lease", async () => {
    const requests: Request[] = [];
    const responses = [
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { message_backlog_count: 0, messages: [] },
        }),
      ),
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: {
            message_backlog_count: 0,
            messages: [
              {
                body: Buffer.from(JSON.stringify(reviewJob())).toString("base64"),
                id: "message-1",
                timestamp_ms: 1_753_747_200_000,
                attempts: 1,
                metadata: { "CF-Content-Type": "json" },
                lease_id: "lease-1",
              },
            ],
          },
        }),
      ),
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result: {} })),
    ];
    const client = new CloudflareQueueClient(
      {
        accountId: "account-id",
        queueId: "queue-id",
        apiToken: "queue-token",
      },
      1_200_000,
      async (input, init) => {
        requests.push(new Request(input, init));
        return responses.shift()!;
      },
    );

    assert.equal(await client.pullOne(), undefined);
    const delivery = await client.pullOne();
    assert.ok(delivery !== undefined);
    assert.equal(delivery.leaseId, "lease-1");
    assert.deepEqual(parseReviewJob(delivery.body), reviewJob());
    await client.acknowledge(delivery.leaseId);

    assert.deepEqual(
      requests.map((request) => new URL(request.url).pathname),
      [
        "/client/v4/accounts/account-id/queues/queue-id/messages/pull",
        "/client/v4/accounts/account-id/queues/queue-id/messages/pull",
        "/client/v4/accounts/account-id/queues/queue-id/messages/ack",
      ],
    );
    for (const request of requests) {
      assert.equal(request.headers.get("Authorization"), "Bearer queue-token");
      assert.equal(request.headers.get("Content-Type"), "application/json");
    }
    assert.deepEqual(await requests[0]!.json(), {
      visibility_timeout_ms: 1_260_000,
      batch_size: 1,
    });
    assert.deepEqual(await requests[2]!.json(), {
      acks: [{ lease_id: "lease-1" }],
      retries: [],
    });
  });

  it("preserves a malformed job lease so the consumer can settle it", async () => {
    const requests: Request[] = [];
    const client = new CloudflareQueueClient(
      {
        accountId: "account-id",
        queueId: "queue-id",
        apiToken: "queue-token",
      },
      1_200_000,
      async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(
          JSON.stringify({
            success: true,
            result:
              requests.length === 1
                ? {
                    messages: [
                      {
                        body: "not-base64",
                        metadata: { "CF-Content-Type": "json" },
                        lease_id: "lease-2",
                      },
                    ],
                  }
                : {},
          }),
        );
      },
    );

    assert.deepEqual(await client.pullOne(), {
      leaseId: "lease-2",
      body: undefined,
    });
    await client.retry("lease-2");
    assert.deepEqual(await requests[1]!.json(), {
      acks: [],
      retries: [{ lease_id: "lease-2" }],
    });
  });

  it("rejects unsuccessful and structurally invalid Cloudflare responses", async () => {
    const configuration = {
      accountId: "account-id",
      queueId: "queue-id",
      apiToken: "queue-token",
    };
    const rejected = new CloudflareQueueClient(
      configuration,
      1_200_000,
      async () => new Response(JSON.stringify({ success: false, result: {} })),
    );
    const invalid = new CloudflareQueueClient(
      configuration,
      1_200_000,
      async () =>
        new Response(JSON.stringify({ success: true, result: { messages: [{ body: "e30=" }] } })),
    );

    await assert.rejects(() => rejected.pullOne(), /request was rejected/u);
    await assert.rejects(() => invalid.pullOne(), /without a lease identifier/u);
  });
});
