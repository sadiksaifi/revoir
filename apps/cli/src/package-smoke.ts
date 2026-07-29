import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { resolveApplicationPaths, type PathEnvironment } from "./config/paths.js";
import {
  createReviewResourceLoader,
  SdkPiSessionFactory,
  type PiSessionFactory,
} from "./review/pi.js";

const EXPECTED_RESULT = '{"version":1,"findings":[]}';
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
}

interface ImageResizeModule {
  resizeImage(
    input: Uint8Array,
    mimeType: string,
    options: { maxWidth: number; maxHeight: number; maxBytes: number },
  ): Promise<unknown>;
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

function defaultDependencies(): PackageSmokeDependencies {
  return {
    sessions: new SdkPiSessionFactory(),
    probeOAuth,
    probeImageRuntime,
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
      piAgentDir,
      result: "ok",
    }),
  );
}
