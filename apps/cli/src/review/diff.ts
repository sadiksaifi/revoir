export type DiffSide = "LEFT" | "RIGHT";

export interface FindingRange {
  start: number;
  end: number;
  side: DiffSide;
}

export interface DiffFile {
  apiPath: string;
  oldPath?: string;
  newPath?: string;
  binary: boolean;
  changedLines: ReadonlyMap<string, number>;
}

export interface DiffIndex {
  files: ReadonlyMap<string, DiffFile>;
}

function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"')) {
    return value;
  }
  if (!value.endsWith('"')) {
    throw new Error("Git diff contains an unterminated quoted path.");
  }

  const source = value.slice(1, -1);
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character !== "\\") {
      result += character;
      continue;
    }

    index += 1;
    const escaped = source[index];
    if (escaped === undefined) {
      throw new Error("Git diff contains an invalid quoted path escape.");
    }
    const simpleEscapes: Readonly<Record<string, string>> = {
      '"': '"',
      "\\": "\\",
      a: "\u0007",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\u000b",
    };
    const simple = simpleEscapes[escaped];
    if (simple !== undefined) {
      result += simple;
      continue;
    }
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      while (
        octal.length < 3 &&
        source[index + 1] !== undefined &&
        /[0-7]/u.test(source[index + 1]!)
      ) {
        index += 1;
        octal += source[index]!;
      }
      result += String.fromCodePoint(Number.parseInt(octal, 8));
      continue;
    }
    throw new Error("Git diff contains an unsupported quoted path escape.");
  }
  return Buffer.from(result, "binary").toString("utf8");
}

function patchPath(value: string): string | undefined {
  if (value === "/dev/null") {
    return undefined;
  }
  const decoded = decodeGitQuotedPath(
    value.startsWith('"') ? value : (value.split("\t", 1)[0] ?? value),
  );
  if (!decoded.startsWith("a/") && !decoded.startsWith("b/")) {
    throw new Error("Git diff contains an invalid patch path.");
  }
  return decoded.slice(2);
}

function metadataPath(value: string): string {
  return decodeGitQuotedPath(value);
}

function changedLineKey(side: DiffSide, line: number): string {
  return `${side}:${line}`;
}

function diffHeaderPaths(line: string): { oldPath?: string; newPath?: string } {
  const quoted = /^diff --git ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/u.exec(line);
  if (quoted !== null) {
    const oldPath = patchPath(quoted[1]!);
    const newPath = patchPath(quoted[2]!);
    return {
      ...(oldPath === undefined ? {} : { oldPath }),
      ...(newPath === undefined ? {} : { newPath }),
    };
  }

  const value = line.slice("diff --git ".length);
  const candidates: { oldPath: string; newPath: string }[] = [];
  for (let index = value.indexOf(" b/"); index >= 0; index = value.indexOf(" b/", index + 1)) {
    const oldValue = value.slice(0, index);
    const newValue = value.slice(index + 1);
    if (oldValue.startsWith("a/") && newValue.startsWith("b/")) {
      candidates.push({ oldPath: oldValue.slice(2), newPath: newValue.slice(2) });
    }
  }
  const samePath = candidates.find((candidate) => candidate.oldPath === candidate.newPath);
  const selected = samePath ?? (candidates.length === 1 ? candidates[0] : undefined);
  return selected ?? {};
}

class MutableDiffFile {
  oldPath: string | undefined = undefined;
  newPath: string | undefined = undefined;
  binary = false;
  readonly changedLines = new Map<string, number>();
}

export function parseGitDiff(diff: string): DiffIndex {
  const files = new Map<string, DiffFile>();
  let current: MutableDiffFile | undefined;
  let oldLine = 0;
  let newLine = 0;
  let position = 0;
  let inHunk = false;
  let hasHunk = false;

  const finishFile = (): void => {
    if (current === undefined) {
      return;
    }
    const apiPath = current.newPath ?? current.oldPath;
    if (apiPath === undefined) {
      throw new Error("Git diff file has no repository path.");
    }
    if (files.has(apiPath)) {
      throw new Error(`Git diff contains duplicate file path "${apiPath}".`);
    }
    files.set(apiPath, {
      apiPath,
      ...(current.oldPath === undefined ? {} : { oldPath: current.oldPath }),
      ...(current.newPath === undefined ? {} : { newPath: current.newPath }),
      binary: current.binary,
      changedLines: current.changedLines,
    });
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finishFile();
      current = new MutableDiffFile();
      oldLine = 0;
      newLine = 0;
      position = 0;
      inHunk = false;
      hasHunk = false;
      const headerPaths = diffHeaderPaths(line);
      current.oldPath = headerPaths.oldPath;
      current.newPath = headerPaths.newPath;
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = metadataPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.newPath = metadataPath(line.slice("rename to ".length));
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      current.oldPath = patchPath(line.slice(4));
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      current.newPath = patchPath(line.slice(4));
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
      const binaryPaths = /^Binary files (.+) and (.+) differ$/u.exec(line);
      if (binaryPaths !== null) {
        current.oldPath = patchPath(binaryPaths[1]!);
        current.newPath = patchPath(binaryPaths[2]!);
      }
      inHunk = false;
      continue;
    }

    const hunk = /^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@/u.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      if (hasHunk) {
        position += 1;
      }
      hasHunk = true;
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }

    position += 1;
    if (line.startsWith("+")) {
      current.changedLines.set(changedLineKey("RIGHT", newLine), position);
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.changedLines.set(changedLineKey("LEFT", oldLine), position);
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    } else if (!line.startsWith("\\")) {
      inHunk = false;
    }
  }
  finishFile();
  return { files };
}

export function diffPosition(file: DiffFile, side: DiffSide, line: number): number | undefined {
  return file.changedLines.get(changedLineKey(side, line));
}

export function isAttachableRange(file: DiffFile, range: FindingRange): boolean {
  if (file.binary || range.start > range.end) {
    return false;
  }
  for (let line = range.start; line <= range.end; line += 1) {
    if (diffPosition(file, range.side, line) === undefined) {
      return false;
    }
  }
  return true;
}
