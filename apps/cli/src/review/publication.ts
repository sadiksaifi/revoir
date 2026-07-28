import type { FindingDefectKind, FindingFixAction, FindingImpactKind } from "@revoir/contracts";

import type { ReviewFindingV1 } from "./findings.js";

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
  compatibility: "Compatibility regression",
  "error-handling": "Error handling defect",
  "test-coverage": "Missing regression coverage",
};

const ISSUES: Readonly<Record<FindingDefectKind, (anchor: string) => string>> = {
  correctness: (anchor) => `${code(anchor)} produces behavior inconsistent with its contract.`,
  validation: (anchor) => `${code(anchor)} accepts data without the required validation.`,
  "resource-lifecycle": (anchor) => `${code(anchor)} leaves a resource lifecycle incomplete.`,
  concurrency: (anchor) => `${code(anchor)} performs an unsynchronized concurrent transition.`,
  security: (anchor) => `${code(anchor)} bypasses a required trust-boundary check.`,
  compatibility: (anchor) => `${code(anchor)} changes a supported interface contract.`,
  "error-handling": (anchor) => `${code(anchor)} discards an operational failure.`,
  "test-coverage": (anchor) =>
    `${code(anchor)} lacks regression coverage for the changed behavior.`,
};

const IMPACTS: Readonly<Record<FindingImpactKind, string>> = {
  "incorrect-result": "The affected operation returns an incorrect result.",
  "operation-failure": "The affected operation fails for a supported input.",
  "data-loss": "The affected operation loses persisted or in-flight data.",
  "resource-leak": "The affected resource remains retained after the operation ends.",
  "execution-stall": "The affected execution path stops making progress.",
  "security-exposure": "The affected boundary exposes data or authority to an untrusted input.",
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
  restore: (anchor) => `Restore the required behavior at ${code(anchor)}.`,
  "add-test": (anchor) => `Add regression coverage for ${code(anchor)}.`,
};

function canonicalEvidence(finding: ReviewFindingV1): string {
  if (finding.range === null) {
    return `The authoritative file change for ${code(finding.path)} contains ${code(finding.anchor)}.`;
  }
  const lines =
    finding.range.start === finding.range.end
      ? `line ${finding.range.start}`
      : `lines ${finding.range.start}-${finding.range.end}`;
  return `The authoritative diff contains ${code(finding.anchor)} on ${finding.range.side} ${lines} in ${code(finding.path)}.`;
}

function details(finding: ReviewFindingV1, location?: string): string {
  const explicit = location ?? explicitLocation(finding);
  return [
    `### ${finding.priority} — ${TITLES[finding.defectKind]}`,
    "",
    `- Location: ${code(explicit)}`,
    `- Issue: ${ISSUES[finding.defectKind](finding.anchor)}`,
    `- Impact: ${IMPACTS[finding.impactKind]}`,
    `- Evidence: ${canonicalEvidence(finding)}`,
    `- Fix direction: ${FIX_DIRECTIONS[finding.fixAction](finding.anchor)}`,
    "",
    `<!-- revoir:finding:v1:${finding.fingerprint} -->`,
  ].join("\n");
}

function explicitLocation(finding: ReviewFindingV1): string {
  if (finding.range === null) {
    return finding.path;
  }
  const lines =
    finding.range.start === finding.range.end
      ? String(finding.range.start)
      : `${finding.range.start}-${finding.range.end}`;
  return `${finding.path}:${lines} (${finding.range.side})`;
}

export function renderInlineFinding(finding: ReviewFindingV1): string {
  return details(finding);
}

export function renderFileFinding(finding: ReviewFindingV1): string {
  return details(finding, explicitLocation(finding));
}

export function renderRunMarker(commitId: string): string {
  return `<!-- revoir:run:v1:${commitId} -->`;
}

export function createReviewPublication(
  commitId: string,
  findings: readonly ReviewFindingV1[],
): ReviewPublication {
  if (findings.length === 0) {
    throw new Error("A findings review requires at least one validated finding.");
  }

  const comments: GitHubInlineReviewComment[] = [];
  const bodyFindings: ReviewFindingV1[] = [];
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
  const body =
    bodyFindings.length === 0
      ? marker
      : `${bodyFindings.map(renderFileFinding).join("\n\n")}\n\n${marker}`;
  const fallbackBody = `${findings.map(renderFileFinding).join("\n\n")}\n\n${marker}`;
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
