import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultDiagnosticGateway,
  repositoryAuthorizationDiagnostic,
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
    const results = await runDiagnostics(configuration, configuration.policy, passingGateway());

    assert.equal(diagnosticsPassed(results), true);
    assert.deepEqual(
      results.map((result) => result.id),
      ["runtime", "git", "pi-auth", "github", "repositories", "cloudflare", "relay", "policy"],
    );
  });

  it("passes the configured shell deadline to remote GitHub and Cloudflare diagnostics", async () => {
    const deadlines: number[] = [];
    const gateway: DiagnosticGateway = {
      ...passingGateway(),
      async checkGitHub(_github, _policy, timeoutMs) {
        deadlines.push(timeoutMs ?? -1);
        return { app: "app", repositories: "" };
      },
      async checkCloudflare(_cloudflare, timeoutMs) {
        deadlines.push(timeoutMs ?? -1);
        return "queue";
      },
    };

    await runDiagnostics(configuration, configuration.policy, gateway);

    assert.deepEqual(deadlines, [
      configuration.timeouts.shellCommandMs,
      configuration.timeouts.shellCommandMs,
    ]);
  });

  it("aborts stalled GitHub and Cloudflare diagnostic requests at the shell deadline", async () => {
    const operations = [
      (gateway: DiagnosticGateway) =>
        gateway.checkGitHub(configuration.github, configuration.policy, 5),
      (gateway: DiagnosticGateway) => gateway.checkCloudflare(configuration.cloudflare, 5),
    ];

    for (const operation of operations) {
      let aborted = false;
      const gateway = createDefaultDiagnosticGateway(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(init.signal?.reason);
              },
              { once: true },
            );
          }),
      );

      // Each iteration owns an isolated fake transport and timeout.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        Promise.race([
          operation(gateway),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("diagnostic request ignored its deadline")), 100);
          }),
        ]),
        (error) => error instanceof DOMException && error.name === "TimeoutError",
      );
      assert.equal(aborted, true);
    }
  });

  it("includes the LaunchAgent health boundary when the caller supplies it", async () => {
    const results = await runDiagnostics(
      configuration,
      configuration.policy,
      passingGateway(),
      undefined,
      async () => "LaunchAgent is healthy with process 42.",
    );

    assert.deepEqual(results.at(-1), {
      id: "service",
      label: "macOS service",
      status: "passed",
      detail: "LaunchAgent is healthy with process 42.",
    });
  });

  it("distinguishes every repository authorization state", () => {
    const entries = ["authorized", "pending", "drifted", "inaccessible", "github-access-only"].map(
      (status, index) => ({
        repository: { id: index + 1, owner: "owner", name: `repository-${status}` },
        installationId: 8,
        status: status as
          | "authorized"
          | "pending"
          | "drifted"
          | "inaccessible"
          | "github-access-only",
        local: status === "authorized",
        cloud: status === "authorized",
        github: status === "authorized" || status === "github-access-only",
      }),
    );

    const result = repositoryAuthorizationDiagnostic(entries);

    assert.equal(result.status, "failed");
    for (const status of [
      "authorized",
      "pending",
      "drifted",
      "inaccessible",
      "github-access-only",
    ]) {
      assert.match(result.detail, new RegExp(`${status}:`, "u"));
    }
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

    const results = await runDiagnostics(configuration, configuration.policy, gateway);

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
      event: string;
      signature: string;
      body: string | undefined;
    }> = [];
    const gateway = createDefaultDiagnosticGateway(async (url, init) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: init?.headers?.Authorization ?? "",
        event: init?.headers?.["X-GitHub-Event"] ?? "",
        signature: init?.headers?.["X-Hub-Signature-256"] ?? "",
        body: init?.body,
      });

      let body: unknown;
      if (url.endsWith("/app")) {
        body = {
          id: 7,
          slug: "revoir-test",
          events: ["pull_request", "issue_comment"],
        };
      } else if (url.endsWith("/access_tokens")) {
        body = {
          token: "installation-secret",
          permissions: {
            metadata: "read",
            contents: "read",
            checks: "write",
            actions: "read",
            issues: "write",
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
      } else if (url === configuration.cloudflare.relayUrl) {
        return {
          ok: true,
          status: 202,
          async json() {
            return {};
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

    assert.deepEqual(await gateway.checkGitHub(configuration.github, configuration.policy), {
      app: "revoir-test, author test-user (42)",
      repositories: "owner/repository (installation 8)",
    });
    assert.equal(
      await gateway.checkCloudflare(configuration.cloudflare),
      "queue review-jobs, HTTP pull consumer consumer; token and pull acknowledgement access verified without leasing messages.",
    );
    assert.match(
      await gateway.checkRelay(
        configuration.cloudflare.relayUrl,
        configuration.github.webhookSecret,
        configuration.timeouts.shellCommandMs,
      ),
      /relay signature and policy path/u,
    );
    assert.equal(requests.length, 8);
    assert.match(requests[0]?.authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/u);
    assert.equal(requests[1]?.method, "POST");
    assert.equal(requests[2]?.authorization, "Bearer installation-secret");
    assert.equal(requests[4]?.authorization, "Bearer cloudflare-secret-token");
    assert.equal(requests[5]?.authorization, "Bearer cloudflare-secret-token");
    assert.equal(requests[6]?.authorization, "Bearer cloudflare-secret-token");
    assert.equal(requests[6]?.method, "POST");
    assert.match(requests[6]?.url ?? "", /\/messages\/ack$/u);
    assert.deepEqual(JSON.parse(requests[6]?.body ?? ""), { acks: [], retries: [] });
    assert.equal(requests[7]?.url, configuration.cloudflare.relayUrl);
    assert.equal(requests[7]?.method, "POST");
    assert.equal(requests[7]?.event, "pull_request");
    assert.match(requests[7]?.signature ?? "", /^sha256=[0-9a-f]{64}$/u);
    assert.equal(requests[7]?.body, "{}");
  });

  it("aborts a stalled relay diagnostic at the configured shell deadline", async () => {
    let relayAborted = false;
    const gateway = createDefaultDiagnosticGateway(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              relayAborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );

    await assert.rejects(
      Promise.race([
        gateway.checkRelay(
          configuration.cloudflare.relayUrl,
          configuration.github.webhookSecret,
          5,
        ),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("relay diagnostic ignored its deadline")), 100);
        }),
      ]),
      (error) => error instanceof DOMException && error.name === "TimeoutError",
    );
    assert.equal(relayAborted, true);
  });

  it("validates every installation with its own token and repository allowlist", async () => {
    const repositoryAuthorizations = new Map<string, string>();
    const requestedInstallations: string[] = [];
    const github = configuration.github;
    const policy = {
      ...configuration.policy,
      installations: [
        ...configuration.policy.installations,
        {
          id: 9,
          repositories: [{ id: 100, owner: "other", name: "second" }],
        },
      ],
    };
    const gateway = createDefaultDiagnosticGateway(async (url, init) => {
      let body: unknown;
      if (url.endsWith("/app")) {
        body = {
          id: 7,
          slug: "revoir-test",
          events: ["pull_request", "issue_comment"],
        };
      } else if (url.includes("/app/installations/")) {
        const installationId = /installations\/(?<id>\d+)/u.exec(url)?.groups?.id ?? "";
        requestedInstallations.push(installationId);
        body = {
          token: `installation-${installationId}-secret`,
          permissions: {
            metadata: "read",
            contents: "read",
            checks: "write",
            actions: "read",
            issues: "write",
            pull_requests: "write",
          },
        };
      } else if (url.endsWith("/user/42")) {
        body = { id: 42, login: "test-user" };
      } else if (url.endsWith("/repositories/99")) {
        repositoryAuthorizations.set("99", init?.headers?.Authorization ?? "");
        body = { id: 99, full_name: "owner/repository" };
      } else {
        repositoryAuthorizations.set("100", init?.headers?.Authorization ?? "");
        body = { id: 100, full_name: "other/second" };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return body;
        },
      };
    });

    assert.deepEqual(await gateway.checkGitHub(github, policy), {
      app: "revoir-test, author test-user (42)",
      repositories: "owner/repository (installation 8), other/second (installation 9)",
    });
    assert.deepEqual(requestedInstallations.toSorted(), ["8", "9"]);
    assert.equal(repositoryAuthorizations.get("99"), "Bearer installation-8-secret");
    assert.equal(repositoryAuthorizations.get("100"), "Bearer installation-9-secret");
  });

  it("requires the pull-request and issue-comment webhook subscriptions", async () => {
    const gateway = createDefaultDiagnosticGateway(async (url) => {
      const body = url.endsWith("/app")
        ? { id: 7, events: ["pull_request"] }
        : url.endsWith("/access_tokens")
          ? {
              token: "installation-secret",
              permissions: {
                metadata: "read",
                contents: "read",
                checks: "write",
                actions: "read",
                issues: "write",
                pull_requests: "write",
              },
            }
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
      gateway.checkGitHub(configuration.github, configuration.policy),
      /missing issue_comment.*Issue comment events/u,
    );
  });

  it("reports every missing GitHub installation permission with an actionable fix", async () => {
    const requiredPermissions = {
      metadata: "read",
      contents: "read",
      checks: "write",
      actions: "read",
      issues: "write",
      pull_requests: "write",
    } as const;

    await Promise.all(
      Object.entries(requiredPermissions).map(async ([missingPermission, requiredGrant]) => {
        const permissions: Record<string, string> = { ...requiredPermissions };
        delete permissions[missingPermission];
        const gateway = createDefaultDiagnosticGateway(async (url) => {
          const body = url.endsWith("/app")
            ? { id: 7, events: ["pull_request", "issue_comment"] }
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
          gateway.checkGitHub(configuration.github, configuration.policy),
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes(missingPermission) &&
            error.message.includes(requiredGrant) &&
            error.message.includes("GitHub App settings"),
        );
      }),
    );
  });

  it("rejects read-only Checks access now that review checks are published", async () => {
    const gateway = createDefaultDiagnosticGateway(async (url) => {
      const body = url.endsWith("/app")
        ? { id: 7, events: ["pull_request", "issue_comment"] }
        : url.endsWith("/access_tokens")
          ? {
              token: "installation-secret",
              permissions: {
                metadata: "read",
                contents: "read",
                checks: "read",
                actions: "read",
                issues: "write",
                pull_requests: "write",
              },
            }
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
      gateway.checkGitHub(configuration.github, configuration.policy),
      /checks must be "write" \(found "read"\)/u,
    );
  });

  it("rejects read-only Issues access because review reactions require writes", async () => {
    const gateway = createDefaultDiagnosticGateway(async (url) => {
      const body = url.endsWith("/app")
        ? { id: 7, events: ["pull_request", "issue_comment"] }
        : url.endsWith("/access_tokens")
          ? {
              token: "installation-secret",
              permissions: {
                metadata: "read",
                contents: "read",
                checks: "write",
                actions: "read",
                issues: "read",
                pull_requests: "write",
              },
            }
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
      gateway.checkGitHub(configuration.github, configuration.policy),
      /issues must be "write" \(found "read"\)/u,
    );
  });

  it("rejects mismatched immutable repository values", async () => {
    const gateway = createDefaultDiagnosticGateway(async (url) => {
      const body = url.endsWith("/app")
        ? { id: 7, events: ["pull_request", "issue_comment"] }
        : url.endsWith("/access_tokens")
          ? {
              token: "installation-secret",
              permissions: {
                metadata: "read",
                contents: "read",
                checks: "write",
                actions: "read",
                issues: "write",
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
      gateway.checkGitHub(configuration.github, configuration.policy),
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
