import type { FindingDefectKind, FindingFixAction, FindingImpactKind } from "@revoir/contracts";

import type { ReviewFindingV2 } from "./findings.js";

export interface GitHubInlineReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

export interface GitHubReviewPayload {
  commit_id: string;
  body?: string;
  comments?: readonly GitHubInlineReviewComment[];
}

export interface ReviewPublication {
  payload: GitHubReviewPayload;
  fallbackPayload: GitHubReviewPayload;
}

function code(value: string): string {
  const runs = [...value.matchAll(/`+/gu)].map((match) => match[0].length);
  const delimiter = "`".repeat(Math.max(0, ...runs) + 1);
  return `${delimiter}${value}${delimiter}`;
}

const TITLES: Readonly<Record<FindingDefectKind, string>> = {
  correctness: "Incorrect behavior",
  validation: "Missing validation",
  "resource-lifecycle": "Resource lifecycle defect",
  concurrency: "Concurrency defect",
  security: "Security boundary defect",
  privacy: "Privacy defect",
  performance: "Performance regression",
  architecture: "Architecture defect",
  compatibility: "Compatibility regression",
  "error-handling": "Error handling defect",
  "test-coverage": "Missing regression coverage",
};

const IMPACTS: Readonly<Record<FindingImpactKind, string>> = {
  "incorrect-result": "The affected operation returns an incorrect result.",
  "operation-failure": "The affected operation fails for a supported input.",
  "data-loss": "The affected operation loses persisted or in-flight data.",
  "resource-leak": "The affected resource remains retained after the operation ends.",
  "execution-stall": "The affected execution path stops making progress.",
  "security-exposure": "The affected boundary exposes data or authority to an untrusted input.",
  "privacy-exposure": "The affected path exposes or retains personal data beyond its intended scope.",
  "performance-degradation": "The affected path consumes materially more time or resources.",
  "boundary-violation": "The affected change violates a required architectural boundary.",
  "compatibility-break": "Existing consumers no longer receive the supported behavior.",
  "regression-risk": "The changed behavior lacks an automated regression signal.",
};

const FIX_DIRECTIONS: Readonly<Record<FindingFixAction, (anchor: string) => string>> = {
  guard: (anchor) => `Guard ${code(anchor)} before the affected operation.`,
  validate: (anchor) => `Validate the data handled by ${code(anchor)} before use.`,
  preserve: (anchor) => `Preserve the established contract at ${code(anchor)}.`,
  propagate: (anchor) => `Propagate the required state through ${code(anchor)}.`,
  synchronize: (anchor) => `Synchronize the transition performed by ${code(anchor)}.`,
  release: (anchor) => `Release the retained resource at ${code(anchor)}.`,
  minimize: (anchor) => `Limit personal-data handling at ${code(anchor)} to the required scope.`,
  optimize: (anchor) => `Remove the avoidable work or resource cost at ${code(anchor)}.`,
  decouple: (anchor) => `Restore the intended architectural boundary at ${code(anchor)}.`,
  restore: (anchor) => `Restore the required behavior at ${code(anchor)}.`,
  "add-test": (anchor) => `Add regression coverage for ${code(anchor)}.`,
};

function canonicalEvidence(finding: ReviewFindingV2): string {
  if (finding.range === null) {
    return `The authoritative file change for ${code(finding.path)} contains ${code(finding.anchor)}.`;
  }
  const lines =
    finding.range.start === finding.range.end
      ? `line ${finding.range.start}`
      : `lines ${finding.range.start}-${finding.range.end}`;
  return `The authoritative diff contains ${code(finding.anchor)} on ${finding.range.side} ${lines} in ${code(finding.path)}.`;
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

function details(finding: ReviewFindingV2, location?: string): string {
  const explicit = location ?? explicitLocation(finding);
  const identityMarkers = [
    `<!-- revoir:finding:v1:${finding.fingerprint} -->`,
    ...(finding.fingerprintAliases ?? []).map(
      (alias) => `<!-- revoir:finding-alias:v1:${finding.fingerprint}:${alias} -->`,
    ),
  ];
  return [
    `### ${finding.priority} — ${TITLES[finding.defectKind]}`,
    "",
    `- Location: ${code(explicit)}`,
    `- Reason: ${markdownText(finding.reason)}`,
    `- Impact: ${IMPACTS[finding.impactKind]}`,
    `- Evidence: ${canonicalEvidence(finding)}`,
    `- Fix direction: ${FIX_DIRECTIONS[finding.fixAction](finding.anchor)}`,
    "",
    ...identityMarkers,
  ].join("\n");
}

function explicitLocation(finding: ReviewFindingV2): string {
  if (finding.range === null) {
    return finding.path;
  }
  const lines =
    finding.range.start === finding.range.end
      ? String(finding.range.start)
      : `${finding.range.start}-${finding.range.end}`;
  return `${finding.path}:${lines} (${finding.range.side})`;
}

export function renderInlineFinding(finding: ReviewFindingV2): string {
  return details(finding);
}

export function renderFileFinding(finding: ReviewFindingV2): string {
  return details(finding, explicitLocation(finding));
}

export function renderRunMarker(commitId: string): string {
  return `<!-- revoir:run:v1:${commitId} -->`;
}

function bodyState(findings: readonly ReviewFindingV2[]): string {
  const identities = new Map<string, Set<string>>();
  for (const finding of findings) {
    const aliases = identities.get(finding.fingerprint) ?? new Set<string>();
    for (const alias of finding.fingerprintAliases ?? []) {
      aliases.add(alias);
    }
    identities.set(finding.fingerprint, aliases);
  }
  const markers = ["<!-- revoir:body-state:v1 -->"];
  for (const [fingerprint, aliases] of [...identities].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    markers.push(`<!-- revoir:body-finding:v1:${fingerprint} -->`);
    for (const alias of [...aliases].toSorted()) {
      markers.push(`<!-- revoir:body-finding-alias:v1:${fingerprint}:${alias} -->`);
    }
  }
  return markers.join("\n");
}

export function createReviewPublication(
  commitId: string,
  findings: readonly ReviewFindingV2[],
  currentBodyFindings: readonly ReviewFindingV2[] = findings.filter(
    (finding) => finding.attachment.kind === "file",
  ),
): ReviewPublication {
  const comments: GitHubInlineReviewComment[] = [];
  const bodyFindings: ReviewFindingV2[] = [];
  for (const finding of findings) {
    if (finding.attachment.kind === "inline") {
      comments.push({
        path: finding.attachment.path,
        line: finding.attachment.endLine,
        side: finding.attachment.side,
        ...(finding.attachment.startLine === finding.attachment.endLine
          ? {}
          : {
              start_line: finding.attachment.startLine,
              start_side: finding.attachment.side,
            }),
        body: renderInlineFinding(finding),
      });
    } else {
      bodyFindings.push(finding);
    }
  }

  const marker = renderRunMarker(commitId);
  const body = [
    ...(bodyFindings.length === 0 ? [] : [bodyFindings.map(renderFileFinding).join("\n\n")]),
    bodyState(currentBodyFindings),
    marker,
  ].join("\n\n");
  const fallbackBodyFindings = new Map(
    currentBodyFindings.concat(findings).map((finding) => [finding.fingerprint, finding]),
  );
  const fallbackBody = [
    ...(findings.length === 0 ? [] : [findings.map(renderFileFinding).join("\n\n")]),
    bodyState([...fallbackBodyFindings.values()]),
    marker,
  ].join("\n\n");
  return {
    payload: {
      commit_id: commitId,
      body,
      ...(comments.length === 0 ? {} : { comments }),
    },
    fallbackPayload: {
      commit_id: commitId,
      body: fallbackBody,
    },
  };
}
