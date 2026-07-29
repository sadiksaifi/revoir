import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewFindingV1 } from "../src/review/findings.js";
import {
  createReviewPublication,
  renderFileFinding,
  renderInlineFinding,
  renderRunMarker,
} from "../src/review/publication.js";

function finding(overrides: Partial<ReviewFindingV1> = {}): ReviewFindingV1 {
  return {
    version: 1,
    fingerprint: "a".repeat(64),
    priority: "P1",
    path: "src/review.ts",
    range: { start: 10, end: 10, side: "RIGHT" },
    defectKind: "concurrency",
    impactKind: "execution-stall",
    fixAction: "synchronize",
    anchor: "submitSignal",
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
  it("builds exact inline coordinates with only a stable hidden run marker", () => {
    const single = finding();
    const multiline = finding({
      fingerprint: "b".repeat(64),
      priority: "P2",
      path: "src/removed.ts",
      range: { start: 4, end: 6, side: "LEFT" },
      defectKind: "validation",
      impactKind: "operation-failure",
      fixAction: "validate",
      anchor: "boundsCheck",
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
      body: `<!-- revoir:body-state:v1 -->\n\n${renderRunMarker("1".repeat(40))}`,
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
    assert.equal("event" in publication.payload, false);
  });

  it("places only unattachable findings in the same pending-review body", () => {
    const inline = finding();
    const file = finding({
      fingerprint: "c".repeat(64),
      priority: "P3",
      path: "assets/logo.png",
      range: null,
      defectKind: "correctness",
      impactKind: "incorrect-result",
      fixAction: "restore",
      anchor: "logo.png",
      attachment: { kind: "file", path: "assets/logo.png" },
    });
    const publication = createReviewPublication("2".repeat(40), [inline, file]);
    assert.equal(
      publication.payload.body,
      `${renderFileFinding(file)}\n\n<!-- revoir:body-state:v1 -->\n<!-- revoir:body-finding:v1:${file.fingerprint} -->\n\n${renderRunMarker(
        "2".repeat(40),
      )}`,
    );
    assert.equal(publication.payload.comments?.length, 1);
    assert.equal(
      publication.fallbackPayload.body,
      `${renderFileFinding(inline)}\n\n${renderFileFinding(file)}\n\n<!-- revoir:body-state:v1 -->\n<!-- revoir:body-finding:v1:${inline.fingerprint} -->\n<!-- revoir:body-finding:v1:${file.fingerprint} -->\n\n${renderRunMarker("2".repeat(40))}`,
    );
    assert.equal("comments" in publication.fallbackPayload, false);
  });

  it("publishes the complete body-finding state with a delta review", () => {
    const retained = finding({
      fingerprint: "c".repeat(64),
      path: "retained.ts",
      range: null,
      anchor: "retained.ts",
      attachment: { kind: "file", path: "retained.ts" },
    });
    const netNew = finding({
      fingerprint: "d".repeat(64),
      path: "new.ts",
      range: null,
      anchor: "new.ts",
      attachment: { kind: "file", path: "new.ts" },
    });
    const publication = createReviewPublication("4".repeat(40), [netNew], [retained, netNew]);

    assert.doesNotMatch(publication.payload.body ?? "", /### P1[\s\S]*retained\.ts/u);
    assert.match(
      publication.payload.body ?? "",
      new RegExp(`<!-- revoir:body-finding:v1:${retained.fingerprint} -->`, "u"),
    );
    assert.match(
      publication.payload.body ?? "",
      new RegExp(`<!-- revoir:body-finding:v1:${netNew.fingerprint} -->`, "u"),
    );
  });

  it("publishes required prose, explicit fallback locations, and stable metadata only", () => {
    const candidate = finding({
      path: "src/name`with-tick.ts",
      range: { start: 10, end: 12, side: "RIGHT" },
      anchor: "name`with-tick",
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
      assert.match(text, /^### P1 — Concurrency defect$/mu);
      assert.match(text, /- Location: ``src\/name`with-tick\.ts:10-12 \(RIGHT\)``/u);
      assert.match(
        text,
        /- Issue: ``name`with-tick`` performs an unsynchronized concurrent transition\./u,
      );
      assert.match(text, /- Impact: The affected execution path stops making progress\./u);
      assert.match(
        text,
        /- Evidence: The authoritative diff contains ``name`with-tick`` on RIGHT lines 10-12 in ``src\/name`with-tick\.ts``\./u,
      );
      assert.match(
        text,
        /- Fix direction: Synchronize the transition performed by ``name`with-tick``\./u,
      );
      assert.match(text, /<!-- revoir:finding:v1:[0-9a-f]{64} -->/u);
      assert.doesNotMatch(
        text,
        /\b(?:could|do not merge|great work|likely|looks good|may|merge this|must not merge|P1 means|summary)\b/iu,
      );
    }
  });

  it("publishes an empty body-state transition without visible finding prose", () => {
    const publication = createReviewPublication("3".repeat(40), [], []);
    assert.doesNotMatch(publication.payload.body ?? "", /### P[0-3]/u);
    assert.match(publication.payload.body ?? "", /<!-- revoir:body-state:v1 -->/u);
  });
});
