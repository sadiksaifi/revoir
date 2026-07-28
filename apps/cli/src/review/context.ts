import { lstat, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { dirname as posixDirname, join as posixJoin } from "node:path/posix";

import { parseGitDiff } from "./diff.js";
import type { GitHubReviewEvidence } from "./evidence.js";
import {
  classifyReviewFile,
  type ReviewFileClassification,
} from "./file-classification.js";
import type { PullRequestReference, PullRequestSnapshot } from "./pull-request.js";
import type { PreparedWorkspace } from "./workspace.js";

export interface RepositoryGuidance {
  path: string;
  content: string;
}

export interface ReviewContext {
  reference: PullRequestReference;
  pullRequestDescription: string;
  baseSha: string;
  headSha: string;
  completeDiff: string;
  guidance: readonly RepositoryGuidance[];
  files: readonly ReviewFileClassification[];
  evidence: GitHubReviewEvidence;
}

export interface AssembleReviewContextInput {
  reference: PullRequestReference;
  pullRequest: PullRequestSnapshot;
  workspace: PreparedWorkspace;
  evidence: GitHubReviewEvidence;
}

function ancestorDirectories(path: string): string[] {
  const directories = [""];
  let current = posixDirname(path);
  const nested: string[] = [];
  while (current !== "." && current !== "/" && current !== "") {
    nested.push(current);
    const parent = posixDirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  directories.push(...nested.toReversed());
  return directories;
}

function isInsideCheckout(checkout: string, candidate: string): boolean {
  const path = relative(resolve(checkout), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

export async function loadApplicableRepositoryGuidance(
  checkout: string,
  diff: string,
): Promise<RepositoryGuidance[]> {
  const index = parseGitDiff(diff);
  const candidatePaths = new Set<string>(["AGENTS.md", "CONTRIBUTING.md"]);
  for (const file of index.files.values()) {
    for (const path of [file.oldPath, file.newPath]) {
      if (path === undefined) {
        continue;
      }
      for (const directory of ancestorDirectories(path)) {
        candidatePaths.add(posixJoin(directory, "AGENTS.md"));
        candidatePaths.add(posixJoin(directory, "CONTRIBUTING.md"));
      }
    }
  }

  const sortedPaths = [...candidatePaths].toSorted((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth === 0 ? left.localeCompare(right) : depth;
  });
  const guidance: RepositoryGuidance[] = [];
  for (const path of sortedPaths) {
    const candidate = join(checkout, ...path.split("/"));
    if (!isInsideCheckout(checkout, candidate)) {
      continue;
    }
    try {
      // Guidance must be authored in the checkout; symlinks are not followed.
      // eslint-disable-next-line no-await-in-loop
      const status = await lstat(candidate);
      if (!status.isFile()) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      guidance.push({ path, content: await readFile(candidate, "utf8") });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
  return guidance;
}

export async function assembleReviewContext(
  input: AssembleReviewContextInput,
): Promise<ReviewContext> {
  const index = parseGitDiff(input.workspace.diff);
  return {
    reference: input.reference,
    pullRequestDescription: input.pullRequest.description ?? "",
    baseSha: input.pullRequest.baseSha,
    headSha: input.pullRequest.headSha,
    completeDiff: input.workspace.diff,
    guidance: await loadApplicableRepositoryGuidance(
      input.workspace.checkout,
      input.workspace.diff,
    ),
    files: [...index.files.keys()].map(classifyReviewFile),
    evidence: input.evidence,
  };
}
