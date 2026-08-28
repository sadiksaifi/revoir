import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { parseRevoirPolicy, REVOIR_POLICY_KV_KEY, REVOIR_WEBHOOK_PATH } from "@revoir/contracts";

import type { RevoirPolicy } from "../config/policy.js";
import { DEFAULT_SHELL_COMMAND_TIMEOUT_MS, type RevoirConfiguration } from "../config/schema.js";
import { EMBEDDED_RELAY_SHA256, EMBEDDED_RELAY_SOURCE } from "../generated/relay-artifact.js";
import { githubInstallationSettingsUrl, parseGitHubInstallation } from "../github-installation.js";
import { createGitHubAppJwt } from "../review/github.js";
import {
  GitHubManifestFlow,
  REQUIRED_GITHUB_APP_EVENTS,
  REQUIRED_GITHUB_APP_PERMISSIONS,
  type GitHubManifestBrowser,
} from "./github-manifest.js";
import type {
  SetupCloudflareCheckpoint,
  SetupCloudflareResources,
  SetupGitHubApp,
  SetupPlatform,
} from "./orchestrator.js";

const RESOURCE_PREFIX = "revoir";
const GITHUB_APP_MACHINE_NAME_MAX_LENGTH = 18;

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface SetupProcessOptions {
  environment?: Readonly<Record<string, string>>;
  input?: string;
  interactive?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SetupProcessRunner {
  run(
    command: string,
    arguments_: readonly string[],
    options?: SetupProcessOptions,
  ): Promise<ProcessResult>;
}

export class ChildProcessSetupRunner implements SetupProcessRunner {
  run(
    command: string,
    arguments_: readonly string[],
    options: SetupProcessOptions = {},
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const timeoutSignal =
        options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
      const operationSignal =
        options.signal === undefined
          ? timeoutSignal
          : timeoutSignal === undefined
            ? options.signal
            : AbortSignal.any([options.signal, timeoutSignal]);
      const child = spawn(command, [...arguments_], {
        env: { ...process.env, ...options.environment },
        stdio: options.interactive ? "inherit" : ["pipe", "pipe", "pipe"],
        ...(operationSignal === undefined ? {} : { signal: operationSignal }),
      });
      if (!options.interactive) {
        child.stdin?.end(options.input);
      }
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new Error(
            `${command} failed with ${signal === null ? `status ${String(code)}` : `signal ${signal}`}.`,
          ),
        );
      });
    });
  }
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} returned an invalid object.`);
  }
  return parsed as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error(`${label} did not return a positive immutable id.`);
  }
  return numeric;
}

function resourceId(output: string, label: string): string {
  const trimmed = output.trim();
  const wholeJson = (() => {
    try {
      return parseJsonRecord(trimmed, label);
    } catch {
      return undefined;
    }
  })();
  const wholeId = wholeJson?.id ?? wholeJson?.queue_id ?? wholeJson?.namespace_id;
  if (typeof wholeId === "string" && wholeId !== "") return wholeId;
  const jsonCandidate = trimmed
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("{") && line.endsWith("}"));
  if (jsonCandidate !== undefined) {
    const parsed = parseJsonRecord(jsonCandidate, label);
    const id = parsed.id ?? parsed.queue_id ?? parsed.namespace_id;
    if (typeof id === "string" && id !== "") {
      return id;
    }
  }
  const quoted = /(?:id|queue[ _]id|namespace[ _]id)\s*[=:]\s*["']?([A-Za-z0-9_-]{8,})["']?/iu.exec(
    output,
  )?.[1];
  if (quoted === undefined) {
    throw new Error(`${label} did not report the created resource id.`);
  }
  return quoted;
}

function samePolicy(left: RevoirPolicy, right: RevoirPolicy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const KV_PROPAGATION_WINDOW_MS = 60_000;
const KV_ACTIVATION_DEADLINE_MS = 65_000;

export class DefaultSetupPlatform implements SetupPlatform {
  readonly #browser: GitHubManifestBrowser;
  readonly #diagnostics: (
    configuration: RevoirConfiguration,
    policy: RevoirPolicy,
  ) => Promise<void>;
  readonly #installService: (configuration: RevoirConfiguration) => Promise<void>;
  readonly #hostname: () => string;
  readonly #manifest: GitHubManifestFlow;
  readonly #process: SetupProcessRunner;
  readonly #secretPrompt: (message: string) => Promise<string>;
  readonly #shellCommandMs: number;
  readonly #selectCloudflareAccount: (
    accounts: readonly { id: string; name: string }[],
  ) => Promise<string>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(input: {
    browser: GitHubManifestBrowser;
    diagnostics: (configuration: RevoirConfiguration, policy: RevoirPolicy) => Promise<void>;
    hostname?: () => string;
    installService(configuration: RevoirConfiguration): Promise<void>;
    secretPrompt(message: string): Promise<string>;
    selectCloudflareAccount?(accounts: readonly { id: string; name: string }[]): Promise<string>;
    shellCommandMs?: number;
    process?: SetupProcessRunner;
    manifest?: GitHubManifestFlow;
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#browser = input.browser;
    this.#diagnostics = input.diagnostics;
    this.#hostname = input.hostname ?? hostname;
    this.#installService = input.installService;
    this.#process = input.process ?? new ChildProcessSetupRunner();
    this.#manifest = input.manifest ?? new GitHubManifestFlow(input.browser);
    this.#secretPrompt = input.secretPrompt;
    this.#shellCommandMs = input.shellCommandMs ?? DEFAULT_SHELL_COMMAND_TIMEOUT_MS;
    this.#selectCloudflareAccount =
      input.selectCloudflareAccount ??
      (async () => {
        throw new Error("Select a Cloudflare account to continue setup.");
      });
    this.#fetch = input.fetch ?? fetch;
    this.#now = input.now ?? Date.now;
    this.#sleep =
      input.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async ensureGitHubAuthentication(): Promise<{ userId: number; login: string }> {
    try {
      try {
        await this.#process.run("gh", ["auth", "status"]);
      } catch {
        await this.#process.run("gh", ["auth", "login", "--web"], { interactive: true });
      }
    } catch (error) {
      throw new Error(
        'GitHub CLI authentication is unavailable. Install a supported "gh" release, ensure it is on PATH, and rerun setup.',
        { cause: error },
      );
    }
    const response = parseJsonRecord(
      (await this.#process.run("gh", ["api", "user"])).stdout,
      "GitHub CLI",
    );
    if (typeof response.login !== "string" || response.login === "") {
      throw new Error("GitHub CLI did not return the authenticated login.");
    }
    return { userId: positiveInteger(response.id, "GitHub CLI"), login: response.login };
  }

  async ensureWranglerAuthentication(
    options: {
      accountId?: string;
      persist?(account: { accountId: string }): Promise<void>;
    } = {},
  ): Promise<{ accountId: string }> {
    let output: string;
    try {
      try {
        output = (await this.#process.run("wrangler", ["whoami", "--json"])).stdout;
      } catch {
        await this.#process.run("wrangler", ["login"], { interactive: true });
        output = (await this.#process.run("wrangler", ["whoami", "--json"])).stdout;
      }
    } catch (error) {
      throw new Error(
        'Cloudflare Wrangler authentication is unavailable. Install Wrangler 4, ensure "wrangler" is on PATH, and rerun setup.',
        { cause: error },
      );
    }
    const identity = parseJsonRecord(output, "Wrangler authentication");
    if (identity.loggedIn !== true || !Array.isArray(identity.accounts)) {
      throw new Error("Wrangler authentication did not return an authenticated account list.");
    }
    const accounts = identity.accounts.map((candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new Error("Wrangler authentication returned an invalid account entry.");
      }
      const account = candidate as Record<string, unknown>;
      if (
        typeof account.id !== "string" ||
        !/^[0-9a-f]{32}$/iu.test(account.id) ||
        typeof account.name !== "string" ||
        account.name.trim() === ""
      ) {
        throw new Error("Wrangler authentication returned an invalid account entry.");
      }
      return { id: account.id, name: account.name };
    });
    if (accounts.length === 0) {
      throw new Error("Wrangler authentication did not return a usable Cloudflare account.");
    }
    let accountId = options.accountId;
    if (accountId !== undefined && !accounts.some(({ id }) => id === accountId)) {
      throw new Error("The checkpointed Cloudflare account is not available to Wrangler.");
    }
    accountId ??=
      accounts.length === 1 ? accounts[0]!.id : await this.#selectCloudflareAccount(accounts);
    if (!accounts.some(({ id }) => id === accountId)) {
      throw new Error("Cloudflare account selection did not match an authenticated account.");
    }
    const selected = { accountId };
    await options.persist?.(selected);
    return selected;
  }

  #cloudflareOptions(accountId: string, options: SetupProcessOptions = {}): SetupProcessOptions {
    return {
      ...options,
      environment: { ...options.environment, CLOUDFLARE_ACCOUNT_ID: accountId },
      timeoutMs: options.timeoutMs ?? this.#shellCommandMs,
    };
  }

  async ensurePiAuthentication(modelId: string, reasoning: string): Promise<void> {
    const separator = modelId.indexOf("/");
    const provider = modelId.slice(0, separator);
    const modelName = modelId.slice(separator + 1);
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({ allowModelNetwork: false });
    const model = runtime.getModel(provider, modelName);
    if (model === undefined || (reasoning !== "minimal" && !model.reasoning)) {
      throw new Error(`Pi does not support ${modelId} with ${reasoning} reasoning.`);
    }
    if ((await runtime.checkAuth(provider))?.type === "oauth") {
      return;
    }
    const browserOperations: Promise<void>[] = [];
    await runtime.login(provider, "oauth", {
      prompt: async (prompt) => this.#secretPrompt(`${prompt.message}: `),
      notify: (event) => {
        if (event.type === "auth_url") {
          browserOperations.push(this.#browser.open(event.url));
        } else if (event.type === "device_code") {
          browserOperations.push(this.#browser.open(event.verificationUri));
        }
      },
    });
    await Promise.all(browserOperations);
    if ((await runtime.checkAuth(provider))?.type !== "oauth") {
      throw new Error("Pi OpenAI Codex authentication did not complete.");
    }
  }

  async ensureCloudflareResources(
    accountId: string,
    setupId: string,
    existing: SetupCloudflareCheckpoint | undefined,
    persist: (resources: SetupCloudflareCheckpoint) => Promise<void>,
  ): Promise<SetupCloudflareResources> {
    if (!/^[0-9a-f]{16}$/u.test(setupId)) {
      throw new Error("Setup checkpoint contains an invalid greenfield resource id.");
    }
    let resources: SetupCloudflareCheckpoint = existing ?? {
      accountId,
      queueName: `${RESOURCE_PREFIX}-review-jobs-${setupId}`,
      workerName: `${RESOURCE_PREFIX}-relay-${setupId}`,
    };
    if (resources.accountId !== accountId) {
      throw new Error("Cloudflare resource checkpoint belongs to a different account.");
    }
    const kvName = `${RESOURCE_PREFIX}-policy-${setupId}`;
    const listed = await this.#process.run(
      "wrangler",
      ["kv", "namespace", "list"],
      this.#cloudflareOptions(accountId),
    );
    let namespaces: unknown;
    try {
      namespaces = JSON.parse(listed.stdout) as unknown;
    } catch {
      throw new Error("Wrangler KV namespace listing returned invalid JSON.");
    }
    if (!Array.isArray(namespaces)) {
      throw new Error("Wrangler KV namespace listing returned an invalid result.");
    }
    const matchingNamespace = namespaces.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as Record<string, unknown>).title === kvName,
    ) as Record<string, unknown> | undefined;
    if (resources.kvNamespaceId === undefined) {
      let kvId =
        typeof matchingNamespace?.id === "string" && matchingNamespace.id !== ""
          ? matchingNamespace.id
          : undefined;
      if (kvId === undefined) {
        const created = await this.#process.run(
          "wrangler",
          ["kv", "namespace", "create", kvName],
          this.#cloudflareOptions(accountId),
        );
        kvId = resourceId(`${created.stdout}\n${created.stderr}`, "Wrangler KV creation");
      }
      resources = { ...resources, kvNamespaceId: kvId };
      await persist(resources);
    } else if (matchingNamespace?.id !== resources.kvNamespaceId) {
      throw new Error("Checkpointed KV namespace no longer matches the owned setup resource.");
    }
    let queueInfo: ProcessResult | undefined;
    if (resources.queueId === undefined) {
      try {
        queueInfo = await this.#process.run(
          "wrangler",
          ["queues", "info", resources.queueName],
          this.#cloudflareOptions(accountId),
        );
      } catch {
        const created = await this.#process.run(
          "wrangler",
          ["queues", "create", resources.queueName],
          this.#cloudflareOptions(accountId),
        );
        queueInfo = await this.#process.run(
          "wrangler",
          ["queues", "info", resources.queueName],
          this.#cloudflareOptions(accountId),
        );
        queueInfo = {
          stdout: `${queueInfo.stdout}\n${created.stdout}`,
          stderr: `${queueInfo.stderr}\n${created.stderr}`,
        };
      }
      resources = {
        ...resources,
        queueId: resourceId(`${queueInfo.stdout}\n${queueInfo.stderr}`, "Wrangler Queue"),
      };
      await persist(resources);
    }
    queueInfo ??= await this.#process.run(
      "wrangler",
      ["queues", "info", resources.queueName],
      this.#cloudflareOptions(accountId),
    );
    if (
      resourceId(`${queueInfo.stdout}\n${queueInfo.stderr}`, "Wrangler Queue verification") !==
      resources.queueId
    ) {
      throw new Error("Checkpointed Queue no longer matches the owned setup resource.");
    }
    if (!/HTTP Pull Consumer/iu.test(`${queueInfo.stdout}\n${queueInfo.stderr}`)) {
      await this.#process.run(
        "wrangler",
        ["queues", "consumer", "http", "add", resources.queueName],
        this.#cloudflareOptions(accountId),
      );
    }
    const kvNamespaceId = resources.kvNamespaceId;
    const queueId = resources.queueId;
    if (kvNamespaceId === undefined || queueId === undefined) {
      throw new Error("Cloudflare resource setup did not produce immutable identifiers.");
    }
    return { ...resources, kvNamespaceId, queueId };
  }

  async #withRelayConfiguration<T>(
    resources: SetupCloudflareResources,
    operation: (configFile: string) => Promise<T>,
  ): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "revoir-relay-"));
    try {
      const workerFile = join(root, "worker.mjs");
      const configFile = join(root, "wrangler.json");
      await Promise.all([
        writeFile(workerFile, EMBEDDED_RELAY_SOURCE, { encoding: "utf8", mode: 0o600 }),
        writeFile(
          configFile,
          `${JSON.stringify(
            {
              account_id: resources.accountId,
              name: resources.workerName,
              main: workerFile,
              compatibility_date: "2026-07-22",
              kv_namespaces: [{ binding: "POLICY_KV", id: resources.kvNamespaceId }],
              queues: {
                producers: [{ binding: "REVIEW_QUEUE", queue: resources.queueName }],
              },
              vars: { REVOIR_RELAY_VERSION: EMBEDDED_RELAY_SHA256 },
            },
            undefined,
            2,
          )}\n`,
          { encoding: "utf8", mode: 0o600 },
        ),
      ]);
      return await operation(configFile);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async deployRelay(resources: SetupCloudflareResources): Promise<string> {
    return this.#withRelayConfiguration(resources, async (configFile) => {
      const deployment = await this.#process.run(
        "wrangler",
        ["deploy", "--config", configFile],
        this.#cloudflareOptions(resources.accountId),
      );
      const baseUrl = /https:\/\/[A-Za-z0-9.-]+\.workers\.dev\/?/u.exec(
        `${deployment.stdout}\n${deployment.stderr}`,
      )?.[0];
      if (baseUrl === undefined) {
        throw new Error("Wrangler deployment did not report the relay workers.dev URL.");
      }
      return `${baseUrl.replace(/\/$/u, "")}${REVOIR_WEBHOOK_PATH}`;
    });
  }

  async configureRelaySecret(
    resources: SetupCloudflareResources,
    webhookSecret: string,
  ): Promise<void> {
    await this.#withRelayConfiguration(resources, async (configFile) => {
      await this.#process.run(
        "wrangler",
        ["secret", "put", "GITHUB_WEBHOOK_SECRET", "--config", configFile],
        this.#cloudflareOptions(resources.accountId, { input: `${webhookSecret}\n` }),
      );
      await this.#process.run(
        "wrangler",
        ["deploy", "--config", configFile],
        this.#cloudflareOptions(resources.accountId),
      );
    });
  }

  createGitHubApp(input: {
    relayUrl: string;
    state: string;
    persist: (app: SetupGitHubApp) => Promise<void>;
  }): Promise<SetupGitHubApp> {
    const machine =
      this.#hostname()
        .replaceAll(/[^A-Za-z0-9-]/gu, "-")
        .slice(0, GITHUB_APP_MACHINE_NAME_MAX_LENGTH) || "mac";
    return this.#manifest.create({
      ...input,
      appName: `Revoir ${machine} ${input.state.slice(0, 8)}`,
    });
  }

  async reconcileGitHubApp(
    configuration: RevoirConfiguration,
    policy: RevoirPolicy,
  ): Promise<void> {
    const jwt = createGitHubAppJwt(configuration.github.appId, configuration.github.privateKey);
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      "User-Agent": "revoir",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const response = await this.#fetch("https://api.github.com/app", { headers });
    if (!response.ok) {
      throw new Error(`GitHub App reconciliation failed with HTTP ${response.status}.`);
    }
    const app = parseJsonRecord(JSON.stringify(await response.json()), "GitHub App");
    if (app.id !== configuration.github.appId || app.slug !== configuration.github.appSlug) {
      throw new Error("GitHub App reconciliation returned a different immutable App identity.");
    }
    const events = Array.isArray(app.events) ? app.events : [];
    const permissions =
      typeof app.permissions === "object" && app.permissions !== null
        ? (app.permissions as Record<string, unknown>)
        : {};
    const expectedPermissions = Object.entries(REQUIRED_GITHUB_APP_PERMISSIONS);
    const drifted =
      events.length !== REQUIRED_GITHUB_APP_EVENTS.length ||
      REQUIRED_GITHUB_APP_EVENTS.some((event) => !events.includes(event)) ||
      Object.keys(permissions).length !== expectedPermissions.length ||
      expectedPermissions.some(([permission, access]) => permissions[permission] !== access);
    if (drifted) {
      const url = `https://github.com/settings/apps/${configuration.github.appSlug}/permissions`;
      await this.#browser.open(url);
      throw new Error(
        `GitHub App permissions or events require approval. Complete the change at ${url}, then rerun setup.`,
      );
    }
    for (const installation of policy.installations) {
      // Installation permission approval is independent for personal and organization owners.
      // eslint-disable-next-line no-await-in-loop
      const installationResponse = await this.#fetch(
        `https://api.github.com/app/installations/${installation.id}/access_tokens`,
        { method: "POST", headers },
      );
      if (!installationResponse.ok) {
        throw new Error(
          `GitHub installation ${installation.id} reconciliation failed with HTTP ${installationResponse.status}.`,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      const installationJson = await installationResponse.json();
      const installationToken = parseJsonRecord(
        JSON.stringify(installationJson),
        `GitHub installation ${installation.id}`,
      );
      const installationPermissions =
        typeof installationToken.permissions === "object" && installationToken.permissions !== null
          ? (installationToken.permissions as Record<string, unknown>)
          : {};
      const installationDrifted =
        Object.keys(installationPermissions).length !== expectedPermissions.length ||
        expectedPermissions.some(
          ([permission, access]) => installationPermissions[permission] !== access,
        );
      if (installationDrifted) {
        // GitHub routes personal and organization installation settings differently.
        // eslint-disable-next-line no-await-in-loop
        const metadataResponse = await this.#fetch(
          `https://api.github.com/app/installations/${installation.id}`,
          { headers },
        );
        if (!metadataResponse.ok) {
          throw new Error(
            `GitHub installation ${installation.id} metadata failed with HTTP ${metadataResponse.status}.`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        const metadata = parseGitHubInstallation(await metadataResponse.json());
        if (metadata.id !== installation.id) {
          throw new Error(
            `GitHub installation ${installation.id} metadata returned a different immutable identity.`,
          );
        }
        const url = githubInstallationSettingsUrl(metadata);
        // eslint-disable-next-line no-await-in-loop
        await this.#browser.open(url);
        throw new Error(
          `GitHub installation ${installation.id} requires permission approval. Complete it at ${url}, then rerun setup.`,
        );
      }
    }
    const hook = await this.#fetch("https://api.github.com/app/hook/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        url: configuration.cloudflare.relayUrl,
        content_type: "json",
        insecure_ssl: "0",
        secret: configuration.github.webhookSecret,
      }),
    });
    if (!hook.ok) {
      throw new Error(`GitHub webhook reconciliation failed with HTTP ${hook.status}.`);
    }
  }

  async requestQueueApiToken(resources: SetupCloudflareResources): Promise<string> {
    const tokenTemplate = new URL("https://dash.cloudflare.com/profile/api-tokens");
    tokenTemplate.searchParams.set(
      "permissionGroupKeys",
      JSON.stringify([{ key: "queues", type: "edit" }]),
    );
    tokenTemplate.searchParams.set("accountId", resources.accountId);
    tokenTemplate.searchParams.set("zoneId", "all");
    tokenTemplate.searchParams.set("name", "Revoir Queue Pull");
    await this.#browser.open(tokenTemplate.toString());
    const token = (await this.#secretPrompt("Cloudflare Queue read/write API token: ")).trim();
    if (token === "") {
      throw new Error("Cloudflare Queue API token cannot be empty.");
    }
    return token;
  }

  async validateQueueApiToken(resources: SetupCloudflareResources, token: string): Promise<void> {
    const queueUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(resources.accountId)}/queues/${encodeURIComponent(resources.queueId)}`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const response = await this.#fetch(queueUrl, { headers });
    if (!response.ok || ((await response.json()) as Record<string, unknown>).success !== true) {
      throw new Error(
        "Cloudflare rejected the Queue token. Grant only Account > Queues > Edit and retry.",
      );
    }
    const acknowledgement = await this.#fetch(`${queueUrl}/messages/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify({ acks: [], retries: [] }),
    });
    if (
      !acknowledgement.ok ||
      ((await acknowledgement.json()) as Record<string, unknown>).success !== true
    ) {
      throw new Error(
        "Cloudflare rejected Queue acknowledgement access. Grant Account > Queues > Edit and retry.",
      );
    }
  }

  async putCloudPolicy(resources: SetupCloudflareResources, policy: RevoirPolicy): Promise<void> {
    await this.#process.run(
      "wrangler",
      [
        "kv",
        "key",
        "put",
        `--namespace-id=${resources.kvNamespaceId}`,
        REVOIR_POLICY_KV_KEY,
        JSON.stringify(parseRevoirPolicy(policy)),
        "--remote",
      ],
      this.#cloudflareOptions(resources.accountId),
    );
  }

  async verifyCloudPolicy(
    resources: SetupCloudflareResources,
    expected: RevoirPolicy,
  ): Promise<void> {
    const startedAt = this.#now();
    const activationAt = startedAt + KV_PROPAGATION_WINDOW_MS;
    const deadline = startedAt + KV_ACTIVATION_DEADLINE_MS;
    do {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.#process.run(
        "wrangler",
        [
          "kv",
          "key",
          "get",
          `--namespace-id=${resources.kvNamespaceId}`,
          REVOIR_POLICY_KV_KEY,
          "--remote",
          "--text",
        ],
        this.#cloudflareOptions(resources.accountId),
      );
      try {
        if (
          samePolicy(parseRevoirPolicy(JSON.parse(result.stdout) as unknown), expected) &&
          this.#now() >= activationAt
        ) {
          return;
        }
      } catch {
        // A stale or unavailable KV read remains unauthorized while propagation continues.
      }
      // eslint-disable-next-line no-await-in-loop
      await this.#sleep(1_000);
    } while (this.#now() < deadline);
    throw new Error("Cloudflare KV policy did not become visible before the activation deadline.");
  }

  async getCloudPolicy(resources: SetupCloudflareResources): Promise<RevoirPolicy> {
    const result = await this.#process.run(
      "wrangler",
      [
        "kv",
        "key",
        "get",
        `--namespace-id=${resources.kvNamespaceId}`,
        REVOIR_POLICY_KV_KEY,
        "--remote",
        "--text",
      ],
      this.#cloudflareOptions(resources.accountId),
    );
    return parseRevoirPolicy(JSON.parse(result.stdout) as unknown);
  }

  installService(configuration: RevoirConfiguration): Promise<void> {
    return this.#installService(configuration);
  }

  runDiagnostics(configuration: RevoirConfiguration, policy: RevoirPolicy): Promise<void> {
    return this.#diagnostics(configuration, policy);
  }
}
