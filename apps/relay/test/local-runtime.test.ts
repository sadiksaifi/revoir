import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseReviewQueueJob } from "@revoir/contracts";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const WEBHOOK_SECRET = "local-runtime-webhook-secret";

async function waitForQueuedJobs(namespace: {
  get(key: string, type: "json"): Promise<unknown>;
}): Promise<unknown[]> {
  const expiresAt = Date.now() + 2_000;
  for (;;) {
    // Poll only the test-owned local Queue sink.
    // eslint-disable-next-line no-await-in-loop
    const value = await namespace.get("jobs", "json");
    if (Array.isArray(value)) {
      return value;
    }
    if (Date.now() >= expiresAt) {
      throw new Error("Local Queue consumer did not receive the webhook job.");
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("Cloudflare local runtime", () => {
  for (const scenario of [
    { event: "pull_request", expectedVersion: 1 },
    { event: "issue_comment", expectedVersion: 2 },
  ] as const) {
    it(`moves one eligible ${scenario.event} webhook through a real Queue binding`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "revoir-relay-"));
      const bundle = join(directory, "relay.mjs");
      await build({
        bundle: true,
        entryPoints: [join(import.meta.dirname, "../src/index.ts")],
        format: "esm",
        outfile: bundle,
        platform: "browser",
        target: "es2024",
      });
      const miniflare = new Miniflare({
        workers: [
          {
            name: "relay",
            modules: true,
            modulesRoot: directory,
            scriptPath: bundle,
            compatibilityDate: "2026-07-22",
            bindings: {
              GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
              GITHUB_USER_ID: "42",
              GITHUB_REPOSITORIES: JSON.stringify([{ id: 99, owner: "owner", name: "repository" }]),
            },
            queueProducers: {
              REVIEW_QUEUE: { queueName: "revoir-review-jobs" },
            },
          },
          {
            name: "queue-sink",
            modules: true,
            script: `
            export default {
              async queue(batch, env) {
                await env.MESSAGES.put(
                  "jobs",
                  JSON.stringify(batch.messages.map((message) => message.body)),
                );
              },
            };
          `,
            compatibilityDate: "2026-07-22",
            kvNamespaces: { MESSAGES: "revoir-local-runtime-messages" },
            queueConsumers: {
              "revoir-review-jobs": { maxBatchSize: 1, maxBatchTimeout: 0.05 },
            },
          },
        ],
      });

      try {
        const pullRequestBody = await readFile(
          join(import.meta.dirname, "fixtures/pull-request.synchronize.json"),
          "utf8",
        );
        const pullRequest = JSON.parse(pullRequestBody) as Record<string, unknown>;
        const body =
          scenario.event === "pull_request"
            ? pullRequestBody
            : JSON.stringify({
                action: "created",
                installation: pullRequest["installation"],
                repository: pullRequest["repository"],
                sender: { id: 42 },
                issue: {
                  number: 17,
                  pull_request: {
                    url: "https://api.github.com/repos/owner/repository/pulls/17",
                  },
                },
                comment: {
                  id: 123456789,
                  body: "@revoirapp review",
                  user: { id: 42 },
                },
              });
        const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
        const response = await miniflare.dispatchFetch("https://relay.example/github/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-GitHub-Delivery": "2f5f7475-33ee-4f91-9b68-0f8af72f6640",
            "X-GitHub-Event": scenario.event,
            "X-Hub-Signature-256": `sha256=${signature}`,
          },
          body,
        });
        assert.equal(response.status, 202);

        const namespace = (await miniflare.getKVNamespace("MESSAGES", "queue-sink")) as unknown as {
          get(key: string, type: "json"): Promise<unknown>;
        };
        const jobs = await waitForQueuedJobs(namespace);
        assert.equal(jobs.length, 1);
        const job = parseReviewQueueJob(jobs[0]);
        assert.equal(job.deliveryId, "2f5f7475-33ee-4f91-9b68-0f8af72f6640");
        assert.equal(job.version, scenario.expectedVersion);
      } finally {
        await miniflare.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
