import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveApplicationPaths } from "../src/config/paths.js";
import { DEFAULT_MODEL, DEFAULT_REASONING } from "../src/config/schema.js";
import { collectSetupConfiguration, parseRepository, parseSetupOptions } from "../src/setup.js";
import { TEST_PRIVATE_KEY } from "./helpers.js";

const paths = resolveApplicationPaths({}, "/Users/test");

function nonInteractiveArguments(): string[] {
  return [
    "--non-interactive",
    "--github-user-id",
    "42",
    "--github-app-id",
    "7",
    "--github-installation-id",
    "8",
    "--github-private-key-file",
    "/secrets/github.pem",
    "--repository",
    "8:99:owner/repository",
    "--cloudflare-account-id",
    "account",
    "--cloudflare-queue-id",
    "queue",
    "--cloudflare-api-token-file",
    "/secrets/cloudflare-token",
  ];
}

describe("setup input", () => {
  it("collects a non-interactive configuration and keeps credentials in files", async () => {
    const requestedFiles: string[] = [];
    const configuration = await collectSetupConfiguration(
      parseSetupOptions(nonInteractiveArguments()),
      paths,
      undefined,
      async (file) => {
        requestedFiles.push(file);
        return file.endsWith(".pem") ? TEST_PRIVATE_KEY : "token-from-file\n";
      },
    );

    assert.equal(configuration.model.id, DEFAULT_MODEL);
    assert.equal(configuration.model.reasoning, DEFAULT_REASONING);
    assert.equal(configuration.cloudflare.apiToken, "token-from-file");
    assert.deepEqual(configuration.github.installations, [
      {
        id: 8,
        repositories: [{ id: 99, owner: "owner", name: "repository" }],
      },
    ]);
    assert.deepEqual(requestedFiles.toSorted(), [
      "/secrets/cloudflare-token",
      "/secrets/github.pem",
    ]);
  });

  it("collects interactive answers and applies blank defaults", async () => {
    const answers = [
      "",
      "",
      "42",
      "7",
      "8,9",
      "/secrets/github.pem",
      "8:99:owner/repository,9:100:owner/second",
      "account",
      "queue",
      "/secrets/cloudflare-token",
      "",
      "",
    ];
    const configuration = await collectSetupConfiguration(
      parseSetupOptions([]),
      paths,
      async () => answers.shift() ?? "",
      async (file) => (file.endsWith(".pem") ? TEST_PRIVATE_KEY : "interactive-token"),
    );

    assert.equal(configuration.model.id, DEFAULT_MODEL);
    assert.equal(configuration.timeouts.reviewMs, 1_200_000);
    assert.deepEqual(
      configuration.github.installations.map((installation) => installation.id),
      [8, 9],
    );
  });

  it("associates non-interactive repositories with multiple installations", async () => {
    const setupArguments = nonInteractiveArguments();
    setupArguments.splice(
      setupArguments.indexOf("--github-private-key-file"),
      0,
      "--github-installation-id",
      "9",
    );
    setupArguments.splice(
      setupArguments.indexOf("--cloudflare-account-id"),
      0,
      "--repository",
      "9:100:other/second",
    );

    const configuration = await collectSetupConfiguration(
      parseSetupOptions(setupArguments),
      paths,
      undefined,
      async (file) => (file.endsWith(".pem") ? TEST_PRIVATE_KEY : "token"),
    );

    assert.deepEqual(configuration.github.installations, [
      {
        id: 8,
        repositories: [{ id: 99, owner: "owner", name: "repository" }],
      },
      {
        id: 9,
        repositories: [{ id: 100, owner: "other", name: "second" }],
      },
    ]);
  });

  it("rejects missing non-interactive fields, invalid options, and repository syntax", async () => {
    await assert.rejects(
      collectSetupConfiguration(parseSetupOptions(["--non-interactive"]), paths),
      /Missing required setup option GitHub immutable user id/u,
    );
    assert.throws(() => parseSetupOptions(["--unknown", "value"]), /Unknown setup option/u);
    assert.throws(() => parseRepository("owner/repository"), /numeric-id/u);
    const legacyArguments = nonInteractiveArguments();
    legacyArguments[legacyArguments.indexOf("--repository") + 1] = "99:owner/repository";
    await assert.rejects(
      collectSetupConfiguration(
        parseSetupOptions(legacyArguments),
        paths,
        undefined,
        async (file) => (file.endsWith(".pem") ? TEST_PRIVATE_KEY : "token"),
      ),
      /must use the "<installation-id>:<repository-id>:<owner>\/<name>" format/u,
    );
    await assert.rejects(
      collectSetupConfiguration(
        parseSetupOptions([...nonInteractiveArguments(), "--repository", "9:100:other/repository"]),
        paths,
        undefined,
        async (file) => (file.endsWith(".pem") ? TEST_PRIVATE_KEY : "token"),
      ),
      /unconfigured GitHub App installation 9/u,
    );
  });
});
