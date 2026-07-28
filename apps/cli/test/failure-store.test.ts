import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FileOperationalFailureStore } from "../src/queue/failure-store.js";

describe("operational failure state", () => {
  it("persists delivery failure counts privately across runner restarts and clears them", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-queue-failures-"));
    const deliveryId = "2f5f7475-33ee-4f91-9b68-0f8af72f6640";
    try {
      await new FileOperationalFailureStore(stateDirectory).save(deliveryId, 2);

      const restartedStore = new FileOperationalFailureStore(stateDirectory);
      assert.equal(await restartedStore.load(deliveryId), 2);
      assert.equal(await restartedStore.load("beec43a9-0a21-4ab8-91e8-22498fa00be9"), 0);

      const failureDirectory = join(stateDirectory, "queue-review-failures");
      const files = await readdir(failureDirectory);
      assert.equal(files.length, 1);
      assert.equal((await stat(failureDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(failureDirectory, files[0]!))).mode & 0o777, 0o600);
      assert.match(await readFile(join(failureDirectory, files[0]!), "utf8"), /"failures":2/u);

      await restartedStore.clear(deliveryId);
      assert.equal(await restartedStore.load(deliveryId), 0);
      assert.deepEqual(await readdir(failureDirectory), []);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
