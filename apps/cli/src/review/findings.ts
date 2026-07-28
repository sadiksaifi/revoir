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
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

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
  /\b(?:apparently|appears?|could|guess|likely|may|maybe|might|perhaps|possibly|potentially|seems?)\b/iu;
const MERGE_OR_SEVERITY_BOILERPLATE =
  /\b(?:blocks? merge|do not merge|merge (?:instruction|this)|must not merge|p[0-3]\s+means|severity\s+(?:is|means))\b/iu;
const PRAISE_OR_SUMMARY =
  /(?:\b(?:excellent|good|great|nice|solid)\s+(?:approach|change|implementation|job|work)\b|\blooks?\s+good\b|\bwell[ -]done\b|\bthe rest of (?:the )?(?:change|code|implementation)\b|^(?:(?:general|overall)\s+)?(?:overview|summary)\b|\boverall(?:,|\s+(?:the|this|change|code|implementation)))/iu;
const PLACEHOLDER =
  /^(?:n\/?a|none|not (?:applicable|available|provided)|pending|placeholder|tbc|tbd|todo|to be (?:added|completed|confirmed|decided|defined|determined|provided)|unknown)[.!?]?$/iu;
const ACTION_VERB =
  /^(?:add|await|bound|call|cancel|check|clone|close|compare|compute|convert|create|decode|defer|delete|derive|discard|encode|ensure|escape|expose|filter|forward|guard|handle|include|initialize|limit|map|move|parse|pass|preserve|propagate|publish|read|reconcile|record|refactor|reject|release|remove|rename|replace|resolve|restore|retry|return|sanitize|serialize|set|skip|sort|stop|submit|throw|update|use|validate|verify|wrap|write)\b/iu;
const NON_ACTIONABLE_DETAIL = /^(?:a|an|it|one|ones|something|that|the|these|this|those)$/iu;

type ProseField = keyof Pick<
  ModelFindingV1,
  "title" | "issue" | "impact" | "evidence" | "fixDirection"
>;

interface ProsePolicy {
  minimumWords: number;
  substantiveMessage: string;
  requiresAction: boolean;
}

const PROSE_POLICIES: Record<ProseField, ProsePolicy> = {
  title: {
    minimumWords: 1,
    substantiveMessage: "must state a substantive title",
    requiresAction: false,
  },
  issue: {
    minimumWords: 2,
    substantiveMessage: "must describe an observed issue",
    requiresAction: false,
  },
  impact: {
    minimumWords: 2,
    substantiveMessage: "must describe a concrete impact",
    requiresAction: false,
  },
  evidence: {
    minimumWords: 2,
    substantiveMessage: "must describe supporting evidence",
    requiresAction: false,
  },
  fixDirection: {
    minimumWords: 2,
    substantiveMessage: "must state a concrete action",
    requiresAction: true,
  },
};

const PROSE_FIELDS = Object.keys(PROSE_POLICIES) as readonly ProseField[];

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
  for (const field of PROSE_FIELDS) {
    const value = finding[field];
    const policy = PROSE_POLICIES[field];
    if (SPECULATIVE.test(value)) {
      throw new Error(`${path}.${field} uses speculative language instead of observed evidence.`);
    }
    if (MERGE_OR_SEVERITY_BOILERPLATE.test(value)) {
      throw new Error(`${path}.${field} contains merge or severity boilerplate.`);
    }
    if (PRAISE_OR_SUMMARY.test(value)) {
      throw new Error(`${path}.${field} contains praise or general-summary prose.`);
    }
    if (!isPlainGfmText(value)) {
      throw new Error(`${path}.${field} contains Markdown instead of concise finding prose.`);
    }
    if (PLACEHOLDER.test(value) || proseTokens(value).length < policy.minimumWords) {
      throw new Error(`${path}.${field} ${policy.substantiveMessage}.`);
    }
    if (policy.requiresAction) {
      validateFixDirection(value, path);
    }
  }
  return finding;
}

function validateFixDirection(value: string, path: string): void {
  const action = ACTION_VERB.exec(value);
  if (action === null || /^(?:consider|fix this|investigate|look into|review)\b/iu.test(value)) {
    throw new Error(`${path}.fixDirection must state a concrete action.`);
  }
  const target = value.slice(action[0].length).trim();
  const targetDetails = proseTokens(target).filter((token) => !NON_ACTIONABLE_DETAIL.test(token));
  if (PLACEHOLDER.test(target) || targetDetails.length === 0) {
    throw new Error(`${path}.fixDirection must state a concrete action.`);
  }
}

function isPlainGfmText(value: string): boolean {
  const tree = fromMarkdown(value, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  if (tree.children.length !== 1 || tree.children[0]?.type !== "paragraph") {
    return false;
  }
  return (
    tree.children[0].children.length > 0 &&
    tree.children[0].children.every((child) => child.type === "text")
  );
}

function proseTokens(value: string): readonly string[] {
  return value.match(/[\p{L}\p{N}]+/gu) ?? [];
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
