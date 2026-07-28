import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  assembleReviewContext,
  loadApplicableRepositoryGuidance,
} from "../src/review/context.js";
import { parsePullRequestUrl, type PullRequestSnapshot } from "../src/review/pull-request.js";
import type { PreparedWorkspace } from "../src/review/workspace.js";

const DIFF = `diff --git a/apps/api/src/server.ts b/apps/api/src/server.ts
index 1111111..2222222 100644
--- a/apps/api/src/server.ts
+++ b/apps/api/src/server.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
diff --git a/apps/web/src/page.ts b/apps/web/src/page.ts
index 3333333..4444444 100644
--- a/apps/web/src/page.ts
+++ b/apps/web/src/page.ts
@@ -1 +1 @@
-export const page = 1;
+export const page = 2;
`;

function pullRequest(): PullRequestSnapshot {
  return {
    number: 17,
    description: "Preserve the API contract while changing both applications.",
    state: "open",
    draft: false,
    authorId: 42,
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    baseRepository: {
      id: 99,
      fullName: "owner/repository",
      cloneUrl: "https://github.com/owner/repository.git",
    },
    headRepository: {
      id: 99,
      fullName: "owner/repository",
      cloneUrl: "https://github.com/owner/repository.git",
    },
  };
}

describe("review context", () => {
  it("loads root and changed-path guidance without loading unrelated guidance", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "revoir-guidance-"));
    try {
      await Promise.all([
        mkdir(join(checkout, "apps", "api", "src"), { recursive: true }),
        mkdir(join(checkout, "apps", "web", "src"), { recursive: true }),
        mkdir(join(checkout, "unrelated"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(checkout, "AGENTS.md"), "root agents"),
        writeFile(join(checkout, "CONTRIBUTING.md"), "root contributing"),
        writeFile(join(checkout, "apps", "AGENTS.md"), "apps agents"),
        writeFile(join(checkout, "apps", "api", "CONTRIBUTING.md"), "api contributing"),
        writeFile(join(checkout, "unrelated", "AGENTS.md"), "must not load"),
      ]);

      assert.deepEqual(await loadApplicableRepositoryGuidance(checkout, DIFF), [
        { path: "AGENTS.md", content: "root agents" },
        { path: "CONTRIBUTING.md", content: "root contributing" },
        { path: "apps/AGENTS.md", content: "apps agents" },
        { path: "apps/api/CONTRIBUTING.md", content: "api contributing" },
      ]);
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it("assembles the PR description, complete diff, guidance, and file policy", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "revoir-context-"));
    try {
      await mkdir(join(checkout, "apps"), { recursive: true });
      await writeFile(join(checkout, "AGENTS.md"), "Review public behavior.");
      const workspace: PreparedWorkspace = {
        root: checkout,
        checkout,
        diff: DIFF,
        remoteUrl: "https://github.com/owner/repository.git",
        async cleanup() {},
      };

      const context = await assembleReviewContext({
        reference: parsePullRequestUrl("https://github.com/owner/repository/pull/17"),
        pullRequest: pullRequest(),
        workspace,
        evidence: { completedChecks: [] },
      });

      assert.equal(context.pullRequestDescription, pullRequest().description);
      assert.equal(context.completeDiff, DIFF);
      assert.deepEqual(context.guidance, [
        { path: "AGENTS.md", content: "Review public behavior." },
      ]);
      assert.deepEqual(
        context.files.map(({ path, detailedReview }) => ({ path, detailedReview })),
        [
          { path: "apps/api/src/server.ts", detailedReview: true },
          { path: "apps/web/src/page.ts", detailedReview: true },
        ],
      );
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });
});
