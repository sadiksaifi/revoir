export const FINDING_CONTRACT_VERSION = 1 as const;
export type FindingPriority = "P0" | "P1" | "P2" | "P3";
export type FindingSide = "LEFT" | "RIGHT";

export interface FindingRangeV1 {
  start: number;
  end: number;
  side: FindingSide;
}

export interface ModelFindingV1 {
  priority: FindingPriority;
  title: string;
  path: string;
  range: FindingRangeV1 | null;
  issue: string;
  impact: string;
  evidence: string;
  fixDirection: string;
}

export interface ModelReviewOutputV1 {
  version: typeof FINDING_CONTRACT_VERSION;
  findings: readonly unknown[];
}

export interface FindingV1 extends ModelFindingV1 {
  version: typeof FINDING_CONTRACT_VERSION;
  fingerprint: string;
}

const PRIORITIES = new Set<FindingPriority>(["P0", "P1", "P2", "P3"]);

export class FindingSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingSchemaError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FindingSchemaError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new FindingSchemaError(`${path} contains an unknown field.`);
    }
  }
  for (const key of keys) {
    if (!(key in value)) {
      throw new FindingSchemaError(`${path}.${key} is required.`);
    }
  }
}

function boundedString(
  value: unknown,
  path: string,
  maximum: number,
  options: { singleLine?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new FindingSchemaError(`${path} must be a string.`);
  }
  if (value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new FindingSchemaError(`${path} must contain 1-${maximum} trimmed characters.`);
  }
  if (options.singleLine && /[\r\n]/u.test(value)) {
    throw new FindingSchemaError(`${path} must be a single line.`);
  }
  if (value.includes("\u0000")) {
    throw new FindingSchemaError(`${path} contains an unsupported null byte.`);
  }
  return value.normalize("NFC");
}

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function findingPath(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new FindingSchemaError(`${path} must be a string.`);
  }
  if (value.length === 0 || value.length > 1024) {
    throw new FindingSchemaError(`${path} must contain 1-1024 characters.`);
  }
  if (value.includes("\u0000")) {
    throw new FindingSchemaError(`${path} contains an unsupported null byte.`);
  }
  if (/[\r\n]/u.test(value) || !hasOnlyUnicodeScalarValues(value)) {
    throw new FindingSchemaError(`${path} contains unsupported path characters.`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new FindingSchemaError(`${path} must be a positive integer.`);
  }
  return value as number;
}

function parseRange(value: unknown, path: string): FindingRangeV1 | null {
  if (value === null) {
    return null;
  }
  const range = record(value, path);
  exactKeys(range, ["start", "end", "side"], path);
  const start = positiveInteger(range.start, `${path}.start`);
  const end = positiveInteger(range.end, `${path}.end`);
  if (start > end) {
    throw new FindingSchemaError(`${path}.start must not exceed ${path}.end.`);
  }
  if (end - start > 49) {
    throw new FindingSchemaError(`${path} may span at most 50 lines.`);
  }
  if (range.side !== "LEFT" && range.side !== "RIGHT") {
    throw new FindingSchemaError(`${path}.side must be LEFT or RIGHT.`);
  }
  return { start, end, side: range.side };
}

export function parseModelReviewOutput(value: string): ModelReviewOutputV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    throw new FindingSchemaError("Review output must be valid JSON.");
  }
  const envelope = record(parsed, "review output");
  exactKeys(envelope, ["version", "findings"], "review output");
  if (envelope.version !== FINDING_CONTRACT_VERSION) {
    throw new FindingSchemaError(
      `Finding contract version is unsupported; expected version ${FINDING_CONTRACT_VERSION}.`,
    );
  }
  if (!Array.isArray(envelope.findings)) {
    throw new FindingSchemaError("review output.findings must be an array.");
  }
  if (envelope.findings.length > 100) {
    throw new FindingSchemaError("review output.findings may contain at most 100 findings.");
  }
  return { version: FINDING_CONTRACT_VERSION, findings: envelope.findings };
}

export function parseModelFinding(value: unknown, index: number): ModelFindingV1 {
  const path = `findings[${index}]`;
  const finding = record(value, path);
  exactKeys(
    finding,
    ["priority", "title", "path", "range", "issue", "impact", "evidence", "fixDirection"],
    path,
  );
  if (!PRIORITIES.has(finding.priority as FindingPriority)) {
    throw new FindingSchemaError(`${path}.priority must be one of P0, P1, P2, or P3.`);
  }
  return {
    priority: finding.priority as FindingPriority,
    title: boundedString(finding.title, `${path}.title`, 120, { singleLine: true }),
    path: findingPath(finding.path, `${path}.path`),
    range: parseRange(finding.range, `${path}.range`),
    issue: boundedString(finding.issue, `${path}.issue`, 2_000, { singleLine: true }),
    impact: boundedString(finding.impact, `${path}.impact`, 2_000, { singleLine: true }),
    evidence: boundedString(finding.evidence, `${path}.evidence`, 4_000, { singleLine: true }),
    fixDirection: boundedString(finding.fixDirection, `${path}.fixDirection`, 1_000, {
      singleLine: true,
    }),
  };
}
