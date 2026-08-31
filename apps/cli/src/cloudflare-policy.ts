import { parseRevoirPolicy, REVOIR_POLICY_KV_KEY } from "@revoir/contracts";

import type { RevoirPolicy } from "./config/policy.js";
import type { RevoirConfiguration } from "./config/schema.js";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const DEFAULT_RETRY_DELAYS_MS = [250, 1_000] as const;

export type CloudflareFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type CloudflarePolicyReadFailureReason =
  | "network"
  | "http_transient"
  | "authentication"
  | "missing_policy"
  | "http_terminal"
  | "invalid_policy";

export class CloudflarePolicyReadError extends Error {
  readonly reason: CloudflarePolicyReadFailureReason;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(input: {
    message: string;
    reason: CloudflarePolicyReadFailureReason;
    retryable: boolean;
    status?: number;
  }) {
    super(input.message);
    this.name = "CloudflarePolicyReadError";
    this.reason = input.reason;
    this.retryable = input.retryable;
    if (input.status !== undefined) {
      this.status = input.status;
    }
  }
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function policyUrl(
  configuration: Pick<RevoirConfiguration["cloudflare"], "accountId" | "kvNamespaceId">,
): string {
  return `${CLOUDFLARE_API}/accounts/${encodeURIComponent(configuration.accountId)}/storage/kv/namespaces/${encodeURIComponent(configuration.kvNamespaceId)}/values/${encodeURIComponent(REVOIR_POLICY_KV_KEY)}`;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish(): void {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      reject(signal?.reason ?? new Error("Cloudflare policy read was cancelled."));
    }
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted === true) cancel();
  });
}

export class CloudflarePolicyReader {
  readonly #configuration: Pick<
    RevoirConfiguration["cloudflare"],
    "accountId" | "apiToken" | "kvNamespaceId"
  >;
  readonly #fetch: CloudflareFetch;
  readonly #requestTimeoutMs: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(input: {
    configuration: Pick<
      RevoirConfiguration["cloudflare"],
      "accountId" | "apiToken" | "kvNamespaceId"
    >;
    fetch?: CloudflareFetch;
    requestTimeoutMs: number;
    retryDelaysMs?: readonly number[];
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  }) {
    this.#configuration = input.configuration;
    this.#fetch = input.fetch ?? fetch;
    this.#requestTimeoutMs = input.requestTimeoutMs;
    this.#retryDelaysMs = input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.#sleep = input.sleep ?? defaultSleep;
  }

  async read(signal?: AbortSignal): Promise<RevoirPolicy> {
    signal?.throwIfAborted();
    for (let attempt = 0; ; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await this.#readOnce(signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (
          !(error instanceof CloudflarePolicyReadError) ||
          !error.retryable ||
          attempt >= this.#retryDelaysMs.length
        ) {
          throw error;
        }
        // eslint-disable-next-line no-await-in-loop
        await this.#sleep(this.#retryDelaysMs[attempt]!, signal);
        signal?.throwIfAborted();
      }
    }
  }

  async #readOnce(signal?: AbortSignal): Promise<RevoirPolicy> {
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const requestSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.#fetch(policyUrl(this.#configuration), {
        headers: { Authorization: `Bearer ${this.#configuration.apiToken}` },
        signal: requestSignal,
      });
    } catch {
      signal?.throwIfAborted();
      throw new CloudflarePolicyReadError({
        message: timeoutSignal.aborted
          ? "Cloudflare KV policy read timed out."
          : "Cloudflare KV policy read failed due to a transient network error.",
        reason: "network",
        retryable: true,
      });
    }

    if (!response.ok) {
      if (transientStatus(response.status)) {
        throw new CloudflarePolicyReadError({
          message: `Cloudflare KV policy read failed transiently with HTTP ${response.status}.`,
          reason: "http_transient",
          retryable: true,
          status: response.status,
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new CloudflarePolicyReadError({
          message:
            "Cloudflare rejected repository policy access. Grant Workers KV Storage Read for the configured account.",
          reason: "authentication",
          retryable: false,
          status: response.status,
        });
      }
      if (response.status === 404) {
        throw new CloudflarePolicyReadError({
          message: "Cloudflare repository policy is missing.",
          reason: "missing_policy",
          retryable: false,
          status: response.status,
        });
      }
      throw new CloudflarePolicyReadError({
        message: `Cloudflare KV policy read failed with terminal HTTP ${response.status}.`,
        reason: "http_terminal",
        retryable: false,
        status: response.status,
      });
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      signal?.throwIfAborted();
      throw new CloudflarePolicyReadError({
        message: "Cloudflare KV policy response failed during transfer.",
        reason: "network",
        retryable: true,
      });
    }
    try {
      return parseRevoirPolicy(JSON.parse(body) as unknown);
    } catch {
      throw new CloudflarePolicyReadError({
        message: "Cloudflare repository policy is malformed.",
        reason: "invalid_policy",
        retryable: false,
      });
    }
  }
}
