import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findingFingerprint, type ReviewFindingV1 } from "../src/review/findings.js";
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

function token(character: string): string {
  return character.repeat(64);
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

  it("does not pair a same-count occurrence replacement through the shared semantic alias", () => {
    const retained = {
      ...finding(token("a"), 2),
      fingerprintAliases: [token("d")],
    };
    const added = {
      ...finding(token("c"), 8),
      fingerprintAliases: [token("f")],
    };
    const semantic = findingFingerprint(retained);
    const retainedThread = {
      id: "THREAD_RETAINED",
      fingerprint: token("a"),
      aliases: [semantic, token("d")],
    };
    const removedThread = {
      id: "THREAD_REMOVED",
      fingerprint: token("b"),
      aliases: [semantic, token("e")],
    };

    for (const findings of [
      [retained, added],
      [added, retained],
    ]) {
      for (const ownedOpenThreads of [
        [retainedThread, removedThread],
        [removedThread, retainedThread],
      ]) {
        const plan = planFindingReconciliation(findings, {
          activeFingerprints: [token("a"), token("b")],
          ownedOpenThreads,
          runHeadShas: ["1".repeat(40)],
        });
        assert.deepEqual(plan.netNewFindings, [added]);
        assert.deepEqual(plan.obsoleteThreadIds, ["THREAD_REMOVED"]);
        assert.deepEqual(plan.currentBodyFindings, []);
        assert.equal(plan.bodyStateChanged, false);
      }
    }
  });

  it("locks exact identities before deterministic weighted stable and context matches", () => {
    const exact = finding(token("a"), 2);
    const stable = {
      ...finding(token("c"), 5),
      fingerprintAliases: [token("b"), token("2")],
    };
    const contextual = {
      ...finding(token("e"), 8),
      fingerprintAliases: [token("1"), token("3")],
    };
    const semantic = findingFingerprint(exact);

    assert.deepEqual(
      planFindingReconciliation([contextual, exact, stable], {
        activeFingerprints: [token("a"), token("b"), token("d")],
        bodyFindings: [
          {
            fingerprint: token("b"),
            aliases: [semantic, token("1")],
          },
        ],
        ownedOpenThreads: [
          {
            id: "THREAD_CONTEXT",
            fingerprint: token("d"),
            aliases: [semantic, token("2"), token("3")],
          },
          {
            id: "THREAD_EXACT",
            fingerprint: token("a"),
            aliases: [semantic],
          },
        ],
        runHeadShas: ["1".repeat(40)],
      }),
      {
        netNewFindings: [],
        obsoleteThreadIds: [],
        currentBodyFindings: [stable],
        bodyStateChanged: true,
      },
    );
  });

  it("uses semantic-only fallback only when one side of the group is a singleton", () => {
    const first = finding(token("a"), 2);
    const second = finding(token("b"), 5);
    const semantic = findingFingerprint(first);
    const oneToMany = planFindingReconciliation([second, first], {
      activeFingerprints: [token("d")],
      ownedOpenThreads: [
        {
          id: "THREAD_SINGLE",
          fingerprint: token("d"),
          aliases: [semantic],
        },
      ],
      runHeadShas: ["1".repeat(40)],
    });
    assert.deepEqual(oneToMany.netNewFindings, [second]);
    assert.deepEqual(oneToMany.obsoleteThreadIds, []);

    const manyToOne = planFindingReconciliation([finding(token("c"), 8)], {
      activeFingerprints: [token("d"), token("e")],
      ownedOpenThreads: [
        {
          id: "THREAD_HIGHER",
          fingerprint: token("e"),
          aliases: [semantic],
        },
        {
          id: "THREAD_LOWER",
          fingerprint: token("d"),
          aliases: [semantic],
        },
      ],
      runHeadShas: ["2".repeat(40)],
    });
    assert.deepEqual(manyToOne.netNewFindings, []);
    assert.deepEqual(manyToOne.obsoleteThreadIds, ["THREAD_HIGHER"]);
  });

  it("leaves ambiguous many-to-many semantic-only residuals unmatched", () => {
    const first = finding(token("a"), 2);
    const second = finding(token("b"), 5);
    const semantic = findingFingerprint(first);

    assert.deepEqual(
      planFindingReconciliation([second, first], {
        activeFingerprints: [token("c"), token("d")],
        ownedOpenThreads: [
          { id: "THREAD_D", fingerprint: token("d"), aliases: [semantic] },
          { id: "THREAD_C", fingerprint: token("c"), aliases: [semantic] },
        ],
        runHeadShas: ["1".repeat(40)],
      }),
      {
        netNewFindings: [second, first],
        obsoleteThreadIds: ["THREAD_C", "THREAD_D"],
        currentBodyFindings: [],
        bodyStateChanged: false,
      },
    );
  });

  it("preserves legacy aliases, body migration, and thread identities within one group", () => {
    const legacyToken = token("1");
    const legacy = {
      ...finding(token("a"), 2),
      fingerprintAliases: [legacyToken],
    };
    const body = {
      ...finding(token("b"), 5),
      fingerprintAliases: [token("2")],
      range: null,
      attachment: { kind: "file", path: "source.ts" } as const,
    };
    const thread = {
      ...finding(token("c"), 8),
      fingerprintAliases: [token("3")],
    };
    const semantic = findingFingerprint(legacy);

    assert.deepEqual(
      planFindingReconciliation([thread, body, legacy], {
        activeFingerprints: [legacyToken, token("b"), token("4")],
        bodyFindings: [{ fingerprint: token("b"), aliases: [token("2")] }],
        bodyStateMigrationRequired: true,
        ownedOpenThreads: [
          {
            id: "THREAD_CURRENT",
            fingerprint: token("4"),
            aliases: [semantic, token("3")],
          },
        ],
        runHeadShas: ["1".repeat(40)],
      }),
      {
        netNewFindings: [],
        obsoleteThreadIds: [],
        currentBodyFindings: [body],
        bodyStateChanged: true,
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

  it("persists changed body aliases before a same-anchor peer appears", () => {
    const primary = "a".repeat(64);
    const contextA = "b".repeat(64);
    const contextB = "c".repeat(64);
    const movedBodyFinding = {
      ...finding(primary, 7),
      fingerprintAliases: [contextB],
      range: null,
      attachment: { kind: "file", path: "source.ts" } as const,
    };

    const aliasRefresh = planFindingReconciliation([movedBodyFinding], {
      activeFingerprints: [primary],
      bodyFindings: [{ fingerprint: primary, aliases: [contextA] }],
      ownedOpenThreads: [],
      runHeadShas: ["1".repeat(40)],
    });
    assert.deepEqual(aliasRefresh.netNewFindings, []);
    assert.equal(aliasRefresh.bodyStateChanged, true);

    const survivor = {
      ...movedBodyFinding,
      fingerprint: "d".repeat(64),
      fingerprintAliases: [primary, contextB],
    };
    const addedPeer = {
      ...movedBodyFinding,
      fingerprint: "e".repeat(64),
      fingerprintAliases: [primary, contextA],
    };
    const peerPlan = planFindingReconciliation([survivor, addedPeer], {
      activeFingerprints: [primary],
      bodyFindings: [{ fingerprint: primary, aliases: [contextB] }],
      ownedOpenThreads: [],
      runHeadShas: ["2".repeat(40)],
    });
    assert.deepEqual(peerPlan.netNewFindings, [addedPeer]);
  });
});
