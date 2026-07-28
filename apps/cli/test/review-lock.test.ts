import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
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

function staleOwnerKey(owner: { pid: number; owner: string }): string {
  return createHash("sha256").update(`${owner.pid}\0${owner.owner}`).digest("hex");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
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
    const firstOwner = await readFile(join(stateDirectory, "manual-review.lock"), "utf8");
    await assert.rejects(() => second.acquire(), ReviewInProgressError);
    assert.equal(await readFile(join(stateDirectory, "manual-review.lock"), "utf8"), firstOwner);

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

  it("recovers an abandoned stale-lock claim", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    const staleOwner = { pid: 2_147_483_647, owner: "stale-owner" };
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });
    await link(lockPath, `${lockPath}.${staleOwnerKey(staleOwner)}.stale`);

    const lease = await new FileReviewLock(stateDirectory).acquire();
    await lease.release();
  });

  it("recovers a stale-lock claim whose claimant exited", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    const staleOwner = { pid: 2_147_483_647, owner: "stale-owner" };
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });
    await writeFile(
      `${lockPath}.${staleOwnerKey(staleOwner)}.reclaim`,
      `${JSON.stringify({
        format: "revoir-stale-claim-v1",
        target: staleOwner,
        claimant: { pid: 2_147_483_646, owner: "abandoned-claimant" },
      })}\n`,
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

  it("does not remove a replacement lock while a stale claimant is delayed", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify({ pid: 2_147_483_647, owner: "stale-owner" })}\n`, {
      mode: 0o600,
    });

    const claimed = deferred();
    const resume = deferred();
    const delayedAcquisition = new FileReviewLock(stateDirectory, {
      afterStaleClaim: async () => {
        claimed.resolve();
        await resume.promise;
      },
    }).acquire();

    await claimed.promise;
    const claimFile = (await readdir(stateDirectory)).find((name) => name.includes(".reclaim"));
    assert.ok(claimFile);
    assert.equal((await stat(join(stateDirectory, claimFile))).mode & 0o777, 0o600);
    await unlink(lockPath);
    const replacementLease = await new FileReviewLock(stateDirectory).acquire();
    const replacementContents = await readFile(lockPath, "utf8");
    resume.resolve();

    await assert.rejects(delayedAcquisition, ReviewInProgressError);
    assert.equal(await readFile(lockPath, "utf8"), replacementContents);
    await assert.rejects(() => new FileReviewLock(stateDirectory).acquire(), ReviewInProgressError);
    await replacementLease.release();
  });

  it("does not remove an invalid lock that cannot be proven stale", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, "not a lock owner\n", { mode: 0o600 });

    await assert.rejects(() => new FileReviewLock(stateDirectory).acquire(), ReviewInProgressError);
    assert.equal(await readFile(lockPath, "utf8"), "not a lock owner\n");
  });

  it("creates private lock files and releases a lease idempotently", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    const lease = await new FileReviewLock(stateDirectory).acquire();

    assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
    await Promise.all([lease.release(), lease.release()]);

    const nextLease = await new FileReviewLock(stateDirectory).acquire();
    await nextLease.release();
  });
});
