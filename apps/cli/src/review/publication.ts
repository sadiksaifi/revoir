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

function details(finding: ReviewFindingV1, location?: string): string {
  return [
    `### ${finding.priority} — ${finding.title}`,
    "",
    ...(location === undefined ? [] : [`- Location: ${code(location)}`]),
    `- Issue: ${finding.issue}`,
    `- Impact: ${finding.impact}`,
    `- Evidence: ${finding.evidence}`,
    `- Fix direction: ${finding.fixDirection}`,
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

  const body =
    bodyFindings.length === 0 ? undefined : bodyFindings.map(renderFileFinding).join("\n\n");
  const fallbackBody = findings.map(renderFileFinding).join("\n\n");
  return {
    payload: {
      commit_id: commitId,
      ...(body === undefined ? {} : { body }),
      ...(comments.length === 0 ? {} : { comments }),
    },
    fallbackPayload: {
      commit_id: commitId,
      body: fallbackBody,
    },
  };
}
