import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FindingSchemaError, parseModelFinding, parseModelReviewOutput } from "../src/findings.js";

function finding(priority = "P1") {
  return {
    priority,
    title: "Dropped cancellation",
    path: "src/review.ts",
    range: { start: 10, end: 12, side: "RIGHT" },
    issue: "The cancellation signal is not forwarded.",
    impact: "A timed-out review continues consuming resources.",
    evidence: "The added call omits the signal argument used by the callee.",
    fixDirection: "Pass the active signal to the call.",
  };
}

describe("finding contract v1", () => {
  it("parses clean output and all supported priorities", () => {
    assert.deepEqual(parseModelReviewOutput('{"version":1,"findings":[]}'), {
      version: 1,
      findings: [],
    });
    for (const priority of ["P0", "P1", "P2", "P3"]) {
      assert.equal(parseModelFinding(finding(priority), 0).priority, priority);
    }
  });

  it("round-trips the versioned contract across JSON and structured clone", () => {
    const value = {
      version: 1,
      findings: [{ ...finding(), range: null }],
    };
    const parsed = parseModelReviewOutput(JSON.stringify(structuredClone(value)));
    assert.deepEqual(parseModelFinding(parsed.findings[0], 0), value.findings[0]);
  });

  it("rejects malformed JSON, unknown versions, fields, and envelope shapes", () => {
    const cases = [
      "not json",
      "null",
      '{"version":2,"findings":[]}',
      '{"version":1,"findings":{} }',
      '{"version":1,"findings":[],"summary":"clean"}',
    ];
    for (const value of cases) {
      assert.throws(() => parseModelReviewOutput(value), FindingSchemaError);
    }
  });

  it("requires every finding field and rejects unknown fields", () => {
    for (const field of Object.keys(finding())) {
      const candidate = { ...finding() } as Record<string, unknown>;
      delete candidate[field];
      assert.throws(
        () => parseModelFinding(candidate, 3),
        new RegExp(`findings\\[3\\]\\.${field} is required`, "u"),
      );
    }
    assert.throws(
      () => parseModelFinding({ ...finding(), confidence: 1 }, 0),
      /unknown field "confidence"/u,
    );
  });

  it("rejects unknown priorities and malformed ranges", () => {
    const cases = [
      finding("P4"),
      { ...finding(), range: { start: 0, end: 1, side: "RIGHT" } },
      { ...finding(), range: { start: 2, end: 1, side: "RIGHT" } },
      { ...finding(), range: { start: 1, end: 51, side: "RIGHT" } },
      { ...finding(), range: { start: 1, end: 1, side: "BOTH" } },
      { ...finding(), range: { start: 1, end: 1, side: "RIGHT", position: 1 } },
    ];
    for (const candidate of cases) {
      assert.throws(() => parseModelFinding(candidate, 0), FindingSchemaError);
    }
  });

  it("rejects empty, untrimmed, multiline-title, and wrong-type fields", () => {
    const cases = [
      { ...finding(), title: "" },
      { ...finding(), title: " padded " },
      { ...finding(), title: "two\nlines" },
      { ...finding(), evidence: null },
      { ...finding(), path: "source\u0000.ts" },
    ];
    for (const candidate of cases) {
      assert.throws(() => parseModelFinding(candidate, 0), FindingSchemaError);
    }
  });
});
