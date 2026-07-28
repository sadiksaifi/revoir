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

const execFileAsync = promisify(execFile);

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
  return {
    priority: "P1",
    title: "Cancellation is dropped",
    path: "source.ts",
    range: { start: 2, end: 3, side: "RIGHT" },
    issue: "The added branch does not forward the cancellation signal.",
    impact: "The missing signal lets timed-out work consume the single review slot.",
    evidence:
      "Both added calls omit the cancellation signal argument required by the invoked operation.",
    fixDirection: "Pass the active cancellation signal to both calls.",
    ...overrides,
  };
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
    await execFileAsync("git", ["add", "--all"], { cwd: checkout });
    await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: checkout });
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
          title: "Validation guard is deleted",
          issue: "The deleted guard was the only validation before persistence.",
          evidence: "The deleted validation guard is absent before persistence.",
          fixDirection: "Restore the validation guard before persistence.",
        }),
        finding({
          path: "new-name.ts",
          range: { start: 1, end: 1, side: "LEFT" },
          title: "Compatibility export is deleted",
          issue: "The renamed file removes the exported compatibility alias.",
          evidence: "The deleted export is the compatibility alias.",
          fixDirection: "Restore the compatibility export.",
        }),
        finding({
          path: "new-name.ts",
          range: { start: 1, end: 1, side: "RIGHT" },
          title: "Runtime export name changes",
          issue: "The replacement export has a different runtime name.",
          evidence: "The added export declares a different runtime name.",
          fixDirection: "Restore the exported runtime name.",
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
          title: "Alpha channel is removed",
          issue: "The binary replacement removes the required alpha channel.",
          evidence: "The replacement bytes contain no alpha channel.",
          fixDirection: "Restore the alpha channel.",
        }),
        finding({
          path: "mode.sh",
          range: null,
          title: "Fixture becomes executable",
          issue: "The executable bit makes this untrusted fixture directly runnable.",
          evidence: "The changed mode marks the fixture executable.",
          fixDirection: "Remove the executable bit from the fixture.",
        }),
        finding({
          range: null,
          title: "Shared resource closes early",
          issue: "The file-level initialization order closes the shared resource early.",
          evidence: "The initialization closes the shared resource before its final use.",
          fixDirection: "Defer closing the shared resource.",
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
      "../source.ts",
      "/source.ts",
      "nested\\source.ts",
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

  it("validates exact reviewed-head Git tree entry types including an uninitialized gitlink", async () => {
    const result = await validateModelReviewOutput(
      output([
        finding({
          path: "source.ts",
          range: null,
          title: "Regular file initializes early",
          issue: "The regular file initializes the shared resource before validation.",
          evidence: "The regular file entry initializes the resource before validation.",
          fixDirection: "Defer regular file initialization until after validation.",
        }),
        finding({
          path: "symlink.ts",
          range: null,
          title: "Symlink redirects consumers",
          issue: "The symlink redirects review consumers to the changed implementation.",
          evidence: "The symlink target redirects consumers to source.ts.",
          fixDirection: "Update the symlink to the validated implementation.",
        }),
        finding({
          path: "vendor",
          range: null,
          title: "Gitlink omits compatibility fix",
          issue: "The gitlink advances to a revision without the required compatibility fix.",
          evidence: "The changed gitlink revision lacks the compatibility fix.",
          fixDirection: "Update the gitlink to a revision containing the compatibility fix.",
        }),
        finding({
          path: "literal[1].ts",
          range: null,
          title: "Literal path initializes early",
          issue: "The literal bracket path initializes the shared resource before validation.",
          evidence: "The literal path entry initializes the resource before validation.",
          fixDirection: "Defer literal path initialization until after validation.",
        }),
        finding({
          path: "directory",
          range: null,
          title: "Directory is not publishable",
          issue: "The directory entry does not identify a publishable file.",
          evidence: "The directory tree entry has no publishable blob.",
          fixDirection: "Use a publishable file instead of the directory.",
        }),
        finding({
          path: "missing.ts",
          range: null,
          title: "Tree entry is missing",
          issue: "The missing entry does not exist in the reviewed head tree.",
          evidence: "The head tree contains no matching entry.",
          fixDirection: "Use an existing head tree entry.",
        }),
        finding({
          path: "deleted.ts",
          range: null,
          title: "Validation file is deleted",
          issue: "The deleted file removes the only validation before persistence.",
          evidence: "The deleted file contained the validation before persistence.",
          fixDirection: "Restore the deleted validation.",
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

  it("rejects speculative, placeholder, non-actionable, and merge prose", async () => {
    const cases = [
      { evidence: "This might fail when the request is cancelled." },
      { evidence: "None" },
      { fixDirection: "Consider fixing this." },
      { issue: "P1 means this blocks merge until it is fixed." },
    ];
    for (const candidate of cases) {
      // Keep each rejection isolated for clear case attribution.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () =>
          validateModelReviewOutput(output([finding(candidate)]), {
            checkout,
            diff: DIFF,
          }),
        FindingContractError,
      );
    }
  });

  it("keeps placeholder title, issue, and impact prose out of publication", async () => {
    const placeholders = [
      { field: "title", value: "None" },
      { field: "issue", value: "Unknown" },
      { field: "impact", value: "Not provided" },
    ] as const;
    const technicalFinding = finding({
      title: "Terminal status bypasses cancellation",
      issue: "The branch maps an unknown terminal status to success.",
      impact: "No cancellation reaches the child process after that mapping.",
      evidence: "The terminal status branch returns success before cancellation.",
    });
    const result = await validateModelReviewOutput(
      output([
        technicalFinding,
        ...placeholders.map(({ field, value }) =>
          finding({
            [field]: value,
            issue:
              field === "issue"
                ? value
                : `The placeholder ${field} candidate omits required review context.`,
          }),
        ),
      ]),
      { checkout, diff: DIFF },
    );

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.title, technicalFinding.title);
    assert.deepEqual(
      result.diagnostics.map(({ index, code, message }) => ({ index, code, message })),
      [
        {
          index: 1,
          code: "invalid",
          message: "findings[1].title must state a substantive title.",
        },
        {
          index: 2,
          code: "invalid",
          message: "findings[2].issue must describe an observed issue.",
        },
        {
          index: 3,
          code: "invalid",
          message: "findings[3].impact must describe a concrete impact.",
        },
      ],
    );

    const publication = JSON.stringify(createReviewPublication("1".repeat(40), result.findings));
    for (const { value } of placeholders) {
      assert.equal(publication.includes(value), false);
      assert.equal(
        result.diagnostics
          .map((diagnostic) => diagnostic.message)
          .join("\n")
          .includes(value),
        false,
      );
    }
  });

  it("rejects structurally empty required prose while preserving terse technical findings", async () => {
    const terseFinding = finding({
      title: "Lock",
      issue: "Lock reenters.",
      impact: "Worker stalls.",
      evidence: "Lock reacquires recursively.",
      fixDirection: "Defer lock reacquisition.",
    });
    const result = await validateModelReviewOutput(
      output([
        terseFinding,
        finding({ title: "TBD" }),
        finding({ issue: "TBD" }),
        finding({ impact: "TBD" }),
        finding({ evidence: "TBD" }),
        finding({ fixDirection: "Add." }),
      ]),
      { checkout, diff: DIFF },
    );

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.title, "Lock");
    assert.deepEqual(
      result.diagnostics.map(({ index, message }) => ({ index, message })),
      [
        { index: 1, message: "findings[1].title must state a substantive title." },
        { index: 2, message: "findings[2].issue must describe an observed issue." },
        { index: 3, message: "findings[3].impact must describe a concrete impact." },
        { index: 4, message: "findings[4].evidence must describe supporting evidence." },
        { index: 5, message: "findings[5].fixDirection must state a concrete action." },
      ],
    );
    const publication = JSON.stringify(createReviewPublication("1".repeat(40), result.findings));
    assert.equal(publication.includes("TBD"), false);
    assert.equal(publication.includes("Add."), false);
    assert.equal(JSON.stringify(result.diagnostics).includes("TBD"), false);
  });

  it("rejects common speculative and merge-instruction prose before publication", async () => {
    const cases: readonly [Record<string, unknown>, RegExp][] = [
      [{ title: "Cancellation could be dropped" }, /speculative language/u],
      [{ issue: "The added branch may drop the cancellation signal." }, /speculative language/u],
      [
        { evidence: "The changed call likely omits the required cancellation signal." },
        /speculative language/u,
      ],
      [
        { fixDirection: "Guard the call because it could run after cancellation." },
        /speculative language/u,
      ],
      [{ title: "Must not merge with dropped cancellation" }, /merge or severity boilerplate/u],
      [
        {
          fixDirection:
            "Reject the change; it must not merge until the cancellation signal is forwarded.",
        },
        /merge or severity boilerplate/u,
      ],
    ];

    for (const [candidate, reason] of cases) {
      // Keep each prohibited phrase isolated for exact field and reason attribution.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () =>
          validateModelReviewOutput(output([finding(candidate)]), {
            checkout,
            diff: DIFF,
          }),
        (error: unknown) => {
          assert.ok(error instanceof FindingContractError);
          assert.match(error.diagnostics[0]?.message ?? "", reason);
          return true;
        },
      );
    }
  });

  it("allows concrete impact phrasing that describes a possible consequence", async () => {
    await assert.rejects(
      () =>
        validateModelReviewOutput(
          output([
            finding({
              impact:
                "A retry could publish the same finding twice after the first request succeeds.",
            }),
          ]),
          { checkout, diff: DIFF },
        ),
      (error: unknown) => {
        assert.ok(error instanceof FindingContractError);
        assert.match(error.diagnostics[0]?.message ?? "", /speculative language/u);
        return true;
      },
    );
  });

  it("keeps praise, summaries, and Markdown out of publication", async () => {
    const prohibited = [
      "Great work overall",
      "## Summary\nThe rest of the change looks good.",
      "The [changed call](https://example.test/private) omits the required signal.",
      "Pass the active cancellation signal.\n\n- Add a regression test.",
    ];
    const result = await validateModelReviewOutput(
      output([
        finding(),
        finding({
          title: prohibited[0],
          issue: "The first added branch does not forward cancellation.",
        }),
        finding({
          issue: prohibited[1],
        }),
        finding({
          issue: "The second added branch does not forward cancellation.",
          evidence: prohibited[2],
        }),
        finding({
          issue: "The third added branch does not forward cancellation.",
          fixDirection: prohibited[3],
        }),
      ]),
      { checkout, diff: DIFF },
    );

    assert.equal(result.findings.length, 1);
    assert.equal(result.diagnostics.length, prohibited.length);
    const publication = JSON.stringify(createReviewPublication("1".repeat(40), result.findings));
    for (const modelControlledText of prohibited) {
      assert.equal(publication.includes(modelControlledText), false);
      assert.equal(
        result.diagnostics
          .map((diagnostic) => diagnostic.message)
          .join("\n")
          .includes(modelControlledText),
        false,
      );
    }
  });

  it("grounds every prose role in shared technical evidence", async () => {
    const disconnected = [
      { title: "Excellent" },
      { title: "Parser overflow" },
      {
        issue: "The parser truncates bytes.",
        evidence: "The added call omits the cancellation signal argument.",
      },
      { impact: "Great implementation throughout." },
      { evidence: "The parser trace contains a truncated byte." },
      { fixDirection: "Guard the parser byte count." },
    ];
    const terse = finding({
      title: "callback_queue",
      issue: "callback_queue reenters.",
      impact: "callback_queue stalls.",
      evidence: "callback_queue reacquires lock.",
      fixDirection: "Defer callback_queue.",
    });
    const result = await validateModelReviewOutput(
      output([finding(), terse, ...disconnected.map((overrides) => finding(overrides))]),
      { checkout, diff: DIFF },
    );

    assert.deepEqual(
      result.findings.map(({ title }) => title),
      ["Cancellation is dropped", "callback_queue"],
    );
    assert.equal(result.diagnostics.length, disconnected.length);
    for (const diagnostic of result.diagnostics) {
      assert.match(diagnostic.message, /ground|praise|share|target/u);
      assert.equal(
        disconnected.some((candidate) =>
          Object.values(candidate).some((value) => diagnostic.message.includes(value)),
        ),
        false,
      );
    }
  });

  it("applies every global prose policy to all five published fields", async () => {
    const fields = ["title", "issue", "impact", "evidence", "fixDirection"] as const;
    const policies = [
      {
        reason: /speculative language/u,
        value: "Perhaps the changed branch drops the active signal.",
      },
      {
        reason: /merge or severity boilerplate/u,
        value: "Do not merge because the changed branch drops the active signal.",
      },
      {
        reason: /praise or general-summary prose/u,
        value: "Great implementation despite the changed branch dropping the active signal.",
      },
      {
        reason: /Markdown instead of concise finding prose/u,
        value: "The _changed branch_ drops the active signal.",
      },
      {
        reason: /Markdown instead of concise finding prose/u,
        value: "<!-- hidden --> The changed branch drops the active signal.",
      },
    ] as const;

    for (const field of fields) {
      for (const [policyIndex, policy] of policies.entries()) {
        const overrides =
          field === "fixDirection"
            ? { [field]: `Add a guard because ${policy.value}` }
            : { [field]: policy.value };
        const candidate = finding({
          issue: `The changed ${field} candidate ${policyIndex + 1} omits the active signal.`,
          ...overrides,
        });
        // This matrix keeps every model-controlled publication field under every global policy.
        // eslint-disable-next-line no-await-in-loop
        const result = await validateModelReviewOutput(output([finding(), candidate]), {
          checkout,
          diff: DIFF,
        });
        assert.equal(result.findings.length, 1);
        assert.match(result.diagnostics[0]?.message ?? "", policy.reason);
        assert.equal(result.diagnostics[0]?.message.includes(policy.value), false);
        assert.equal(
          JSON.stringify(createReviewPublication("1".repeat(40), result.findings)).includes(
            policy.value,
          ),
          false,
        );
      }
    }
  });

  it("rejects GFM nodes and placeholder action targets before publication", async () => {
    const prohibited = [
      { issue: "The `validation` accepts an unsupported state." },
      { impact: "The <strong>worker</strong> stalls after the invalid transition." },
      { evidence: "The https://example.test/private branch omits the required guard." },
      { fixDirection: "Add TBD." },
      { fixDirection: "Replace unknown." },
    ];
    const result = await validateModelReviewOutput(
      output([
        finding({
          title: "callback_queue stalls",
          issue: "callback_queue reenters.",
          impact: "Worker stalls.",
          evidence: "callback_queue reacquires lock.",
          fixDirection: "Defer callback_queue.",
        }),
        ...prohibited.map((overrides, index) =>
          finding({
            ...overrides,
            issue:
              "issue" in overrides
                ? overrides.issue
                : `The changed branch ${index + 1} omits the required review guard.`,
          }),
        ),
      ]),
      { checkout, diff: DIFF },
    );

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.title, "callback_queue stalls");
    assert.equal(result.diagnostics.length, prohibited.length);
    const publication = JSON.stringify(createReviewPublication("1".repeat(40), result.findings));
    for (const candidate of prohibited) {
      const modelText = Object.values(candidate)[0];
      assert.equal(typeof modelText === "string" && publication.includes(modelText), false);
    }
  });

  it("publishes valid candidates from mixed output and reports safe diagnostics", async () => {
    const secretSource = "PRIVATE_SOURCE_TOKEN";
    const result = await validateModelReviewOutput(
      output([
        finding(),
        finding({
          priority: "P9",
          evidence: secretSource,
          issue: "An invalid proposal must be discarded.",
        }),
      ]),
      { checkout, diff: DIFF },
    );
    assert.equal(result.findings.length, 1);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.code, "invalid");
    assert.doesNotMatch(result.diagnostics[0]?.message ?? "", new RegExp(secretSource, "u"));
  });

  it("collapses duplicate stable fingerprints with first-valid-wins ordering", async () => {
    const result = await validateModelReviewOutput(
      output([
        finding(),
        finding({
          priority: "P3",
          title: "Signal presentation differs",
          impact: "Different impact wording.",
          evidence: "Different cancellation signal evidence wording.",
          fixDirection: "Guard the call with the active signal.",
        }),
      ]),
      { checkout, diff: DIFF },
    );
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.priority, "P1");
    assert.equal(result.diagnostics[0]?.code, "duplicate");
  });

  it("keeps fingerprints stable across wording and changes them with identity", () => {
    const base = finding() as ModelFindingV1;
    const fingerprint = findingFingerprint(base);
    assert.equal(
      findingFingerprint({
        ...base,
        issue: "  THE added branch does not forward   the cancellation signal. ",
      }),
      fingerprint,
    );
    assert.notEqual(
      findingFingerprint({ ...base, issue: "A different issue is observed." }),
      fingerprint,
    );
    assert.notEqual(findingFingerprint({ ...base, path: "new-name.ts" }), fingerprint);
    assert.notEqual(
      findingFingerprint({
        ...base,
        range: { start: 2, end: 2, side: "RIGHT" },
      }),
      fingerprint,
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
