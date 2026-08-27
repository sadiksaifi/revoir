import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  FINDING_CONTRACT_VERSION,
  parseModelFinding,
  parseModelReviewOutput,
  type FindingRangeV2,
  type FindingV2,
  type ModelFindingV2,
} from "@revoir/contracts";

import { isAttachableRange, parseGitDiff, type DiffFile, type DiffSide } from "./diff.js";
import { classifyReviewFile } from "./file-classification.js";
import { SystemCommandRunner } from "./workspace.js";

export {
  FINDING_CONTRACT_VERSION,
  type FindingDefectKind,
  type FindingFixAction,
  type FindingImpactKind,
  type FindingPriority,
} from "@revoir/contracts";

export interface ReviewFindingV2 extends FindingV2 {
  attachment: FindingAttachment;
  fingerprintAliases?: readonly string[];
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
  findings: readonly ReviewFindingV2[];
  diagnostics: readonly FindingDiagnostic[];
}

const commandRunner = new SystemCommandRunner();

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
  finding: ModelFindingV2,
  file: DiffFile | undefined,
  signal: AbortSignal | undefined,
  shellCommandMs: number,
): Promise<void> {
  safeRepositoryPath(finding.path);
  if (file === undefined) {
    throw new Error("path is not part of the reviewed base-to-head diff.");
  }

  if (file.newPath === undefined) {
    return;
  }
  const entry = await reviewedHeadEntry(checkout, finding.path, signal, shellCommandMs);
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

function exactAnchorRanges(file: DiffFile, anchor: string): FindingRangeV2[] {
  return [...file.changedLineText.entries()].flatMap(([key, text]) => {
    if (text.trim() !== anchor) {
      return [];
    }
    const separator = key.indexOf(":");
    const side = key.slice(0, separator);
    const line = Number(key.slice(separator + 1));
    if ((side !== "LEFT" && side !== "RIGHT") || !Number.isSafeInteger(line) || line <= 0) {
      return [];
    }
    return [{ start: line, end: line, side }];
  });
}

function validateTechnicalAnchor(finding: ModelFindingV2, file: DiffFile): ModelFindingV2 {
  if (finding.range !== null) {
    const hasExactSelectedLine = Array.from(
      { length: finding.range.end - finding.range.start + 1 },
      (_, offset) =>
        file.changedLineText.get(
          changedLineKey(finding.range!.side, finding.range!.start + offset),
        ) ?? "",
    ).some((value) => value.trim() === finding.anchor);
    if (hasExactSelectedLine) {
      return finding;
    }
    throw new Error(
      "technical anchor must equal a complete authoritative changed line or file path.",
    );
  }

  const exactPath =
    finding.anchor === file.apiPath ||
    finding.anchor === file.oldPath ||
    finding.anchor === file.newPath;
  if (exactPath) {
    return finding;
  }
  const ranges = exactAnchorRanges(file, finding.anchor);
  if (ranges.length === 1) {
    return { ...finding, range: ranges[0]! };
  }
  if (ranges.length > 1) {
    return finding;
  }
  throw new Error(
    "technical anchor must equal a complete authoritative changed line or file path.",
  );
}

interface GitTreeEntry {
  mode: string;
  type: string;
}

async function reviewedHeadEntry(
  checkout: string,
  repositoryPath: string,
  signal: AbortSignal | undefined,
  shellCommandMs: number,
): Promise<GitTreeEntry | undefined> {
  signal?.throwIfAborted();
  let stdout: Buffer;
  try {
    const result = await commandRunner.run(
      "git",
      ["-C", checkout, "ls-tree", "-z", "--full-tree", "HEAD", "--", `:(literal)${repositoryPath}`],
      {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: shellCommandMs,
      },
    );
    stdout = Buffer.from(result.stdout);
  } catch (error) {
    signal?.throwIfAborted();
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
    ModelFindingV2,
    "path" | "range" | "defectKind" | "impactKind" | "fixAction" | "anchor"
  >,
  occurrenceContext?: string,
): string {
  const identityParts: unknown[] = [
    FINDING_CONTRACT_VERSION,
    finding.path,
    finding.defectKind,
    finding.impactKind,
    finding.anchor,
  ];
  if (occurrenceContext !== undefined) {
    identityParts.push(occurrenceContext);
  }
  return createHash("sha256").update(JSON.stringify(identityParts)).digest("hex");
}

export function exactFindingFingerprint(
  finding: Pick<
    ModelFindingV2,
    "path" | "range" | "defectKind" | "impactKind" | "fixAction" | "anchor"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        FINDING_CONTRACT_VERSION,
        finding.path,
        finding.range?.start ?? null,
        finding.range?.end ?? null,
        finding.range?.side ?? null,
        finding.defectKind,
        finding.impactKind,
        finding.fixAction,
        finding.anchor,
      ]),
    )
    .digest("hex");
}

function anchorOccurrenceContext(file: DiffFile, finding: ModelFindingV2): string | undefined {
  if (finding.range === null) {
    return undefined;
  }
  const changedLines = [...file.changedLineText.entries()]
    .flatMap(([key, text]) => {
      const [side, lineText] = key.split(":");
      const line = Number(lineText);
      return side === finding.range!.side && Number.isInteger(line) ? [{ line, text }] : [];
    })
    .toSorted((left, right) => left.line - right.line);
  const occurrence = changedLines.findIndex(
    ({ line, text }) =>
      line >= finding.range!.start && line <= finding.range!.end && text.trim() === finding.anchor,
  );
  if (occurrence < 0) {
    return undefined;
  }
  const before = changedLines
    .slice(0, occurrence)
    .findLast(({ text }) => text.trim() !== finding.anchor)?.text;
  const after = changedLines
    .slice(occurrence + 1)
    .find(({ text }) => text.trim() !== finding.anchor)?.text;
  if (before === undefined && after === undefined) {
    return undefined;
  }
  return JSON.stringify([before ?? null, after ?? null]);
}

function occurrenceKey(finding: ModelFindingV2): string {
  return JSON.stringify([
    finding.range?.start ?? null,
    finding.range?.end ?? null,
    finding.range?.side ?? null,
  ]);
}

interface ValidatedCandidate {
  readonly index: number;
  readonly finding: ModelFindingV2;
  readonly attachment: FindingAttachment;
  readonly baseFingerprint: string;
  readonly contextFingerprint?: string;
  readonly occurrenceKey: string;
}

function attachment(file: DiffFile, finding: ModelFindingV2): FindingAttachment {
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
  options: {
    checkout: string;
    diff: string;
    signal?: AbortSignal;
    shellCommandMs?: number;
  },
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
  const diagnostics: FindingDiagnostic[] = [];
  const candidates: ValidatedCandidate[] = [];
  for (const [index, candidate] of envelope.findings.entries()) {
    try {
      const modelFinding = parseModelFinding(candidate, index);
      const repositoryPath = safeRepositoryPath(modelFinding.path);
      if (!classifyReviewFile(repositoryPath).detailedReview) {
        throw new Error("path is excluded from detailed review by the fixed file policy.");
      }
      const file = diff.files.get(repositoryPath);
      // Candidate order is contract-significant for deterministic first-wins deduplication.
      // eslint-disable-next-line no-await-in-loop
      await validatePath(
        options.checkout,
        modelFinding,
        file,
        options.signal,
        options.shellCommandMs ?? 120_000,
      );
      if (file === undefined) {
        throw new Error("path is not part of the reviewed base-to-head diff.");
      }
      if (modelFinding.range !== null && !isAttachableRange(file, modelFinding.range)) {
        throw new Error("range is not a contiguous changed-line range in the reviewed diff.");
      }
      const anchoredFinding = validateTechnicalAnchor(modelFinding, file);
      const context = anchorOccurrenceContext(file, anchoredFinding);
      candidates.push({
        index,
        finding: anchoredFinding,
        attachment: attachment(file, anchoredFinding),
        baseFingerprint: findingFingerprint(anchoredFinding),
        ...(context === undefined
          ? {}
          : { contextFingerprint: findingFingerprint(anchoredFinding, context) }),
        occurrenceKey: occurrenceKey(anchoredFinding),
      });
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw options.signal.reason instanceof Error ? options.signal.reason : error;
      }
      diagnostics.push({
        index,
        code: "invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const occurrenceKeysByFingerprint = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const keys = occurrenceKeysByFingerprint.get(candidate.baseFingerprint) ?? new Set<string>();
    keys.add(candidate.occurrenceKey);
    occurrenceKeysByFingerprint.set(candidate.baseFingerprint, keys);
  }

  const findings: ReviewFindingV2[] = [];
  const seenOccurrences = new Set<string>();
  for (const candidate of candidates) {
    const occurrenceIdentity = `${candidate.baseFingerprint}:${candidate.occurrenceKey}`;
    if (seenOccurrences.has(occurrenceIdentity)) {
      diagnostics.push({
        index: candidate.index,
        code: "duplicate",
        message: `findings[${candidate.index}] duplicates an earlier stable fingerprint.`,
      });
      continue;
    }
    seenOccurrences.add(occurrenceIdentity);
    const hasPeerOccurrences =
      (occurrenceKeysByFingerprint.get(candidate.baseFingerprint)?.size ?? 0) > 1;
    const fingerprint = hasPeerOccurrences
      ? findingFingerprint(candidate.finding, candidate.occurrenceKey)
      : candidate.baseFingerprint;
    const fingerprintAliases = new Set([
      candidate.baseFingerprint,
      exactFindingFingerprint(candidate.finding),
      ...(candidate.contextFingerprint === undefined ? [] : [candidate.contextFingerprint]),
    ]);
    fingerprintAliases.delete(fingerprint);
    findings.push({
      version: FINDING_CONTRACT_VERSION,
      fingerprint,
      ...(fingerprintAliases.size === 0
        ? {}
        : { fingerprintAliases: [...fingerprintAliases].toSorted() }),
      ...candidate.finding,
      attachment: candidate.attachment,
    });
  }

  if (envelope.findings.length > 0 && findings.length === 0) {
    throw new FindingContractError(
      `Pi returned no publishable findings (${diagnostics.length} rejected).`,
      diagnostics,
    );
  }
  return { version: FINDING_CONTRACT_VERSION, findings, diagnostics };
}
