import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, normalize, posix, relative, sep } from "node:path";

import {
  FINDING_CONTRACT_VERSION,
  parseModelFinding,
  parseModelReviewOutput,
  type FindingV1,
  type ModelFindingV1,
} from "@revoir/contracts";

import { isAttachableRange, parseGitDiff, type DiffFile, type DiffSide } from "./diff.js";

export { FINDING_CONTRACT_VERSION, type FindingPriority } from "@revoir/contracts";

export interface ReviewFindingV1 extends FindingV1 {
  attachment: FindingAttachment;
}

export type FindingAttachment =
  | {
      kind: "inline";
      path: string;
      startLine: number;
      endLine: number;
      side: DiffSide;
    }
  | {
      kind: "file";
      path: string;
    };

export interface FindingDiagnostic {
  index: number;
  code: "duplicate" | "invalid";
  message: string;
}

export interface ValidatedReviewOutput {
  version: typeof FINDING_CONTRACT_VERSION;
  findings: readonly ReviewFindingV1[];
  diagnostics: readonly FindingDiagnostic[];
}

const SPECULATIVE =
  /\b(?:apparently|appears?|guess|maybe|might|perhaps|possibly|potentially|seems?)\b/iu;
const MERGE_OR_SEVERITY_BOILERPLATE =
  /\b(?:blocks? merge|do not merge|merge (?:instruction|this)|p[0-3]\s+means|severity\s+(?:is|means))\b/iu;
const ACTION_VERB =
  /^(?:add|await|bound|call|cancel|check|clone|close|compare|compute|convert|create|decode|defer|delete|derive|discard|encode|ensure|escape|expose|filter|forward|guard|handle|include|initialize|limit|map|move|parse|pass|preserve|propagate|publish|read|reconcile|record|refactor|reject|release|remove|rename|replace|resolve|restore|retry|return|sanitize|serialize|set|skip|sort|stop|submit|throw|update|use|validate|verify|wrap|write)\b/iu;

export class FindingContractError extends Error {
  readonly diagnostics: readonly FindingDiagnostic[];

  constructor(
    message: string,
    diagnostics: readonly FindingDiagnostic[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FindingContractError";
    this.diagnostics = diagnostics;
  }
}

function validateFindingProse(finding: ModelFindingV1, index: number): ModelFindingV1 {
  const path = `findings[${index}]`;
  if (SPECULATIVE.test(finding.issue) || SPECULATIVE.test(finding.evidence)) {
    throw new Error(`${path} uses speculative language instead of observed evidence.`);
  }
  if (/^(?:n\/?a|none|not provided|unknown)$/iu.test(finding.evidence)) {
    throw new Error(`${path}.evidence must describe supporting evidence.`);
  }
  if (
    !ACTION_VERB.test(finding.fixDirection) ||
    /^(?:consider|fix this|investigate|look into|review)\b/iu.test(finding.fixDirection)
  ) {
    throw new Error(`${path}.fixDirection must state a concrete action.`);
  }
  if (
    [finding.title, finding.issue, finding.impact, finding.evidence, finding.fixDirection].some(
      (text) => MERGE_OR_SEVERITY_BOILERPLATE.test(text),
    )
  ) {
    throw new Error(`${path} contains merge or severity boilerplate.`);
  }
  return finding;
}

function safeRepositoryPath(value: string): string {
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("path must be a normalized repository-relative POSIX path.");
  }
  if (posix.normalize(value) !== value || normalize(value).split(sep).join("/") !== value) {
    throw new Error("path must be a normalized repository-relative POSIX path.");
  }
  return value;
}

async function validatePath(
  checkout: string,
  finding: ModelFindingV1,
  file: DiffFile | undefined,
): Promise<void> {
  safeRepositoryPath(finding.path);
  if (file === undefined) {
    throw new Error("path is not part of the reviewed base-to-head diff.");
  }
  const candidate = join(checkout, ...finding.path.split("/"));
  const inside = relative(checkout, candidate);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error("path resolves outside the reviewed workspace.");
  }

  if (file.newPath === undefined) {
    return;
  }
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw new Error("path does not identify a file in the reviewed head.");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("path does not exist in the reviewed head.", { cause: error });
    }
    throw error;
  }
}

function canonicalText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function findingFingerprint(
  finding: Pick<ModelFindingV1, "path" | "range" | "issue">,
): string {
  const identity = JSON.stringify({
    version: FINDING_CONTRACT_VERSION,
    path: finding.path,
    range: finding.range,
    issue: canonicalText(finding.issue),
  });
  return createHash("sha256").update(identity).digest("hex");
}

function attachment(file: DiffFile, finding: ModelFindingV1): FindingAttachment {
  if (finding.range === null || !isAttachableRange(file, finding.range)) {
    return { kind: "file", path: file.apiPath };
  }
  return {
    kind: "inline",
    path: file.apiPath,
    startLine: finding.range.start,
    endLine: finding.range.end,
    side: finding.range.side,
  };
}

export async function validateModelReviewOutput(
  value: string,
  options: { checkout: string; diff: string },
): Promise<ValidatedReviewOutput> {
  let envelope;
  try {
    envelope = parseModelReviewOutput(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FindingContractError(
      "Pi returned an invalid finding envelope.",
      [{ index: -1, code: "invalid", message }],
      { cause: error },
    );
  }

  const diff = parseGitDiff(options.diff);
  const findings: ReviewFindingV1[] = [];
  const diagnostics: FindingDiagnostic[] = [];
  const fingerprints = new Set<string>();
  for (const [index, candidate] of envelope.findings.entries()) {
    try {
      const modelFinding = validateFindingProse(parseModelFinding(candidate, index), index);
      const repositoryPath = safeRepositoryPath(modelFinding.path);
      const file = diff.files.get(repositoryPath);
      // Candidate order is contract-significant for deterministic first-wins deduplication.
      // eslint-disable-next-line no-await-in-loop
      await validatePath(options.checkout, modelFinding, file);
      if (file === undefined) {
        throw new Error("path is not part of the reviewed base-to-head diff.");
      }
      if (modelFinding.range !== null && !isAttachableRange(file, modelFinding.range)) {
        throw new Error("range is not a contiguous changed-line range in the reviewed diff.");
      }
      const fingerprint = findingFingerprint(modelFinding);
      if (fingerprints.has(fingerprint)) {
        diagnostics.push({
          index,
          code: "duplicate",
          message: `findings[${index}] duplicates an earlier stable fingerprint.`,
        });
        continue;
      }
      fingerprints.add(fingerprint);
      findings.push({
        version: FINDING_CONTRACT_VERSION,
        fingerprint,
        ...modelFinding,
        attachment: attachment(file, modelFinding),
      });
    } catch (error) {
      diagnostics.push({
        index,
        code: "invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (envelope.findings.length > 0 && findings.length === 0) {
    throw new FindingContractError(
      `Pi returned no publishable findings (${diagnostics.length} rejected).`,
      diagnostics,
    );
  }
  return { version: FINDING_CONTRACT_VERSION, findings, diagnostics };
}
