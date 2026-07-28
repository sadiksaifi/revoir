import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffPosition, isAttachableRange, parseGitDiff } from "../src/review/diff.js";

const DIFF = `diff --git a/source.ts b/source.ts
index 1111111..2222222 100644
--- a/source.ts
+++ b/source.ts
@@ -1,4 +1,5 @@
 const retained = true;
-const removed = true;
+const added = true;
+const second = true;
 const middle = true;
@@ -10,2 +11,2 @@ export const tail = true;
-const oldTail = true;
+const newTail = true;
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
-old name
+new name
diff --git a/logo.png b/logo.png
index 4444444..5555555 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/path with space.sh b/path with space.sh
old mode 100644
new mode 100755
`;

describe("Git diff positions", () => {
  it("maps exact additions, deletions, later hunks, and multiline ranges", () => {
    const index = parseGitDiff(DIFF);
    const source = index.files.get("source.ts");
    assert.ok(source);
    assert.equal(diffPosition(source, "LEFT", 2), 2);
    assert.equal(diffPosition(source, "RIGHT", 2), 3);
    assert.equal(diffPosition(source, "RIGHT", 3), 4);
    assert.equal(diffPosition(source, "LEFT", 10), 7);
    assert.equal(diffPosition(source, "RIGHT", 11), 8);
    assert.equal(diffPosition(source, "RIGHT", 1), undefined);
    assert.equal(isAttachableRange(source, { start: 2, end: 3, side: "RIGHT" }), true);
    assert.equal(isAttachableRange(source, { start: 1, end: 3, side: "RIGHT" }), false);
  });

  it("represents deleted, renamed, binary, and file-only changes", () => {
    const index = parseGitDiff(DIFF);
    const deleted = index.files.get("deleted.ts");
    assert.ok(deleted);
    assert.equal(deleted.newPath, undefined);
    assert.equal(diffPosition(deleted, "LEFT", 1), 1);
    assert.equal(diffPosition(deleted, "LEFT", 2), 2);

    const renamed = index.files.get("new-name.ts");
    assert.ok(renamed);
    assert.equal(renamed.oldPath, "old-name.ts");
    assert.equal(renamed.newPath, "new-name.ts");
    assert.equal(diffPosition(renamed, "LEFT", 1), 1);
    assert.equal(diffPosition(renamed, "RIGHT", 1), 2);

    const binary = index.files.get("logo.png");
    assert.ok(binary);
    assert.equal(binary.binary, true);
    assert.equal(isAttachableRange(binary, { start: 1, end: 1, side: "RIGHT" }), false);

    const modeOnly = index.files.get("path with space.sh");
    assert.ok(modeOnly);
    assert.equal(modeOnly.oldPath, "path with space.sh");
    assert.equal(modeOnly.newPath, "path with space.sh");
    assert.equal(modeOnly.changedLines.size, 0);
  });

  it("decodes quoted Git paths", () => {
    const index = parseGitDiff(`diff --git "a/src/na\\303\\257ve.ts" "b/src/na\\303\\257ve.ts"
index 1111111..2222222 100644
--- "a/src/na\\303\\257ve.ts"
+++ "b/src/na\\303\\257ve.ts"
@@ -1 +1 @@
-old
+new
`);
    const file = index.files.get("src/naïve.ts");
    assert.ok(file);
    assert.equal(diffPosition(file, "RIGHT", 1), 2);
  });

  it("does not confuse changed content with patch path headers", () => {
    const index = parseGitDiff(`diff --git a/operators.txt b/operators.txt
index 1111111..2222222 100644
--- a/operators.txt
+++ b/operators.txt
@@ -1 +1 @@
--- removed operator
+++ added operator
`);
    const file = index.files.get("operators.txt");
    assert.ok(file);
    assert.equal(diffPosition(file, "LEFT", 1), 1);
    assert.equal(diffPosition(file, "RIGHT", 1), 2);
  });
});
