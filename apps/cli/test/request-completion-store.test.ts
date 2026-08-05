import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FileReviewRequestCompletionStore } from "../src/queue/request-completion-store.js";

describe("review request completion store", () => {
  it("persists one completed comment identity with protected permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "revoir-request-completions-"));
    const identity = { repositoryId: 99, commentId: 123456789 };
    try {
      const store = new FileReviewRequestCompletionStore(directory);
      assert.equal(await store.has(identity), false);

      await store.mark(identity);

      assert.equal(await new FileReviewRequestCompletionStore(directory).has(identity), true);
      assert.equal(await store.has({ ...identity, commentId: identity.commentId + 1 }), false);
      const stateDirectory = join(directory, "completed-review-requests");
      const files = await readdir(stateDirectory);
      assert.equal(files.length, 1);
      assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(stateDirectory, files[0]!))).mode & 0o777, 0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed identities without creating completion state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "revoir-request-completions-"));
    try {
      const store = new FileReviewRequestCompletionStore(directory);
      await assert.rejects(store.mark({ repositoryId: 99, commentId: 0 }), /identity is invalid/u);
      await assert.rejects(store.has({ repositoryId: -1, commentId: 1 }), /identity is invalid/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
