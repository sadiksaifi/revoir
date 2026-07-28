const REDACTED = "[REDACTED]";
const SECRET_KEY =
  /(?:authorization|api[-_]?key|private[-_]?key|token|secret|password|credential|oauth)/iu;

function collectSecrets(value: unknown, secrets: Set<string>, secretContext = false): void {
  if (typeof value === "string") {
    if (secretContext && value.length > 0) {
      secrets.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSecrets(item, secrets, secretContext);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    collectSecrets(nested, secrets, secretContext || SECRET_KEY.test(key));
  }
}

function replaceSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => redacted.split(secret).join(REDACTED), value);
}

function redactUnknown(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return replaceSecrets(value, secrets);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: value.name,
      message: replaceSecrets(value.message, secrets),
    };
    if (value.stack !== undefined) {
      output.stack = replaceSecrets(value.stack, secrets);
    }
    if (value.cause !== undefined) {
      output.cause = redactUnknown(value.cause, secrets, seen);
    }
    return output;
  }
  if (typeof value !== "object") {
    return replaceSecrets(String(value), secrets);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, secrets, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? REDACTED : redactUnknown(nested, secrets, seen);
  }
  return output;
}

export class SecretRedactor {
  readonly #secrets: readonly string[];

  constructor(secretSource?: unknown) {
    const secrets = new Set<string>();
    collectSecrets(secretSource, secrets);
    this.#secrets = [...secrets].toSorted((left, right) => right.length - left.length);
  }

  text(value: string): string {
    return replaceSecrets(value, this.#secrets);
  }

  value(value: unknown): unknown {
    return redactUnknown(value, this.#secrets, new WeakSet());
  }

  error(error: unknown, verbose = false): string {
    if (error instanceof Error) {
      const rendered = verbose && error.stack !== undefined ? error.stack : error.message;
      return this.text(rendered);
    }
    if (typeof error === "string") {
      return this.text(error);
    }
    return JSON.stringify(this.value(error));
  }
}
