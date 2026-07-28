import type { ReviewFindingV1 } from "./findings.js";

export interface OwnedFindingThread {
  readonly id: string;
  readonly fingerprint: string;
}

export interface PriorReviewState {
  readonly activeFingerprints: readonly string[];
  readonly ownedOpenThreads: readonly OwnedFindingThread[];
  readonly runHeadShas: readonly string[];
}

export interface FindingReconciliationPlan {
  readonly netNewFindings: readonly ReviewFindingV1[];
  readonly obsoleteThreadIds: readonly string[];
}

export function planFindingReconciliation(
  findings: readonly ReviewFindingV1[],
  prior: PriorReviewState,
): FindingReconciliationPlan {
  const currentFingerprints = new Set(findings.map(({ fingerprint }) => fingerprint));
  const activeFingerprints = new Set(prior.activeFingerprints);
  const obsoleteThreadIds = new Set<string>();

  for (const thread of prior.ownedOpenThreads) {
    activeFingerprints.add(thread.fingerprint);
    if (!currentFingerprints.has(thread.fingerprint)) {
      obsoleteThreadIds.add(thread.id);
    }
  }

  return {
    netNewFindings: findings.filter(({ fingerprint }) => !activeFingerprints.has(fingerprint)),
    obsoleteThreadIds: [...obsoleteThreadIds].sort(),
  };
}
