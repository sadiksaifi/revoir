import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { darwinProcessBirth, linuxProcessBirth } from "../src/review/process-identity.js";

describe("process birth metadata", () => {
  it("reads Linux start time after a command containing spaces and parentheses", () => {
    const trailingFields = [
      "S",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "424242",
      "20",
    ].join(" ");

    const bootId = "123e4567-e89b-12d3-a456-426614174000";
    assert.equal(
      linuxProcessBirth(`123 (worker) pool) ${trailingFields}`, `${bootId}\n`),
      `linux:${bootId}:424242`,
    );
    assert.equal(linuxProcessBirth("invalid", bootId), undefined);
  });

  it("normalizes macOS ps metadata under the forced C locale and verifies its PID", () => {
    const output = "  123   Tue Jul 28 13:52:35 2026    \n";

    assert.equal(darwinProcessBirth(output, 123), "darwin:Tue Jul 28 13:52:35 2026");
    assert.equal(darwinProcessBirth(output, 124), undefined);
    assert.equal(darwinProcessBirth("", 123), undefined);
  });
});
