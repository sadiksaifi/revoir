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
      await new FileOperationalFailureStore(stateDirectory).save(deliveryId, {
        failures: 2,
        terminalReport: { status: "not-required" },
      });

      const restartedStore = new FileOperationalFailureStore(stateDirectory);
      assert.deepEqual(await restartedStore.load(deliveryId), {
        failures: 2,
        terminalReport: { status: "not-required" },
      });
      assert.deepEqual(await restartedStore.load("beec43a9-0a21-4ab8-91e8-22498fa00be9"), {
        failures: 0,
        terminalReport: { status: "not-required" },
      });

      const failureDirectory = join(stateDirectory, "queue-review-failures");
      const files = await readdir(failureDirectory);
      assert.equal(files.length, 1);
      assert.equal((await stat(failureDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(failureDirectory, files[0]!))).mode & 0o777, 0o600);
      assert.match(await readFile(join(failureDirectory, files[0]!), "utf8"), /"failures":2/u);

      await restartedStore.clear(deliveryId);
      assert.deepEqual(await restartedStore.load(deliveryId), {
        failures: 0,
        terminalReport: { status: "not-required" },
      });
      assert.deepEqual(await readdir(failureDirectory), []);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("persists terminal publication progress and confirmation across restarts", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-terminal-report-"));
    const deliveryId = "2f5f7475-33ee-4f91-9b68-0f8af72f6640";
    try {
      const store = new FileOperationalFailureStore(stateDirectory);
      await store.save(deliveryId, {
        failures: 3,
        terminalReport: {
          status: "publishing",
          attempts: 1,
          category: "github",
        },
      });
      assert.deepEqual(await new FileOperationalFailureStore(stateDirectory).load(deliveryId), {
        failures: 3,
        terminalReport: {
          status: "publishing",
          attempts: 1,
          category: "github",
        },
      });

      await store.save(deliveryId, {
        failures: 3,
        terminalReport: {
          status: "confirmed",
          attempts: 1,
          category: "github",
        },
      });
      assert.deepEqual(await new FileOperationalFailureStore(stateDirectory).load(deliveryId), {
        failures: 3,
        terminalReport: {
          status: "confirmed",
          attempts: 1,
          category: "github",
        },
      });
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
