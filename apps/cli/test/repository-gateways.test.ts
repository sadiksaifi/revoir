import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEmptyPolicy, withRepository } from "../src/config/policy.js";
import {
  GitHubRepositoryGateway,
  LocalAndWranglerPolicyStore,
} from "../src/repository-gateways.js";
import type { SetupProcessRunner } from "../src/setup/platform.js";
import { createTestConfiguration } from "./helpers.js";

const configuration = createTestConfiguration({
  cacheDir: "/cache",
  stateDir: "/state",
  dataDir: "/data",
});

function installations(count: number, offset = 0) {
  return Array.from({ length: count }, (_value, index) => ({
    id: offset + index + 1,
    account: { login: `other-${offset + index + 1}` },
    target_type: "Organization",
  }));
}

function repositories(count: number, offset = 0) {
  return Array.from({ length: count }, (_value, index) => ({
    id: offset + index + 1,
    name: `repository-${offset + index + 1}`,
    owner: { login: "owner" },
  }));
}

describe("GitHub repository gateway", () => {
  it("aborts stalled GitHub REST discovery at the configured shell deadline", async () => {
    let requestAborted = false;
    const gateway = new GitHubRepositoryGateway({
      browser: { async open() {} },
      configuration: configuration.github,
      process: {
        async run() {
          return {
            stdout: JSON.stringify({ id: 9001, name: "repository", owner: { login: "owner" } }),
            stderr: "",
          };
        },
      },
      shellCommandMs: 5,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    });

    await assert.rejects(
      Promise.race([
        gateway.discover({ owner: "owner", name: "repository" }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("GitHub REST request ignored its deadline")), 100);
        }),
      ]),
      (error) => error instanceof DOMException && error.name === "TimeoutError",
    );
    assert.equal(requestAborted, true);
  });

  it("discovers an installation beyond the first GitHub page", async () => {
    const urls: string[] = [];
    let processTimeoutMs: number | undefined;
    const process: SetupProcessRunner = {
      async run(_command, _arguments, options) {
        processTimeoutMs = options?.timeoutMs;
        return {
          stdout: JSON.stringify({ id: 9001, name: "repository", owner: { login: "owner" } }),
          stderr: "",
        };
      },
    };
    const gateway = new GitHubRepositoryGateway({
      browser: { async open() {} },
      configuration: configuration.github,
      process,
      shellCommandMs: 123,
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/app/installations/777/access_tokens")) {
          return Response.json({ token: "installation-token" });
        }
        if (url.endsWith("/repositories/9001")) {
          return Response.json({});
        }
        return Response.json(
          url.endsWith("page=1")
            ? installations(100)
            : [{ id: 777, account: { login: "owner" }, target_type: "Organization" }],
        );
      },
    });

    assert.deepEqual(await gateway.discover({ owner: "owner", name: "repository" }), {
      repository: { id: 9001, owner: "owner", name: "repository" },
      installation: {
        id: 777,
        hasRepositoryAccess: true,
        settingsUrl: "https://github.com/organizations/owner/settings/installations/777",
      },
      newInstallationUrl: `https://github.com/apps/${configuration.github.appSlug}/installations/new`,
    });
    assert.deepEqual(
      urls
        .filter((url) => url.includes("/app/installations?"))
        .map((url) => new URL(url).searchParams.get("page")),
      ["1", "2"],
    );
    assert.equal(processTimeoutMs, 123);
  });

  it("treats an installation-token 404 during discovery as authoritative uninstallation", async () => {
    const gateway = new GitHubRepositoryGateway({
      browser: { async open() {} },
      configuration: configuration.github,
      process: {
        async run() {
          return {
            stdout: JSON.stringify({ id: 9001, name: "repository", owner: { login: "owner" } }),
            stderr: "",
          };
        },
      },
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/app/installations?")) {
          return Response.json([
            { id: 8, account: { login: "owner" }, target_type: "Organization" },
          ]);
        }
        if (url.endsWith("/app/installations/8/access_tokens")) {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        throw new Error(`unexpected GitHub request: ${url}`);
      },
    });

    assert.deepEqual(await gateway.discover({ owner: "owner", name: "repository" }), {
      repository: { id: 9001, owner: "owner", name: "repository" },
      newInstallationUrl: `https://github.com/apps/${configuration.github.appSlug}/installations/new`,
    });
    assert.equal(
      await gateway.waitForRepositoryAccess(8, { id: 9001 }, false),
      "installation-absent",
    );
  });

  it("does not classify a repository-probe 403 as missing access", async () => {
    const gateway = new GitHubRepositoryGateway({
      browser: { async open() {} },
      configuration: configuration.github,
      process: {
        async run() {
          return {
            stdout: JSON.stringify({ id: 9001, name: "repository", owner: { login: "owner" } }),
            stderr: "",
          };
        },
      },
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/app/installations?")) {
          return Response.json([
            { id: 8, account: { login: "owner" }, target_type: "Organization" },
          ]);
        }
        if (url.endsWith("/app/installations/8/access_tokens")) {
          return Response.json({ token: "installation-token" });
        }
        if (url.endsWith("/repositories/9001")) {
          return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
        }
        throw new Error(`unexpected GitHub request: ${url}`);
      },
    });

    await assert.rejects(
      gateway.discover({ owner: "owner", name: "repository" }),
      /repository access verification failed with HTTP 403/u,
    );
    await assert.rejects(
      gateway.waitForRepositoryAccess(8, { id: 9001 }, false),
      /repository access verification failed with HTTP 403/u,
    );
  });

  it("propagates installation-token authentication, server, and network failures", async () => {
    for (const failure of [401, 500, "network"] as const) {
      const gateway = new GitHubRepositoryGateway({
        browser: { async open() {} },
        configuration: configuration.github,
        process: {
          async run() {
            return {
              stdout: JSON.stringify({ id: 9001, name: "repository", owner: { login: "owner" } }),
              stderr: "",
            };
          },
        },
        fetch: async (input) => {
          const url = String(input);
          if (url.includes("/app/installations?")) {
            return Response.json([
              { id: 8, account: { login: "owner" }, target_type: "Organization" },
            ]);
          }
          if (failure === "network") throw new Error("GitHub network unavailable");
          return Response.json({ message: "failed" }, { status: failure });
        },
      });

      // Each failure must remain operational, never authoritative absence.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        gateway.discover({ owner: "owner", name: "repository" }),
        failure === "network"
          ? /GitHub network unavailable/u
          : new RegExp(`installation authentication failed with HTTP ${failure}`, "u"),
      );
    }
  });

  it("lists repositories beyond the first GitHub page", async () => {
    const urls: string[] = [];
    const gateway = new GitHubRepositoryGateway({
      browser: { async open() {} },
      configuration: configuration.github,
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/app/installations?")) {
          return Response.json([
            { id: 8, account: { login: "owner" }, target_type: "Organization" },
          ]);
        }
        if (url.endsWith("/app/installations/8/access_tokens")) {
          return Response.json({ token: "installation-token" });
        }
        if (url.endsWith("page=1")) {
          return Response.json({ repositories: repositories(100) });
        }
        return Response.json({ repositories: repositories(1, 100) });
      },
    });

    const accessible = await gateway.listAccessibleRepositories();
    assert.equal(accessible.length, 101);
    assert.deepEqual(accessible.at(-1), {
      installationId: 8,
      repository: { id: 101, owner: "owner", name: "repository-101" },
    });
    assert.equal(urls.filter((url) => url.includes("/installation/repositories?")).length, 2);
  });
});

describe("Wrangler policy propagation", () => {
  it("passes cancellation and the shell timeout to Wrangler policy reads", async () => {
    const expected = createEmptyPolicy(42);
    const controller = new AbortController();
    let options:
      | {
          environment?: Readonly<Record<string, string>>;
          signal?: AbortSignal;
          timeoutMs?: number;
        }
      | undefined;
    const store = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      process: {
        async run(_command, _arguments, receivedOptions) {
          options = receivedOptions as typeof options;
          return { stdout: JSON.stringify(expected), stderr: "" };
        },
      },
      shellCommandMs: 123,
    });

    await (store.loadCloud as (signal?: AbortSignal) => Promise<unknown>)(controller.signal);
    assert.equal(options?.signal, controller.signal);
    assert.equal(options?.timeoutMs, 123);
    assert.equal(options?.environment?.CLOUDFLARE_ACCOUNT_ID, configuration.cloudflare.accountId);
  });

  it("bounds Wrangler policy writes with the configured shell timeout", async () => {
    const expected = createEmptyPolicy(42);
    let options: { environment?: Readonly<Record<string, string>>; timeoutMs?: number } | undefined;
    const store = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      process: {
        async run(_command, _arguments, receivedOptions) {
          options = receivedOptions as typeof options;
          return { stdout: "", stderr: "" };
        },
      },
      shellCommandMs: 123,
    });

    await store.writeCloud(expected);
    assert.equal(options?.timeoutMs, 123);
    assert.equal(options?.environment?.CLOUDFLARE_ACCOUNT_ID, configuration.cloudflare.accountId);
  });

  it("revalidates a current policy after the KV propagation window", async () => {
    const expected = createEmptyPolicy(42);
    let now = 0;
    let reads = 0;
    const sleeps: number[] = [];
    const store = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      shellCommandMs: configuration.timeouts.shellCommandMs,
      process: {
        async run() {
          reads += 1;
          return { stdout: JSON.stringify(expected), stderr: "" };
        },
      },
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await store.verifyCloud(expected);
    assert.equal(now, 60_000);
    assert.equal(reads, 61);
    assert.equal(sleeps.length, 60);
  });

  it("waits until the exact cloud policy is visible", async () => {
    const expected = createEmptyPolicy(42);
    const stale = withRepository(expected, 8, {
      id: 99,
      owner: "owner",
      name: "repository",
    });
    const reads = [JSON.stringify(stale), "not-json", JSON.stringify(expected)];
    let now = 0;
    const sleeps: number[] = [];
    const store = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      shellCommandMs: configuration.timeouts.shellCommandMs,
      process: {
        async run() {
          return { stdout: reads.shift() ?? JSON.stringify(expected), stderr: "" };
        },
      },
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await store.verifyCloud(expected);
    assert.deepEqual(sleeps.slice(0, 2), [1_000, 1_000]);
    assert.equal(sleeps.length, 60);
  });

  it("fails closed when cloud policy misses the propagation deadline", async () => {
    let now = 0;
    let reads = 0;
    const store = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      shellCommandMs: configuration.timeouts.shellCommandMs,
      process: {
        async run() {
          reads += 1;
          return { stdout: "not-json", stderr: "" };
        },
      },
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await assert.rejects(store.verifyCloud(createEmptyPolicy(42)), /activation deadline/u);
    assert.equal(reads, 65);
  });
});
