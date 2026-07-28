import { basename } from "node:path/posix";

export type ReviewFileCategory =
  | "source"
  | "manifest"
  | "generator-source"
  | "generated"
  | "vendored"
  | "minified"
  | "snapshot"
  | "lock";

export interface ReviewFileClassification {
  path: string;
  category: ReviewFileCategory;
  detailedReview: boolean;
  supportingEvidence: boolean;
}

const MANIFEST_NAMES = new Set([
  "cargo.toml",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "gemfile",
  "go.mod",
  "package.json",
  "pom.xml",
  "pyproject.toml",
]);

const LOCK_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "deno.lock",
  "gemfile.lock",
  "package-lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

const GENERATED_DIRECTORIES = new Set([
  ".next",
  ".nuxt",
  ".svelte-kit",
  "build",
  "coverage",
  "dist",
  "gen",
  "generated",
  "out",
  "target",
]);

const VENDORED_DIRECTORIES = new Set([
  "bower_components",
  "node_modules",
  "third-party",
  "third_party",
  "vendor",
  "vendors",
]);

function classification(
  path: string,
  category: ReviewFileCategory,
  detailedReview: boolean,
  supportingEvidence = detailedReview,
): ReviewFileClassification {
  return { path, category, detailedReview, supportingEvidence };
}

function isManifest(name: string): boolean {
  return (
    MANIFEST_NAMES.has(name) ||
    /^requirements(?:[._-].+)?\.txt$/u.test(name) ||
    /^build\.gradle(?:\.kts)?$/u.test(name) ||
    /\.csproj$/u.test(name)
  );
}

function isGeneratorSource(pathSegments: readonly string[], name: string): boolean {
  return (
    pathSegments.some((segment) => segment === "generator" || segment === "generators") ||
    /^(?:codegen|generate|generator)(?:[._-]|$)/u.test(name)
  );
}

export function classifyReviewFile(path: string): ReviewFileClassification {
  const lowerPath = path.toLowerCase();
  const segments = lowerPath.split("/");
  const name = basename(lowerPath);

  if (isManifest(name)) {
    return classification(path, "manifest", true);
  }
  if (isGeneratorSource(segments.slice(0, -1), name)) {
    return classification(path, "generator-source", true);
  }
  if (LOCK_NAMES.has(name)) {
    return classification(path, "lock", false, true);
  }
  if (segments.some((segment) => VENDORED_DIRECTORIES.has(segment))) {
    return classification(path, "vendored", false);
  }
  if (
    segments.includes("__snapshots__") ||
    name.endsWith(".snap") ||
    name.includes(".snapshot.")
  ) {
    return classification(path, "snapshot", false);
  }
  if (/(?:^|[.-])min\.[a-z0-9]+(?:\.map)?$/u.test(name)) {
    return classification(path, "minified", false);
  }
  if (
    segments.some((segment) => GENERATED_DIRECTORIES.has(segment)) ||
    /(?:^|[._-])generated(?:[._-]|$)/u.test(name) ||
    /\.(?:g|gen)\.[a-z0-9]+$/u.test(name) ||
    /\.(?:map)$/u.test(name)
  ) {
    return classification(path, "generated", false);
  }
  return classification(path, "source", true);
}
