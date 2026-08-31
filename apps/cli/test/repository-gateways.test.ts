import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEmptyPolicy, withRepository } from "../src/config/policy.js";
import {
  CloudflarePolicyReadError,
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
  it("bounds the repository authentication probe with the configured shell deadline", async () => {
    const calls: { arguments: readonly string[]; timeoutMs?: number }[] = [];
    const gateway = new GitHubRepositoryGateway({
      browser: { async open() {} },
      configuration: configuration.github,
      process: {
        async run(_command, arguments_, options) {
          calls.push({
            arguments: arguments_,
            ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          });
          return { stdout: "", stderr: "" };
        },
      },
      shellCommandMs: 123,
    });

    await gateway.ensureAuthenticated();

    assert.deepEqual(calls, [{ arguments: ["auth", "status"], timeoutMs: 123 }]);
  });

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
  it("bounds both Wrangler authentication probes for the selected account", async () => {
    const calls: {
      arguments: readonly string[];
      environment?: Readonly<Record<string, string>>;
      timeoutMs?: number;
    }[] = [];
    let firstProbe = true;
    const store = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      process: {
        async run(_command, arguments_, options) {
          calls.push({
            arguments: arguments_,
            ...(options?.environment === undefined ? {} : { environment: options.environment }),
            ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          });
          if (arguments_[0] === "whoami" && firstProbe) {
            firstProbe = false;
            throw new Error("not authenticated");
          }
          return { stdout: "", stderr: "" };
        },
      },
      shellCommandMs: 123,
    });

    await store.ensureAuthenticated();

    const probes = calls.filter(({ arguments: arguments_ }) => arguments_[0] === "whoami");
    assert.deepEqual(probes, [
      {
        arguments: ["whoami", "--json"],
        environment: { CLOUDFLARE_ACCOUNT_ID: configuration.cloudflare.accountId },
        timeoutMs: 123,
      },
      {
        arguments: ["whoami", "--json"],
        environment: { CLOUDFLARE_ACCOUNT_ID: configuration.cloudflare.accountId },
        timeoutMs: 123,
      },
    ]);
  });

  it("reads the cloud policy directly with the configured token and deadline", async () => {
    const expected = createEmptyPolicy(42);
    const controller = new AbortController();
    let request: { url: string; authorization: string | null; signal?: AbortSignal } | undefined;
    const store = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      fetch: async (input, init) => {
        request = {
          url: input.toString(),
          authorization: new Headers(init?.headers).get("Authorization"),
          ...(init?.signal == null ? {} : { signal: init.signal }),
        };
        return new Response(JSON.stringify(expected));
      },
      shellCommandMs: 123,
    });

    await (store.loadCloud as (signal?: AbortSignal) => Promise<unknown>)(controller.signal);
    assert.equal(
      request?.url,
      `https://api.cloudflare.com/client/v4/accounts/${configuration.cloudflare.accountId}/storage/kv/namespaces/${configuration.cloudflare.kvNamespaceId}/values/policy`,
    );
    assert.equal(request?.authorization, `Bearer ${configuration.cloudflare.apiToken}`);
    assert.equal(request?.signal?.aborted, false);
  });

  it("retries only transient Cloudflare policy read failures with deterministic backoff", async () => {
    const expected = createEmptyPolicy(42);
    const statuses = [408, 429, 503, 200];
    const sleeps: number[] = [];
    const store = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      fetch: async () => {
        const status = statuses.shift()!;
        return new Response(status === 200 ? JSON.stringify(expected) : "sensitive response body", {
          status,
        });
      },
      shellCommandMs: 123,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      policyReadRetryDelaysMs: [10, 20, 30],
    });

    assert.deepEqual(await store.loadCloud(), expected);
    assert.deepEqual(sleeps, [10, 20, 30]);
  });

  it("retries transient network failures without exposing their unsafe cause", async () => {
    const expected = createEmptyPolicy(42);
    let attempts = 0;
    const store = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error(`network failed with ${configuration.cloudflare.apiToken}`);
        }
        return new Response(JSON.stringify(expected));
      },
      shellCommandMs: 123,
      sleep: async () => {},
      policyReadRetryDelaysMs: [0],
    });

    assert.deepEqual(await store.loadCloud(), expected);
    assert.equal(attempts, 2);
  });

  it("fails immediately and safely for non-transient HTTP and invalid policy responses", async () => {
    for (const status of [400, 401, 403, 404]) {
      let attempts = 0;
      const store = new LocalAndWranglerPolicyStore({
        cloudflare: configuration.cloudflare,
        policyFile: "/unused/policy.json",
        fetch: async () => {
          attempts += 1;
          return new Response(`unsafe ${configuration.cloudflare.apiToken}`, { status });
        },
        shellCommandMs: 123,
        sleep: async () => assert.fail(`HTTP ${status} must not be retried`),
      });

      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(store.loadCloud(), (error) => {
        assert.equal(error instanceof CloudflarePolicyReadError, true);
        assert.equal((error as CloudflarePolicyReadError).retryable, false);
        assert.doesNotMatch((error as Error).message, /unsafe|cloudflare-secret-token/u);
        return true;
      });
      assert.equal(attempts, 1);
    }

    const malformed = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      fetch: async () => new Response(`not-json-${configuration.cloudflare.apiToken}`),
      shellCommandMs: 123,
      sleep: async () => assert.fail("Malformed policy must not be retried"),
    });
    await assert.rejects(malformed.loadCloud(), (error) => {
      assert.equal(error instanceof CloudflarePolicyReadError, true);
      assert.equal((error as CloudflarePolicyReadError).reason, "invalid_policy");
      assert.doesNotMatch((error as Error).message, /not-json|cloudflare-secret-token/u);
      return true;
    });
  });

  it("preserves caller cancellation during a direct policy read", async () => {
    const controller = new AbortController();
    const cancellation = new Error("stop policy read");
    const store = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
      shellCommandMs: 123,
      sleep: async () => assert.fail("Cancellation must not be retried"),
    });

    const loading = store.loadCloud(controller.signal);
    controller.abort(cancellation);
    await assert.rejects(loading, cancellation);
  });

  it("preserves caller cancellation during policy-read backoff", async () => {
    const controller = new AbortController();
    const cancellation = new Error("stop policy backoff");
    let attempts = 0;
    let markBackoffStarted!: () => void;
    const backoffStarted = new Promise<void>((resolve) => {
      markBackoffStarted = resolve;
    });
    const store = new LocalAndWranglerPolicyStore({
      cloudflare: configuration.cloudflare,
      policyFile: "/unused/policy.json",
      fetch: async () => {
        attempts += 1;
        return new Response("transient", { status: 503 });
      },
      shellCommandMs: 123,
      sleep: async (_milliseconds, signal) =>
        new Promise<void>((_resolve, reject) => {
          markBackoffStarted();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });

    const loading = store.loadCloud(controller.signal);
    await backoffStarted;
    controller.abort(cancellation);
    await assert.rejects(loading, cancellation);
    assert.equal(attempts, 1);
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
      fetch: async () => {
        reads += 1;
        return new Response(JSON.stringify(expected));
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
      fetch: async () => {
        return new Response(reads.shift() ?? JSON.stringify(expected));
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
      fetch: async () => {
        reads += 1;
        return new Response("not-json");
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
