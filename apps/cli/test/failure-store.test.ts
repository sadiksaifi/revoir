import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FileOperationalFailureStore } from "../src/queue/failure-store.js";

describe("operational failure state", () => {
  it("persists committed failures privately across runner restarts and clears them", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-queue-failures-"));
    const deliveryId = "2f5f7475-33ee-4f91-9b68-0f8af72f6640";
    try {
      await new FileOperationalFailureStore(stateDirectory).save(deliveryId, {
        committedFailures: 2,
      });

      const restartedStore = new FileOperationalFailureStore(stateDirectory);
      assert.deepEqual(await restartedStore.load(deliveryId), {
        committedFailures: 2,
      });
      assert.deepEqual(await restartedStore.load("beec43a9-0a21-4ab8-91e8-22498fa00be9"), {
        committedFailures: 0,
      });

      const failureDirectory = join(stateDirectory, "queue-review-failures");
      const files = await readdir(failureDirectory);
      assert.equal(files.length, 1);
      assert.equal((await stat(failureDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(failureDirectory, files[0]!))).mode & 0o777, 0o600);
      assert.match(
        await readFile(join(failureDirectory, files[0]!), "utf8"),
        /"committedFailures":2/u,
      );

      await restartedStore.clear(deliveryId);
      assert.deepEqual(await restartedStore.load(deliveryId), {
        committedFailures: 0,
      });
      assert.deepEqual(await readdir(failureDirectory), []);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("persists the terminal category with the absorbing third failure", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-terminal-report-"));
    const deliveryId = "2f5f7475-33ee-4f91-9b68-0f8af72f6640";
    try {
      const store = new FileOperationalFailureStore(stateDirectory);
      await store.save(deliveryId, {
        committedFailures: 3,
        terminalCategory: "github",
      });
      assert.deepEqual(await new FileOperationalFailureStore(stateDirectory).load(deliveryId), {
        committedFailures: 3,
        terminalCategory: "github",
      });
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("persists an owned next-slot reservation with its transport attempt", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-reserved-attempt-"));
    const deliveryId = "2f5f7475-33ee-4f91-9b68-0f8af72f6640";
    const reserved = {
      committedFailures: 1 as const,
      reservation: {
        slot: 2 as const,
        ownerToken: "boot-id:reservation-id",
        transportAttempt: 17,
      },
    };
    try {
      await new FileOperationalFailureStore(stateDirectory).save(deliveryId, reserved);

      assert.deepEqual(
        await new FileOperationalFailureStore(stateDirectory).load(deliveryId),
        reserved,
      );
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("persists completed ad hoc review state separately from an attempt reservation", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-completed-request-"));
    const deliveryId = "2f5f7475-33ee-4f91-9b68-0f8af72f6640";
    const completed = {
      committedFailures: 1 as const,
      reviewCompleted: true as const,
    };
    try {
      await new FileOperationalFailureStore(stateDirectory).save(deliveryId, completed);

      assert.deepEqual(
        await new FileOperationalFailureStore(stateDirectory).load(deliveryId),
        completed,
      );
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("loads version 4 failure state written by an earlier daemon", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-legacy-failure-state-"));
    const deliveryId = "2f5f7475-33ee-4f91-9b68-0f8af72f6640";
    const legacyState = {
      version: 4,
      deliveryId,
      committedFailures: 1,
      reservation: {
        slot: 2,
        ownerToken: "earlier-daemon:reservation",
        transportAttempt: 7,
      },
    };
    try {
      const failureDirectory = join(stateDirectory, "queue-review-failures");
      const stateFile = `${createHash("sha256").update(deliveryId).digest("hex")}.json`;
      await mkdir(failureDirectory, { recursive: true });
      await writeFile(join(failureDirectory, stateFile), `${JSON.stringify(legacyState)}\n`);

      assert.deepEqual(await new FileOperationalFailureStore(stateDirectory).load(deliveryId), {
        committedFailures: 1,
        reservation: legacyState.reservation,
      });
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("validates reservation ownership, sequencing, and terminal state", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "revoir-invalid-failure-state-"));
    const deliveryId = "2f5f7475-33ee-4f91-9b68-0f8af72f6640";
    const store = new FileOperationalFailureStore(stateDirectory);
    try {
      await assert.rejects(
        store.save(deliveryId, {
          committedFailures: 0,
          reservation: { slot: 2, ownerToken: "owner", transportAttempt: 1 },
        } as never),
        /failure state is invalid/u,
      );
      await assert.rejects(
        store.save(deliveryId, {
          committedFailures: 1,
          reservation: { slot: 2, ownerToken: "", transportAttempt: 1 },
        } as never),
        /failure state is invalid/u,
      );
      await assert.rejects(
        store.save(deliveryId, { committedFailures: 3 } as never),
        /failure state is invalid/u,
      );
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
