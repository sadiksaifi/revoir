import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultDiagnosticGateway,
  diagnosticsPassed,
  runDiagnostics,
  type DiagnosticGateway,
  validateNodeRuntime,
} from "../src/diagnostics.js";
import { createTestConfiguration, passingGateway } from "./helpers.js";

const configuration = createTestConfiguration({
  cacheDir: "/cache",
  stateDir: "/state",
  dataDir: "/data",
});

describe("diagnostic contracts", () => {
  it("requires a compatible Node.js runtime", () => {
    assert.equal(validateNodeRuntime("24.16.0", "node"), "Node.js 24.16.0");
    assert.throws(() => validateNodeRuntime("23.11.0", "node"), /24 or newer/u);
    assert.throws(() => validateNodeRuntime("1.2.3", "bun"), /Node\.js runtime/u);
  });

  it("reports every required installation check", async () => {
    const results = await runDiagnostics(configuration, passingGateway());

    assert.equal(diagnosticsPassed(results), true);
    assert.deepEqual(
      results.map((result) => result.id),
      ["runtime", "git", "pi-auth", "github", "repositories", "cloudflare"],
    );
  });

  it("captures missing prerequisites without stopping other checks", async () => {
    const gateway: DiagnosticGateway = {
      ...passingGateway(),
      async checkGit() {
        throw new Error("git missing");
      },
      async checkPi() {
        throw new Error("Pi login missing");
      },
      async checkGitHub() {
        throw new Error("GitHub credentials invalid");
      },
      async checkCloudflare() {
        throw new Error("Cloudflare token invalid");
      },
    };

    const results = await runDiagnostics(configuration, gateway);

    assert.equal(diagnosticsPassed(results), false);
    assert.equal(results.filter((result) => result.status === "failed").length, 5);
    assert.match(
      results.find((result) => result.id === "repositories")?.detail ?? "",
      /Skipped because GitHub/u,
    );
  });

  it("validates GitHub App, immutable identities, repositories, and Cloudflare Queue over mocked HTTP", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string;
      body: string | undefined;
    }> = [];
    const gateway = createDefaultDiagnosticGateway(async (url, init) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: init?.headers?.Authorization ?? "",
        body: init?.body,
      });

      let body: unknown;
      if (url.endsWith("/app")) {
        body = { id: 7, slug: "revoir-test" };
      } else if (url.endsWith("/access_tokens")) {
        body = {
          token: "installation-secret",
          permissions: {
            metadata: "read",
            contents: "read",
            checks: "read",
            actions: "read",
            pull_requests: "write",
          },
        };
      } else if (url.endsWith("/user/42")) {
        body = { id: 42, login: "test-user" };
      } else if (url.endsWith("/repositories/99")) {
        body = { id: 99, full_name: "owner/repository" };
      } else if (url.endsWith("/queues/queue/consumers")) {
        body = {
          success: true,
          result: [
            {
              consumer_id: "consumer",
              queue_name: "review-jobs",
              type: "http_pull",
              settings: {
                batch_size: 1,
                max_retries: 3,
                visibility_timeout_ms: 1_200_000,
              },
            },
          ],
        };
      } else if (url.endsWith("/queues/queue/messages/ack")) {
        body = {
          success: true,
          result: { ackCount: 0, retryCount: 0, warnings: {} },
        };
      } else if (url.includes("api.cloudflare.com")) {
        body = {
          success: true,
          result: {
            queue_id: "queue",
            queue_name: "review-jobs",
            settings: { delivery_paused: false },
          },
        };
      } else {
        return {
          ok: false,
          status: 404,
          async json() {
            return {};
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return body;
        },
      };
    });

    assert.deepEqual(await gateway.checkGitHub(configuration.github), {
      app: "revoir-test, author test-user (42)",
      repositories: "owner/repository",
    });
    assert.equal(
      await gateway.checkCloudflare(configuration.cloudflare),
      "queue review-jobs, HTTP pull consumer consumer; token and pull acknowledgement access verified without leasing messages.",
    );
    assert.equal(requests.length, 7);
    assert.match(requests[0]?.authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/u);
    assert.equal(requests[1]?.method, "POST");
    assert.equal(requests[2]?.authorization, "Bearer installation-secret");
    assert.equal(requests[4]?.authorization, "Bearer cloudflare-secret-token");
    assert.equal(requests[5]?.authorization, "Bearer cloudflare-secret-token");
    assert.equal(requests[6]?.authorization, "Bearer cloudflare-secret-token");
    assert.equal(requests[6]?.method, "POST");
    assert.match(requests[6]?.url ?? "", /\/messages\/ack$/u);
    assert.deepEqual(JSON.parse(requests[6]?.body ?? ""), { acks: [], retries: [] });
  });

  it("reports every missing GitHub installation permission with an actionable fix", async () => {
    const requiredPermissions = {
      metadata: "read",
      contents: "read",
      checks: "read",
      actions: "read",
      pull_requests: "write",
    } as const;

    await Promise.all(
      Object.entries(requiredPermissions).map(async ([missingPermission, requiredGrant]) => {
        const permissions: Record<string, string> = { ...requiredPermissions };
        delete permissions[missingPermission];
        const gateway = createDefaultDiagnosticGateway(async (url) => {
          const body = url.endsWith("/app")
            ? { id: 7 }
            : url.endsWith("/access_tokens")
              ? { token: "installation-secret", permissions }
              : url.endsWith("/user/42")
                ? { id: 42 }
                : { id: 99, full_name: "owner/repository" };
          return {
            ok: true,
            status: 200,
            async json() {
              return body;
            },
          };
        });

        await assert.rejects(
          gateway.checkGitHub(configuration.github),
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes(missingPermission) &&
            error.message.includes(requiredGrant) &&
            error.message.includes("GitHub App settings"),
        );
      }),
    );
  });

  it("rejects mismatched immutable repository values", async () => {
    const gateway = createDefaultDiagnosticGateway(async (url) => {
      const body = url.endsWith("/app")
        ? { id: 7 }
        : url.endsWith("/access_tokens")
          ? {
              token: "installation-secret",
              permissions: {
                metadata: "read",
                contents: "read",
                checks: "read",
                actions: "read",
                pull_requests: "write",
              },
            }
          : url.endsWith("/user/42")
            ? { id: 42 }
            : { id: 99, full_name: "owner/different" };
      return {
        ok: true,
        status: 200,
        async json() {
          return body;
        },
      };
    });

    await assert.rejects(
      gateway.checkGitHub(configuration.github),
      /does not match configured repository/u,
    );
  });

  it("rejects a Cloudflare response without the configured queue identity", async () => {
    const gateway = createDefaultDiagnosticGateway(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          result: { queue_id: "different", queue_name: "review-jobs" },
        };
      },
    }));

    await assert.rejects(gateway.checkCloudflare(configuration.cloudflare), /different queue id/u);
  });

  it("requires an enabled HTTP pull consumer without leasing any messages", async () => {
    const requestedUrls: string[] = [];
    const gateway = createDefaultDiagnosticGateway(async (url) => {
      requestedUrls.push(url);
      const body = url.endsWith("/consumers")
        ? {
            success: true,
            result: [{ consumer_id: "worker-consumer", type: "worker" }],
          }
        : {
            success: true,
            result: {
              queue_id: "queue",
              queue_name: "review-jobs",
              settings: { delivery_paused: false },
            },
          };
      return {
        ok: true,
        status: 200,
        async json() {
          return body;
        },
      };
    });

    await assert.rejects(
      gateway.checkCloudflare(configuration.cloudflare),
      /no HTTP pull consumer.*Enable HTTP pull/u,
    );
    assert.equal(
      requestedUrls.some((url) => url.includes("/messages/")),
      false,
    );
  });

  it("rejects a Queues Read-only token that cannot acknowledge pull messages", async () => {
    const gateway = createDefaultDiagnosticGateway(async (url) => {
      if (url.endsWith("/messages/ack")) {
        return {
          ok: false,
          status: 403,
          async json() {
            return {
              success: false,
              errors: [{ code: 10000, message: "Authentication error" }],
            };
          },
        };
      }
      const body = url.endsWith("/consumers")
        ? {
            success: true,
            result: [{ consumer_id: "consumer", type: "http_pull" }],
          }
        : {
            success: true,
            result: {
              queue_id: "queue",
              queue_name: "review-jobs",
              settings: { delivery_paused: false },
            },
          };
      return {
        ok: true,
        status: 200,
        async json() {
          return body;
        },
      };
    });

    await assert.rejects(
      gateway.checkCloudflare(configuration.cloudflare),
      /Queues Read and Queues Write.*rerun diagnostics/u,
    );
  });

  it("rejects a paused Cloudflare Queue before inspecting consumers", async () => {
    const requestedUrls: string[] = [];
    const gateway = createDefaultDiagnosticGateway(async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            result: {
              queue_id: "queue",
              queue_name: "review-jobs",
              settings: { delivery_paused: true },
            },
          };
        },
      };
    });

    await assert.rejects(
      gateway.checkCloudflare(configuration.cloudflare),
      /delivery is paused.*Resume delivery/u,
    );
    assert.equal(requestedUrls.length, 1);
  });
});
