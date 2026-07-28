import {
  findingFingerprint,
  prerequisiteFindingFingerprint,
  type ReviewFindingV1,
} from "./findings.js";

const FINDING_MARKER = /^<!-- revoir:finding:v1:([0-9a-f]{64}) -->\r?$/gmu;
const FINDING_ALIAS_MARKER =
  /^<!-- revoir:finding-alias:v1:([0-9a-f]{64}):([0-9a-f]{64}) -->\r?$/gmu;
const BODY_STATE_MARKER = /^<!-- revoir:body-state:v1 -->\r?$/mu;
const BODY_FINDING_MARKER = /^<!-- revoir:body-finding:v1:([0-9a-f]{64}) -->\r?$/gmu;
const BODY_FINDING_ALIAS_MARKER =
  /^<!-- revoir:body-finding-alias:v1:([0-9a-f]{64}):([0-9a-f]{64}) -->\r?$/gmu;
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
  readonly currentBodyFindings: readonly ReviewFindingV1[];
  readonly bodyStateChanged: boolean;
}

function markerValues(value: string, pattern: RegExp): string[] {
  return [...value.matchAll(pattern)].map((match) => match[1]!);
}

export function findingMarkerFingerprints(value: string): string[] {
  return markerValues(value, FINDING_MARKER);
}

export function findingMarkerIdentities(value: string): PriorFindingIdentity[] {
  return markerIdentities(value, FINDING_MARKER, FINDING_ALIAS_MARKER);
}

function markerIdentities(
  value: string,
  marker: RegExp,
  aliasMarker: RegExp,
): PriorFindingIdentity[] {
  const aliasesByFingerprint = new Map<string, Set<string>>();
  for (const match of value.matchAll(aliasMarker)) {
    const aliases = aliasesByFingerprint.get(match[1]!) ?? new Set<string>();
    aliases.add(match[2]!);
    aliasesByFingerprint.set(match[1]!, aliases);
  }
  const seen = new Set<string>();
  const identities: PriorFindingIdentity[] = [];
  for (const fingerprint of markerValues(value, marker)) {
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

export function bodyStateFindingIdentities(
  value: string,
): readonly PriorFindingIdentity[] | undefined {
  if (!BODY_STATE_MARKER.test(value)) {
    return undefined;
  }
  return markerIdentities(value, BODY_FINDING_MARKER, BODY_FINDING_ALIAS_MARKER);
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

function identitySnapshot(identities: readonly PriorFindingIdentity[]): string {
  const aliasesByFingerprint = new Map<string, Set<string>>();
  for (const identity of identities) {
    const aliases = aliasesByFingerprint.get(identity.fingerprint) ?? new Set<string>();
    for (const alias of identity.aliases ?? []) {
      aliases.add(alias);
    }
    aliasesByFingerprint.set(identity.fingerprint, aliases);
  }
  return JSON.stringify(
    [...aliasesByFingerprint]
      .map(([fingerprint, aliases]) => [fingerprint, [...aliases].toSorted()] as const)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

interface MatchablePriorIdentity extends PriorFindingIdentity {
  readonly source: "body" | "thread" | "legacy";
  readonly threadId?: string;
}

function priorFindingIdentities(prior: PriorReviewState): MatchablePriorIdentity[] {
  const identities: MatchablePriorIdentity[] = [];
  for (const { fingerprint, aliases } of prior.bodyFindings ?? []) {
    identities.push(
      aliases === undefined
        ? { fingerprint, source: "body" }
        : { fingerprint, aliases, source: "body" },
    );
  }
  for (const { id, fingerprint, aliases } of prior.ownedOpenThreads) {
    identities.push(
      aliases === undefined
        ? { fingerprint, source: "thread", threadId: id }
        : { fingerprint, aliases, source: "thread", threadId: id },
    );
  }
  for (const fingerprint of prior.activeFingerprints) {
    if (identities.some((identity) => identity.fingerprint === fingerprint)) {
      continue;
    }
    identities.push({ fingerprint, source: "legacy" });
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
): {
  readonly currentMatches: ReadonlySet<number>;
  readonly priorMatches: ReadonlySet<number>;
  readonly priorByCurrent: ReadonlyMap<number, number>;
} {
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
        Number(candidates[right]![0]?.exact ?? false) -
          Number(candidates[left]![0]?.exact ?? false) ||
        (candidates[right]![0]?.intersection ?? 0) - (candidates[left]![0]?.intersection ?? 0) ||
        candidates[left]!.length - candidates[right]!.length ||
        current[left]!.fingerprint.localeCompare(current[right]!.fingerprint),
    );
  for (const currentIndex of currentOrder) {
    assign(currentIndex, new Set());
  }
  const priorByCurrent = new Map<number, number>();
  for (const [priorIndex, currentIndex] of matchedCurrentByPrior) {
    priorByCurrent.set(currentIndex, priorIndex);
  }
  return {
    currentMatches: new Set(matchedCurrentByPrior.values()),
    priorMatches: new Set(matchedCurrentByPrior.keys()),
    priorByCurrent,
  };
}

export function planFindingReconciliation(
  findings: readonly ReviewFindingV1[],
  prior: PriorReviewState,
): FindingReconciliationPlan {
  const current = findings.map((finding) => currentFindingIdentity(finding));
  const previous = priorFindingIdentities(prior);
  const matches = matchFindingIdentities(current, previous);
  const currentBodyFindings = findings.filter((finding, index) => {
    if (finding.attachment.kind === "file") {
      return true;
    }
    const priorIndex = matches.priorByCurrent.get(index);
    return priorIndex !== undefined && previous[priorIndex]?.source === "body";
  });
  const priorBodyFindings = prior.bodyFindings ?? [];
  const currentBodyState = currentBodyFindings.map(({ fingerprint, fingerprintAliases }) => ({
    fingerprint,
    ...(fingerprintAliases === undefined ? {} : { aliases: fingerprintAliases }),
  }));
  const bodyStateChanged =
    prior.bodyFindings !== undefined &&
    identitySnapshot(currentBodyState) !== identitySnapshot(priorBodyFindings);

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
    currentBodyFindings,
    bodyStateChanged,
  };
}
