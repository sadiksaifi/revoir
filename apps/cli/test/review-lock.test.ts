import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { FileReviewLock, ReviewInProgressError } from "../src/review/lock.js";

const temporaryDirectories: string[] = [];

async function temporaryStateDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "revoir-lock-test-"));
  temporaryDirectories.push(root);
  return join(root, "state", "revoir");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("manual review process lock", () => {
  it("serializes independent review services through the XDG state directory", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const first = new FileReviewLock(stateDirectory);
    const second = new FileReviewLock(stateDirectory);

    const firstLease = await first.acquire();
    await assert.rejects(() => second.acquire(), ReviewInProgressError);

    await firstLease.release();
    const secondLease = await second.acquire();
    await secondLease.release();
  });

  it("reclaims a lock owned by a process that no longer exists", async () => {
    const stateDirectory = await temporaryStateDirectory();
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(stateDirectory, "manual-review.lock"),
      `${JSON.stringify({ pid: 2_147_483_647, owner: "stale-owner" })}\n`,
      { mode: 0o600 },
    );

    const lease = await new FileReviewLock(stateDirectory).acquire();
    await lease.release();
  });

  it("allows only one concurrent reclaimer to acquire a stale lock", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify({ pid: 2_147_483_647, owner: "stale-owner" })}\n`, {
      mode: 0o600,
    });

    const results = await Promise.allSettled([
      new FileReviewLock(stateDirectory).acquire(),
      new FileReviewLock(stateDirectory).acquire(),
    ]);
    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<FileReviewLock["acquire"]>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    assert.equal(acquired.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof ReviewInProgressError);
    await assert.rejects(() => new FileReviewLock(stateDirectory).acquire(), ReviewInProgressError);
    assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
    await acquired[0]?.value.release();
  });

  it("does not remove an invalid lock that cannot be proven stale", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, "not a lock owner\n", { mode: 0o600 });

    await assert.rejects(() => new FileReviewLock(stateDirectory).acquire(), ReviewInProgressError);
    assert.equal(await readFile(lockPath, "utf8"), "not a lock owner\n");
  });
});
