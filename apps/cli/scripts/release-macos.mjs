import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, glob, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNoEnhancedSeaTemporaryEntrypoint,
  assertStandaloneNativeManifest,
  machOArchitecture,
  standaloneNativeAssetPaths,
  standaloneNativeRuntimeAssetPaths,
} from "./release-validation.mjs";

const cliDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(cliDirectory, "..", "..");
const releaseDirectory = join(repository, "artifacts", `revoir-macos-${process.arch}`);
const artifact = join(releaseDirectory, "revoir");
const metadataFile = join(releaseDirectory, "revoir.metadata.json");
const hostMachOArchitecture = machOArchitecture(process.arch);
const expectedNode = "v24.16.0";
const expectedPnpm = "10.33.2";
const expectedPackager = "6.21.0";

function execute(command, arguments_, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? repository,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} exited with ${signal === null ? `status ${code}` : `signal ${signal}`}${
            options.capture ? `: ${stderr}` : ""
          }`,
        ),
      );
    });
  });
}

async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function assertFrozenTools() {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("Standalone releases are host-native macOS builds only.");
  }
  if (process.version !== expectedNode) {
    throw new Error(`Release requires Node ${expectedNode}, received ${process.version}.`);
  }
  const pnpm = (await execute("pnpm", ["--version"], { capture: true })).stdout.trim();
  if (pnpm !== expectedPnpm) {
    throw new Error(`Release requires pnpm ${expectedPnpm}, received ${pnpm}.`);
  }
  const packager = (
    await execute(join(cliDirectory, "node_modules", ".bin", "pkg"), ["--version"], {
      capture: true,
    })
  ).stdout.trim();
  if (packager !== expectedPackager) {
    throw new Error(`Release requires @yao-pkg/pkg ${expectedPackager}, received ${packager}.`);
  }
}

async function assertArtifactScan(file) {
  const contents = await readFile(file);
  assertNoEnhancedSeaTemporaryEntrypoint(contents);
  const forbiddenBuildPaths = [repository, homedir()].filter((value) => value.length > 1);
  if (forbiddenBuildPaths.some((value) => contents.includes(Buffer.from(value)))) {
    throw new Error("Standalone artifact contains an absolute build-machine path.");
  }
  const candidateSecrets = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        value !== undefined &&
        value.length >= 8 &&
        /(API_KEY|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)/u.test(name),
    )
    .map(([, value]) => value);
  if (candidateSecrets.some((value) => contents.includes(Buffer.from(value)))) {
    throw new Error("Standalone artifact contains a build-environment secret value.");
  }
  const requiredResources = [
    "auth/oauth/openai-codex.js",
    "providers/data/.manifest.json",
    "image-resize-worker.js",
    "photon_rs_bg.wasm",
    ...standaloneNativeAssetPaths(process.arch),
  ];
  if (requiredResources.some((value) => !contents.includes(Buffer.from(value)))) {
    throw new Error("Standalone artifact is missing an explicit Pi runtime resource.");
  }
  const foreignArchitecture = process.arch === "arm64" ? "x64" : "arm64";
  const forbiddenNativeResources = [
    ...standaloneNativeAssetPaths(foreignArchitecture),
    "node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node",
  ];
  if (forbiddenNativeResources.some((value) => contents.includes(Buffer.from(value)))) {
    throw new Error("Standalone artifact contains a foreign-architecture native addon.");
  }
}

async function stageHostNativeAssets(stage) {
  const nativeAssets = standaloneNativeAssetPaths(process.arch);
  const nativeAssetSet = new Set(nativeAssets);
  const stagedNativeAssets = [];
  for await (const path of glob("node_modules/**/*.node", { cwd: stage })) {
    stagedNativeAssets.push(path);
  }
  await Promise.all(
    stagedNativeAssets
      .filter((path) => !nativeAssetSet.has(path))
      .map((path) => rm(join(stage, path), { force: true })),
  );
  await Promise.all(
    nativeAssets.map(async (path) => {
      const architectures = (
        await execute("/usr/bin/lipo", ["-archs", join(stage, path)], { capture: true })
      ).stdout.trim();
      if (architectures !== hostMachOArchitecture) {
        throw new Error(
          `Staged native addon "${path}" is not host-native (${architectures || "unknown"}).`,
        );
      }
    }),
  );
  const packageFile = join(stage, "package.json");
  const packageManifest = JSON.parse(await readFile(packageFile, "utf8"));
  if (!Array.isArray(packageManifest.pkg?.assets)) {
    throw new Error("Deployed CLI package is missing its standalone asset manifest.");
  }
  if (packageManifest.pkg.assets.some((path) => String(path).endsWith(".node"))) {
    throw new Error("Source standalone asset manifest must not contain static native addons.");
  }
  packageManifest.pkg.assets.push(...standaloneNativeRuntimeAssetPaths(process.arch));
  await writeFile(packageFile, `${JSON.stringify(packageManifest, null, 2)}\n`);
  return nativeAssets;
}

function fakeProviderResponse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "keep-alive",
    "cache-control": "no-cache",
  });
  const message = '{"version":1,"findings":[]}';
  response.write(
    `data: ${JSON.stringify({
      id: "revoir-package-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: "revoir-smoke",
      choices: [{ index: 0, delta: { role: "assistant", content: message }, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "revoir-package-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: "revoir-smoke",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

async function smokeStandalone(file, smokeRoot, manifestRoot) {
  const provider = createServer((_request, response) => fakeProviderResponse(response));
  await new Promise((resolvePromise, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolvePromise);
  });
  try {
    const address = provider.address();
    if (address === null || typeof address === "string") {
      throw new Error("Fake Pi provider did not bind a local port.");
    }
    const piAgentDir = join(smokeRoot, "pi-agent");
    await mkdir(piAgentDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(piAgentDir, "models.json"),
      `${JSON.stringify(
        {
          providers: {
            "revoir-smoke": {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: "openai-completions",
              apiKey: "package-smoke-only",
              compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
              },
              models: [
                {
                  id: "revoir-smoke",
                  name: "Revoir package smoke",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 16_384,
                  maxTokens: 1_024,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(piAgentDir, "auth.json"), "{}\n", { mode: 0o600 });
    const environment = {
      HOME: smokeRoot,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      XDG_CONFIG_HOME: join(smokeRoot, "xdg", "config"),
      XDG_CACHE_HOME: join(smokeRoot, "xdg", "cache"),
      XDG_STATE_HOME: join(smokeRoot, "xdg", "state"),
      XDG_DATA_HOME: join(smokeRoot, "xdg", "data"),
      PI_CODING_AGENT_DIR: piAgentDir,
      REVOIR_INTERNAL_PACKAGE_SMOKE: "1",
      REVOIR_PACKAGE_SMOKE_MODEL: "revoir-smoke/revoir-smoke",
    };
    const version = await execute(file, ["--version"], {
      cwd: smokeRoot,
      env: environment,
      capture: true,
    });
    if (version.stdout.trim() !== "revoir 0.0.0") {
      throw new Error("Standalone version smoke returned unexpected output.");
    }
    const help = await execute(file, ["--help"], {
      cwd: smokeRoot,
      env: environment,
      capture: true,
    });
    if (!help.stdout.includes("Revoir 0.0.0")) {
      throw new Error("Standalone help smoke returned unexpected output.");
    }
    const pi = await execute(file, ["__package-smoke"], {
      cwd: smokeRoot,
      env: environment,
      capture: true,
    });
    const summary = JSON.parse(pi.stdout);
    if (
      summary.result !== "ok" ||
      summary.configDir !== join(smokeRoot, "xdg", "config", "revoir")
    ) {
      throw new Error("Standalone Pi/XDG smoke returned unexpected output.");
    }
    assertStandaloneNativeManifest(summary.nativeAssets, process.arch, manifestRoot);
  } finally {
    await new Promise((resolvePromise) => provider.close(resolvePromise));
  }
}

async function build() {
  await assertFrozenTools();
  const dirty = (await execute("git", ["status", "--porcelain"], { capture: true })).stdout.trim();
  if (dirty !== "") {
    throw new Error("Standalone releases require a clean Git worktree.");
  }
  await execute("pnpm", ["install", "--frozen-lockfile"]);
  await execute("pnpm", ["--filter", "cli", "build"]);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "revoir-release-"));
  try {
    const stage = join(temporaryRoot, `revoir-macos-${process.arch}`);
    const smokeRoot = join(temporaryRoot, "standalone-smoke");
    await execute(
      "pnpm",
      ["--filter", "cli", "--prod", "--config.node-linker=hoisted", "deploy", "--legacy", stage],
      { cwd: repository },
    );
    await stageHostNativeAssets(stage);
    await mkdir(releaseDirectory, { recursive: true });
    await rm(artifact, { force: true });
    await execute(
      process.execPath,
      [
        join(cliDirectory, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js"),
        "--targets",
        `node24.16.0-macos-${process.arch}`,
        "--output",
        artifact,
        ".",
      ],
      { cwd: stage },
    );
    await assertArtifactScan(artifact);
    const unsignedSha256 = await sha256(artifact);
    await execute("/usr/bin/codesign", ["--force", "--sign", "-", artifact]);
    await execute("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", artifact]);
    const fileDescription = (await execute("/usr/bin/file", [artifact], { capture: true })).stdout;
    if (!fileDescription.includes(hostMachOArchitecture)) {
      throw new Error("Standalone artifact architecture does not match the build host.");
    }
    const architectures = (
      await execute("/usr/bin/lipo", ["-archs", artifact], { capture: true })
    ).stdout.trim();
    if (architectures !== hostMachOArchitecture) {
      throw new Error(`Standalone artifact is not host-native (${architectures}).`);
    }
    await mkdir(smokeRoot, { recursive: true });
    await smokeStandalone(artifact, smokeRoot, `/${basename(stage)}`);
    const { createReleaseMetadata, installStandaloneExecutable } =
      await import("../dist/release.js");
    const installHome = join(smokeRoot, "install-home");
    const installed = await installStandaloneExecutable(artifact, installHome);
    if (installed !== join(installHome, ".local", "bin", "revoir")) {
      throw new Error("Standalone installer did not use the fixed user-local path.");
    }
    const installedVersion = await execute(installed, ["--version"], {
      cwd: smokeRoot,
      env: {
        HOME: installHome,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      capture: true,
    });
    if (installedVersion.stdout.trim() !== "revoir 0.0.0") {
      throw new Error("Installed standalone copy did not launch.");
    }
    const commit = (await execute("git", ["rev-parse", "HEAD"], { capture: true })).stdout.trim();
    const lockfileSha256 = await sha256(join(repository, "pnpm-lock.yaml"));
    const metadata = createReleaseMetadata({
      architecture: process.arch,
      commit,
      lockfileSha256,
      unsignedSha256,
    });
    await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
    const writtenMetadata = JSON.parse(await readFile(metadataFile, "utf8"));
    if (
      writtenMetadata.build?.commit !== commit ||
      writtenMetadata.build?.lockfileSha256 !== lockfileSha256 ||
      writtenMetadata.artifact?.unsignedSha256 !== unsignedSha256
    ) {
      throw new Error("Standalone metadata does not match its Git, lockfile, or unsigned input.");
    }
    process.stdout.write(`${artifact}\n${metadataFile}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function install() {
  const { installStandaloneExecutable } = await import("../dist/release.js");
  await chmod(artifact, 0o755);
  process.stdout.write(`${await installStandaloneExecutable(artifact, homedir())}\n`);
}

const command = process.argv[2] ?? "build";
if (command === "build") {
  await build();
} else if (command === "install") {
  await install();
} else {
  throw new Error(`Unknown release command "${command}".`);
}
