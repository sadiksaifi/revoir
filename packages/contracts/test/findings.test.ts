import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FindingSchemaError, parseModelFinding, parseModelReviewOutput } from "../src/findings.js";

function finding(priority = "P1") {
  return {
    priority,
    path: "src/review.ts",
    range: { start: 10, end: 12, side: "RIGHT" },
    defectKind: "concurrency",
    impactKind: "execution-stall",
    fixAction: "synchronize",
    anchor: "submitSignal",
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

  it("preserves exact Git path and technical-anchor code points", () => {
    const decomposedPath = " dir/cafe\u0301 [literal] .ts ";
    const candidate = finding();
    const parsed = parseModelFinding(
      {
        ...candidate,
        path: decomposedPath,
        anchor: "cafe\u0301Signal",
      },
      0,
    );

    assert.equal(parsed.path, decomposedPath);
    assert.deepEqual(Buffer.from(parsed.path), Buffer.from(decomposedPath));
    assert.equal(parsed.anchor, "cafe\u0301Signal");
    assert.deepEqual(Buffer.from(parsed.anchor), Buffer.from("cafe\u0301Signal"));
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

  it("keeps model-controlled contract versions and field names out of diagnostics", () => {
    const sourceSecret = "PRIVATE_SOURCE_TOKEN";
    const cases: readonly [string, RegExp][] = [
      [`{"version":"${sourceSecret}","findings":[]}`, /expected version 1/u],
      [
        JSON.stringify({ version: 1, findings: [], [sourceSecret]: "echo" }),
        /review output contains an unknown field/u,
      ],
      [
        JSON.stringify({
          version: 1,
          findings: [{ ...finding(), [sourceSecret]: "echo" }],
        }),
        /findings\[0\] contains an unknown field/u,
      ],
    ];

    for (const [value, safeReason] of cases) {
      assert.throws(
        () => {
          const envelope = parseModelReviewOutput(value);
          if (envelope.findings.length > 0) {
            parseModelFinding(envelope.findings[0], 0);
          }
        },
        (error: unknown) => {
          assert.ok(error instanceof FindingSchemaError);
          assert.match(error.message, safeReason);
          assert.doesNotMatch(error.message, new RegExp(sourceSecret, "u"));
          return true;
        },
      );
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
      /contains an unknown field/u,
    );
  });

  it("rejects unknown priorities, semantic enums, and malformed ranges", () => {
    const cases = [
      finding("P4"),
      { ...finding(), defectKind: "praise" },
      { ...finding(), impactKind: "maybe-bad" },
      { ...finding(), fixAction: "consider" },
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

  it("rejects empty, untrimmed, multiline, and wrong-type string fields", () => {
    const cases = [
      { ...finding(), anchor: "" },
      { ...finding(), anchor: " padded " },
      { ...finding(), anchor: "two\nlines" },
      { ...finding(), anchor: null },
      { ...finding(), path: "source\u0000.ts" },
      { ...finding(), path: "source\ud800.ts" },
      { ...finding(), path: "source\nline.ts" },
    ];
    for (const candidate of cases) {
      assert.throws(() => parseModelFinding(candidate, 0), FindingSchemaError);
    }
  });

  it("rejects unpaired UTF-16 surrogates in every contract string before field rules", () => {
    const malformed = [
      "trailing\ud800",
      "leading\ud800tail",
      "leading\ud800X",
      "leading\udc00tail",
    ];
    const fields = ["priority", "path", "defectKind", "impactKind", "fixAction", "anchor"] as const;

    for (const field of fields) {
      for (const value of malformed) {
        assert.throws(
          () => parseModelFinding({ ...finding(), [field]: value }, 0),
          /must contain only Unicode scalar values/u,
        );
      }
    }
    for (const value of malformed) {
      assert.throws(
        () => parseModelFinding({ ...finding(), range: { start: 1, end: 1, side: value } }, 0),
        /must contain only Unicode scalar values/u,
      );
      assert.throws(
        () => parseModelReviewOutput(JSON.stringify({ version: value, findings: [] })),
        /must contain only Unicode scalar values/u,
      );
    }
  });

  it("round-trips valid astral characters in exact path and anchor strings", () => {
    const astral = "queue-\u{1f680}";
    const parsed = parseModelFinding(
      {
        ...finding(),
        path: `${astral}.ts`,
        anchor: astral,
      },
      0,
    );

    assert.equal(parsed.path, `${astral}.ts`);
    assert.equal(parsed.anchor, astral);
  });
});
