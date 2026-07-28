import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewFindingV1 } from "../src/review/findings.js";
import {
  createReviewPublication,
  renderFileFinding,
  renderInlineFinding,
} from "../src/review/publication.js";

function finding(overrides: Partial<ReviewFindingV1> = {}): ReviewFindingV1 {
  return {
    version: 1,
    fingerprint: "a".repeat(64),
    priority: "P1",
    title: "Cancellation is dropped",
    path: "src/review.ts",
    range: { start: 10, end: 10, side: "RIGHT" },
    issue: "The added call does not forward cancellation.",
    impact: "Timed-out work occupies the only review slot.",
    evidence: "The changed call omits the signal argument accepted by the callee.",
    fixDirection: "Pass the active signal to the call.",
    attachment: {
      kind: "inline",
      path: "src/review.ts",
      startLine: 10,
      endLine: 10,
      side: "RIGHT",
    },
    ...overrides,
  };
}

describe("findings-only review publication", () => {
  it("builds exact single- and multiline inline coordinates without a summary body", () => {
    const single = finding();
    const multiline = finding({
      fingerprint: "b".repeat(64),
      priority: "P2",
      path: "src/removed.ts",
      range: { start: 4, end: 6, side: "LEFT" },
      issue: "The deleted range removes the only bounds check.",
      attachment: {
        kind: "inline",
        path: "src/removed.ts",
        startLine: 4,
        endLine: 6,
        side: "LEFT",
      },
    });
    const publication = createReviewPublication("1".repeat(40), [single, multiline]);
    assert.deepEqual(publication.payload, {
      commit_id: "1".repeat(40),
      comments: [
        {
          path: "src/review.ts",
          line: 10,
          side: "RIGHT",
          body: renderInlineFinding(single),
        },
        {
          path: "src/removed.ts",
          line: 6,
          side: "LEFT",
          start_line: 4,
          start_side: "LEFT",
          body: renderInlineFinding(multiline),
        },
      ],
    });
    assert.equal("body" in publication.payload, false);
    assert.equal("event" in publication.payload, false);
  });

  it("places only unattachable findings in the same pending-review body", () => {
    const inline = finding();
    const file = finding({
      fingerprint: "c".repeat(64),
      priority: "P3",
      title: "Binary asset drops transparency",
      path: "assets/logo.png",
      range: null,
      issue: "The replacement image has no alpha channel.",
      attachment: { kind: "file", path: "assets/logo.png" },
    });
    const publication = createReviewPublication("2".repeat(40), [inline, file]);
    assert.equal(publication.payload.body, renderFileFinding(file));
    assert.equal(publication.payload.comments?.length, 1);
    assert.equal(
      publication.fallbackPayload.body,
      `${renderFileFinding(inline)}\n\n${renderFileFinding(file)}`,
    );
    assert.equal("comments" in publication.fallbackPayload, false);
  });

  it("publishes required prose, explicit fallback locations, and stable metadata only", () => {
    const candidate = finding({
      path: "src/name`with-tick.ts",
      range: { start: 10, end: 12, side: "RIGHT" },
      attachment: {
        kind: "inline",
        path: "src/name`with-tick.ts",
        startLine: 10,
        endLine: 12,
        side: "RIGHT",
      },
    });
    const inline = renderInlineFinding(candidate);
    const file = renderFileFinding(candidate);
    for (const text of [inline, file]) {
      assert.match(text, /^### P1 — ``src\/name`with-tick\.ts:10-12 \(RIGHT\)``/mu);
      assert.doesNotMatch(text, /Cancellation is dropped/u);
      assert.match(text, /- Issue: /u);
      assert.match(text, /- Impact: /u);
      assert.match(text, /- Evidence: /u);
      assert.match(text, /- Fix direction: /u);
      assert.match(text, /<!-- revoir:finding:v1:[0-9a-f]{64} -->/u);
      assert.doesNotMatch(
        text,
        /\b(?:could|do not merge|great work|likely|looks good|may|merge this|must not merge|P1 means|summary)\b/iu,
      );
    }
    assert.doesNotMatch(inline, /- Location:/u);
    assert.doesNotMatch(file, /- Location:/u);
  });

  it("rejects an empty findings review", () => {
    assert.throws(
      () => createReviewPublication("3".repeat(40), []),
      /requires at least one validated finding/u,
    );
  });
});
