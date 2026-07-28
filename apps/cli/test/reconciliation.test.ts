import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewFindingV1 } from "../src/review/findings.js";
import { planFindingReconciliation } from "../src/review/reconciliation.js";

function finding(fingerprint: string, startLine: number): ReviewFindingV1 {
  return {
    version: 1,
    fingerprint,
    priority: "P1",
    path: "source.ts",
    range: { start: startLine, end: startLine, side: "RIGHT" },
    defectKind: "correctness",
    impactKind: "incorrect-result",
    fixAction: "restore",
    anchor: "currentValue",
    attachment: {
      kind: "inline",
      path: "source.ts",
      startLine,
      endLine: startLine,
      side: "RIGHT",
    },
  };
}

describe("finding reconciliation", () => {
  it("keeps a finding published with the prerequisite v1 fingerprint unchanged", () => {
    const unchanged = finding("a".repeat(64), 40);
    const publishedV1Fingerprint =
      "ad56f42afdf550df6ca0ae4627140ed572f1e4a5c4be3754b838503a1aea2920";

    assert.deepEqual(
      planFindingReconciliation([unchanged], {
        activeFingerprints: [publishedV1Fingerprint],
        ownedOpenThreads: [{ id: "THREAD_PUBLISHED_V1", fingerprint: publishedV1Fingerprint }],
        runHeadShas: ["1".repeat(40)],
      }),
      {
        netNewFindings: [],
        obsoleteThreadIds: [],
        currentBodyFindings: [],
        bodyStateChanged: false,
      },
    );
  });

  it("keeps unchanged findings, publishes net-new findings, and resolves obsolete owned threads", () => {
    const unchanged = finding("a".repeat(64), 40);
    const changed = finding("b".repeat(64), 12);

    assert.deepEqual(
      planFindingReconciliation([unchanged, changed], {
        activeFingerprints: ["a".repeat(64)],
        ownedOpenThreads: [
          { id: "THREAD_Z", fingerprint: "c".repeat(64) },
          { id: "THREAD_A", fingerprint: "a".repeat(64) },
          { id: "THREAD_B", fingerprint: "d".repeat(64) },
        ],
        runHeadShas: ["1".repeat(40)],
      }),
      {
        netNewFindings: [changed],
        obsoleteThreadIds: ["THREAD_B", "THREAD_Z"],
        currentBodyFindings: [],
        bodyStateChanged: false,
      },
    );
  });

  it("deduplicates prior GitHub state and produces deterministic resolution order", () => {
    const current = finding("e".repeat(64), 7);
    assert.deepEqual(
      planFindingReconciliation([current], {
        activeFingerprints: ["e".repeat(64), "e".repeat(64)],
        ownedOpenThreads: [
          { id: "THREAD_2", fingerprint: "f".repeat(64) },
          { id: "THREAD_1", fingerprint: "f".repeat(64) },
          { id: "THREAD_2", fingerprint: "f".repeat(64) },
        ],
        runHeadShas: [],
      }),
      {
        netNewFindings: [],
        obsoleteThreadIds: ["THREAD_1", "THREAD_2"],
        currentBodyFindings: [],
        bodyStateChanged: false,
      },
    );
  });

  it("tracks body findings as a complete snapshot across delta and retirement runs", () => {
    const retained = {
      ...finding("a".repeat(64), 7),
      range: null,
      attachment: { kind: "file", path: "source.ts" } as const,
    };
    const netNew = {
      ...retained,
      fingerprint: "b".repeat(64),
      anchor: "otherValue",
    };
    const deltaPlan = planFindingReconciliation([retained, netNew], {
      activeFingerprints: [retained.fingerprint],
      bodyFindings: [{ fingerprint: retained.fingerprint }],
      ownedOpenThreads: [],
      runHeadShas: ["1".repeat(40)],
    });
    assert.deepEqual(deltaPlan.netNewFindings, [netNew]);
    assert.deepEqual(deltaPlan.currentBodyFindings, [retained, netNew]);
    assert.equal(deltaPlan.bodyStateChanged, true);

    const unchangedInline = finding("c".repeat(64), 9);
    const retirementPlan = planFindingReconciliation([unchangedInline], {
      activeFingerprints: [retained.fingerprint, unchangedInline.fingerprint],
      bodyFindings: [{ fingerprint: retained.fingerprint }],
      ownedOpenThreads: [{ id: "THREAD_CURRENT", fingerprint: unchangedInline.fingerprint }],
      runHeadShas: ["2".repeat(40)],
    });
    assert.deepEqual(retirementPlan.netNewFindings, []);
    assert.deepEqual(retirementPlan.currentBodyFindings, []);
    assert.equal(retirementPlan.bodyStateChanged, true);

    const returnPlan = planFindingReconciliation([retained], {
      activeFingerprints: [],
      bodyFindings: [],
      ownedOpenThreads: [],
      runHeadShas: ["3".repeat(40)],
    });
    assert.deepEqual(returnPlan.netNewFindings, [retained]);
  });
});
