import type { RevoirConfiguration } from "../config/schema.js";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const VISIBILITY_GRACE_MS = 60_000;
const MAX_VISIBILITY_TIMEOUT_MS = 12 * 60 * 60 * 1000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface QueueDelivery {
  leaseId: string;
  attempt: number;
  body: unknown;
}

interface CloudflareEnvelope {
  success?: unknown;
  result?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireLeaseId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Cloudflare Queue returned a message without a lease identifier.");
  }
  return value;
}

function requireAttempt(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("Cloudflare Queue returned a message without a valid attempt count.");
  }
  return value as number;
}

function requireRetryDelay(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 24 * 60 * 60) {
    throw new Error("Cloudflare Queue retry delay must be between 0 and 86400 seconds.");
  }
  return value;
}

function requireSettlement(result: unknown, operation: "acknowledged" | "retried"): void {
  const expectedCount = operation === "acknowledged" ? "ackCount" : "retryCount";
  const otherCount = operation === "acknowledged" ? "retryCount" : "ackCount";
  const hasWarnings =
    isRecord(result) &&
    "warnings" in result &&
    (!isRecord(result.warnings) || Object.keys(result.warnings).length > 0);
  if (!isRecord(result) || result[expectedCount] !== 1 || result[otherCount] !== 0 || hasWarnings) {
    throw new Error(`Cloudflare Queue did not confirm exactly one ${operation} lease.`);
  }
}

function decodeBody(message: Record<string, unknown>): unknown {
  if (!isRecord(message.metadata) || message.metadata["CF-Content-Type"] !== "json") {
    return undefined;
  }
  if (
    typeof message.body !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(message.body)
  ) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(message.body, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export class CloudflareQueueClient {
  readonly #configuration: RevoirConfiguration["cloudflare"];
  readonly #fetch: Fetch;
  readonly #visibilityTimeoutMs: number;

  constructor(
    configuration: RevoirConfiguration["cloudflare"],
    reviewTimeoutMs: number,
    fetchImplementation: Fetch = fetch,
  ) {
    this.#configuration = configuration;
    this.#fetch = fetchImplementation;
    this.#visibilityTimeoutMs = Math.min(
      reviewTimeoutMs + VISIBILITY_GRACE_MS,
      MAX_VISIBILITY_TIMEOUT_MS,
    );
  }

  async pullOne(signal?: AbortSignal): Promise<QueueDelivery | undefined> {
    const result = await this.#request(
      "pull",
      {
        visibility_timeout_ms: this.#visibilityTimeoutMs,
        batch_size: 1,
      },
      signal,
    );
    if (!isRecord(result) || !Array.isArray(result.messages) || result.messages.length > 1) {
      throw new Error("Cloudflare Queue returned an invalid pull response.");
    }
    const message = result.messages[0];
    if (message === undefined) {
      return undefined;
    }
    if (!isRecord(message)) {
      throw new Error("Cloudflare Queue returned an invalid message.");
    }
    return {
      leaseId: requireLeaseId(message.lease_id),
      attempt: requireAttempt(message.attempts),
      body: decodeBody(message),
    };
  }

  async acknowledge(leaseId: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#request(
      "ack",
      {
        acks: [{ lease_id: requireLeaseId(leaseId) }],
        retries: [],
      },
      signal,
    );
    requireSettlement(result, "acknowledged");
  }

  async retry(leaseId: string, delaySeconds = 0, signal?: AbortSignal): Promise<void> {
    const result = await this.#request(
      "ack",
      {
        acks: [],
        retries: [
          {
            lease_id: requireLeaseId(leaseId),
            delay_seconds: requireRetryDelay(delaySeconds),
          },
        ],
      },
      signal,
    );
    requireSettlement(result, "retried");
  }

  async #request(
    operation: "pull" | "ack",
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { accountId, queueId, apiToken } = this.#configuration;
    const response = await this.#fetch(
      `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(queueId)}/messages/${operation}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!response.ok) {
      throw new Error(`Cloudflare Queue ${operation} request failed with HTTP ${response.status}.`);
    }
    let envelope: CloudflareEnvelope;
    try {
      envelope = (await response.json()) as CloudflareEnvelope;
    } catch {
      throw new Error(`Cloudflare Queue ${operation} request returned invalid JSON.`);
    }
    if (!isRecord(envelope) || envelope.success !== true || !("result" in envelope)) {
      throw new Error(`Cloudflare Queue ${operation} request was rejected.`);
    }
    return envelope.result;
  }
}
