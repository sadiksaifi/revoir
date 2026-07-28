import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

import type { ModelFindingV1 } from "@revoir/contracts";

import {
  FindingContractError,
  findingFingerprint,
  validateModelReviewOutput,
} from "../src/review/findings.js";
import { createReviewPublication } from "../src/review/publication.js";
import { planFindingReconciliation } from "../src/review/reconciliation.js";

const execFileAsync = promisify(execFile);
const NFD_PATH = "cafe\u0301.ts";
const NFC_PATH = NFD_PATH.normalize("NFC");
const LITERAL_SPACE_PATH = "literal [1] .ts";
const BACKSLASH_PATH = "slash\\name.ts";

const DIFF = `diff --git a/source.ts b/source.ts
index 1111111..2222222 100644
--- a/source.ts
+++ b/source.ts
@@ -1,3 +1,4 @@
 const retained = true;
-const removed = true;
+const added = true;
+const second = true;
 const tail = true;
diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
index 3333333..0000000
--- a/deleted.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second
diff --git a/old-name.ts b/new-name.ts
similarity index 50%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1 +1 @@
-old
+new
diff --git a/logo.png b/logo.png
index 4444444..5555555 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/missing.ts b/missing.ts
new file mode 100644
--- /dev/null
+++ b/missing.ts
@@ -0,0 +1 @@
+missing
diff --git a/mode.sh b/mode.sh
old mode 100644
new mode 100755
`;

const GIT_TREE_DIFF = `${DIFF}diff --git a/symlink.ts b/symlink.ts
new file mode 120000
index 0000000..7777777
--- /dev/null
+++ b/symlink.ts
@@ -0,0 +1 @@
+source.ts
diff --git a/vendor b/vendor
index 8888888..9999999 160000
--- a/vendor
+++ b/vendor
@@ -1 +1 @@
-Subproject commit 1111111111111111111111111111111111111111
+Subproject commit 2222222222222222222222222222222222222222
diff --git a/directory b/directory
index aaaaaaa..bbbbbbb 040000
diff --git a/literal[1].ts b/literal[1].ts
new file mode 100644
--- /dev/null
+++ b/literal[1].ts
@@ -0,0 +1 @@
+literal
`;

function finding(overrides: Record<string, unknown> = {}) {
  const candidate = {
    priority: "P1",
    path: "source.ts",
    range: { start: 2, end: 3, side: "RIGHT" },
    defectKind: "concurrency",
    impactKind: "execution-stall",
    fixAction: "synchronize",
    anchor: "const",
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "anchor")) {
    const path = typeof candidate.path === "string" ? candidate.path : "";
    const range =
      typeof candidate.range === "object" && candidate.range !== null
        ? (candidate.range as { side?: unknown })
        : null;
    candidate.anchor =
      range === null
        ? path
        : path === "deleted.ts"
          ? "first"
          : path === "new-name.ts"
            ? range.side === "LEFT"
              ? "old"
              : "new"
            : path === BACKSLASH_PATH
              ? "backslash"
              : "const";
  }
  return candidate;
}

function output(findings: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, findings, ...extra });
}

describe("finding validation", () => {
  let checkout = "";

  before(async () => {
    checkout = await mkdtemp(join(tmpdir(), "revoir-findings-"));
    await Promise.all([
      writeFile(join(checkout, "source.ts"), "const added = true;\n"),
      writeFile(join(checkout, "new-name.ts"), "new\n"),
      writeFile(join(checkout, "logo.png"), Buffer.from([0, 1, 2])),
      writeFile(join(checkout, "mode.sh"), "#!/bin/sh\n"),
      writeFile(join(checkout, "outside.ts"), "unchanged\n"),
      writeFile(join(checkout, "literal[1].ts"), "literal\n"),
      writeFile(join(checkout, NFD_PATH), "decomposed\n"),
      writeFile(join(checkout, LITERAL_SPACE_PATH), "literal space\n"),
      writeFile(join(checkout, BACKSLASH_PATH), "const backslash = true;\n"),
      mkdir(join(checkout, "directory")).then(() =>
        writeFile(join(checkout, "directory", "nested.ts"), "nested\n"),
      ),
      symlink("source.ts", join(checkout, "symlink.ts")),
    ]);
    await execFileAsync("git", ["init", "--quiet"], { cwd: checkout });
    await execFileAsync("git", ["config", "user.name", "Revoir Test"], { cwd: checkout });
    await execFileAsync("git", ["config", "user.email", "revoir@example.test"], {
      cwd: checkout,
    });
    await execFileAsync("git", ["config", "core.precomposeUnicode", "false"], {
      cwd: checkout,
    });
    await execFileAsync("git", ["add", "--all"], { cwd: checkout });
    await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: checkout });
    const { stdout: treeNames } = await execFileAsync(
      "git",
      ["ls-tree", "-rz", "--name-only", "HEAD"],
      { cwd: checkout, encoding: "buffer" },
    );
    assert.ok(
      treeNames
        .subarray(0, -1)
        .toString("utf8")
        .split("\u0000")
        .some((entry) => Buffer.from(entry).equals(Buffer.from(NFD_PATH))),
    );
    const { stdout: sourceBlob } = await execFileAsync("git", ["rev-parse", "HEAD:source.ts"], {
      cwd: checkout,
      encoding: "utf8",
    });
    await execFileAsync(
      "git",
      ["update-index", "--add", "--cacheinfo", `100644,${sourceBlob.trim()},${NFC_PATH}`],
      { cwd: checkout },
    );
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
    });
    await execFileAsync(
      "git",
      ["update-index", "--add", "--cacheinfo", `160000,${stdout.trim()},vendor`],
      { cwd: checkout },
    );
    await execFileAsync("git", ["commit", "--quiet", "-m", "add gitlink"], {
      cwd: checkout,
    });
  });

  after(async () => {
    await rm(checkout, { recursive: true, force: true });
  });

  it("accepts clean output and exact inline additions", async () => {
    assert.deepEqual(await validateModelReviewOutput(output([]), { checkout, diff: DIFF }), {
      version: 1,
      findings: [],
      diagnostics: [],
    });
    const result = await validateModelReviewOutput(output([finding()]), {
      checkout,
      diff: DIFF,
    });
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0]?.attachment, {
      kind: "inline",
      path: "source.ts",
      startLine: 2,
      endLine: 3,
      side: "RIGHT",
    });
    assert.match(result.findings[0]?.fingerprint ?? "", /^[0-9a-f]{64}$/u);
  });

  it("maps deletions and both sides of renames to GitHub's API path", async () => {
    const result = await validateModelReviewOutput(
      output([
        finding({
          path: "deleted.ts",
          range: { start: 1, end: 2, side: "LEFT" },
        }),
        finding({
          path: "new-name.ts",
          range: { start: 1, end: 1, side: "LEFT" },
        }),
        finding({
          path: "new-name.ts",
          range: { start: 1, end: 1, side: "RIGHT" },
        }),
      ]),
      { checkout, diff: DIFF },
    );
    assert.deepEqual(
      result.findings.map((candidate) => candidate.attachment),
      [
        {
          kind: "inline",
          path: "deleted.ts",
          startLine: 1,
          endLine: 2,
          side: "LEFT",
        },
        {
          kind: "inline",
          path: "new-name.ts",
          startLine: 1,
          endLine: 1,
          side: "LEFT",
        },
        {
          kind: "inline",
          path: "new-name.ts",
          startLine: 1,
          endLine: 1,
          side: "RIGHT",
        },
      ],
    );
  });

  it("keeps binary, mode-only, and explicit file-level findings in the body", async () => {
    const result = await validateModelReviewOutput(
      output([
        finding({
          path: "logo.png",
          range: null,
        }),
        finding({
          path: "mode.sh",
          range: null,
        }),
        finding({
          range: null,
        }),
      ]),
      { checkout, diff: DIFF },
    );
    assert.deepEqual(
      result.findings.map((candidate) => candidate.attachment),
      [
        { kind: "file", path: "logo.png" },
        { kind: "file", path: "mode.sh" },
        { kind: "file", path: "source.ts" },
      ],
    );
  });

  it("rejects traversal, nonexistent, directory, and out-of-diff paths", async () => {
    const cases = [
      "",
      ".",
      "./source.ts",
      "../source.ts",
      "nested/../source.ts",
      "nested//source.ts",
      "/source.ts",
      "missing.ts",
      "directory",
      "outside.ts",
      "source.ts/",
    ];
    for (const path of cases) {
      // Keep each rejection isolated for clear case attribution.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () =>
          validateModelReviewOutput(output([finding({ path, range: null })]), {
            checkout,
            diff: DIFF,
          }),
        FindingContractError,
      );
    }
  });

  it("preserves a literal backslash through diff, tree, fingerprint, and payload paths", async () => {
    const repository = await mkdtemp(join(tmpdir(), "revoir-backslash-path-"));
    try {
      await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
      await execFileAsync("git", ["config", "user.name", "Revoir Test"], { cwd: repository });
      await execFileAsync("git", ["config", "user.email", "revoir@example.test"], {
        cwd: repository,
      });
      await writeFile(join(repository, "README.md"), "base\n");
      await execFileAsync("git", ["add", "--all"], { cwd: repository });
      await execFileAsync("git", ["commit", "--quiet", "-m", "base"], { cwd: repository });
      const { stdout: base } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
      });
      await writeFile(join(repository, BACKSLASH_PATH), "const backslash = true;\n");
      await execFileAsync("git", ["add", "--all"], { cwd: repository });
      await execFileAsync("git", ["commit", "--quiet", "-m", "head"], { cwd: repository });
      const { stdout: diff } = await execFileAsync(
        "git",
        ["diff", "--binary", "--src-prefix=a/", "--dst-prefix=b/", base.trim(), "HEAD", "--"],
        { cwd: repository },
      );
      assert.equal(diff.includes('"a/slash\\\\name.ts"'), true);

      const result = await validateModelReviewOutput(
        output([
          finding({
            path: BACKSLASH_PATH,
            range: { start: 1, end: 1, side: "RIGHT" },
          }),
        ]),
        { checkout: repository, diff },
      );

      assert.equal(result.findings[0]?.path, BACKSLASH_PATH);
      assert.deepEqual(Buffer.from(result.findings[0]?.path ?? ""), Buffer.from(BACKSLASH_PATH));
      assert.equal(result.findings[0]?.attachment.path, BACKSLASH_PATH);
      const publication = createReviewPublication("f".repeat(40), result.findings);
      assert.equal(publication.payload.comments?.[0]?.path, BACKSLASH_PATH);
      assert.match(publication.payload.comments?.[0]?.body ?? "", /slash\\name\.ts/u);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("validates exact reviewed-head Git tree entry types including an uninitialized gitlink", async () => {
    const result = await validateModelReviewOutput(
      output([
        finding({
          path: "source.ts",
          range: null,
        }),
        finding({
          path: "symlink.ts",
          range: null,
        }),
        finding({
          path: "vendor",
          range: null,
        }),
        finding({
          path: "literal[1].ts",
          range: null,
        }),
        finding({
          path: "directory",
          range: null,
        }),
        finding({
          path: "missing.ts",
          range: null,
        }),
        finding({
          path: "deleted.ts",
          range: null,
        }),
      ]),
      { checkout, diff: GIT_TREE_DIFF },
    );

    assert.equal(result.findings.length, 5, JSON.stringify(result.diagnostics));
    assert.deepEqual(
      result.findings.map(({ path, attachment: findingAttachment }) => ({
        path,
        attachment: findingAttachment,
      })),
      [
        { path: "source.ts", attachment: { kind: "file", path: "source.ts" } },
        { path: "symlink.ts", attachment: { kind: "file", path: "symlink.ts" } },
        { path: "vendor", attachment: { kind: "file", path: "vendor" } },
        { path: "literal[1].ts", attachment: { kind: "file", path: "literal[1].ts" } },
        { path: "deleted.ts", attachment: { kind: "file", path: "deleted.ts" } },
      ],
    );
    assert.deepEqual(
      result.diagnostics.map(({ index, message }) => ({ index, message })),
      [
        { index: 4, message: "path does not identify a file in the reviewed head." },
        { index: 5, message: "path does not exist in the reviewed head." },
      ],
    );
  });

  it("rejects context, wrong-side, gapped, and binary line ranges", async () => {
    const ranges = [
      { path: "source.ts", range: { start: 1, end: 1, side: "RIGHT" } },
      { path: "source.ts", range: { start: 3, end: 3, side: "LEFT" } },
      { path: "source.ts", range: { start: 2, end: 4, side: "RIGHT" } },
      { path: "logo.png", range: { start: 1, end: 1, side: "RIGHT" } },
    ];
    for (const candidate of ranges) {
      // Keep each rejection isolated for clear case attribution.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () =>
          validateModelReviewOutput(output([finding(candidate)]), {
            checkout,
            diff: DIFF,
          }),
        /no publishable findings/u,
      );
    }
  });

  it("rejects unknown and incompatible semantic values with static diagnostics", async () => {
    const privateValue = "PRIVATE_MODEL_VALUE";
    const result = await validateModelReviewOutput(
      output([
        finding(),
        finding({ defectKind: privateValue }),
        finding({ impactKind: privateValue }),
        finding({ fixAction: privateValue }),
        finding({ defectKind: "security", impactKind: "resource-leak" }),
        finding({ defectKind: "security", impactKind: "security-exposure", fixAction: "release" }),
      ]),
      { checkout, diff: DIFF },
    );

    assert.equal(result.findings.length, 1);
    assert.equal(result.diagnostics.length, 5);
    for (const diagnostic of result.diagnostics) {
      assert.equal(diagnostic.message.includes(privateValue), false);
      assert.match(diagnostic.message, /supported|incompatible/u);
    }
    assert.equal(
      JSON.stringify(createReviewPublication("1".repeat(40), result.findings)).includes(
        privateValue,
      ),
      false,
    );
  });

  it("requires an exact technical anchor in the selected authoritative change", async () => {
    const privateAnchor = "PRIVATE_UNOBSERVED_ANCHOR";
    const result = await validateModelReviewOutput(
      output([
        finding({ anchor: "added" }),
        finding({ anchor: privateAnchor }),
        finding({ anchor: "Added" }),
        finding({ anchor: "adde\u0301d" }),
      ]),
      { checkout, diff: DIFF },
    );

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.anchor, "added");
    assert.equal(result.diagnostics.length, 3);
    for (const diagnostic of result.diagnostics) {
      assert.equal(
        diagnostic.message,
        "technical anchor is not present in the authoritative changed content.",
      );
      assert.equal(diagnostic.message.includes(privateAnchor), false);
    }
  });

  it("covers every defect class without accepting model-controlled prose fields", async () => {
    const classes = [
      ["correctness", "incorrect-result", "guard"],
      ["validation", "operation-failure", "validate"],
      ["resource-lifecycle", "resource-leak", "release"],
      ["concurrency", "execution-stall", "synchronize"],
      ["security", "security-exposure", "validate"],
      ["compatibility", "compatibility-break", "preserve"],
      ["error-handling", "operation-failure", "propagate"],
      ["test-coverage", "regression-risk", "add-test"],
    ] as const;
    const result = await validateModelReviewOutput(
      output(
        classes.map(([defectKind, impactKind, fixAction], index) =>
          finding({
            priority: `P${index % 4}`,
            range: null,
            defectKind,
            impactKind,
            fixAction,
            anchor: "source.ts",
          }),
        ),
      ),
      { checkout, diff: DIFF },
    );

    assert.deepEqual(
      result.findings.map(({ defectKind }) => defectKind),
      classes.map(([defectKind]) => defectKind),
    );
    const publication = JSON.stringify(createReviewPublication("1".repeat(40), result.findings));
    for (const forbidden of ["flawless", "looks good", "summary", "must not merge", "perhaps"]) {
      assert.equal(publication.toLowerCase().includes(forbidden), false);
    }

    const oldProseShape = {
      priority: "P1",
      path: "source.ts",
      range: null,
      defectKind: "correctness",
      impactKind: "incorrect-result",
      fixAction: "guard",
      anchor: "source.ts",
      title: "PRIVATE_TITLE",
    };
    await assert.rejects(
      () => validateModelReviewOutput(output([oldProseShape]), { checkout, diff: DIFF }),
      (error: unknown) => {
        assert.ok(error instanceof FindingContractError);
        assert.equal(JSON.stringify(error.diagnostics).includes("PRIVATE_TITLE"), false);
        return true;
      },
    );
  });

  it("collapses duplicate stable fingerprints with first-valid-wins ordering", async () => {
    const result = await validateModelReviewOutput(
      output([
        finding(),
        finding({
          priority: "P3",
        }),
      ]),
      { checkout, diff: DIFF },
    );
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.priority, "P1");
    assert.equal(result.diagnostics[0]?.code, "duplicate");
  });

  it("keeps distinct same-anchor occurrences publishable across separate changed ranges", async () => {
    const diff = `diff --git a/source.ts b/source.ts
index 1111111..2222222 100644
--- a/source.ts
+++ b/source.ts
@@ -1 +1,4 @@
 const retained = true;
+throwIfAborted(signal);
+const between = true;
+throwIfAborted(signal);
`;
    const result = await validateModelReviewOutput(
      output([
        finding({
          range: { start: 2, end: 2, side: "RIGHT" },
          anchor: "throwIfAborted(signal);",
        }),
        finding({
          range: { start: 4, end: 4, side: "RIGHT" },
          anchor: "throwIfAborted(signal);",
        }),
      ]),
      { checkout, diff },
    );

    assert.equal(result.findings.length, 2);
    assert.equal(result.diagnostics.length, 0);
    assert.notEqual(result.findings[0]?.fingerprint, result.findings[1]?.fingerprint);
  });

  it("keeps a surviving same-anchor occurrence stable after its peer disappears", async () => {
    const withPeer = `diff --git a/source.ts b/source.ts
index 1111111..2222222 100644
--- a/source.ts
+++ b/source.ts
@@ -1 +1,4 @@
 const retained = true;
+throwIfAborted(signal);
+const between = true;
+throwIfAborted(signal);
`;
    const withoutPeer = `diff --git a/source.ts b/source.ts
index 1111111..3333333 100644
--- a/source.ts
+++ b/source.ts
@@ -1 +1,3 @@
 const retained = true;
+const between = true;
+throwIfAborted(signal);
`;
    const peer = finding({
      range: { start: 2, end: 2, side: "RIGHT" },
      anchor: "throwIfAborted(signal);",
    });
    const survivingWithPeer = finding({
      range: { start: 4, end: 4, side: "RIGHT" },
      anchor: "throwIfAborted(signal);",
    });
    const survivingWithoutPeer = finding({
      range: { start: 3, end: 3, side: "RIGHT" },
      anchor: "throwIfAborted(signal);",
    });
    const firstRun = await validateModelReviewOutput(output([peer, survivingWithPeer]), {
      checkout,
      diff: withPeer,
    });
    const secondRun = await validateModelReviewOutput(output([survivingWithoutPeer]), {
      checkout,
      diff: withoutPeer,
    });
    const peerFingerprint = firstRun.findings[0]!.fingerprint;
    const survivingFingerprint = firstRun.findings[1]!.fingerprint;

    assert.equal(secondRun.findings[0]?.fingerprint, survivingFingerprint);
    assert.deepEqual(
      planFindingReconciliation(secondRun.findings, {
        activeFingerprints: [peerFingerprint, survivingFingerprint],
        ownedOpenThreads: [
          { id: "THREAD_PEER", fingerprint: peerFingerprint },
          { id: "THREAD_SURVIVOR", fingerprint: survivingFingerprint },
        ],
        runHeadShas: ["1".repeat(40)],
      }),
      {
        netNewFindings: [],
        obsoleteThreadIds: ["THREAD_PEER"],
      },
    );
  });

  it("keeps Unicode case-fold lookalikes as distinct exact anchors", async () => {
    const diff = `diff --git a/source.ts b/source.ts
index 1111111..2222222 100644
--- a/source.ts
+++ b/source.ts
@@ -1 +1 @@
-const previous = true;
+const Straße = STRASSE;
`;
    const result = await validateModelReviewOutput(
      output([
        finding({ range: { start: 1, end: 1, side: "RIGHT" }, anchor: "Straße" }),
        finding({ range: { start: 1, end: 1, side: "RIGHT" }, anchor: "STRASSE" }),
      ]),
      { checkout, diff },
    );

    assert.equal(result.findings.length, 2);
    assert.equal(result.diagnostics.length, 0);
    assert.notEqual(result.findings[0]?.fingerprint, result.findings[1]?.fingerprint);
  });

  it("uses a stable finding-identity fingerprint matrix across repeated reviews", () => {
    const base = finding() as unknown as ModelFindingV1;
    const fingerprint = findingFingerprint(base);
    assert.equal(
      findingFingerprint({
        anchor: base.anchor,
        fixAction: base.fixAction,
        impactKind: base.impactKind,
        defectKind: base.defectKind,
        range: base.range,
        path: base.path,
      }),
      fingerprint,
    );
    assert.equal(findingFingerprint({ ...base }), fingerprint, "identical finding");
    assert.equal(
      findingFingerprint({
        ...base,
        range: { start: 20, end: 21, side: "LEFT" },
      }),
      fingerprint,
      "moved finding",
    );
    assert.equal(
      findingFingerprint({ ...base, fixAction: "propagate" }),
      fingerprint,
      "changed remediation for the same defect",
    );
    assert.notEqual(findingFingerprint({ ...base, path: "new-name.ts" }), fingerprint);
    for (const changed of [
      { defectKind: "correctness" },
      { impactKind: "incorrect-result" },
      { anchor: "Const" },
      { anchor: "Straße" },
      { anchor: "STRASSE" },
      { anchor: "İ" },
      { anchor: "i" },
      { anchor: "Σ" },
      { anchor: "σ" },
      { anchor: "ς" },
    ] as const) {
      assert.notEqual(findingFingerprint({ ...base, ...changed }), fingerprint);
    }
    assert.notEqual(
      findingFingerprint({ ...base, anchor: "café" }),
      findingFingerprint({ ...base, anchor: "cafe\u0301" }),
    );
    assert.notEqual(
      findingFingerprint({ ...base, path: NFC_PATH }),
      findingFingerprint({ ...base, path: NFD_PATH }),
    );
    for (const [left, right] of [
      ["Straße", "STRASSE"],
      ["İ", "i"],
      ["Σ", "σ"],
      ["σ", "ς"],
    ] as const) {
      assert.notEqual(
        findingFingerprint({ ...base, anchor: left }),
        findingFingerprint({ ...base, anchor: right }),
      );
    }
  });

  it("preserves exact NFD, NFC, metacharacter, and space paths through validation", async () => {
    const diff = `diff --git "a/cafe\\314\\201.ts" "b/cafe\\314\\201.ts"
index 1111111..2222222 100644
--- "a/cafe\\314\\201.ts"
+++ "b/cafe\\314\\201.ts"
@@ -1 +1 @@
-old
+decomposed
diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"
index 3333333..4444444 100644
--- "a/caf\\303\\251.ts"
+++ "b/caf\\303\\251.ts"
@@ -1 +1 @@
-old
+composed
diff --git a/literal [1] .ts b/literal [1] .ts
index 5555555..6666666 100644
--- a/literal [1] .ts
+++ b/literal [1] .ts
@@ -1 +1 @@
-old
+literal space
`;
    const result = await validateModelReviewOutput(
      output([
        finding({
          path: NFD_PATH,
          range: { start: 1, end: 1, side: "RIGHT" },
          anchor: "decomposed",
        }),
        finding({
          path: NFC_PATH,
          range: { start: 1, end: 1, side: "RIGHT" },
          anchor: "composed",
        }),
        finding({
          path: LITERAL_SPACE_PATH,
          range: { start: 1, end: 1, side: "RIGHT" },
          anchor: "literal space",
        }),
      ]),
      { checkout, diff },
    );

    assert.deepEqual(
      result.findings.map(({ path, fingerprint, attachment: exactAttachment }) => ({
        path,
        fingerprint,
        attachment: exactAttachment,
      })),
      [
        {
          path: NFD_PATH,
          fingerprint: findingFingerprint({
            ...(finding() as unknown as ModelFindingV1),
            path: NFD_PATH,
            range: { start: 1, end: 1, side: "RIGHT" },
            anchor: "decomposed",
          }),
          attachment: {
            kind: "inline",
            path: NFD_PATH,
            startLine: 1,
            endLine: 1,
            side: "RIGHT",
          },
        },
        {
          path: NFC_PATH,
          fingerprint: findingFingerprint({
            ...(finding() as unknown as ModelFindingV1),
            path: NFC_PATH,
            range: { start: 1, end: 1, side: "RIGHT" },
            anchor: "composed",
          }),
          attachment: {
            kind: "inline",
            path: NFC_PATH,
            startLine: 1,
            endLine: 1,
            side: "RIGHT",
          },
        },
        {
          path: LITERAL_SPACE_PATH,
          fingerprint: findingFingerprint({
            ...(finding() as unknown as ModelFindingV1),
            path: LITERAL_SPACE_PATH,
            range: { start: 1, end: 1, side: "RIGHT" },
            anchor: "literal space",
          }),
          attachment: {
            kind: "inline",
            path: LITERAL_SPACE_PATH,
            startLine: 1,
            endLine: 1,
            side: "RIGHT",
          },
        },
      ],
    );
    assert.notEqual(result.findings[0]?.fingerprint, result.findings[1]?.fingerprint);
    assert.deepEqual(
      createReviewPublication("1".repeat(40), result.findings).payload.comments?.map(
        ({ path }) => path,
      ),
      [NFD_PATH, NFC_PATH, LITERAL_SPACE_PATH],
    );
  });

  it("rejects malformed envelopes and nonempty all-invalid output", async () => {
    for (const value of [
      "not json",
      '{"version":2,"findings":[]}',
      '{"version":1,"findings":[],"summary":"clean"}',
      output([finding({ priority: "P9" })]),
    ]) {
      // Keep each rejection isolated for clear case attribution.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () => validateModelReviewOutput(value, { checkout, diff: DIFF }),
        FindingContractError,
      );
    }
  });
});
