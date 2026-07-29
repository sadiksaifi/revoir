import { execFile as execFileCallback } from "node:child_process";
import { sign } from "node:crypto";

import type { RevoirConfiguration } from "./config/schema.js";

const GITHUB_API = "https://api.github.com";
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_PULL_ACKNOWLEDGEMENT_ERROR =
  "Cloudflare Queue pull acknowledgement check failed. Grant Account > Queues > Edit (Queues Read and Queues Write) to this token for the configured account, then rerun diagnostics.";
const REQUIRED_GITHUB_PERMISSIONS = {
  metadata: "read",
  contents: "read",
  checks: "read",
  actions: "read",
  pull_requests: "write",
} as const;

function execFile(
  executable: string,
  arguments_: readonly string[],
  options: { timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(
      executable,
      [...arguments_],
      { ...options, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export type DiagnosticStatus = "passed" | "failed";

export interface DiagnosticResult {
  id: "runtime" | "git" | "pi-auth" | "github" | "repositories" | "cloudflare";
  label: string;
  status: DiagnosticStatus;
  detail: string;
  error?: unknown;
}

export interface DiagnosticGateway {
  checkRuntime(): Promise<string>;
  checkGit(timeoutMs: number): Promise<string>;
  checkPi(modelId: string, reasoning: string): Promise<string>;
  checkGitHub(
    configuration: RevoirConfiguration["github"],
  ): Promise<{ app: string; repositories: string }>;
  checkCloudflare(configuration: RevoirConfiguration["cloudflare"]): Promise<string>;
}

export function validateNodeRuntime(version: string, runtimeName: string): string {
  if (runtimeName !== "node") {
    throw new Error("Revoir requires the Node.js runtime.");
  }
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`Revoir requires Node.js 24 or newer; found ${version}.`);
  }
  return `Node.js ${version}`;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchFunction = (
  input: string,
  init?: {
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
  },
) => Promise<JsonResponse>;

function parseJsonRecord(value: unknown, service: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${service} returned an invalid response.`);
  }
  return value as Record<string, unknown>;
}

async function requestJson(
  fetchImplementation: FetchFunction,
  service: string,
  url: string,
  init?: Parameters<FetchFunction>[1],
): Promise<Record<string, unknown>> {
  const response = await fetchImplementation(url, init);
  if (!response.ok) {
    throw new Error(`${service} request failed with HTTP ${response.status}.`);
  }
  return parseJsonRecord(await response.json(), service);
}

function createGitHubAppJwt(appId: number, privateKey: string, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: String(appId) }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function githubHeaders(token: string): Readonly<Record<string, string>> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "revoir",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function validateGitHubPermissions(value: unknown): void {
  const permissions = parseJsonRecord(value, "GitHub installation permissions");
  const invalidPermissions = Object.entries(REQUIRED_GITHUB_PERMISSIONS).filter(
    ([permission, requiredGrant]) => permissions[permission] !== requiredGrant,
  );
  if (invalidPermissions.length === 0) {
    return;
  }

  const detail = invalidPermissions
    .map(([permission, requiredGrant]) => {
      const configuredGrant = permissions[permission];
      return `${permission} must be "${requiredGrant}" (found ${
        typeof configuredGrant === "string" ? `"${configuredGrant}"` : "missing"
      })`;
    })
    .join("; ");
  throw new Error(
    `GitHub installation permissions are invalid: ${detail}. Update the repository permissions in the GitHub App settings, approve the permission change for this installation, and rerun diagnostics.`,
  );
}

export function createDefaultDiagnosticGateway(
  fetchImplementation: FetchFunction = fetch,
): DiagnosticGateway {
  return {
    async checkRuntime() {
      return validateNodeRuntime(process.versions.node, process.release.name);
    },

    async checkGit(timeoutMs) {
      try {
        const { stdout } = await execFile("git", ["--version"], {
          timeout: timeoutMs,
          maxBuffer: 64 * 1024,
        });
        const version = stdout.trim();
        if (!/^git version \d/u.test(version)) {
          throw new Error(`Unexpected output: ${version}`);
        }
        return version;
      } catch (error) {
        throw new Error('System Git is unavailable. Install Git and ensure "git" is on PATH.', {
          cause: error,
        });
      }
    },

    async checkPi(modelId, reasoning) {
      const separator = modelId.indexOf("/");
      const providerId = modelId.slice(0, separator);
      const requestedModelId = modelId.slice(separator + 1);
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
      const model = modelRuntime.getModel(providerId, requestedModelId);
      if (model === undefined) {
        throw new Error(
          `Pi does not support configured model "${modelId}". Update model.id or Pi.`,
        );
      }
      if (!model.reasoning) {
        throw new Error(`Pi model "${modelId}" does not support reasoning level "${reasoning}".`);
      }
      const auth = await modelRuntime.getAuth(model);
      const authCheck = await modelRuntime.checkAuth(providerId);
      if (auth === undefined || authCheck?.type !== "oauth") {
        throw new Error(
          'Pi OpenAI Codex login is unavailable. Run "pi", then use "/login" and select OpenAI Codex.',
        );
      }
      return `${modelId} (${reasoning} reasoning), OpenAI Codex OAuth`;
    },

    async checkGitHub(configuration) {
      const appJwt = createGitHubAppJwt(configuration.appId, configuration.privateKey);
      const app = await requestJson(fetchImplementation, "GitHub App", `${GITHUB_API}/app`, {
        headers: githubHeaders(appJwt),
      });
      if (app.id !== configuration.appId) {
        throw new Error(
          `GitHub authenticated app id ${String(app.id)} does not match configured app id ${configuration.appId}.`,
        );
      }

      const tokenResponse = await requestJson(
        fetchImplementation,
        "GitHub installation",
        `${GITHUB_API}/app/installations/${configuration.installationId}/access_tokens`,
        { method: "POST", headers: githubHeaders(appJwt) },
      );
      if (typeof tokenResponse.token !== "string" || tokenResponse.token === "") {
        throw new Error("GitHub installation did not return an access token.");
      }
      validateGitHubPermissions(tokenResponse.permissions);
      const installationToken = tokenResponse.token;

      const user = await requestJson(
        fetchImplementation,
        "GitHub user identity",
        `${GITHUB_API}/user/${configuration.userId}`,
        { headers: githubHeaders(installationToken) },
      );
      if (user.id !== configuration.userId) {
        throw new Error(
          `GitHub user id ${String(user.id)} does not match configured user id ${configuration.userId}.`,
        );
      }

      await Promise.all(
        configuration.repositories.map(async (repository) => {
          const response = await requestJson(
            fetchImplementation,
            "GitHub repository",
            `${GITHUB_API}/repositories/${repository.id}`,
            { headers: githubHeaders(installationToken) },
          );
          const expectedName = `${repository.owner}/${repository.name}`;
          if (
            response.id !== repository.id ||
            typeof response.full_name !== "string" ||
            response.full_name.toLowerCase() !== expectedName.toLowerCase()
          ) {
            throw new Error(
              `GitHub repository id ${repository.id} does not match configured repository "${expectedName}".`,
            );
          }
        }),
      );

      const appName =
        typeof app.slug === "string" && app.slug !== "" ? app.slug : `app ${configuration.appId}`;
      const login =
        typeof user.login === "string" && user.login !== ""
          ? user.login
          : `user ${configuration.userId}`;
      return {
        app: `${appName}, author ${login} (${configuration.userId})`,
        repositories: configuration.repositories
          .map((repository) => `${repository.owner}/${repository.name}`)
          .join(", "),
      };
    },

    async checkCloudflare(configuration) {
      const headers = {
        Authorization: `Bearer ${configuration.apiToken}`,
        "Content-Type": "application/json",
      };
      const queueUrl = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(configuration.accountId)}/queues/${encodeURIComponent(configuration.queueId)}`;
      const response = await requestJson(fetchImplementation, "Cloudflare Queue", queueUrl, {
        headers,
      });
      if (response.success !== true) {
        throw new Error("Cloudflare Queue credentials were not accepted.");
      }
      const result = parseJsonRecord(response.result, "Cloudflare Queue");
      const returnedQueueId = result.queue_id ?? result.id;
      if (typeof returnedQueueId !== "string" || returnedQueueId !== configuration.queueId) {
        throw new Error(`Cloudflare returned a different queue id (${String(returnedQueueId)}).`);
      }
      if (
        typeof result.settings === "object" &&
        result.settings !== null &&
        !Array.isArray(result.settings) &&
        (result.settings as Record<string, unknown>).delivery_paused === true
      ) {
        throw new Error(
          "Cloudflare Queue delivery is paused. Resume delivery before running Revoir.",
        );
      }

      const consumerResponse = await requestJson(
        fetchImplementation,
        "Cloudflare Queue consumers",
        `${queueUrl}/consumers`,
        { headers },
      );
      if (consumerResponse.success !== true || !Array.isArray(consumerResponse.result)) {
        throw new Error("Cloudflare Queue consumers returned an invalid response.");
      }
      const httpPullConsumer = consumerResponse.result.find(
        (consumer) =>
          typeof consumer === "object" &&
          consumer !== null &&
          !Array.isArray(consumer) &&
          (consumer as Record<string, unknown>).type === "http_pull",
      ) as Record<string, unknown> | undefined;
      if (httpPullConsumer === undefined) {
        throw new Error(
          "Cloudflare Queue has no HTTP pull consumer. Enable HTTP pull for this queue before running Revoir.",
        );
      }

      let acknowledgementResponse: Record<string, unknown>;
      try {
        // Empty lists exercise the pull consumer's write-only acknowledgement endpoint
        // without pulling, leasing, acknowledging, or retrying a real message.
        acknowledgementResponse = await requestJson(
          fetchImplementation,
          "Cloudflare Queue pull acknowledgement",
          `${queueUrl}/messages/ack`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ acks: [], retries: [] }),
          },
        );
      } catch (error) {
        throw new Error(CLOUDFLARE_PULL_ACKNOWLEDGEMENT_ERROR, { cause: error });
      }
      if (acknowledgementResponse.success !== true) {
        throw new Error(CLOUDFLARE_PULL_ACKNOWLEDGEMENT_ERROR);
      }

      const queueName =
        typeof result.queue_name === "string"
          ? result.queue_name
          : typeof result.name === "string"
            ? result.name
            : configuration.queueId;
      const consumerId =
        typeof httpPullConsumer.consumer_id === "string" && httpPullConsumer.consumer_id !== ""
          ? httpPullConsumer.consumer_id
          : "configured";
      return `queue ${queueName}, HTTP pull consumer ${consumerId}; token and pull acknowledgement access verified without leasing messages.`;
    },
  };
}

async function capture(
  id: DiagnosticResult["id"],
  label: string,
  operation: () => Promise<string>,
): Promise<DiagnosticResult> {
  try {
    return { id, label, status: "passed", detail: await operation() };
  } catch (error) {
    return {
      id,
      label,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
      error,
    };
  }
}

export async function runDiagnostics(
  configuration: RevoirConfiguration,
  gateway: DiagnosticGateway = createDefaultDiagnosticGateway(),
): Promise<DiagnosticResult[]> {
  const [runtime, git, pi, github, cloudflare] = await Promise.all([
    capture("runtime", "Node runtime", () => gateway.checkRuntime()),
    capture("git", "System Git", () => gateway.checkGit(configuration.timeouts.shellCommandMs)),
    capture("pi-auth", "Pi Codex authentication", () =>
      gateway.checkPi(configuration.model.id, configuration.model.reasoning),
    ),
    (async () => {
      try {
        const result = await gateway.checkGitHub(configuration.github);
        return [
          {
            id: "github",
            label: "GitHub App and author",
            status: "passed",
            detail: result.app,
          },
          {
            id: "repositories",
            label: "Repository allowlist",
            status: "passed",
            detail: result.repositories,
          },
        ] satisfies DiagnosticResult[];
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return [
          {
            id: "github",
            label: "GitHub App and author",
            status: "failed",
            detail,
            error,
          },
          {
            id: "repositories",
            label: "Repository allowlist",
            status: "failed",
            detail: "Skipped because GitHub authentication or identity validation failed.",
          },
        ] satisfies DiagnosticResult[];
      }
    })(),
    capture("cloudflare", "Cloudflare Queue", () =>
      gateway.checkCloudflare(configuration.cloudflare),
    ),
  ]);

  return [runtime, git, pi, ...github, cloudflare];
}

export function diagnosticsPassed(results: readonly DiagnosticResult[]): boolean {
  return results.every((result) => result.status === "passed");
}
