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
const liveProcessBirth = "current-process-birth";

type ProcessIdentity = { kind: "missing" } | { kind: "alive"; processBirth: string | undefined };

function inspectProcesses(
  identities: ReadonlyMap<number, ProcessIdentity>,
): (pid: number) => Promise<ProcessIdentity> {
  return async (pid) => identities.get(pid) ?? { kind: "missing" };
}

function deterministicLock(
  stateDirectory: string,
  identities: ReadonlyMap<number, ProcessIdentity>,
  hooks: { afterStaleClaim?(): Promise<void> } = {},
): FileReviewLock {
  return new FileReviewLock(stateDirectory, {
    ...hooks,
    inspectProcess: inspectProcesses(identities),
  });
}

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
    const stalePid = 41_001;
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(stateDirectory, "manual-review.lock"),
      `${JSON.stringify({ pid: stalePid, owner: "stale-owner" })}\n`,
      { mode: 0o600 },
    );

    const lease = await deterministicLock(
      stateDirectory,
      new Map([
        [stalePid, { kind: "missing" }],
        [process.pid, { kind: "alive", processBirth: liveProcessBirth }],
      ]),
    ).acquire();
    await lease.release();
  });

  it("keeps a lock when the PID and process birth still identify the owner process", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    const owner = {
      pid: process.pid,
      owner: "live-owner",
      processBirth: liveProcessBirth,
    };
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });

    await assert.rejects(
      () =>
        deterministicLock(
          stateDirectory,
          new Map([[process.pid, { kind: "alive", processBirth: liveProcessBirth }]]),
        ).acquire(),
      ReviewInProgressError,
    );
    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), owner);
  });

  it("reclaims a lock when its PID was reused by a process with a different birth", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        owner: "stale-owner",
        processBirth: "previous-process-birth",
      })}\n`,
      { mode: 0o600 },
    );

    const lease = await deterministicLock(
      stateDirectory,
      new Map([[process.pid, { kind: "alive", processBirth: liveProcessBirth }]]),
    ).acquire();
    await lease.release();
  });

  it("keeps legacy and unverified lock owners when their PID is still live", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    const legacyOwner = { pid: process.pid, owner: "legacy-live-owner" };
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify(legacyOwner)}\n`, { mode: 0o600 });

    const liveWithoutBirth = new Map<number, ProcessIdentity>([
      [process.pid, { kind: "alive", processBirth: undefined }],
    ]);
    await assert.rejects(
      () => deterministicLock(stateDirectory, liveWithoutBirth).acquire(),
      ReviewInProgressError,
    );
    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), legacyOwner);

    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        owner: "unverified-live-owner",
        processBirth: "recorded-birth",
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      () => deterministicLock(stateDirectory, liveWithoutBirth).acquire(),
      ReviewInProgressError,
    );
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
    const stalePid = 41_002;
    const claimantPid = 41_003;
    const staleOwner = { pid: stalePid, owner: "stale-owner" };
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });
    await writeFile(
      `${lockPath}.${staleOwnerKey(staleOwner)}.reclaim`,
      `${JSON.stringify({
        format: "revoir-stale-claim-v1",
        target: staleOwner,
        claimant: { pid: claimantPid, owner: "abandoned-claimant" },
      })}\n`,
      { mode: 0o600 },
    );

    const lease = await deterministicLock(
      stateDirectory,
      new Map([
        [stalePid, { kind: "missing" }],
        [claimantPid, { kind: "missing" }],
        [process.pid, { kind: "alive", processBirth: liveProcessBirth }],
      ]),
    ).acquire();
    await lease.release();
  });

  it("recovers an abandoned stale claim after its claimant PID is reused", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    const stalePid = 41_004;
    const staleOwner = { pid: stalePid, owner: "stale-owner" };
    const abandonedClaimant = {
      pid: process.pid,
      owner: "abandoned-claimant",
      processBirth: "previous-process-birth",
    };
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });
    await writeFile(
      `${lockPath}.${staleOwnerKey(staleOwner)}.reclaim`,
      `${JSON.stringify({
        format: "revoir-stale-claim-v1",
        target: staleOwner,
        claimant: abandonedClaimant,
      })}\n`,
      { mode: 0o600 },
    );

    const lease = await deterministicLock(
      stateDirectory,
      new Map([
        [stalePid, { kind: "missing" }],
        [process.pid, { kind: "alive", processBirth: liveProcessBirth }],
      ]),
    ).acquire();
    await lease.release();
  });

  it("allows only one concurrent reclaimer to acquire a stale lock", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    const stalePid = 41_005;
    const identities = new Map<number, ProcessIdentity>([
      [stalePid, { kind: "missing" }],
      [process.pid, { kind: "alive", processBirth: liveProcessBirth }],
    ]);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify({ pid: stalePid, owner: "stale-owner" })}\n`, {
      mode: 0o600,
    });

    const results = await Promise.allSettled([
      deterministicLock(stateDirectory, identities).acquire(),
      deterministicLock(stateDirectory, identities).acquire(),
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
    await assert.rejects(
      () => deterministicLock(stateDirectory, identities).acquire(),
      ReviewInProgressError,
    );
    assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
    await acquired[0]?.value.release();
  });

  it("does not remove a replacement lock while a stale claimant is delayed", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    const stalePid = 41_006;
    const identities = new Map<number, ProcessIdentity>([
      [stalePid, { kind: "missing" }],
      [process.pid, { kind: "alive", processBirth: liveProcessBirth }],
    ]);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify({ pid: stalePid, owner: "stale-owner" })}\n`, {
      mode: 0o600,
    });

    const claimed = deferred();
    const resume = deferred();
    const delayedAcquisition = deterministicLock(stateDirectory, identities, {
      async afterStaleClaim() {
        claimed.resolve();
        await resume.promise;
      },
    }).acquire();

    await claimed.promise;
    const claimFile = (await readdir(stateDirectory)).find((name) => name.includes(".reclaim"));
    assert.ok(claimFile);
    assert.equal((await stat(join(stateDirectory, claimFile))).mode & 0o777, 0o600);
    await unlink(lockPath);
    const replacementLease = await deterministicLock(stateDirectory, identities).acquire();
    const replacementContents = await readFile(lockPath, "utf8");
    resume.resolve();

    await assert.rejects(delayedAcquisition, ReviewInProgressError);
    assert.equal(await readFile(lockPath, "utf8"), replacementContents);
    await assert.rejects(
      () => deterministicLock(stateDirectory, identities).acquire(),
      ReviewInProgressError,
    );
    await replacementLease.release();
  });

  it("does not remove an invalid lock that cannot be proven stale", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, "not a lock owner\n", { mode: 0o600 });

    await assert.rejects(() => new FileReviewLock(stateDirectory).acquire(), ReviewInProgressError);
    assert.equal(await readFile(lockPath, "utf8"), "not a lock owner\n");

    const invalidOwner = {
      pid: process.pid,
      owner: "invalid-owner",
      processBirth: 123,
    };
    await writeFile(lockPath, `${JSON.stringify(invalidOwner)}\n`, { mode: 0o600 });
    await assert.rejects(() => new FileReviewLock(stateDirectory).acquire(), ReviewInProgressError);
    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), invalidOwner);
  });

  it("creates private lock files and releases a lease idempotently", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    const identities = new Map<number, ProcessIdentity>([
      [process.pid, { kind: "alive", processBirth: liveProcessBirth }],
    ]);
    const lease = await deterministicLock(stateDirectory, identities).acquire();

    assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
    await Promise.all([lease.release(), lease.release()]);

    const nextLease = await deterministicLock(stateDirectory, identities).acquire();
    await nextLease.release();
  });

  it("shares concurrent release work and retries failed release I/O", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    let releasePhase = false;
    let readFailures = 1;
    let unlinkFailures = 1;
    let releaseReads = 0;
    let releaseUnlinks = 0;
    const lock = new FileReviewLock(stateDirectory, {
      inspectProcess: inspectProcesses(
        new Map([[process.pid, { kind: "alive", processBirth: liveProcessBirth }]]),
      ),
      async readFile(path, encoding) {
        if (releasePhase && path === lockPath) {
          releaseReads += 1;
          if (readFailures > 0) {
            readFailures -= 1;
            throw new Error("injected release read failure");
          }
        }
        return readFile(path, encoding);
      },
      async unlink(path) {
        if (releasePhase && path === lockPath) {
          releaseUnlinks += 1;
          if (unlinkFailures > 0) {
            unlinkFailures -= 1;
            throw new Error("injected release unlink failure");
          }
        }
        await unlink(path);
      },
    });
    const lease = await lock.acquire();
    releasePhase = true;

    const failedReads = await Promise.allSettled([lease.release(), lease.release()]);
    assert.ok(failedReads.every((result) => result.status === "rejected"));
    assert.equal(releaseReads, 1);
    assert.equal(releaseUnlinks, 0);

    const failedUnlinks = await Promise.allSettled([lease.release(), lease.release()]);
    assert.ok(failedUnlinks.every((result) => result.status === "rejected"));
    assert.equal(releaseReads, 2);
    assert.equal(releaseUnlinks, 1);

    await Promise.all([lease.release(), lease.release()]);
    assert.equal(releaseReads, 3);
    assert.equal(releaseUnlinks, 2);
    await lease.release();
    assert.equal(releaseReads, 3);
    assert.equal(releaseUnlinks, 2);
    await assert.rejects(() => readFile(lockPath, "utf8"), { code: "ENOENT" });
  });

  it("does not remove a replacement owner while releasing a lease", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = join(stateDirectory, "manual-review.lock");
    const lease = await deterministicLock(
      stateDirectory,
      new Map([[process.pid, { kind: "alive", processBirth: liveProcessBirth }]]),
    ).acquire();
    const replacement = {
      pid: process.pid,
      owner: "replacement-owner",
      processBirth: liveProcessBirth,
    };
    await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

    await lease.release();

    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), replacement);
  });

  it("aborts a non-settling process probe without leaving a lock behind", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const cancellation = new Error("cancel lock acquisition");
    const abortController = new AbortController();
    const lock = new FileReviewLock(stateDirectory, {
      async inspectProcess() {
        return new Promise(() => {});
      },
    });

    const acquisition = lock.acquire(abortController.signal);
    abortController.abort(cancellation);

    await assert.rejects(
      Promise.race([
        acquisition,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("process probe did not cancel")), 100);
        }),
      ]),
      cancellation,
    );
    assert.deepEqual(await readdir(stateDirectory), []);
  });
});
