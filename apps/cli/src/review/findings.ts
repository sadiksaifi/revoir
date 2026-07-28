import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { promisify } from "node:util";

import {
  FINDING_CONTRACT_VERSION,
  parseModelFinding,
  parseModelReviewOutput,
  type FindingDefectKind,
  type FindingFixAction,
  type FindingImpactKind,
  type FindingV1,
  type ModelFindingV1,
} from "@revoir/contracts";

import { isAttachableRange, parseGitDiff, type DiffFile, type DiffSide } from "./diff.js";
import { classifyReviewFile } from "./file-classification.js";

export {
  FINDING_CONTRACT_VERSION,
  type FindingDefectKind,
  type FindingFixAction,
  type FindingImpactKind,
  type FindingPriority,
} from "@revoir/contracts";

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

const execFileAsync = promisify(execFile);

const ALLOWED_IMPACTS: Readonly<Record<FindingDefectKind, readonly FindingImpactKind[]>> = {
  correctness: ["incorrect-result", "operation-failure", "data-loss"],
  validation: ["incorrect-result", "operation-failure", "security-exposure"],
  "resource-lifecycle": ["resource-leak", "operation-failure", "execution-stall"],
  concurrency: ["incorrect-result", "data-loss", "execution-stall"],
  security: ["security-exposure", "data-loss"],
  compatibility: ["compatibility-break", "operation-failure"],
  "error-handling": ["operation-failure", "resource-leak"],
  "test-coverage": ["regression-risk"],
};

const ALLOWED_ACTIONS: Readonly<Record<FindingDefectKind, readonly FindingFixAction[]>> = {
  correctness: ["guard", "preserve", "propagate", "restore"],
  validation: ["guard", "validate"],
  "resource-lifecycle": ["guard", "release", "restore"],
  concurrency: ["guard", "propagate", "synchronize", "release"],
  security: ["guard", "validate", "preserve", "restore"],
  compatibility: ["preserve", "propagate", "restore"],
  "error-handling": ["guard", "propagate", "release", "restore"],
  "test-coverage": ["add-test"],
};

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

function validateFindingSemantics(finding: ModelFindingV1, index: number): ModelFindingV1 {
  const path = `findings[${index}]`;
  if (!ALLOWED_IMPACTS[finding.defectKind].includes(finding.impactKind)) {
    throw new Error(`${path}.impactKind is incompatible with defectKind.`);
  }
  if (!ALLOWED_ACTIONS[finding.defectKind].includes(finding.fixAction)) {
    throw new Error(`${path}.fixAction is incompatible with defectKind.`);
  }
  return finding;
}

function safeRepositoryPath(value: string): string {
  if (
    posix.isAbsolute(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("path must be a normalized repository-relative POSIX path.");
  }
  if (posix.normalize(value) !== value) {
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

  if (file.newPath === undefined) {
    return;
  }
  const entry = await reviewedHeadEntry(checkout, finding.path);
  if (entry === undefined) {
    throw new Error("path does not exist in the reviewed head.");
  }
  if (entry.type === "blob" || (entry.mode === "160000" && entry.type === "commit")) {
    return;
  }
  throw new Error("path does not identify a file in the reviewed head.");
}

function changedLineKey(side: DiffSide, line: number): string {
  return `${side}:${line}`;
}

function validateTechnicalAnchor(finding: ModelFindingV1, file: DiffFile): void {
  const observed =
    finding.range === null
      ? [
          file.apiPath,
          ...(file.oldPath === undefined ? [] : [file.oldPath]),
          ...(file.newPath === undefined ? [] : [file.newPath]),
          ...file.changedLineText.values(),
        ]
      : Array.from(
          { length: finding.range.end - finding.range.start + 1 },
          (_, offset) =>
            file.changedLineText.get(
              changedLineKey(finding.range!.side, finding.range!.start + offset),
            ) ?? "",
        );
  if (!observed.some((value) => value.includes(finding.anchor))) {
    throw new Error("technical anchor is not present in the authoritative changed content.");
  }
}

interface GitTreeEntry {
  mode: string;
  type: string;
}

async function reviewedHeadEntry(
  checkout: string,
  repositoryPath: string,
): Promise<GitTreeEntry | undefined> {
  let stdout: Buffer;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["-C", checkout, "ls-tree", "-z", "--full-tree", "HEAD", "--", `:(literal)${repositoryPath}`],
      { encoding: "buffer" },
    ));
  } catch (error) {
    throw new Error("The reviewed head Git tree could not be inspected.", { cause: error });
  }

  const expectedPath = Buffer.from(repositoryPath);
  let offset = 0;
  while (offset < stdout.length) {
    const terminator = stdout.indexOf(0, offset);
    if (terminator < 0) {
      throw new Error("The reviewed head Git tree returned malformed output.");
    }
    const record = stdout.subarray(offset, terminator);
    const separator = record.indexOf(9);
    if (separator < 0) {
      throw new Error("The reviewed head Git tree returned malformed output.");
    }
    if (record.subarray(separator + 1).equals(expectedPath)) {
      const [mode, type, objectId, extra] = record
        .subarray(0, separator)
        .toString("ascii")
        .split(" ");
      if (
        mode === undefined ||
        type === undefined ||
        objectId === undefined ||
        extra !== undefined ||
        !/^[0-7]{6}$/u.test(mode) ||
        !/^[0-9a-f]{40,64}$/u.test(objectId)
      ) {
        throw new Error("The reviewed head Git tree returned malformed output.");
      }
      return { mode, type };
    }
    offset = terminator + 1;
  }
  return undefined;
}

export function findingFingerprint(
  finding: Pick<
    ModelFindingV1,
    "path" | "range" | "defectKind" | "impactKind" | "fixAction" | "anchor"
  >,
): string {
  const identity = JSON.stringify([
    FINDING_CONTRACT_VERSION,
    finding.path,
    finding.range?.start ?? null,
    finding.range?.end ?? null,
    finding.range?.side ?? null,
    finding.defectKind,
    finding.impactKind,
    finding.fixAction,
    finding.anchor,
  ]);
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
      const modelFinding = validateFindingSemantics(parseModelFinding(candidate, index), index);
      const repositoryPath = safeRepositoryPath(modelFinding.path);
      if (!classifyReviewFile(repositoryPath).detailedReview) {
        throw new Error("path is excluded from detailed review by the fixed file policy.");
      }
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
      validateTechnicalAnchor(modelFinding, file);
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
