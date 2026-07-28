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
    }> = [];
    const gateway = createDefaultDiagnosticGateway(async (url, init) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: init?.headers?.Authorization ?? "",
      });

      let body: unknown;
      if (url.endsWith("/app")) {
        body = { id: 7, slug: "revoir-test" };
      } else if (url.endsWith("/access_tokens")) {
        body = { token: "installation-secret" };
      } else if (url.endsWith("/user/42")) {
        body = { id: 42, login: "test-user" };
      } else if (url.endsWith("/repositories/99")) {
        body = { id: 99, full_name: "owner/repository" };
      } else if (url.includes("api.cloudflare.com")) {
        body = {
          success: true,
          result: { queue_id: "queue", queue_name: "review-jobs" },
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
    assert.equal(await gateway.checkCloudflare(configuration.cloudflare), "queue review-jobs");
    assert.equal(requests.length, 5);
    assert.match(requests[0]?.authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/u);
    assert.equal(requests[1]?.method, "POST");
    assert.equal(requests[2]?.authorization, "Bearer installation-secret");
    assert.equal(requests[4]?.authorization, "Bearer cloudflare-secret-token");
  });

  it("rejects mismatched immutable repository values", async () => {
    const gateway = createDefaultDiagnosticGateway(async (url) => {
      const body = url.endsWith("/app")
        ? { id: 7 }
        : url.endsWith("/access_tokens")
          ? { token: "installation-secret" }
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
});
