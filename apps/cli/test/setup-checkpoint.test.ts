import assert from "node:assert/strict";
import { lstat, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { acquireCommandLock, ConcurrentCommandError } from "../src/config/command-lock.js";
import {
  createSetupCheckpoint,
  loadSetupCheckpoint,
  removeSetupCheckpoint,
  SetupCheckpointError,
  validateSetupCheckpoint,
  writeSetupCheckpoint,
} from "../src/config/setup-checkpoint.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "revoir-checkpoint-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("setup checkpoint", () => {
  it("persists one-time credentials before any stage completes", async () => {
    const root = await temporaryDirectory();
    const checkpointFile = join(root, "config", "setup-checkpoint.json");
    const checkpoint = createSetupCheckpoint();
    checkpoint.secrets.githubWebhookSecret = "generated-before-manifest";
    await writeSetupCheckpoint(checkpointFile, checkpoint);

    assert.equal((await lstat(join(root, "config"))).mode & 0o777, 0o700);
    assert.equal((await lstat(checkpointFile)).mode & 0o777, 0o600);
    assert.deepEqual(await loadSetupCheckpoint(checkpointFile), checkpoint);

    checkpoint.completedStages.push("prerequisites");
    checkpoint.resources.identity = { userId: 42, login: "owner" };
    checkpoint.secrets.githubPrivateKey = "one-time-private-key";
    await writeSetupCheckpoint(checkpointFile, checkpoint);
    assert.deepEqual(await loadSetupCheckpoint(checkpointFile), checkpoint);
  });

  it("rejects unknown, duplicate, and non-contiguous stages", () => {
    assert.throws(
      () =>
        validateSetupCheckpoint({ ...createSetupCheckpoint(), completedStages: ["github-app"] }),
      /contiguous ordered prefix/u,
    );
    assert.throws(
      () =>
        validateSetupCheckpoint({
          ...createSetupCheckpoint(),
          completedStages: ["prerequisites", "prerequisites"],
        }),
      SetupCheckpointError,
    );
    assert.throws(
      () => validateSetupCheckpoint({ ...createSetupCheckpoint(), legacy: true }),
      /invalid top-level shape/u,
    );
  });

  it("removes only a valid protected checkpoint and tolerates absence", async () => {
    const root = await temporaryDirectory();
    const checkpointFile = join(root, "config", "setup-checkpoint.json");
    await writeSetupCheckpoint(checkpointFile, createSetupCheckpoint());
    await removeSetupCheckpoint(checkpointFile);
    assert.equal(await loadSetupCheckpoint(checkpointFile), undefined);
    await removeSetupCheckpoint(checkpointFile);
  });
});

describe("command lock", () => {
  it("excludes concurrent mutating commands and releases cleanly", async () => {
    const root = await temporaryDirectory();
    const lockFile = join(root, "config", "command.lock");
    const first = await acquireCommandLock(lockFile);
    await assert.rejects(acquireCommandLock(lockFile), ConcurrentCommandError);
    await first.release();
    const second = await acquireCommandLock(lockFile);
    await second.release();
  });
});
