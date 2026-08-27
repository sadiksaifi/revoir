import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createEmptyPolicy,
  installationForRepository,
  withRepository,
  type RevoirPolicy,
} from "../src/config/policy.js";
import { repositoryAuthorizationDiagnostic } from "../src/diagnostics.js";
import { createEffectivePolicyLoader } from "../src/repository-gateways.js";
import {
  parseGitHubRemote,
  parseRepositoryReference,
  FilePendingRepositoryStore,
  RepositoryGitHubAccessPendingError,
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

  async ensureAuthenticated(): Promise<void> {}

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
    failOpen?: boolean;
    failWait?: boolean;
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
      if (overrides.failOpen === true) throw new Error("browser unavailable");
    },
    async waitForInstallation(): Promise<RepositoryApproval> {
      if (overrides.failWait === true) throw new Error("installation polling unavailable");
      return {
        status: overrides.approval === "pending" ? "pending" : "approved",
        installationId: 8,
        settingsUrl: "https://github.com/settings/installations/8",
      };
    },
    async waitForRepositoryAccess(_installationId, _repository, expected) {
      events.push(`poll:${String(expected)}`);
      if (overrides.failWait === true) throw new Error("repository polling unavailable");
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
        ...values.filter((candidate) => {
          if (candidate.repository.id !== operation.repository.id) return true;
          return operation.kind === "add" && candidate.kind === "remove";
        }),
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
  it("atomically replaces persisted add intent with removal intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-pending-transition-test-"));
    try {
      const pending = new FilePendingRepositoryStore(join(root, "state"));
      const add: PendingRepositoryOperation = {
        version: 1,
        kind: "add",
        repository: REPOSITORY,
        settingsUrl: "https://github.com/apps/revoir/installations/new",
        createdAt: "2026-08-27T00:00:00.000Z",
      };
      await pending.upsert(add);
      await pending.upsert({
        ...add,
        kind: "remove",
        installationId: 8,
        settingsUrl: "https://github.com/settings/installations/8",
      });

      assert.deepEqual(
        (await pending.load()).map(({ kind }) => kind),
        ["remove"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads the fail-closed local/cloud intersection for each Mac authorization check", async () => {
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 8, REPOSITORY);

    assert.deepEqual(await createEffectivePolicyLoader(policies)(), createEmptyPolicy(42));

    policies.cloud = policies.local;
    assert.deepEqual(await createEffectivePolicyLoader(policies)(), policies.local);

    policies.loadCloud = async () => {
      throw new Error("KV unavailable");
    };
    await assert.rejects(createEffectivePolicyLoader(policies)(), /KV unavailable/u);
  });

  it("propagates cancellation into effective cloud-policy loading", async () => {
    const controller = new AbortController();
    const cancellation = new Error("review cancelled");
    let cloudSignal: AbortSignal | undefined;
    const loader = createEffectivePolicyLoader({
      async loadLocal() {
        return createEmptyPolicy(42);
      },
      async loadCloud(signal?: AbortSignal) {
        cloudSignal = signal;
        return new Promise<RevoirPolicy>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    const loading = (loader as (signal?: AbortSignal) => Promise<RevoirPolicy>)(controller.signal);
    controller.abort(cancellation);
    await assert.rejects(
      Promise.race([
        loading,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("policy loading ignored cancellation")), 100);
        }),
      ]),
      cancellation,
    );
    assert.equal(cloudSignal, controller.signal);
  });

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

  it("persists non-authorizing installation approval before opening GitHub", async () => {
    const policies = new MemoryPolicies();
    const pending = pendingStore();
    const manager = new RepositoryManager({
      github: fakeGitHub({ installation: false, failOpen: true }),
      policies,
      pending,
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });

    await assert.rejects(
      manager.add({ owner: "Owner", name: "repository" }),
      (error) =>
        error instanceof RepositoryGitHubAccessPendingError &&
        /No Revoir authorization was added/u.test(error.message),
    );
    assert.deepEqual(policies.local, createEmptyPolicy(42));
    assert.equal(pending.values[0]?.kind, "add");
    assert.equal(pending.values[0]?.installationId, undefined);
  });

  it("persists GitHub access pending after both policy gates synchronize", async () => {
    const policies = new MemoryPolicies();
    const pending = pendingStore();
    const manager = new RepositoryManager({
      github: fakeGitHub({ access: false, failWait: true }),
      policies,
      pending,
    });

    await assert.rejects(
      manager.add({ owner: "Owner", name: "repository" }),
      (error) =>
        error instanceof RepositoryGitHubAccessPendingError &&
        /Local and cloud policy are synchronized/u.test(error.message),
    );
    assert.deepEqual(policies.local, policies.cloud);
    assert.equal(policies.local.installations[0]?.repositories[0]?.id, REPOSITORY.id);
    assert.equal(pending.values[0]?.kind, "add");
  });

  it("cancels an organization-install approval that never produced an installation", async () => {
    const policies = new MemoryPolicies();
    const pending = pendingStore();
    const github = fakeGitHub({ installation: false, access: false, approval: "pending" });
    const manager = new RepositoryManager({ github, policies, pending });
    assert.equal((await manager.add({ owner: "Owner", name: "repository" })).status, "pending");
    assert.equal(pending.values[0]?.kind, "add");

    assert.deepEqual(await manager.remove({ owner: "Owner", name: "repository" }), {
      status: "removed",
      repository: REPOSITORY,
    });
    assert.deepEqual(pending.values, []);
    assert.deepEqual(await manager.list(), []);
  });

  it("cancels a pre-install pending add that has no installation identity", async () => {
    const policies = new MemoryPolicies();
    const pending = pendingStore();
    const github = fakeGitHub({ installation: false, access: false, failOpen: true });
    const manager = new RepositoryManager({ github, policies, pending });
    await assert.rejects(manager.add({ owner: "Owner", name: "repository" }));
    assert.equal(pending.values[0]?.kind, "add");
    assert.equal(pending.values[0]?.installationId, undefined);
    github.open = async (url) => {
      github.events.push(`open:${url}`);
    };

    assert.equal((await manager.remove({ owner: "Owner", name: "repository" })).status, "removed");
    assert.deepEqual(pending.values, []);
    assert.deepEqual(await manager.list(), []);
  });

  it("turns a late installation approval into cleanup without reviving pending add intent", async () => {
    const policies = new MemoryPolicies();
    const pending = pendingStore();
    const github = fakeGitHub({ installation: false, approval: "pending" });
    const manager = new RepositoryManager({ github, policies, pending });
    assert.equal((await manager.add({ owner: "Owner", name: "repository" })).status, "pending");
    let hasAccess = true;
    github.discover = async () => ({
      repository: REPOSITORY,
      installation: {
        id: 8,
        hasRepositoryAccess: hasAccess,
        settingsUrl: "https://github.com/settings/installations/8",
      },
      newInstallationUrl: "https://github.com/apps/revoir/installations/new",
    });
    github.waitForRepositoryAccess = async (_installationId, _repository, expected) => {
      assert.equal(expected, false);
      hasAccess = false;
      return "confirmed";
    };
    github.listAccessibleRepositories = async () =>
      hasAccess ? [{ installationId: 8, repository: REPOSITORY }] : [];

    assert.equal((await manager.remove({ owner: "Owner", name: "repository" })).status, "removed");
    assert.deepEqual(pending.values, []);
    assert.deepEqual(await manager.list(), []);
  });

  it("cancels pending add intent while preserving late GitHub access on request", async () => {
    const policies = new MemoryPolicies();
    const pending = pendingStore();
    const github = fakeGitHub({ installation: false, approval: "pending" });
    const manager = new RepositoryManager({ github, policies, pending });
    assert.equal((await manager.add({ owner: "Owner", name: "repository" })).status, "pending");
    github.discover = async () => ({
      repository: REPOSITORY,
      installation: {
        id: 8,
        hasRepositoryAccess: true,
        settingsUrl: "https://github.com/settings/installations/8",
      },
      newInstallationUrl: "https://github.com/apps/revoir/installations/new",
    });

    assert.equal(
      (await manager.remove({ owner: "Owner", name: "repository" }, { keepGitHubAccess: true }))
        .status,
      "removed",
    );
    assert.deepEqual(pending.values, []);
    assert.equal((await manager.list())[0]?.status, "github-access-only");
    assert.notEqual((await manager.list())[0]?.status, "pending");
  });

  it("finishes a pending external removal before re-adding repository access", async () => {
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 8, REPOSITORY);
    policies.cloud = policies.local;
    const pending = pendingStore();
    await pending.upsert({
      version: 1,
      kind: "remove",
      repository: REPOSITORY,
      installationId: 8,
      settingsUrl: "https://github.com/settings/installations/8",
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    const github = fakeGitHub();
    let hasAccess = true;
    let removalStarted = false;
    let finishRemoval!: () => void;
    const removalApproval = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    github.waitForRepositoryAccess = async (_installationId, _repository, expected) => {
      github.events.push(`poll:${String(expected)}`);
      if (!expected) {
        removalStarted = true;
        await removalApproval;
        hasAccess = false;
      } else {
        assert.equal(hasAccess, false, "re-add must observe the completed removal first");
        hasAccess = true;
      }
      return "confirmed";
    };
    github.listAccessibleRepositories = async () =>
      hasAccess ? [{ installationId: 8, repository: REPOSITORY }] : [];
    const manager = new RepositoryManager({ github, policies, pending });

    const adding = manager.add({ owner: "Owner", name: "repository" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(removalStarted, true);
    assert.equal(policies.local.installations[0]?.repositories.length, 0);
    assert.equal(policies.cloud.installations[0]?.repositories.length, 0);
    assert.equal(pending.values[0]?.kind, "remove");

    finishRemoval();
    assert.equal((await adding).status, "authorized");
    assert.deepEqual(github.events, [
      "open:https://github.com/settings/installations/8",
      "poll:false",
      "open:https://github.com/settings/installations/8",
      "poll:true",
    ]);
    assert.deepEqual(pending.values, []);
    assert.equal((await manager.list())[0]?.status, "authorized");
  });

  it("treats an uninstalled pending installation as removed before starting a new installation", async () => {
    const policies = new MemoryPolicies();
    const pending = pendingStore();
    await pending.upsert({
      version: 1,
      kind: "remove",
      repository: REPOSITORY,
      installationId: 8,
      settingsUrl: "https://github.com/settings/installations/8",
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    let replacementInstalled = false;
    const github = fakeGitHub({ installation: false, approval: "pending" });
    github.discover = async () => ({
      repository: REPOSITORY,
      ...(replacementInstalled
        ? {
            installation: {
              id: 9,
              hasRepositoryAccess: true,
              settingsUrl: "https://github.com/settings/installations/9",
            },
          }
        : {}),
      newInstallationUrl: "https://github.com/apps/revoir/installations/new",
    });
    github.waitForRepositoryAccess = async () => {
      throw new Error("old installation token failed with HTTP 404");
    };
    github.waitForInstallation = async () => ({
      status: "pending",
      settingsUrl: "https://github.com/apps/revoir/installations/new",
    });
    const manager = new RepositoryManager({ github, policies, pending });

    assert.deepEqual(await manager.add({ owner: "Owner", name: "repository" }), {
      status: "pending",
      repository: REPOSITORY,
    });
    assert.deepEqual(
      github.events,
      ["open:https://github.com/apps/revoir/installations/new"],
      "the removed installation must not be opened or authenticated",
    );
    assert.deepEqual(
      pending.values.map(({ kind, installationId }) => ({ kind, installationId })),
      [{ kind: "add", installationId: undefined }],
    );

    replacementInstalled = true;
    assert.deepEqual(await manager.add({ owner: "Owner", name: "repository" }), {
      status: "authorized",
      repository: REPOSITORY,
      installationId: 9,
    });
    assert.deepEqual(pending.values, []);
  });

  it("treats a replacement installation identity as completion of the old pending removal", async () => {
    const policies = new MemoryPolicies();
    const pending = pendingStore();
    await pending.upsert({
      version: 1,
      kind: "remove",
      repository: REPOSITORY,
      installationId: 8,
      settingsUrl: "https://github.com/settings/installations/8",
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    const github = fakeGitHub();
    github.discover = async () => ({
      repository: REPOSITORY,
      installation: {
        id: 9,
        hasRepositoryAccess: true,
        settingsUrl: "https://github.com/settings/installations/9",
      },
      newInstallationUrl: "https://github.com/apps/revoir/installations/new",
    });
    github.waitForRepositoryAccess = async () => {
      throw new Error("the replaced installation must not be polled");
    };

    assert.deepEqual(
      await new RepositoryManager({ github, policies, pending }).add({
        owner: "Owner",
        name: "repository",
      }),
      { status: "authorized", repository: REPOSITORY, installationId: 9 },
    );
    assert.deepEqual(github.events, []);
    assert.deepEqual(pending.values, []);
  });

  it("revokes local trust before Wrangler and cloud trust before GitHub discovery", async () => {
    const events: string[] = [];
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 8, REPOSITORY);
    policies.cloud = policies.local;
    let localWrites = 0;
    policies.writeLocal = async (policy) => {
      events.push(localWrites === 0 ? "local-revoked" : "local-synchronized");
      localWrites += 1;
      policies.local = policy;
    };
    policies.ensureAuthenticated = async () => {
      events.push("wrangler-authenticated");
    };
    policies.writeCloud = async (policy) => {
      events.push("cloud-revoked");
      policies.cloud = policy;
    };
    policies.verifyCloud = async () => {
      events.push("cloud-verified");
    };
    const github = fakeGitHub();
    github.ensureAuthenticated = async () => {
      events.push("github-authenticated");
    };
    const discover = github.discover.bind(github);
    github.discover = async (reference) => {
      events.push("github-discovered");
      return discover(reference);
    };

    await new RepositoryManager({ github, policies, pending: pendingStore() }).remove({
      owner: "Owner",
      name: "repository",
    });

    assert.deepEqual(events, [
      "local-revoked",
      "wrangler-authenticated",
      "local-synchronized",
      "cloud-revoked",
      "cloud-verified",
      "github-authenticated",
      "github-discovered",
    ]);
  });

  it("durably revokes the local execution gate before persisting removal intent", async () => {
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 8, REPOSITORY);
    policies.cloud = policies.local;
    const pending = pendingStore();
    const interruption = new Error("interrupted immediately after pending removal persistence");
    pending.upsert = async (operation) => {
      assert.equal(
        installationForRepository(policies.local, "Owner", "repository"),
        undefined,
        "pending removal must never become durable while local execution remains authorized",
      );
      pending.values.push(operation);
      throw interruption;
    };

    await assert.rejects(
      new RepositoryManager({ github: fakeGitHub(), policies, pending }).remove({
        owner: "Owner",
        name: "repository",
      }),
      interruption,
    );
    assert.equal(installationForRepository(policies.local, "Owner", "repository"), undefined);
    assert.equal(
      installationForRepository(
        await createEffectivePolicyLoader(policies)(),
        "Owner",
        "repository",
      ),
      undefined,
    );
    assert.equal(pending.values[0]?.kind, "remove");
  });

  it("keeps local trust revoked when Wrangler authentication fails", async () => {
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 8, REPOSITORY);
    policies.cloud = policies.local;
    policies.ensureAuthenticated = async () => {
      throw new Error("Wrangler unavailable");
    };
    const pending = pendingStore();

    await assert.rejects(
      new RepositoryManager({ github: fakeGitHub(), policies, pending }).remove({
        owner: "Owner",
        name: "repository",
      }),
      /Wrangler unavailable/u,
    );

    assert.equal(installationForRepository(policies.local, "Owner", "repository"), undefined);
    assert.equal(installationForRepository(policies.cloud, "Owner", "repository")?.id, 8);
    assert.deepEqual(pending.values, [
      {
        version: 1,
        kind: "remove",
        repository: REPOSITORY,
        installationId: 8,
        createdAt: pending.values[0]?.createdAt,
      },
    ]);
  });

  it("keeps both policy gates revoked when GitHub authentication fails", async () => {
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 8, REPOSITORY);
    policies.cloud = policies.local;
    const github = fakeGitHub();
    github.ensureAuthenticated = async () => {
      throw new Error("GitHub unavailable");
    };
    const pending = pendingStore();

    await assert.rejects(
      new RepositoryManager({ github, policies, pending }).remove({
        owner: "Owner",
        name: "repository",
      }),
      (error) =>
        error instanceof RepositoryGitHubAccessPendingError &&
        /authorization is revoked/u.test(error.message),
    );

    assert.equal(installationForRepository(policies.local, "Owner", "repository"), undefined);
    assert.equal(installationForRepository(policies.cloud, "Owner", "repository"), undefined);
    assert.equal(pending.values[0]?.kind, "remove");
    assert.equal(pending.values[0]?.repository.id, REPOSITORY.id);
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
    assert.deepEqual(policies.events, ["local:1", "local:1", "cloud:1", "cloud:verified"]);
    assert.equal(policies.local.installations[0]?.repositories.length, 0);
    assert.deepEqual(github.events, [
      "open:https://github.com/settings/installations/8",
      "poll:false",
    ]);
    assert.equal(pending.values[0]?.kind, "remove");
  });

  it("removes a renamed repository by immutable identity before GitHub cleanup", async () => {
    const previousIdentity = { ...REPOSITORY, name: "previous-name" };
    const events: string[] = [];
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 8, previousIdentity);
    policies.cloud = policies.local;
    const writeLocal = policies.writeLocal.bind(policies);
    policies.writeLocal = async (policy) => {
      events.push("local-revoked");
      await writeLocal(policy);
    };
    const writeCloud = policies.writeCloud.bind(policies);
    policies.writeCloud = async (policy) => {
      events.push("cloud-written");
      await writeCloud(policy);
    };
    policies.verifyCloud = async () => {
      events.push("cloud-verified");
    };
    const github = fakeGitHub();
    github.discover = async () => ({
      repository: REPOSITORY,
      installation: {
        id: 8,
        hasRepositoryAccess: true,
        settingsUrl: "https://github.com/settings/installations/8",
      },
      newInstallationUrl: "https://github.com/apps/revoir/installations/new",
    });
    github.open = async () => {
      events.push("github-opened");
    };
    github.waitForRepositoryAccess = async () => {
      events.push("github-polled");
      return "confirmed";
    };
    const manager = new RepositoryManager({ github, policies, pending: pendingStore() });

    assert.deepEqual(await manager.remove({ owner: "Owner", name: "repository" }), {
      status: "removed",
      repository: REPOSITORY,
    });
    assert.equal(
      policies.local.installations.some((installation) =>
        installation.repositories.some(({ id }) => id === REPOSITORY.id),
      ),
      false,
    );
    assert.equal(
      policies.cloud.installations.some((installation) =>
        installation.repositories.some(({ id }) => id === REPOSITORY.id),
      ),
      false,
    );
    assert.ok(events.lastIndexOf("local-revoked") < events.lastIndexOf("cloud-written"));
    assert.ok(events.lastIndexOf("cloud-written") < events.lastIndexOf("cloud-verified"));
    assert.ok(events.lastIndexOf("cloud-verified") < events.lastIndexOf("github-opened"));
    assert.ok(events.lastIndexOf("github-opened") < events.lastIndexOf("github-polled"));
  });

  it("removes renamed policy trust while preserving GitHub access on request", async () => {
    const previousIdentity = { ...REPOSITORY, name: "previous-name" };
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 8, previousIdentity);
    policies.cloud = policies.local;
    const github = fakeGitHub();
    github.discover = async () => ({
      repository: REPOSITORY,
      installation: {
        id: 8,
        hasRepositoryAccess: true,
        settingsUrl: "https://github.com/settings/installations/8",
      },
      newInstallationUrl: "https://github.com/apps/revoir/installations/new",
    });

    assert.deepEqual(
      await new RepositoryManager({ github, policies, pending: pendingStore() }).remove(
        { owner: "Owner", name: "repository" },
        { keepGitHubAccess: true },
      ),
      { status: "removed", repository: REPOSITORY },
    );
    assert.equal(
      policies.local.installations.some((installation) =>
        installation.repositories.some(({ id }) => id === REPOSITORY.id),
      ),
      false,
    );
    assert.equal(
      policies.cloud.installations.some((installation) =>
        installation.repositories.some(({ id }) => id === REPOSITORY.id),
      ),
      false,
    );
    assert.deepEqual(github.events, []);
  });

  it("keeps renamed authorization locally revoked when cloud cleanup is interrupted", async () => {
    const previousIdentity = { ...REPOSITORY, name: "previous-name" };
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 8, previousIdentity);
    policies.cloud = policies.local;
    const writeCloud = policies.writeCloud.bind(policies);
    let cloudWrites = 0;
    policies.writeCloud = async (policy) => {
      cloudWrites += 1;
      if (cloudWrites === 2) throw new Error("KV unavailable");
      await writeCloud(policy);
    };
    const github = fakeGitHub();
    github.discover = async () => ({
      repository: REPOSITORY,
      installation: {
        id: 8,
        hasRepositoryAccess: true,
        settingsUrl: "https://github.com/settings/installations/8",
      },
      newInstallationUrl: "https://github.com/apps/revoir/installations/new",
    });
    const pending = pendingStore();

    await assert.rejects(
      new RepositoryManager({ github, policies, pending }).remove({
        owner: "Owner",
        name: "repository",
      }),
      (error) =>
        error instanceof RepositoryPolicyUpdateError &&
        /local authorization was revoked/iu.test(error.message),
    );
    assert.equal(
      policies.local.installations.some((installation) =>
        installation.repositories.some(({ id }) => id === REPOSITORY.id),
      ),
      false,
    );
    assert.equal(
      policies.cloud.installations.some((installation) =>
        installation.repositories.some(({ id }) => id === REPOSITORY.id),
      ),
      true,
    );
    assert.deepEqual(
      pending.values.map(({ kind, repository }) => ({ kind, repository })),
      [{ kind: "remove", repository: REPOSITORY }],
    );
    assert.deepEqual(github.events, []);
  });

  it("revokes renamed local trust before persisting remote cleanup intent", async () => {
    const previousIdentity = { ...REPOSITORY, name: "previous-name" };
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 8, previousIdentity);
    policies.cloud = policies.local;
    const github = fakeGitHub();
    github.discover = async () => ({
      repository: REPOSITORY,
      installation: {
        id: 8,
        hasRepositoryAccess: true,
        settingsUrl: "https://github.com/settings/installations/8",
      },
      newInstallationUrl: "https://github.com/apps/revoir/installations/new",
    });
    const pending = pendingStore();
    pending.upsert = async () => {
      throw new Error("interrupted before pending intent was durable");
    };

    await assert.rejects(
      new RepositoryManager({ github, policies, pending }).remove({
        owner: "Owner",
        name: "repository",
      }),
      /interrupted before pending intent was durable/u,
    );
    assert.equal(
      policies.local.installations.some((installation) =>
        installation.repositories.some(({ id }) => id === REPOSITORY.id),
      ),
      false,
    );
    assert.equal(
      policies.cloud.installations.some((installation) =>
        installation.repositories.some(({ id }) => id === REPOSITORY.id),
      ),
      true,
    );
    assert.deepEqual(github.events, []);
  });

  it("keeps GitHub-only repository access without opening settings or polling", async () => {
    const policies = new MemoryPolicies();
    const github = fakeGitHub();
    const pending = pendingStore();
    const manager = new RepositoryManager({ github, policies, pending });

    assert.deepEqual(
      await manager.remove({ owner: "Owner", name: "repository" }, { keepGitHubAccess: true }),
      { status: "removed", repository: REPOSITORY },
    );
    assert.deepEqual(github.events, []);
    assert.deepEqual(pending.values, []);
  });

  it("keeps authorization revoked and saves GitHub cleanup when polling fails", async () => {
    const policies = new MemoryPolicies();
    const seedManager = new RepositoryManager({
      github: fakeGitHub(),
      policies,
      pending: pendingStore(),
    });
    await seedManager.add({ owner: "Owner", name: "repository" });
    const pending = pendingStore();
    const manager = new RepositoryManager({
      github: fakeGitHub({ failWait: true }),
      policies,
      pending,
    });

    await assert.rejects(
      manager.remove({ owner: "Owner", name: "repository" }),
      (error) =>
        error instanceof RepositoryGitHubAccessPendingError &&
        /Revoir authorization is revoked/u.test(error.message),
    );
    assert.equal(policies.local.installations[0]?.repositories.length, 0);
    assert.equal(policies.cloud.installations[0]?.repositories.length, 0);
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

  it("reports installation replacement as authorization drift", async () => {
    const policies = new MemoryPolicies();
    policies.local = withRepository(createEmptyPolicy(42), 8, REPOSITORY);
    policies.cloud = policies.local;
    const github = fakeGitHub();
    github.listAccessibleRepositories = async () => [
      { installationId: 9, repository: REPOSITORY },
    ];
    const entries = await new RepositoryManager({
      github,
      policies,
      pending: pendingStore(),
    }).list();

    assert.deepEqual(entries, [
      {
        repository: REPOSITORY,
        installationId: 9,
        status: "drifted",
        local: true,
        cloud: true,
        github: true,
      },
    ]);
    assert.deepEqual(repositoryAuthorizationDiagnostic(entries), {
      id: "authorization",
      label: "Repository authorization",
      status: "failed",
      detail: "drifted: Owner/repository",
    });
  });

  it("classifies installation identity agreement across every authorization source", async () => {
    const scenarios = [
      { name: "all sources agree", cloud: 8, github: 8, expected: "authorized" },
      { name: "GitHub access is absent", cloud: 8, github: undefined, expected: "inaccessible" },
      { name: "GitHub installation differs", cloud: 8, github: 9, expected: "drifted" },
      { name: "cloud installation differs", cloud: 9, github: 8, expected: "drifted" },
      {
        name: "local installation differs from cloud and GitHub",
        cloud: 9,
        github: 9,
        expected: "drifted",
      },
      {
        name: "policy installations differ while GitHub access is absent",
        cloud: 9,
        github: undefined,
        expected: "drifted",
      },
    ] as const;

    for (const scenario of scenarios) {
      const policies = new MemoryPolicies();
      policies.local = withRepository(createEmptyPolicy(42), 8, REPOSITORY);
      policies.cloud = withRepository(createEmptyPolicy(42), scenario.cloud, REPOSITORY);
      const github = fakeGitHub();
      github.listAccessibleRepositories = async () =>
        scenario.github === undefined
          ? []
          : [{ installationId: scenario.github, repository: REPOSITORY }];

      const entry = (
        await new RepositoryManager({ github, policies, pending: pendingStore() }).list()
      )[0];
      assert.equal(entry?.status, scenario.expected, scenario.name);
    }
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
