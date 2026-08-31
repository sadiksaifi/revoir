import { execFile as execFileCallback } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { resolveApplicationPaths, type PathEnvironment } from "./config/paths.js";
import {
  createEmptyPolicy,
  loadPolicy,
  withRepository,
  writePolicy,
  type RevoirPolicy,
} from "./config/policy.js";
import { createConfiguration, type RevoirConfiguration } from "./config/schema.js";
import type { SetupCheckpoint } from "./config/setup-checkpoint.js";
import { loadConfiguration, writeConfiguration } from "./config/store.js";
import {
  createDefaultDiagnosticGateway,
  diagnosticsPassed,
  runDiagnostics,
} from "./diagnostics.js";
import { EMBEDDED_RELAY_SHA256, EMBEDDED_RELAY_SOURCE } from "./generated/relay-artifact.js";
import {
  createDefaultQueueRunService,
  QueueReviewRunner,
  type OperationalFailureState,
  type OperationalFailureStore,
  type QueueClient,
} from "./queue/runner.js";
import { createDefaultManualReviewService } from "./review/orchestrator.js";
import {
  createReviewResourceLoader,
  SdkPiSessionFactory,
  type PiSessionFactory,
} from "./review/pi.js";
import { parsePullRequestUrl, type PullRequestSnapshot } from "./review/pull-request.js";
import { GitWorkspacePreparer } from "./review/workspace.js";
import { readServiceLogs, serviceLogPaths } from "./service/logging.js";
import {
  LaunchdServiceManager,
  type LaunchctlGateway,
  type LaunchctlInspection,
} from "./service/manager.js";
import { EndToEndSetup, type SetupPlatform } from "./setup/orchestrator.js";

const EXPECTED_RESULT = '{"version":2,"findings":[]}';
const SYSTEM_PROMPT =
  "This is a packaged Revoir runtime probe. Return exactly one empty Revoir finding envelope.";

export interface PackageSmokeInput {
  cwd: string;
  environment: PathEnvironment;
  write(value: string): void;
}

export interface PackageSmokeDependencies {
  sessions: PiSessionFactory;
  probeOAuth(): Promise<void>;
  probeImageRuntime(): Promise<void>;
  probeNativeRuntime(): Promise<readonly string[]>;
  probeHostBoundaries(input: PackageSmokeInput): Promise<void>;
}

interface ImageResizeModule {
  resizeImage(
    input: Uint8Array,
    mimeType: string,
    options: { maxWidth: number; maxHeight: number; maxBytes: number },
  ): Promise<unknown>;
}

interface NativeModifierModule {
  isModifierPressed(key: string): boolean;
}

interface ClipboardNativeModule {
  clipboard: unknown;
}

function codingAgentPackageDirectory(): string {
  const entryPoint = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return dirname(dirname(entryPoint));
}

async function probeOAuth(): Promise<void> {
  const runtime = await ModelRuntime.create({ modelsPath: null });
  const oauth = runtime.getProvider("openai-codex")?.auth.oauth;
  if (oauth === undefined) {
    throw new Error("Packaged Pi did not expose the OpenAI Codex OAuth flow.");
  }
  const auth = await oauth.toAuth({
    type: "oauth",
    access: "revoir-package-smoke-token",
    refresh: "unused",
    expires: Number.MAX_SAFE_INTEGER,
  });
  if (auth.apiKey !== "revoir-package-smoke-token") {
    throw new Error("Packaged Pi did not load its dynamic OpenAI Codex OAuth module.");
  }
  const originalFetch = globalThis.fetch;
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "package-smoke-account" },
    }),
  ).toString("base64url");
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        access_token: `header.${payload}.signature`,
        refresh_token: "rotated-package-smoke-refresh",
        expires_in: 3_600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const refreshed = await oauth.refresh({
      type: "oauth",
      access: "expired",
      refresh: "package-smoke-refresh",
      expires: 0,
    });
    if (
      refreshed.refresh !== "rotated-package-smoke-refresh" ||
      refreshed.accountId !== "package-smoke-account"
    ) {
      throw new Error("Packaged Pi OAuth refresh returned unexpected credentials.");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function probeImageRuntime(): Promise<void> {
  const packageDirectory = codingAgentPackageDirectory();
  const resizeModuleUrl = pathToFileURL(
    join(packageDirectory, "dist", "utils", "image-resize.js"),
  ).href;
  const resizeModule = (await import(resizeModuleUrl)) as ImageResizeModule;
  const image = await readFile(
    join(packageDirectory, "dist", "modes", "interactive", "assets", "clankolas.png"),
  );
  const resized = await resizeModule.resizeImage(image, "image/png", {
    maxWidth: 32,
    maxHeight: 32,
    maxBytes: 64 * 1024,
  });
  if (resized === null) {
    throw new Error("Packaged Pi could not load its image worker and Photon WASM runtime.");
  }
}

async function probeNativeRuntime(): Promise<readonly string[]> {
  const sea = await import("node:sea");
  if (!sea.isSea()) {
    throw new Error("Native package smoke requires a Node single executable application.");
  }
  const manifest = JSON.parse(sea.getAsset("__pkg_manifest__", "utf8")) as {
    offsets?: Record<string, unknown>;
  };
  if (manifest.offsets === undefined) {
    throw new Error("Packaged SEA manifest is missing its file offsets.");
  }
  const nativeAssets = Object.keys(manifest.offsets)
    .filter((path) => path.endsWith(".node"))
    .toSorted();
  const tuiEntryPoint = fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"));
  const tuiDirectory = dirname(dirname(tuiEntryPoint));
  const nativeModifierPath = join(
    tuiDirectory,
    "native",
    "darwin",
    "prebuilds",
    `darwin-${process.arch}`,
    "darwin-modifiers.node",
  );
  const nativeModifier = createRequire(import.meta.url)(nativeModifierPath) as NativeModifierModule;
  if (typeof nativeModifier.isModifierPressed !== "function") {
    throw new Error("Packaged Pi TUI native modifier addon did not load.");
  }
  nativeModifier.isModifierPressed("shift");
  const clipboardRequire = createRequire(
    pathToFileURL(join(codingAgentPackageDirectory(), "package.json")).href,
  );
  let clipboardBinding: unknown;
  try {
    clipboardBinding = clipboardRequire(`@mariozechner/clipboard-darwin-${process.arch}`);
  } catch (cause) {
    throw new Error("Packaged host-native clipboard binding could not be required.", { cause });
  }
  if (typeof clipboardBinding !== "object" || clipboardBinding === null) {
    throw new Error("Packaged host-native clipboard binding returned an invalid module.");
  }
  const clipboardNativeUrl = pathToFileURL(
    join(codingAgentPackageDirectory(), "dist", "utils", "clipboard-native.js"),
  ).href;
  const clipboardNative = (await import(clipboardNativeUrl)) as ClipboardNativeModule;
  if (clipboardNative.clipboard === null || clipboardNative.clipboard === undefined) {
    throw new Error("Packaged host-native clipboard addon did not load.");
  }
  return nativeAssets;
}

async function runGit(arguments_: readonly string[], cwd?: string): Promise<string> {
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    execFileCallback(
      "git",
      [...arguments_],
      {
        ...(cwd === undefined ? {} : { cwd }),
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "C",
          LC_ALL: "C",
        },
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, commandStdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolvePromise(commandStdout);
      },
    );
  });
  return stdout.trim();
}

async function probeGitWorkspace(input: PackageSmokeInput): Promise<void> {
  const source = join(input.cwd, "system-git-source");
  const remote = join(input.cwd, "system-git-remote.git");
  await runGit(["init", "--quiet", source]);
  await runGit(["config", "user.name", "Revoir package smoke"], source);
  await runGit(["config", "user.email", "revoir-package-smoke@example.invalid"], source);
  await writeFile(join(source, "source.ts"), "export const value = 1;\n");
  await runGit(["add", "--all"], source);
  await runGit(["commit", "--quiet", "-m", "base"], source);
  const baseSha = await runGit(["rev-parse", "HEAD"], source);
  await writeFile(join(source, "source.ts"), "export const value = 2;\n");
  await runGit(["add", "--all"], source);
  await runGit(["commit", "--quiet", "-m", "head"], source);
  const headSha = await runGit(["rev-parse", "HEAD"], source);
  await runGit(["clone", "--quiet", "--bare", source, remote]);
  const paths = resolveApplicationPaths(input.environment, input.environment.HOME);
  const workspace = await new GitWorkspacePreparer(paths.cacheDir, 10_000).prepare(
    parsePullRequestUrl("https://github.com/package-smoke/repository/pull/1"),
    {
      number: 1,
      description: "Package smoke",
      state: "open",
      draft: false,
      authorId: 1,
      baseSha,
      headSha,
      baseRepository: {
        id: 1,
        fullName: "package-smoke/repository",
        cloneUrl: remote,
      },
      headRepository: {
        id: 1,
        fullName: "package-smoke/repository",
        cloneUrl: remote,
      },
    } satisfies PullRequestSnapshot,
    "package-smoke-installation-token",
    new AbortController().signal,
  );
  try {
    if (!workspace.diff.includes("+export const value = 2;")) {
      throw new Error("Packaged system Git workspace did not produce the expected diff.");
    }
  } finally {
    await workspace.cleanup();
  }
}

async function probeServiceLifecycle(input: PackageSmokeInput): Promise<void> {
  const homeDir = input.environment.HOME;
  if (homeDir === undefined) {
    throw new Error("Packaged service smoke requires HOME.");
  }
  const paths = resolveApplicationPaths(input.environment, homeDir);
  let inspection: LaunchctlInspection | undefined;
  const operations: string[] = [];
  const launchctl: LaunchctlGateway = {
    async inspect() {
      operations.push("inspect");
      return inspection;
    },
    async bootstrap() {
      operations.push("bootstrap");
      inspection = { state: "running", pid: process.pid, lastExitCode: undefined };
    },
    async bootout() {
      operations.push("bootout");
      inspection = undefined;
    },
    async kickstart() {
      operations.push("kickstart");
      inspection = { state: "running", pid: process.pid, lastExitCode: undefined };
    },
  };
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Packaged launchd smoke requires a macOS user id.");
  }
  const manager = new LaunchdServiceManager(
    {
      configFile: paths.configFile,
      executableArguments: [process.execPath],
      homeDir,
      paths,
      uid,
      ...(input.environment.XDG_CONFIG_HOME === undefined ||
      input.environment.XDG_CONFIG_HOME === ""
        ? {}
        : { xdgConfigHome: input.environment.XDG_CONFIG_HOME }),
    },
    launchctl,
  );
  await manager.install();
  const plist = await readFile(manager.plistFile, "utf8");
  if (!plist.includes(`<string>${process.execPath}</string>`) || plist.includes("/snapshot/")) {
    throw new Error("Packaged LaunchAgent arguments do not invoke only the installed executable.");
  }
  await new Promise<void>((resolvePromise, reject) => {
    execFileCallback("/usr/bin/plutil", ["-lint", manager.plistFile], (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
  if ((await manager.status()).state !== "healthy") {
    throw new Error("Packaged fake-launchctl service did not become healthy.");
  }
  await manager.start();
  await manager.stop();
  if ((await manager.status()).state !== "stopped") {
    throw new Error("Packaged fake-launchctl service did not stop.");
  }
  await manager.start();
  await writeFile(serviceLogPaths(paths.stateDir).launchdStdout, "package smoke service log\n", {
    mode: 0o600,
  });
  if (!(await readServiceLogs(paths.stateDir)).includes("package smoke service log")) {
    throw new Error("Packaged service logs did not resolve from XDG state.");
  }
  await manager.uninstall();
  if (!operations.includes("bootstrap") || !operations.includes("bootout")) {
    throw new Error("Packaged fake-launchctl lifecycle did not exercise service mutations.");
  }
}

async function probeSetupAndInitializers(input: PackageSmokeInput): Promise<void> {
  const homeDir = input.environment.HOME;
  if (homeDir === undefined) {
    throw new Error("Packaged setup smoke requires HOME.");
  }
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const paths = resolveApplicationPaths(input.environment, homeDir);
  let checkpoint: SetupCheckpoint | undefined;
  let finalConfiguration: RevoirConfiguration | undefined;
  let finalPolicy: RevoirPolicy | undefined;
  const setupPlatform: SetupPlatform = {
    async ensureGitHubAuthentication() {
      return { userId: 1, login: "package-smoke" };
    },
    async ensureWranglerAuthentication() {
      return { accountId: "package-smoke-account" };
    },
    async ensurePiAuthentication() {},
    async ensureCloudflareResources(accountId, setupId, _existing, persist) {
      const resources = {
        accountId,
        kvNamespaceId: "package-smoke-kv-id",
        queueId: "package-smoke-queue-id",
        queueName: `revoir-review-jobs-${setupId}`,
        workerName: `revoir-relay-${setupId}`,
      };
      await persist(resources);
      return resources;
    },
    async deployRelay() {
      return "https://revoir-relay.example.workers.dev/github/webhook";
    },
    async relayIsCurrent() {
      return true;
    },
    async configureRelaySecret() {},
    async createGitHubApp(created) {
      const app = {
        appId: 2,
        appSlug: "package-smoke",
        privateKey,
        webhookSecret: "package-smoke-webhook-secret",
      };
      await created.persist(app);
      return app;
    },
    async reconcileGitHubApp(configuration) {
      return {
        appId: configuration.github.appId,
        appSlug: configuration.github.appSlug,
      };
    },
    async requestRuntimeApiToken() {
      return "package-smoke-cloudflare-token";
    },
    async validateRuntimeApiToken() {},
    async putCloudPolicy() {},
    async getCloudPolicy() {
      return createEmptyPolicy(1);
    },
    async verifyCloudPolicy() {},
    async installService() {},
    async runDiagnostics() {},
  };
  const greenfield = await new EndToEndSetup({
    platform: setupPlatform,
    state: {
      async load() {
        return checkpoint;
      },
      async write(value) {
        checkpoint = structuredClone(value);
      },
      async remove() {
        checkpoint = undefined;
      },
      async writeFinal(configuration, policy) {
        finalConfiguration = structuredClone(configuration);
        finalPolicy = structuredClone(policy);
      },
    },
    defaults: {
      model: { id: "openai-codex/gpt-5.6-sol", reasoning: "high" },
      service: { executablePath: "/usr/local/bin:/usr/bin:/bin" },
      timeouts: { reviewMs: 1_200_000, shellCommandMs: 120_000 },
      paths: { cacheDir: paths.cacheDir, stateDir: paths.stateDir, dataDir: paths.dataDir },
    },
  }).run();
  if (
    greenfield.policy.installations.length !== 0 ||
    finalConfiguration?.github.privateKey !== privateKey ||
    finalPolicy?.userId !== 1 ||
    checkpoint !== undefined
  ) {
    throw new Error("Packaged greenfield setup orchestration did not complete cleanly.");
  }
  const configuration = createConfiguration({
    service: { executablePath: "/usr/local/bin:/usr/bin:/bin" },
    github: {
      appId: 2,
      appSlug: "package-smoke",
      privateKey,
      webhookSecret: "package-smoke-webhook-secret",
    },
    cloudflare: {
      accountId: "package-smoke-account",
      queueId: "package-smoke-queue-id",
      queueName: "revoir-review-jobs",
      kvNamespaceId: "package-smoke-kv-id",
      workerName: "revoir-relay",
      apiToken: "package-smoke-cloudflare-token",
      relayUrl: "https://revoir-relay.example.workers.dev/github/webhook",
    },
    paths: {
      cacheDir: paths.cacheDir,
      stateDir: paths.stateDir,
      dataDir: paths.dataDir,
    },
  });
  const policy = withRepository({ version: 1, revision: 0, userId: 1, installations: [] }, 3, {
    id: 1,
    owner: "package-smoke",
    name: "repository",
  });
  await Promise.all([
    writeConfiguration(paths.configFile, configuration),
    writePolicy(paths.policyFile, policy),
  ]);
  const defaultGateway = createDefaultDiagnosticGateway();
  const gateway = {
    checkRuntime: defaultGateway.checkRuntime,
    async checkGit() {
      const version = await runGit(["--version"]);
      if (!version.startsWith("git version ")) {
        throw new Error("Packaged system Git returned unexpected version output.");
      }
      return version;
    },
    async checkPi() {
      return "packaged Pi initialized with external auth";
    },
    async checkGitHub() {
      return { app: "package-smoke", repositories: "package-smoke/repository" };
    },
    async checkCloudflare() {
      return "package-smoke queue";
    },
    async checkRelay() {
      return "package-smoke relay";
    },
    async checkPolicy() {
      return "package-smoke policy";
    },
  };
  const loadedConfiguration = await loadConfiguration(paths.configFile);
  const loadPackagePolicy = () => loadPolicy(paths.policyFile);
  if (!diagnosticsPassed(await runDiagnostics(loadedConfiguration, policy, gateway))) {
    throw new Error("Packaged diagnostic initialization failed.");
  }
  createDefaultManualReviewService(loadedConfiguration, loadPackagePolicy);
  createDefaultQueueRunService(loadedConfiguration, loadPackagePolicy);
  if (createHash("sha256").update(EMBEDDED_RELAY_SOURCE).digest("hex") !== EMBEDDED_RELAY_SHA256) {
    throw new Error("Packaged relay artifact checksum does not match its embedded metadata.");
  }
  await writeFile(join(input.cwd, "embedded-relay-smoke.mjs"), EMBEDDED_RELAY_SOURCE, {
    mode: 0o600,
  });

  let acknowledged = false;
  const queue: QueueClient = {
    async pullOne() {
      return { leaseId: "package-smoke", attempt: 1, body: { version: 2 } };
    },
    async acknowledge() {
      acknowledged = true;
    },
    async retry() {
      throw new Error("Malformed package smoke delivery must not retry.");
    },
  };
  const store: OperationalFailureStore = {
    async load(): Promise<OperationalFailureState> {
      return { committedFailures: 0 };
    },
    async save() {},
    async clear() {},
  };
  const runner = new QueueReviewRunner(
    loadedConfiguration,
    queue,
    {
      async review() {
        throw new Error("Malformed package smoke delivery must not start a review.");
      },
    },
    { async report() {} },
    store,
  );
  if ((await runner.consumeOne()) !== "settled" || !acknowledged) {
    throw new Error("Packaged Queue runner did not settle its fake delivery.");
  }
  const cancelled = new AbortController();
  cancelled.abort(new Error("package smoke cancellation"));
  let pulledAfterCancellation = false;
  await new QueueReviewRunner(
    loadedConfiguration,
    {
      async pullOne() {
        pulledAfterCancellation = true;
        return undefined;
      },
      async acknowledge() {},
      async retry() {},
    },
    {
      async review() {
        throw new Error("Cancelled package smoke runner must not review.");
      },
    },
    { async report() {} },
    store,
  ).run(cancelled.signal);
  if (pulledAfterCancellation) {
    throw new Error("Packaged Queue runner pulled after cancellation.");
  }
}

async function probeHostBoundaries(input: PackageSmokeInput): Promise<void> {
  await probeSetupAndInitializers(input);
  await probeGitWorkspace(input);
  await probeServiceLifecycle(input);
}

function defaultDependencies(): PackageSmokeDependencies {
  return {
    sessions: new SdkPiSessionFactory(),
    probeOAuth,
    probeImageRuntime,
    probeNativeRuntime,
    probeHostBoundaries,
  };
}

export async function runPackageSmoke(
  input: PackageSmokeInput,
  dependencies: PackageSmokeDependencies = defaultDependencies(),
): Promise<void> {
  const cwd = resolve(input.cwd);
  const homeDir = input.environment.HOME;
  const piAgentDir = input.environment.PI_CODING_AGENT_DIR;
  const model = input.environment.REVOIR_PACKAGE_SMOKE_MODEL;
  if (homeDir === undefined || piAgentDir === undefined || model === undefined) {
    throw new Error(
      "Packaged runtime smoke requires HOME, PI_CODING_AGENT_DIR, and REVOIR_PACKAGE_SMOKE_MODEL.",
    );
  }
  const paths = resolveApplicationPaths(input.environment, homeDir);
  const resources = createReviewResourceLoader(SYSTEM_PROMPT);
  if (
    resources.getSystemPrompt() !== SYSTEM_PROMPT ||
    resources.getExtensions().extensions.length !== 0 ||
    resources.getSkills().skills.length !== 0
  ) {
    throw new Error("Packaged Pi resource isolation does not match Revoir's fixed resources.");
  }

  await dependencies.probeOAuth();
  await dependencies.probeImageRuntime();
  const nativeAssets = await dependencies.probeNativeRuntime();
  await dependencies.probeHostBoundaries(input);
  const session = await dependencies.sessions.create(
    {
      cwd,
      model,
      reasoning: "minimal",
      shellCommandMs: 5_000,
      systemPrompt: SYSTEM_PROMPT,
    },
    new AbortController().signal,
  );
  try {
    const result = await session.run(
      "Return the empty Revoir finding envelope.",
      AbortSignal.timeout(10_000),
    );
    if (result !== EXPECTED_RESULT) {
      throw new Error("Packaged Pi fake provider returned an unexpected result.");
    }
  } finally {
    await session.dispose();
  }

  input.write(
    JSON.stringify({
      configDir: paths.configDir,
      model,
      nativeAssets,
      piAgentDir,
      result: "ok",
    }),
  );
}
