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
  readonly bodyStateMigrationRequired?: boolean;
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

interface CurrentFindingIdentity extends PriorFindingIdentity {
  readonly semanticFingerprint: string;
}

function currentFindingIdentity(finding: ReviewFindingV1): CurrentFindingIdentity {
  const semanticFingerprint = findingFingerprint(finding);
  const aliases = new Set([
    ...(finding.fingerprintAliases ?? []),
    semanticFingerprint,
    prerequisiteFindingFingerprint(finding),
  ]);
  aliases.delete(finding.fingerprint);
  return {
    fingerprint: finding.fingerprint,
    semanticFingerprint,
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

interface IndexedIdentity<T extends PriorFindingIdentity> {
  readonly index: number;
  readonly identity: T;
}

function identitiesIntersect(left: PriorFindingIdentity, right: PriorFindingIdentity): boolean {
  const rightFingerprints = identityFingerprints(right);
  return [...identityFingerprints(left)].some((fingerprint) => rightFingerprints.has(fingerprint));
}

function compareCurrentIdentity(
  left: IndexedIdentity<CurrentFindingIdentity>,
  right: IndexedIdentity<CurrentFindingIdentity>,
): number {
  return (
    left.identity.fingerprint.localeCompare(right.identity.fingerprint) || left.index - right.index
  );
}

function comparePriorIdentity(
  left: IndexedIdentity<MatchablePriorIdentity>,
  right: IndexedIdentity<MatchablePriorIdentity>,
): number {
  return (
    left.identity.fingerprint.localeCompare(right.identity.fingerprint) ||
    (left.identity.threadId ?? "").localeCompare(right.identity.threadId ?? "") ||
    left.identity.source.localeCompare(right.identity.source) ||
    left.index - right.index
  );
}

function tokenCounts<T extends PriorFindingIdentity>(
  identities: readonly IndexedIdentity<T>[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { identity } of identities) {
    for (const token of identityFingerprints(identity)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

function discriminativeScore(
  current: CurrentFindingIdentity,
  prior: MatchablePriorIdentity,
  semanticFingerprint: string,
  currentTokenCounts: ReadonlyMap<string, number>,
  priorTokenCounts: ReadonlyMap<string, number>,
): number {
  const priorTokens = identityFingerprints(prior);
  let score = 0;
  for (const token of identityFingerprints(current)) {
    if (
      token === semanticFingerprint ||
      !priorTokens.has(token) ||
      currentTokenCounts.get(token) !== 1 ||
      priorTokenCounts.get(token) !== 1
    ) {
      continue;
    }
    score +=
      1 + Number(token === current.fingerprint) * 2 + Number(token === prior.fingerprint) * 2;
  }
  return score;
}

function maximumWeightPairs(weights: readonly (readonly number[])[]): readonly [number, number][] {
  const rowCount = weights.length;
  const columnCount = weights[0]?.length ?? 0;
  if (rowCount === 0 || columnCount === 0) {
    return [];
  }
  const size = Math.max(rowCount, columnCount);
  let maximumWeight = 0;
  for (const row of weights) {
    for (const weight of row) {
      maximumWeight = Math.max(maximumWeight, weight);
    }
  }
  if (maximumWeight === 0) {
    return [];
  }
  // Hungarian assignment keeps the strongest total evidence without depending on API ordering.
  const rowPotential = Array.from({ length: size + 1 }, () => 0);
  const columnPotential = Array.from({ length: size + 1 }, () => 0);
  const matchedRowByColumn = Array.from({ length: size + 1 }, () => 0);
  const previousColumn = Array.from({ length: size + 1 }, () => 0);

  for (let row = 1; row <= size; row += 1) {
    matchedRowByColumn[0] = row;
    let column = 0;
    const minimum = Array.from({ length: size + 1 }, () => Number.POSITIVE_INFINITY);
    const used = Array.from({ length: size + 1 }, () => false);
    do {
      used[column] = true;
      const matchedRow = matchedRowByColumn[column]!;
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidateColumn = 1; candidateColumn <= size; candidateColumn += 1) {
        if (used[candidateColumn]) {
          continue;
        }
        const weight =
          matchedRow <= rowCount && candidateColumn <= columnCount
            ? weights[matchedRow - 1]![candidateColumn - 1]!
            : 0;
        const cost =
          maximumWeight - weight - rowPotential[matchedRow]! - columnPotential[candidateColumn]!;
        if (cost < minimum[candidateColumn]!) {
          minimum[candidateColumn] = cost;
          previousColumn[candidateColumn] = column;
        }
        if (minimum[candidateColumn]! < delta) {
          delta = minimum[candidateColumn]!;
          nextColumn = candidateColumn;
        }
      }
      for (let candidateColumn = 0; candidateColumn <= size; candidateColumn += 1) {
        if (used[candidateColumn]) {
          const usedRow = matchedRowByColumn[candidateColumn]!;
          rowPotential[usedRow] = rowPotential[usedRow]! + delta;
          columnPotential[candidateColumn]! -= delta;
        } else {
          minimum[candidateColumn]! -= delta;
        }
      }
      column = nextColumn;
    } while (matchedRowByColumn[column] !== 0);

    do {
      const priorColumn = previousColumn[column]!;
      matchedRowByColumn[column] = matchedRowByColumn[priorColumn]!;
      column = priorColumn;
    } while (column !== 0);
  }

  const pairs: Array<[number, number]> = [];
  for (let column = 1; column <= columnCount; column += 1) {
    const row = matchedRowByColumn[column]! - 1;
    if (row >= 0 && row < rowCount && weights[row]![column - 1]! > 0) {
      pairs.push([row, column - 1]);
    }
  }
  return pairs;
}

function matchFindingIdentities(
  current: readonly CurrentFindingIdentity[],
  prior: readonly MatchablePriorIdentity[],
): {
  readonly currentMatches: ReadonlySet<number>;
  readonly priorMatches: ReadonlySet<number>;
  readonly priorByCurrent: ReadonlyMap<number, number>;
} {
  const currentMatches = new Set<number>();
  const priorMatches = new Set<number>();
  const priorByCurrent = new Map<number, number>();
  const recordMatch = (currentIndex: number, priorIndex: number): void => {
    currentMatches.add(currentIndex);
    priorMatches.add(priorIndex);
    priorByCurrent.set(currentIndex, priorIndex);
  };
  const currentGroups = new Map<string, Array<IndexedIdentity<CurrentFindingIdentity>>>();
  for (const [index, identity] of current.entries()) {
    const group = currentGroups.get(identity.semanticFingerprint) ?? [];
    group.push({ index, identity });
    currentGroups.set(identity.semanticFingerprint, group);
  }
  const priorGroups = new Map<string, Array<IndexedIdentity<MatchablePriorIdentity>>>();
  const semanticFingerprints = [...currentGroups.keys()].toSorted();
  for (const [index, identity] of prior.entries()) {
    const tokens = identityFingerprints(identity);
    // A prior identity may participate only when its persisted aliases identify one semantic
    // group. Legacy records without that alias can still migrate through one unique token overlap.
    let possibleGroups = semanticFingerprints.filter((fingerprint) => tokens.has(fingerprint));
    if (possibleGroups.length === 0) {
      possibleGroups = semanticFingerprints.filter((fingerprint) =>
        currentGroups
          .get(fingerprint)!
          .some(({ identity: currentIdentity }) => identitiesIntersect(currentIdentity, identity)),
      );
    }
    if (possibleGroups.length !== 1) {
      continue;
    }
    const semanticFingerprint = possibleGroups[0]!;
    const group = priorGroups.get(semanticFingerprint) ?? [];
    group.push({ index, identity });
    priorGroups.set(semanticFingerprint, group);
  }

  for (const semanticFingerprint of semanticFingerprints) {
    const currentGroup = currentGroups.get(semanticFingerprint)!.toSorted(compareCurrentIdentity);
    const priorGroup = (priorGroups.get(semanticFingerprint) ?? []).toSorted(comparePriorIdentity);
    const remainingCurrent = new Set(currentGroup.map(({ index }) => index));
    const remainingPrior = new Set(priorGroup.map(({ index }) => index));

    // Primary equality is authoritative and cannot be displaced by weaker aliases.
    for (const currentEntry of currentGroup) {
      const exact = priorGroup.find(
        (priorEntry) =>
          remainingPrior.has(priorEntry.index) &&
          currentEntry.identity.fingerprint === priorEntry.identity.fingerprint,
      );
      if (exact !== undefined) {
        recordMatch(currentEntry.index, exact.index);
        remainingCurrent.delete(currentEntry.index);
        remainingPrior.delete(exact.index);
      }
    }

    const discriminativeCurrent = currentGroup.filter(({ index }) => remainingCurrent.has(index));
    const discriminativePrior = priorGroup.filter(({ index }) => remainingPrior.has(index));
    const currentTokenCounts = tokenCounts(discriminativeCurrent);
    const priorTokenCounts = tokenCounts(discriminativePrior);
    const cardinalityScale = Math.max(discriminativeCurrent.length, discriminativePrior.length) + 1;
    const weights = discriminativeCurrent.map(({ identity: currentIdentity }) =>
      discriminativePrior.map(({ identity: priorIdentity }) => {
        const score = discriminativeScore(
          currentIdentity,
          priorIdentity,
          semanticFingerprint,
          currentTokenCounts,
          priorTokenCounts,
        );
        return score === 0 ? 0 : score * cardinalityScale + 1;
      }),
    );
    for (const [currentOffset, priorOffset] of maximumWeightPairs(weights)) {
      const currentEntry = discriminativeCurrent[currentOffset]!;
      const priorEntry = discriminativePrior[priorOffset]!;
      recordMatch(currentEntry.index, priorEntry.index);
      remainingCurrent.delete(currentEntry.index);
      remainingPrior.delete(priorEntry.index);
    }

    // A semantic alias alone proves continuity only when at least one original side is singular.
    // Residual many-to-many groups represent replacements unless another token discriminates them.
    if (currentGroup.length === 1 || priorGroup.length === 1) {
      const fallbackCurrent = currentGroup.find(({ index }) => remainingCurrent.has(index));
      const fallbackPrior = priorGroup.find(
        ({ index, identity }) =>
          remainingPrior.has(index) && identityFingerprints(identity).has(semanticFingerprint),
      );
      if (fallbackCurrent !== undefined && fallbackPrior !== undefined) {
        recordMatch(fallbackCurrent.index, fallbackPrior.index);
      }
    }
  }

  return {
    currentMatches,
    priorMatches,
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
    prior.bodyStateMigrationRequired === true ||
    (prior.bodyFindings !== undefined &&
      identitySnapshot(currentBodyState) !== identitySnapshot(priorBodyFindings));

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
