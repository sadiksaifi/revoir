import type { ReviewFindingV1 } from "./findings.js";

const FINDING_MARKER = /<!-- revoir:finding:v1:([0-9a-f]{64}) -->/gu;
const RUN_MARKER = /<!-- revoir:run:v1:([0-9a-f]{40,64}) -->/gu;

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

function markerValues(value: string, pattern: RegExp): string[] {
  return [...value.matchAll(pattern)].map((match) => match[1]!);
}

export function findingMarkerFingerprints(value: string): string[] {
  return markerValues(value, FINDING_MARKER);
}

export function runMarkerHeadShas(value: string): string[] {
  return markerValues(value, RUN_MARKER);
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
