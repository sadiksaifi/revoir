import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEmptyPolicy, withRepository, type RevoirPolicy } from "../src/config/policy.js";
import {
  parseGitHubRemote,
  parseRepositoryReference,
  RepositoryManager,
  RepositoryPolicyUpdateError,
  type PendingRepositoryOperation,
  type RepositoryApproval,
  type RepositoryDiscovery,
  type RepositoryGitHubGateway,
  type RepositoryPolicyStore,
} from "../src/repository.js";

const REPOSITORY = { id: 99, owner: "Owner", name: "repository" } as const;

class MemoryPolicies implements RepositoryPolicyStore {
  local: RevoirPolicy = createEmptyPolicy(42);
  cloud: RevoirPolicy = createEmptyPolicy(42);
  events: string[] = [];
  failWrite = false;

  async loadLocal(): Promise<RevoirPolicy> {
    return this.local;
  }

  async writeLocal(policy: RevoirPolicy): Promise<void> {
    this.events.push(`local:${policy.installations.length}`);
    this.local = policy;
  }

  async loadCloud(): Promise<RevoirPolicy> {
    return this.cloud;
  }

  async writeCloud(policy: RevoirPolicy): Promise<void> {
    this.events.push(`cloud:${policy.installations.length}`);
    if (this.failWrite) throw new Error("KV unavailable");
    this.cloud = policy;
  }

  async verifyCloud(_policy: RevoirPolicy): Promise<void> {
    this.events.push("cloud:verified");
  }
}

function fakeGitHub(
  overrides: {
    access?: boolean;
    approval?: "confirmed" | "pending";
    installation?: boolean;
  } = {},
): RepositoryGitHubGateway & { events: string[] } {
  const events: string[] = [];
  const discovery: RepositoryDiscovery = {
    repository: REPOSITORY,
    ...(overrides.installation === false
      ? {}
      : {
          installation: {
            id: 8,
            hasRepositoryAccess: overrides.access ?? true,
            settingsUrl: "https://github.com/settings/installations/8",
          },
        }),
    newInstallationUrl: "https://github.com/apps/revoir/installations/new",
  };
  return {
    events,
    async discover() {
      return discovery;
    },
    async open(url) {
      events.push(`open:${url}`);
    },
    async waitForInstallation(): Promise<RepositoryApproval> {
      return {
        status: overrides.approval === "pending" ? "pending" : "approved",
        installationId: 8,
        settingsUrl: "https://github.com/settings/installations/8",
      };
    },
    async waitForRepositoryAccess(_installationId, _repository, expected) {
      events.push(`poll:${String(expected)}`);
      return overrides.approval ?? "confirmed";
    },
    async listAccessibleRepositories() {
      return overrides.access === false ? [] : [{ installationId: 8, repository: REPOSITORY }];
    },
  };
}

function pendingStore() {
  const values: PendingRepositoryOperation[] = [];
  return {
    values,
    async load() {
      return values;
    },
    async upsert(operation: PendingRepositoryOperation) {
      values.splice(
        0,
        values.length,
        ...values.filter(
          (candidate) =>
            candidate.kind !== operation.kind ||
            candidate.repository.id !== operation.repository.id,
        ),
        operation,
      );
    },
    async remove(kind: "add" | "remove", repositoryId: number) {
      const next = values.filter(
        (candidate) => candidate.kind !== kind || candidate.repository.id !== repositoryId,
      );
      values.splice(0, values.length, ...next);
    },
  };
}

describe("repository references", () => {
  it("accepts explicit, HTTPS, and SSH repository identities without numeric ids", () => {
    assert.deepEqual(parseRepositoryReference("Owner/repository"), {
      owner: "Owner",
      name: "repository",
    });
    assert.deepEqual(parseGitHubRemote("https://github.com/Owner/repository.git\n"), {
      owner: "Owner",
      name: "repository",
    });
    assert.deepEqual(parseGitHubRemote("git@github.com:Owner/repository.git"), {
      owner: "Owner",
      name: "repository",
    });
    assert.throws(() => parseRepositoryReference("99:Owner/repository"), /OWNER\/REPOSITORY/u);
  });
});

describe("repository authorization", () => {
  it("adds local then cloud policy before reporting GitHub-confirmed authorization", async () => {
    const policies = new MemoryPolicies();
    const github = fakeGitHub({ access: false });
    const manager = new RepositoryManager({ github, policies, pending: pendingStore() });

    assert.deepEqual(await manager.add({ owner: "Owner", name: "repository" }), {
      status: "authorized",
      repository: REPOSITORY,
      installationId: 8,
    });
    assert.deepEqual(policies.events, ["local:1", "cloud:1", "cloud:verified"]);
    assert.deepEqual(github.events, [
      "open:https://github.com/settings/installations/8",
      "poll:true",
    ]);
  });

  it("rolls local authorization back when the cloud write fails", async () => {
    const policies = new MemoryPolicies();
    policies.failWrite = true;
    const manager = new RepositoryManager({
      github: fakeGitHub(),
      policies,
      pending: pendingStore(),
    });

    await assert.rejects(
      manager.add({ owner: "Owner", name: "repository" }),
      RepositoryPolicyUpdateError,
    );
    assert.equal(policies.local.installations.length, 0);
    assert.deepEqual(policies.events, ["local:1", "cloud:1", "local:0"]);
  });

  it("preserves cloud revocations when adding a different repository", async () => {
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 7, {
      id: 41,
      owner: "Owner",
      name: "revoked",
    });
    const manager = new RepositoryManager({
      github: fakeGitHub(),
      policies,
      pending: pendingStore(),
    });

    await manager.add({ owner: "Owner", name: "repository" });

    assert.deepEqual(
      policies.cloud.installations.flatMap(({ repositories }) => repositories),
      [REPOSITORY],
    );
    assert.deepEqual(policies.local, policies.cloud);
  });

  it("persists a resumable pending operation when organization approval outlives polling", async () => {
    const policies = new MemoryPolicies();
    const pending = pendingStore();
    const manager = new RepositoryManager({
      github: fakeGitHub({ installation: false, approval: "pending" }),
      policies,
      pending,
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });

    const result = await manager.add({ owner: "Owner", name: "repository" });
    assert.equal(result.status, "pending");
    assert.equal(policies.local.installations.length, 0);
    assert.deepEqual(pending.values, [
      {
        version: 1,
        kind: "add",
        repository: REPOSITORY,
        installationId: 8,
        settingsUrl: "https://github.com/settings/installations/8",
        createdAt: "2026-08-27T00:00:00.000Z",
      },
    ]);
  });

  it("revokes local and cloud policy before attempting GitHub cleanup", async () => {
    const policies = new MemoryPolicies();
    const seedManager = new RepositoryManager({
      github: fakeGitHub(),
      policies,
      pending: pendingStore(),
    });
    await seedManager.add({ owner: "Owner", name: "repository" });
    policies.events = [];
    const github = fakeGitHub({ approval: "pending" });
    const pending = pendingStore();
    const manager = new RepositoryManager({ github, policies, pending });

    assert.equal(
      (await manager.remove({ owner: "Owner", name: "repository" })).status,
      "github-access-pending",
    );
    assert.deepEqual(policies.events, ["local:1", "cloud:1", "cloud:verified"]);
    assert.equal(policies.local.installations[0]?.repositories.length, 0);
    assert.deepEqual(github.events, [
      "open:https://github.com/settings/installations/8",
      "poll:false",
    ]);
    assert.equal(pending.values[0]?.kind, "remove");
  });

  it("classifies authorization, drift, and GitHub-only access without broadening policy", async () => {
    const policies = new MemoryPolicies();
    const manager = new RepositoryManager({
      github: fakeGitHub(),
      policies,
      pending: pendingStore(),
    });
    assert.equal((await manager.list())[0]?.status, "github-access-only");
    assert.equal(policies.local.installations.length, 0);
  });

  it("lists a non-authorizing pending approval before GitHub exposes an installation", async () => {
    const policies = new MemoryPolicies();
    const pending = pendingStore();
    const manager = new RepositoryManager({
      github: fakeGitHub({ installation: false, approval: "pending" }),
      policies,
      pending,
    });
    await manager.add({ owner: "Owner", name: "repository" });

    assert.deepEqual(await manager.list(), [
      {
        repository: REPOSITORY,
        installationId: 8,
        status: "pending",
        local: false,
        cloud: false,
        github: true,
      },
    ]);
  });
});
