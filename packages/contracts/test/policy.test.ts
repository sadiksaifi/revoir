import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PolicySchemaError, parseRevoirPolicy } from "../src/policy.js";

function policy() {
  return {
    version: 1,
    revision: 4,
    userId: 42,
    installations: [
      {
        id: 8,
        repositories: [
          { id: 99, owner: "owner", name: "repository" },
          { id: 100, owner: "organization", name: "another-repository" },
        ],
      },
    ],
  };
}

describe("Revoir policy contract v1", () => {
  it("round-trips a complete policy and accepts an empty repository policy", () => {
    const value = policy();
    assert.deepEqual(parseRevoirPolicy(JSON.stringify(structuredClone(value))), value);
    assert.deepEqual(
      parseRevoirPolicy({ version: 1, revision: 0, userId: 42, installations: [] }),
      { version: 1, revision: 0, userId: 42, installations: [] },
    );
    assert.deepEqual(
      parseRevoirPolicy({
        version: 1,
        revision: 1,
        userId: 42,
        installations: [{ id: 8, repositories: [] }],
      }),
      {
        version: 1,
        revision: 1,
        userId: 42,
        installations: [{ id: 8, repositories: [] }],
      },
    );
  });

  it("requires every field and rejects unknown fields", () => {
    for (const field of Object.keys(policy())) {
      const candidate = structuredClone(policy()) as Record<string, unknown>;
      delete candidate[field];
      assert.throws(() => parseRevoirPolicy(candidate), PolicySchemaError);
    }
    for (const field of Object.keys(policy().installations[0]!)) {
      const candidate = structuredClone(policy());
      delete (candidate.installations[0] as unknown as Record<string, unknown>)[field];
      assert.throws(() => parseRevoirPolicy(candidate), PolicySchemaError);
    }
    for (const field of Object.keys(policy().installations[0]!.repositories[0]!)) {
      const candidate = structuredClone(policy());
      delete (candidate.installations[0]!.repositories[0] as unknown as Record<string, unknown>)[
        field
      ];
      assert.throws(() => parseRevoirPolicy(candidate), PolicySchemaError);
    }

    assert.throws(() => parseRevoirPolicy({ ...policy(), extra: true }), PolicySchemaError);
  });

  it("rejects malformed versions, revisions, identities, and repository names", () => {
    const cases = [
      "not json",
      null,
      { ...policy(), version: 2 },
      { ...policy(), revision: -1 },
      { ...policy(), revision: 1.5 },
      { ...policy(), userId: 0 },
      { ...policy(), installations: {} },
      { ...policy(), installations: [{ id: 0, repositories: [] }] },
      {
        ...policy(),
        installations: [{ id: 8, repositories: [{ id: 99, owner: "bad owner", name: "repo" }] }],
      },
      {
        ...policy(),
        installations: [{ id: 8, repositories: [{ id: 99, owner: "owner", name: "bad/name" }] }],
      },
    ];
    for (const candidate of cases) {
      assert.throws(() => parseRevoirPolicy(candidate), PolicySchemaError);
    }
  });

  it("rejects duplicate installation, repository ID, and full-name identities", () => {
    const value = policy();
    const duplicateInstallation = {
      ...value,
      installations: [...value.installations, structuredClone(value.installations[0]!)],
    };
    const duplicateRepositoryId = structuredClone(value);
    duplicateRepositoryId.installations.push({
      id: 9,
      repositories: [{ id: 99, owner: "other", name: "different" }],
    });
    const duplicateRepositoryName = structuredClone(value);
    duplicateRepositoryName.installations.push({
      id: 9,
      repositories: [{ id: 101, owner: "OWNER", name: "REPOSITORY" }],
    });

    for (const candidate of [
      duplicateInstallation,
      duplicateRepositoryId,
      duplicateRepositoryName,
    ]) {
      assert.throws(() => parseRevoirPolicy(candidate), PolicySchemaError);
    }
  });
});
