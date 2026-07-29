import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SecretRedactor } from "../src/redaction.js";

describe("SecretRedactor", () => {
  it("redacts nested credentials and occurrences in command output", () => {
    const redactor = new SecretRedactor({
      github: { privateKey: "private-key-material" },
      cloudflare: { apiToken: "cloudflare-token" },
      nested: { oauth: { accessToken: "oauth-token" } },
    });

    assert.deepEqual(
      redactor.value({
        output: "command failed with private-key-material, cloudflare-token, and oauth-token",
        authorization: "Bearer cloudflare-token",
      }),
      {
        output: "command failed with [REDACTED], [REDACTED], and [REDACTED]",
        authorization: "[REDACTED]",
      },
    );
  });

  it("redacts normal and verbose error rendering", () => {
    const redactor = new SecretRedactor({ apiToken: "top-secret-token" });
    const error = new Error("request rejected top-secret-token");

    assert.equal(redactor.error(error), "request rejected [REDACTED]");
    assert.doesNotMatch(redactor.error(error, true), /top-secret-token/u);
    assert.match(redactor.error(error, true), /\[REDACTED\]/u);
  });

  it("handles structured errors and circular values", () => {
    const redactor = new SecretRedactor();
    const value: Record<string, unknown> = { password: "secret", label: "safe" };
    value.self = value;
    assert.deepEqual(redactor.value(value), {
      password: "[REDACTED]",
      label: "safe",
      self: "[Circular]",
    });
  });
});
