import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { FileReviewCancellationStore } from "../src/review/cancellation-store.js";

const temporaryDirectories: string[] = [];
const reference = {
  owner: "owner",
  repository: "repository",
  number: 17,
  url: "https://github.com/owner/repository/pull/17",
};

async function temporaryStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "revoir-cancellation-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("review cancellation state", () => {
  it("writes and atomically replaces a private per-PR marker", async () => {
    const state = await temporaryStateDirectory();
    let now = new Date("2026-09-04T10:00:00.000Z");
    const store = new FileReviewCancellationStore(state, () => now);

    assert.equal(await store.read(reference), undefined);
    assert.deepEqual(await store.record(reference), { cancelledAt: now.toISOString() });
    now = new Date("2026-09-04T10:01:00.000Z");
    await store.record(reference);

    const directory = join(state, "review-cancellations");
    const [file] = await readdir(directory);
    assert.ok(file);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(directory, file))).mode & 0o777, 0o600);
    assert.deepEqual(await store.read(reference), { cancelledAt: now.toISOString() });
  });

  it("never exposes a partial marker to concurrent readers", async () => {
    const state = await temporaryStateDirectory();
    let tick = 0;
    const store = new FileReviewCancellationStore(
      state,
      () => new Date(1_780_000_000_000 + tick++),
    );
    await store.record(reference);

    const reads = Array.from({ length: 50 }, async () => store.read(reference));
    const writes = Array.from({ length: 10 }, async () => store.record(reference));
    const results = await Promise.all([...reads, ...writes]);
    assert.ok(results.every((result) => result?.cancelledAt !== undefined));
  });

  it("rejects malformed, unsafe, and symbolic-link marker files", async () => {
    const state = await temporaryStateDirectory();
    const store = new FileReviewCancellationStore(state);
    await store.record(reference);
    const directory = join(state, "review-cancellations");
    const [file] = await readdir(directory);
    assert.ok(file);
    const marker = join(directory, file);

    await writeFile(marker, "not json\n");
    await assert.rejects(store.read(reference), /not valid JSON/u);
    await writeFile(
      marker,
      JSON.stringify({ version: 1, pullRequest: "wrong", cancelledAt: new Date().toISOString() }),
    );
    await assert.rejects(store.read(reference), /marker is invalid/u);
    await chmod(marker, 0o644);
    await assert.rejects(store.read(reference), /unsafe mode/u);
    await rm(marker);
    const target = join(state, "target");
    await writeFile(target, "{}\n");
    await symlink(target, marker);
    await assert.rejects(store.read(reference), /regular file/u);
  });
});
