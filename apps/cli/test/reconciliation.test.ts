import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findingFingerprint, type ReviewFindingV2 } from "../src/review/findings.js";
import { planFindingReconciliation } from "../src/review/reconciliation.js";

function finding(fingerprint: string, startLine: number): ReviewFindingV2 {
  return {
    version: 2,
    fingerprint,
    priority: "P1",
    path: "source.ts",
    range: { start: startLine, end: startLine, side: "RIGHT" },
    defectKind: "correctness",
    impactKind: "incorrect-result",
    fixAction: "restore",
    reason: "The changed value produces an incorrect result for supported callers.",
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
  it("keeps unchanged findings, publishes net-new findings, and resolves obsolete owned threads", () => {
    const unchanged = finding("a".repeat(64), 40);
    const changed = finding("b".repeat(64), 12);

    assert.deepEqual(
      planFindingReconciliation([unchanged, changed], {
        ownedOpenThreads: [
          { id: "THREAD_Z", fingerprint: "c".repeat(64) },
          {
            id: "THREAD_A",
            fingerprint: "a".repeat(64),
            aliases: [findingFingerprint(unchanged)],
          },
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

  it("does not migrate an aliasless prior finding through token overlap", () => {
    const current = {
      ...finding(token("a"), 40),
      fingerprintAliases: [token("b")],
    };

    assert.deepEqual(
      planFindingReconciliation([current], {
        ownedOpenThreads: [{ id: "THREAD_OLD", fingerprint: token("b") }],
        runHeadShas: [],
      }),
      {
        netNewFindings: [current],
        obsoleteThreadIds: ["THREAD_OLD"],
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

  it("matches repeated cohorts only to minimum multiplicity and preserves real transitions", () => {
    const repeated = token("1");
    const changedContext = token("2");
    const semantic = findingFingerprint(finding(token("a"), 2));
    const currentA = {
      ...finding(token("a"), 2),
      fingerprintAliases: [repeated],
    };
    const currentB = {
      ...finding(token("b"), 5),
      fingerprintAliases: [repeated],
    };
    const currentC = {
      ...finding(token("c"), 8),
      fingerprintAliases: [repeated],
    };
    const priorD = {
      id: "THREAD_D",
      fingerprint: token("d"),
      aliases: [semantic, repeated],
    };
    const priorE = {
      id: "THREAD_E",
      fingerprint: token("e"),
      aliases: [semantic, repeated],
    };
    const priorF = {
      id: "THREAD_F",
      fingerprint: token("f"),
      aliases: [semantic, repeated],
    };

    for (const findings of [
      [currentA, currentB, currentC],
      [currentC, currentB, currentA],
    ]) {
      for (const ownedOpenThreads of [
        [priorD, priorE],
        [priorE, priorD],
      ]) {
        const expansion = planFindingReconciliation(findings, {
          ownedOpenThreads,
          runHeadShas: ["1".repeat(40)],
        });
        assert.deepEqual(expansion.netNewFindings, [currentC]);
        assert.deepEqual(expansion.obsoleteThreadIds, []);
      }
    }

    const contraction = planFindingReconciliation([currentB, currentA], {
      ownedOpenThreads: [priorF, priorD, priorE],
      runHeadShas: ["2".repeat(40)],
    });
    assert.deepEqual(contraction.netNewFindings, []);
    assert.deepEqual(contraction.obsoleteThreadIds, ["THREAD_F"]);

    const contextReplacement = planFindingReconciliation(
      [
        { ...currentA, fingerprintAliases: [changedContext] },
        { ...currentB, fingerprintAliases: [changedContext] },
      ],
      {
        ownedOpenThreads: [priorD, priorE],
        runHeadShas: ["3".repeat(40)],
      },
    );
    assert.deepEqual(contextReplacement.netNewFindings, [
      { ...currentA, fingerprintAliases: [changedContext] },
      { ...currentB, fingerprintAliases: [changedContext] },
    ]);
    assert.deepEqual(contextReplacement.obsoleteThreadIds, ["THREAD_D", "THREAD_E"]);
  });

  it("partitions mixed cohorts by the full signature and fails closed across signatures", () => {
    const signatureX = token("1");
    const signatureY = token("2");
    const semantic = findingFingerprint(finding(token("a"), 2));
    const current = [
      { ...finding(token("a"), 2), fingerprintAliases: [signatureX] },
      { ...finding(token("b"), 5), fingerprintAliases: [signatureX] },
      { ...finding(token("c"), 8), fingerprintAliases: [signatureY] },
      { ...finding(token("d"), 11), fingerprintAliases: [signatureY] },
    ];
    const prior = [
      {
        id: "THREAD_E",
        fingerprint: token("e"),
        aliases: [semantic, signatureX],
      },
      {
        id: "THREAD_F",
        fingerprint: token("f"),
        aliases: [semantic, signatureX],
      },
      {
        id: "THREAD_G",
        fingerprint: token("g"),
        aliases: [semantic, signatureY],
      },
      {
        id: "THREAD_H",
        fingerprint: token("h"),
        aliases: [semantic, signatureY],
      },
    ];

    for (const findings of [current, current.toReversed()]) {
      for (const ownedOpenThreads of [prior, prior.toReversed()]) {
        const plan = planFindingReconciliation(findings, {
          ownedOpenThreads,
          runHeadShas: ["1".repeat(40)],
        });
        assert.deepEqual(plan.netNewFindings, []);
        assert.deepEqual(plan.obsoleteThreadIds, []);
      }
    }

    const crossSignatureCurrent = [
      {
        ...finding(token("a"), 2),
        fingerprintAliases: [signatureX, signatureY],
      },
      {
        ...finding(token("b"), 5),
        fingerprintAliases: [signatureX, signatureY],
      },
    ];
    const crossSignaturePlan = planFindingReconciliation(crossSignatureCurrent, {
      ownedOpenThreads: prior,
      runHeadShas: ["2".repeat(40)],
    });
    assert.deepEqual(crossSignaturePlan.netNewFindings, crossSignatureCurrent);
    assert.deepEqual(crossSignaturePlan.obsoleteThreadIds, [
      "THREAD_E",
      "THREAD_F",
      "THREAD_G",
      "THREAD_H",
    ]);
  });

  it("does not displace exact or unique matches while preserving body and thread counts", () => {
    const repeated = token("1");
    const unique = token("2");
    const exact = {
      ...finding(token("a"), 2),
      fingerprintAliases: [repeated],
    };
    const body = {
      ...finding(token("b"), 5),
      fingerprintAliases: [repeated, unique],
      range: null,
      attachment: { kind: "file", path: "source.ts" } as const,
    };
    const cohortC = {
      ...finding(token("c"), 8),
      fingerprintAliases: [repeated],
    };
    const cohortD = {
      ...finding(token("d"), 11),
      fingerprintAliases: [repeated],
    };
    const semantic = findingFingerprint(exact);
    const threads = [
      {
        id: "THREAD_EXACT",
        fingerprint: token("a"),
        aliases: [semantic, repeated],
      },
      {
        id: "THREAD_G",
        fingerprint: token("g"),
        aliases: [semantic, repeated],
      },
      {
        id: "THREAD_H",
        fingerprint: token("h"),
        aliases: [semantic, repeated],
      },
    ];

    for (const findings of [
      [body, cohortD, exact, cohortC],
      [cohortC, exact, cohortD, body],
    ]) {
      for (const ownedOpenThreads of [threads, threads.toReversed()]) {
        const plan = planFindingReconciliation(findings, {
          bodyFindings: [
            {
              fingerprint: token("f"),
              aliases: [semantic, repeated, unique],
            },
          ],
          ownedOpenThreads,
          runHeadShas: ["1".repeat(40)],
        });
        assert.deepEqual(plan.netNewFindings, []);
        assert.deepEqual(plan.obsoleteThreadIds, []);
        assert.deepEqual(plan.currentBodyFindings, [body]);
        assert.equal(plan.bodyStateChanged, true);
      }
    }
  });

  it("does not infer prior state from unversioned review-body markers", () => {
    const unversionedToken = token("1");
    const unversioned = {
      ...finding(token("a"), 2),
      fingerprintAliases: [unversionedToken],
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
    const semantic = findingFingerprint(unversioned);

    assert.deepEqual(
      planFindingReconciliation([thread, body, unversioned], {
        bodyFindings: [{ fingerprint: token("b"), aliases: [token("2")] }],
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
        netNewFindings: [unversioned],
        obsoleteThreadIds: [],
        currentBodyFindings: [body],
        bodyStateChanged: false,
      },
    );
  });

  it("deduplicates prior GitHub state and produces deterministic resolution order", () => {
    const current = finding("e".repeat(64), 7);
    assert.deepEqual(
      planFindingReconciliation([current], {
        ownedOpenThreads: [
          { id: "THREAD_2", fingerprint: "f".repeat(64) },
          { id: "THREAD_1", fingerprint: "f".repeat(64) },
          { id: "THREAD_2", fingerprint: "f".repeat(64) },
        ],
        runHeadShas: [],
      }),
      {
        netNewFindings: [current],
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
      bodyFindings: [{ fingerprint: retained.fingerprint }],
      ownedOpenThreads: [],
      runHeadShas: ["1".repeat(40)],
    });
    assert.deepEqual(deltaPlan.netNewFindings, [netNew]);
    assert.deepEqual(deltaPlan.currentBodyFindings, [retained, netNew]);
    assert.equal(deltaPlan.bodyStateChanged, true);

    const unchangedInline = finding("c".repeat(64), 9);
    const retirementPlan = planFindingReconciliation([unchangedInline], {
      bodyFindings: [{ fingerprint: retained.fingerprint }],
      ownedOpenThreads: [{ id: "THREAD_CURRENT", fingerprint: unchangedInline.fingerprint }],
      runHeadShas: ["2".repeat(40)],
    });
    assert.deepEqual(retirementPlan.netNewFindings, []);
    assert.deepEqual(retirementPlan.currentBodyFindings, []);
    assert.equal(retirementPlan.bodyStateChanged, true);

    const returnPlan = planFindingReconciliation([retained], {
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
      range: null,
      attachment: { kind: "file", path: "source.ts" } as const,
    };
    const semantic = findingFingerprint(movedBodyFinding);
    const currentMovedBodyFinding = {
      ...movedBodyFinding,
      fingerprintAliases: [semantic, contextB],
    };

    const aliasRefresh = planFindingReconciliation([currentMovedBodyFinding], {
      bodyFindings: [{ fingerprint: primary, aliases: [semantic, contextA] }],
      ownedOpenThreads: [],
      runHeadShas: ["1".repeat(40)],
    });
    assert.deepEqual(aliasRefresh.netNewFindings, []);
    assert.equal(aliasRefresh.bodyStateChanged, true);

    const survivor = {
      ...currentMovedBodyFinding,
      fingerprint: "d".repeat(64),
      fingerprintAliases: [semantic, primary, contextB],
    };
    const addedPeer = {
      ...currentMovedBodyFinding,
      fingerprint: "e".repeat(64),
      fingerprintAliases: [semantic, primary, contextA],
    };
    const peerPlan = planFindingReconciliation([survivor, addedPeer], {
      bodyFindings: [{ fingerprint: primary, aliases: [semantic, contextB] }],
      ownedOpenThreads: [],
      runHeadShas: ["2".repeat(40)],
    });
    assert.deepEqual(peerPlan.netNewFindings, [addedPeer]);
  });
});
