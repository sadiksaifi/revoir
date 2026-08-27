import { createServer, type Server } from "node:http";

export const REQUIRED_GITHUB_APP_PERMISSIONS = {
  actions: "read",
  checks: "write",
  contents: "read",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
} as const;

export const REQUIRED_GITHUB_APP_EVENTS = ["issue_comment", "pull_request"] as const;

export interface GitHubManifestResult {
  appId: number;
  appSlug: string;
  privateKey: string;
}

export interface GitHubManifestBrowser {
  open(url: string): Promise<void>;
}

export type GitHubManifestFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface PendingCallback {
  promise: Promise<string>;
  reject(error: Error): void;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function pendingCallback(): PendingCallback & { resolve(code: string): void } {
  let resolve!: (code: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    throw new Error("GitHub App callback did not bind exclusively to 127.0.0.1.");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function parseConversion(value: unknown): GitHubManifestResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub returned an invalid App Manifest conversion.");
  }
  const conversion = value as Record<string, unknown>;
  const appId = conversion.id;
  const appSlug = conversion.slug;
  const privateKey = conversion.pem;
  if (!Number.isSafeInteger(appId) || (appId as number) <= 0) {
    throw new Error("GitHub App Manifest conversion omitted the immutable App id.");
  }
  if (typeof appSlug !== "string" || appSlug === "") {
    throw new Error("GitHub App Manifest conversion omitted the App slug.");
  }
  if (
    typeof privateKey !== "string" ||
    !/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/u.test(
      privateKey,
    )
  ) {
    throw new Error("GitHub App Manifest conversion omitted its one-time private key.");
  }
  return { appId: appId as number, appSlug, privateKey };
}

export class GitHubManifestFlow {
  readonly #browser: GitHubManifestBrowser;
  readonly #fetch: GitHubManifestFetch;
  readonly #timeoutMs: number;

  constructor(
    browser: GitHubManifestBrowser,
    fetchImplementation: GitHubManifestFetch = fetch,
    timeoutMs = 5 * 60 * 1000,
  ) {
    this.#browser = browser;
    this.#fetch = fetchImplementation;
    this.#timeoutMs = timeoutMs;
  }

  async create(input: {
    appName: string;
    relayUrl: string;
    state: string;
    webhookSecret: string;
  }): Promise<GitHubManifestResult> {
    const callback = pendingCallback();
    void callback.promise.catch(() => {});
    let manifestJson = "";
    const server = createServer((request, response) => {
      const origin = `http://${request.headers.host ?? "127.0.0.1"}`;
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname === "/start") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; form-action https://github.com; script-src 'unsafe-inline'",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(
          `<!doctype html><meta charset="utf-8"><title>Create Revoir GitHub App</title><form id="manifest" method="post" action="https://github.com/settings/apps/new?state=${encodeURIComponent(input.state)}"><input type="hidden" name="manifest" value="${htmlEscape(manifestJson)}"></form><p>Opening GitHub…</p><script>document.getElementById("manifest").submit()</script>`,
        );
        return;
      }
      if (url.pathname !== "/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== input.state) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Invalid setup state. Return to the terminal and retry.");
        callback.reject(new Error("GitHub App callback state did not match the setup request."));
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null || code === "") {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("GitHub did not return an App Manifest code.");
        callback.reject(new Error("GitHub App callback did not include a conversion code."));
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("Revoir GitHub App created. You can close this tab and return to the terminal.");
      callback.resolve(code);
    });

    try {
      const port = await listenLoopback(server);
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      manifestJson = JSON.stringify({
        name: input.appName,
        url: "https://github.com/sadiksaifi/revoir",
        redirect_url: callbackUrl,
        public: true,
        default_permissions: REQUIRED_GITHUB_APP_PERMISSIONS,
        default_events: REQUIRED_GITHUB_APP_EVENTS,
        hook_attributes: {
          active: true,
          url: input.relayUrl,
          webhook_secret: input.webhookSecret,
        },
      });
      await this.#browser.open(`http://127.0.0.1:${port}/start`);
      const code = await Promise.race([
        callback.promise,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("GitHub App browser approval expired. Rerun setup to retry.")),
            this.#timeoutMs,
          ).unref();
        }),
      ]);
      const response = await this.#fetch(
        `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "revoir",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!response.ok) {
        throw new Error(`GitHub App Manifest conversion failed with HTTP ${response.status}.`);
      }
      return parseConversion(await response.json());
    } finally {
      await closeServer(server);
    }
  }
}
