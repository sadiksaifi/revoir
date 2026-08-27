import assert from "node:assert/strict";
import { chmod, lstat, mkdir, rm, symlink, unlink } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createEmptyPolicy,
  intersectPolicies,
  loadPolicy,
  PolicyMutationError,
  repositoryInPolicy,
  withRepository,
  withoutRepository,
  writePolicy,
  type RevoirPolicy,
} from "../src/config/policy.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "revoir-policy-test-"));
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

function policy(
  userId: number,
  installations: RevoirPolicy["installations"],
  revision = 1,
): RevoirPolicy {
  return { version: 1, revision, userId, installations };
}

describe("repository policy", () => {
  it("accepts an empty policy and adds/removes repositories immutably", () => {
    const empty = createEmptyPolicy(42);
    assert.deepEqual(empty, { version: 1, revision: 0, userId: 42, installations: [] });

    const repository = { id: 99, owner: "Owner", name: "Repository" };
    const added = withRepository(empty, 8, repository);
    assert.equal(added.revision, 1);
    assert.ok(repositoryInPolicy(added, 8, { id: 99, owner: "owner", name: "repository" }));
    assert.equal(withRepository(added, 8, repository), added);

    const removed = withoutRepository(added, 99);
    assert.equal(removed.revision, 2);
    assert.deepEqual(removed.installations, [{ id: 8, repositories: [] }]);
    assert.equal(withoutRepository(removed, 99), removed);
  });

  it("rejects conflicting immutable identities", () => {
    const existing = withRepository(createEmptyPolicy(42), 8, {
      id: 99,
      owner: "owner",
      name: "repository",
    });
    assert.throws(
      () => withRepository(existing, 8, { id: 99, owner: "owner", name: "renamed" }),
      PolicyMutationError,
    );
    assert.throws(
      () => withRepository(existing, 8, { id: 100, owner: "OWNER", name: "REPOSITORY" }),
      PolicyMutationError,
    );
    assert.throws(
      () => withRepository(existing, 9, { id: 99, owner: "owner", name: "repository" }),
      PolicyMutationError,
    );
  });

  it("uses the exact local/cloud intersection and fails closed on user mismatch", () => {
    const local = policy(
      42,
      [
        {
          id: 8,
          repositories: [
            { id: 99, owner: "owner", name: "shared" },
            { id: 100, owner: "owner", name: "local-only" },
          ],
        },
        { id: 9, repositories: [{ id: 101, owner: "other", name: "local" }] },
      ],
      4,
    );
    const cloud = policy(
      42,
      [
        {
          id: 8,
          repositories: [
            { id: 99, owner: "OWNER", name: "SHARED" },
            { id: 102, owner: "owner", name: "cloud-only" },
          ],
        },
      ],
      6,
    );

    assert.deepEqual(intersectPolicies(local, cloud), {
      version: 1,
      revision: 4,
      userId: 42,
      installations: [{ id: 8, repositories: [{ id: 99, owner: "owner", name: "shared" }] }],
    });
    assert.deepEqual(intersectPolicies(local, policy(43, [], 6)).installations, []);
  });

  it("stores policy separately with protected modes and rejects symlinks", async () => {
    const root = await temporaryDirectory();
    const policyFile = join(root, "config", "revoir", "policy.json");
    const value = createEmptyPolicy(42);

    await writePolicy(policyFile, value);
    assert.equal((await lstat(join(root, "config", "revoir"))).mode & 0o777, 0o700);
    assert.equal((await lstat(policyFile)).mode & 0o777, 0o600);
    assert.deepEqual(await loadPolicy(policyFile), value);

    await chmod(policyFile, 0o644);
    await assert.rejects(loadPolicy(policyFile), /chmod 600/u);
    await chmod(policyFile, 0o600);
    await unlink(policyFile);
    const target = join(root, "target.json");
    await mkdir(join(root, "other"), { mode: 0o700 });
    await writePolicy(target, value);
    await symlink(target, policyFile);
    await assert.rejects(writePolicy(policyFile, value), /not a regular file/u);
  });
});
