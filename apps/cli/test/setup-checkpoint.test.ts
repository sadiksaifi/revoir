import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function spawnPendingCommandLock(lockFile: string): Promise<ChildProcess> {
  const moduleUrl = new URL("../src/config/command-lock.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { acquireCommandLock } from ${JSON.stringify(moduleUrl)};
await acquireCommandLock(${JSON.stringify(lockFile)}, {
  async beforePublish() {
    process.stdout.write("READY\\n");
    await new Promise(() => setInterval(() => {}, 1_000));
  },
});`,
    ],
    { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("READY\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`candidate child exited before ready (${String(code ?? signal)})`));
    });
  });
  return child;
}

async function seedStaleCommandLock(lockFile: string): Promise<void> {
  await mkdir(join(lockFile, ".."), { recursive: true, mode: 0o700 });
  await writeFile(
    lockFile,
    `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      token: "stale-owner",
      acquiredAt: "2026-08-27T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
}

async function spawnReclaimingCommandLock(
  lockFile: string,
  stage: "candidate" | "published",
): Promise<ChildProcess> {
  const moduleUrl = new URL("../src/config/command-lock.ts", import.meta.url).href;
  const callback = stage === "candidate" ? "afterReclaimCandidate" : "afterReclaimPublication";
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { acquireCommandLock } from ${JSON.stringify(moduleUrl)};
await acquireCommandLock(${JSON.stringify(lockFile)}, {
  async ${callback}() {
    process.stdout.write("READY\\n");
    await new Promise(() => setInterval(() => {}, 1_000));
  },
});`,
    ],
    { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("READY\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`reclaim child exited before ready (${String(code ?? signal)})`));
    });
  });
  return child;
}

async function killChild(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
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

  it("rejects an unsafe path even when no checkpoint exists", async () => {
    await assert.rejects(
      loadSetupCheckpoint("relative/setup-checkpoint.json"),
      /absolute normalized path/u,
    );
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

  it("recovers when acquisition is interrupted before its durable record is published", async () => {
    const root = await temporaryDirectory();
    const lockFile = join(root, "config", "command.lock");
    const interruption = new Error("process stopped before publication");

    await assert.rejects(
      acquireCommandLock(lockFile, {
        beforePublish() {
          throw interruption;
        },
      }),
      interruption,
    );

    const recovered = await acquireCommandLock(lockFile);
    await recovered.release();
  });

  it("does not remove a concurrent writer while another durable record awaits publication", async () => {
    const root = await temporaryDirectory();
    const lockFile = join(root, "config", "command.lock");
    let resumePublication!: () => void;
    const publicationPaused = new Promise<void>((resolve) => {
      resumePublication = resolve;
    });
    let candidateReady!: () => void;
    const candidatePrepared = new Promise<void>((resolve) => {
      candidateReady = resolve;
    });
    const firstAttempt = acquireCommandLock(lockFile, {
      async beforePublish() {
        candidateReady();
        await publicationPaused;
      },
    });

    await candidatePrepared;
    const concurrent = await acquireCommandLock(lockFile);
    resumePublication();
    await assert.rejects(firstAttempt, ConcurrentCommandError);
    await assert.rejects(acquireCommandLock(lockFile), ConcurrentCommandError);
    await concurrent.release();
  });

  it("allows only one reclaimer to replace the exact stale lock both contenders observed", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "config");
    const lockFile = join(directory, "command.lock");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      lockFile,
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "stale-owner",
        acquiredAt: "2026-08-27T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    let observed = 0;
    let releaseObservers!: () => void;
    const observersReleased = new Promise<void>((resolve) => {
      releaseObservers = resolve;
    });
    let bothObserved!: () => void;
    const bothObservedStale = new Promise<void>((resolve) => {
      bothObserved = resolve;
    });
    const contender = () =>
      acquireCommandLock(lockFile, {
        async afterStaleSnapshot() {
          observed += 1;
          if (observed === 2) bothObserved();
          await observersReleased;
        },
      });
    const attempts = [contender(), contender()];

    await Promise.race([
      bothObservedStale,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("reclaimers did not both pause on the stale inode")),
          100,
        );
      }),
    ]);
    releaseObservers();
    const results = await Promise.allSettled(attempts);
    const leases = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireCommandLock>>> =>
        result.status === "fulfilled",
    );
    const outcomes = results.map((result) =>
      result.status === "fulfilled"
        ? "fulfilled"
        : `${result.reason instanceof Error ? result.reason.name : typeof result.reason}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
    );
    assert.equal(leases.length, 1, outcomes.join("\n"));
    assert.equal(
      results.filter(
        (result) => result.status === "rejected" && result.reason instanceof ConcurrentCommandError,
      ).length,
      1,
      outcomes.join("\n"),
    );
    await assert.rejects(acquireCommandLock(lockFile), ConcurrentCommandError);
    await leases[0]!.value.release();
  });

  it("reclaims a durable pending candidate whose owner was killed before publication", async () => {
    const root = await temporaryDirectory();
    const lockFile = join(root, "config", "command.lock");
    const child = await spawnPendingCommandLock(lockFile);
    await killChild(child);
    assert.equal(
      (await readdir(join(root, "config"))).some((name) => name.endsWith(".pending")),
      true,
    );

    const recovered = await acquireCommandLock(lockFile);
    await recovered.release();
    assert.equal(
      (await readdir(join(root, "config"))).some((name) => name.endsWith(".pending")),
      false,
    );
  });

  it("preserves a live writer's pending candidate while another command acquires", async () => {
    const root = await temporaryDirectory();
    const lockFile = join(root, "config", "command.lock");
    const child = await spawnPendingCommandLock(lockFile);
    try {
      const concurrent = await acquireCommandLock(lockFile);
      await concurrent.release();
      assert.equal(
        (await readdir(join(root, "config"))).some((name) => name.endsWith(".pending")),
        true,
      );
    } finally {
      await killChild(child);
    }
  });

  it("reclaims a dead durable reclaim candidate created before claim publication", async () => {
    const root = await temporaryDirectory();
    const lockFile = join(root, "config", "command.lock");
    await seedStaleCommandLock(lockFile);
    const child = await spawnReclaimingCommandLock(lockFile, "candidate");
    await killChild(child);
    assert.equal(
      (await readdir(join(root, "config"))).some((name) => name.endsWith(".tmp")),
      true,
    );

    const recovered = await acquireCommandLock(lockFile);
    await recovered.release();
    assert.equal(
      (await readdir(join(root, "config"))).some((name) => name.includes(".reclaim")),
      false,
    );
  });

  it("reclaims a dead published reclaim claim after its owner is killed", async () => {
    const root = await temporaryDirectory();
    const lockFile = join(root, "config", "command.lock");
    await seedStaleCommandLock(lockFile);
    const child = await spawnReclaimingCommandLock(lockFile, "published");
    await killChild(child);
    assert.equal(
      (await readdir(join(root, "config"))).some((name) => name.includes(".reclaim")),
      true,
    );

    const recovered = await acquireCommandLock(lockFile);
    await recovered.release();
    assert.equal(
      (await readdir(join(root, "config"))).some((name) => name.includes(".reclaim")),
      false,
    );
  });

  it("preserves a live published reclaim claimant and the canonical stale lock", async () => {
    const root = await temporaryDirectory();
    const lockFile = join(root, "config", "command.lock");
    await seedStaleCommandLock(lockFile);
    const child = await spawnReclaimingCommandLock(lockFile, "published");
    try {
      const before = await readdir(join(root, "config"));
      await assert.rejects(acquireCommandLock(lockFile), ConcurrentCommandError);
      assert.deepEqual(await readdir(join(root, "config")), before);
      assert.equal(JSON.parse(await readFile(lockFile, "utf8")).token, "stale-owner");
    } finally {
      await killChild(child);
    }
  });

  it("recovers a reclaim chain abandoned by repeated claimant process deaths", async () => {
    const root = await temporaryDirectory();
    const lockFile = join(root, "config", "command.lock");
    await seedStaleCommandLock(lockFile);
    for (let generation = 0; generation < 3; generation += 1) {
      // Each next process must observe the artifact left by the prior killed process.
      // eslint-disable-next-line no-await-in-loop
      const child = await spawnReclaimingCommandLock(lockFile, "published");
      // eslint-disable-next-line no-await-in-loop
      await killChild(child);
      assert.equal(
        // eslint-disable-next-line no-await-in-loop
        (await readdir(join(root, "config"))).filter(
          (name) => name.includes(".reclaim") && !name.endsWith(".tmp"),
        ).length,
        generation + 1,
      );
    }

    const recovered = await acquireCommandLock(lockFile);
    await recovered.release();
    assert.equal(
      (await readdir(join(root, "config"))).some((name) => name.includes(".reclaim")),
      false,
    );
  });

  it("recovers more abandoned reclaim generations than the former fixed limit", async () => {
    const root = await temporaryDirectory();
    const lockFile = join(root, "config", "command.lock");
    await seedStaleCommandLock(lockFile);
    const staleStats = await lstat(lockFile);
    await Promise.all(
      Array.from({ length: 105 }, async (_value, generation) => {
        const suffix = generation === 0 ? "" : `.${generation}`;
        await writeFile(
          join(root, "config", `.command-lock.stale-owner.reclaim${suffix}`),
          `${JSON.stringify({
            version: 1,
            target: { token: "stale-owner", device: staleStats.dev, inode: staleStats.ino },
            claimant: {
              version: 1,
              pid: 2_147_483_647,
              token: `dead-claim-${generation}`,
              acquiredAt: "2026-08-27T00:00:00.000Z",
            },
          })}\n`,
          { mode: 0o600 },
        );
      }),
    );

    const recovered = await acquireCommandLock(lockFile);
    await recovered.release();
    assert.equal(
      (await readdir(join(root, "config"))).some((name) => name.includes(".reclaim")),
      false,
    );
  });
});
