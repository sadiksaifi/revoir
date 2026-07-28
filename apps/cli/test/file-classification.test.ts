import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyReviewFile } from "../src/review/file-classification.js";

describe("review file classification", () => {
  it("excludes deterministic generated, vendored, minified, snapshot, and lock paths", () => {
    const fixtures = [
      ["src/generated/client.ts", "generated", false],
      ["dist/index.js", "generated", false],
      ["src/schema.generated.ts", "generated", false],
      ["vendor/library/source.ts", "vendored", false],
      ["third_party/library/source.cc", "vendored", false],
      ["public/app.min.js", "minified", false],
      ["test/__snapshots__/view.test.ts.snap", "snapshot", false],
      ["pnpm-lock.yaml", "lock", true],
      ["packages/app/package-lock.json", "lock", true],
    ] as const;

    for (const [path, category, supportingEvidence] of fixtures) {
      assert.deepEqual(classifyReviewFile(path), {
        path,
        category,
        detailedReview: false,
        supportingEvidence,
      });
    }
  });

  it("keeps manifests, authored generator sources, and ordinary source eligible for detail", () => {
    const fixtures = [
      ["package.json", "manifest"],
      ["vendor/package.json", "manifest"],
      ["tools/generate-client.ts", "generator-source"],
      ["generators/openapi.ts", "generator-source"],
      ["src/client.ts", "source"],
    ] as const;

    for (const [path, category] of fixtures) {
      assert.deepEqual(classifyReviewFile(path), {
        path,
        category,
        detailedReview: true,
        supportingEvidence: true,
      });
    }
  });

  it("keeps generator-like files excluded inside generated and vendored directories", () => {
    const fixtures = [
      ["dist/generator.js", "generated"],
      ["generated/generate-client.ts", "generated"],
      ["vendor/generator.ts", "vendored"],
      ["third_party/generators/client.ts", "vendored"],
    ] as const;

    for (const [path, category] of fixtures) {
      assert.deepEqual(classifyReviewFile(path), {
        path,
        category,
        detailedReview: false,
        supportingEvidence: false,
      });
    }
  });

  it("excludes common ecosystem lockfiles while retaining them as supporting evidence", () => {
    const paths = [
      "Podfile.lock",
      "ios/Podfile.lock",
      "Package.resolved",
      ".swiftpm/Package.resolved",
      "go.sum",
      "services/api/go.sum",
      "go.work.sum",
      "workspace/go.work.sum",
    ];

    for (const path of paths) {
      assert.deepEqual(classifyReviewFile(path), {
        path,
        category: "lock",
        detailedReview: false,
        supportingEvidence: true,
      });
    }
  });

  it("uses semantic lock basenames without excluding similarly named authored files", () => {
    const lockPaths = [
      "packages.lock.json",
      "src/packages.LOCK.JSON",
      "pubspec.lock",
      "npm-shrinkwrap.json",
      "gradle.lockfile",
      "cache.lockb",
      "dependency-lock.yaml",
      "workspace_lock.yml",
      "lock.json",
      "shrinkwrap.yaml",
    ];
    for (const path of lockPaths) {
      assert.deepEqual(classifyReviewFile(path), {
        path,
        category: "lock",
        detailedReview: false,
        supportingEvidence: true,
      });
    }

    const sourcePaths = [
      "clock.json",
      "locksmith.json",
      "lockstep.yaml",
      "deadlock-analysis.json",
      "catalog.locked",
      "lock.ts",
      "package-lock.xml",
      "package-lock.json.example",
      "yarn.lock.backup",
      "README.lock.md",
    ];
    for (const path of sourcePaths) {
      assert.deepEqual(classifyReviewFile(path), {
        path,
        category: "source",
        detailedReview: true,
        supportingEvidence: true,
      });
    }
  });
});
