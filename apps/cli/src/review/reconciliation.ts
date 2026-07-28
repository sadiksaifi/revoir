import {
  findingFingerprint,
  prerequisiteFindingFingerprint,
  type ReviewFindingV1,
} from "./findings.js";

const FINDING_MARKER = /^<!-- revoir:finding:v1:([0-9a-f]{64}) -->\r?$/gmu;
const FINDING_ALIAS_MARKER =
  /^<!-- revoir:finding-alias:v1:([0-9a-f]{64}):([0-9a-f]{64}) -->\r?$/gmu;
const RUN_MARKER = /^<!-- revoir:run:v1:([0-9a-f]{40,64}) -->\r?$/gmu;

export interface PriorFindingIdentity {
  readonly fingerprint: string;
  readonly aliases?: readonly string[];
}

export interface OwnedFindingThread extends PriorFindingIdentity {
  readonly id: string;
}

export interface PriorReviewState {
  readonly activeFingerprints: readonly string[];
  readonly bodyFindings?: readonly PriorFindingIdentity[];
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

export function findingMarkerIdentities(value: string): PriorFindingIdentity[] {
  const aliasesByFingerprint = new Map<string, Set<string>>();
  for (const match of value.matchAll(FINDING_ALIAS_MARKER)) {
    const aliases = aliasesByFingerprint.get(match[1]!) ?? new Set<string>();
    aliases.add(match[2]!);
    aliasesByFingerprint.set(match[1]!, aliases);
  }
  const seen = new Set<string>();
  const identities: PriorFindingIdentity[] = [];
  for (const fingerprint of findingMarkerFingerprints(value)) {
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    const aliases = aliasesByFingerprint.get(fingerprint);
    identities.push({
      fingerprint,
      ...(aliases === undefined || aliases.size === 0 ? {} : { aliases: [...aliases].toSorted() }),
    });
  }
  return identities;
}

export function runMarkerHeadShas(value: string): string[] {
  return markerValues(value, RUN_MARKER);
}

function identityFingerprints(identity: PriorFindingIdentity): Set<string> {
  return new Set([identity.fingerprint, ...(identity.aliases ?? [])]);
}

function currentFindingIdentity(finding: ReviewFindingV1): PriorFindingIdentity {
  const aliases = new Set([
    ...(finding.fingerprintAliases ?? []),
    findingFingerprint(finding),
    prerequisiteFindingFingerprint(finding),
  ]);
  aliases.delete(finding.fingerprint);
  return {
    fingerprint: finding.fingerprint,
    ...(aliases.size === 0 ? {} : { aliases: [...aliases].toSorted() }),
  };
}

interface MatchablePriorIdentity extends PriorFindingIdentity {
  readonly threadId?: string;
}

function priorFindingIdentities(prior: PriorReviewState): MatchablePriorIdentity[] {
  const identities: MatchablePriorIdentity[] = [
    ...(prior.bodyFindings ?? []),
    ...prior.ownedOpenThreads.map(({ id, fingerprint, aliases }) => ({
      fingerprint,
      ...(aliases === undefined ? {} : { aliases }),
      threadId: id,
    })),
  ];
  for (const fingerprint of prior.activeFingerprints) {
    if (identities.some((identity) => identity.fingerprint === fingerprint)) {
      continue;
    }
    identities.push({ fingerprint });
  }
  return identities;
}

function intersectionSize(left: PriorFindingIdentity, right: PriorFindingIdentity): number {
  const rightFingerprints = identityFingerprints(right);
  let count = 0;
  for (const fingerprint of identityFingerprints(left)) {
    if (rightFingerprints.has(fingerprint)) {
      count += 1;
    }
  }
  return count;
}

function matchFindingIdentities(
  current: readonly PriorFindingIdentity[],
  prior: readonly MatchablePriorIdentity[],
): { readonly currentMatches: ReadonlySet<number>; readonly priorMatches: ReadonlySet<number> } {
  const candidates = current.map((identity) =>
    prior
      .map((priorIdentity, index) => ({
        index,
        intersection: intersectionSize(identity, priorIdentity),
        exact: identity.fingerprint === priorIdentity.fingerprint,
      }))
      .filter(({ intersection }) => intersection > 0)
      .toSorted(
        (left, right) =>
          Number(right.exact) - Number(left.exact) ||
          right.intersection - left.intersection ||
          prior[left.index]!.fingerprint.localeCompare(prior[right.index]!.fingerprint) ||
          (prior[left.index]!.threadId ?? "").localeCompare(prior[right.index]!.threadId ?? ""),
      ),
  );
  const matchedCurrentByPrior = new Map<number, number>();
  const assign = (currentIndex: number, visited: Set<number>): boolean => {
    for (const { index: priorIndex } of candidates[currentIndex]!) {
      if (visited.has(priorIndex)) {
        continue;
      }
      visited.add(priorIndex);
      const displaced = matchedCurrentByPrior.get(priorIndex);
      if (displaced === undefined || assign(displaced, visited)) {
        matchedCurrentByPrior.set(priorIndex, currentIndex);
        return true;
      }
    }
    return false;
  };
  const currentOrder = current
    .map((_identity, index) => index)
    .toSorted(
      (left, right) =>
        candidates[left]!.length - candidates[right]!.length ||
        current[left]!.fingerprint.localeCompare(current[right]!.fingerprint),
    );
  for (const currentIndex of currentOrder) {
    assign(currentIndex, new Set());
  }
  return {
    currentMatches: new Set(matchedCurrentByPrior.values()),
    priorMatches: new Set(matchedCurrentByPrior.keys()),
  };
}

export function planFindingReconciliation(
  findings: readonly ReviewFindingV1[],
  prior: PriorReviewState,
): FindingReconciliationPlan {
  const current = findings.map((finding) => currentFindingIdentity(finding));
  const previous = priorFindingIdentities(prior);
  const matches = matchFindingIdentities(current, previous);

  return {
    netNewFindings: findings.filter((_finding, index) => !matches.currentMatches.has(index)),
    obsoleteThreadIds: [
      ...new Set(
        previous.flatMap((identity, index) =>
          identity.threadId !== undefined && !matches.priorMatches.has(index)
            ? [identity.threadId]
            : [],
        ),
      ),
    ].toSorted(),
  };
}
