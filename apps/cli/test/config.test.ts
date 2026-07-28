import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { resolveApplicationPaths } from "../src/config/paths.js";
import {
  ConfigurationValidationError,
  createConfiguration,
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  validateConfiguration,
} from "../src/config/schema.js";
import {
  ConfigurationFileError,
  loadConfiguration,
  writeConfiguration,
} from "../src/config/store.js";
import { createTestConfiguration, TEST_PRIVATE_KEY } from "./helpers.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "revoir-config-test-"));
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

describe("XDG paths", () => {
  it("uses the agreed macOS defaults", () => {
    assert.deepEqual(resolveApplicationPaths({}, "/Users/test"), {
      configDir: "/Users/test/.config/revoir",
      configFile: "/Users/test/.config/revoir/config.json",
      cacheDir: "/Users/test/.cache/revoir",
      stateDir: "/Users/test/.local/state/revoir",
      dataDir: "/Users/test/.local/share/revoir",
    });
  });

  it("honors every XDG override", () => {
    assert.deepEqual(
      resolveApplicationPaths(
        {
          XDG_CONFIG_HOME: "/xdg/config",
          XDG_CACHE_HOME: "/xdg/cache",
          XDG_STATE_HOME: "/xdg/state",
          XDG_DATA_HOME: "/xdg/data",
        },
        "/Users/test",
      ),
      {
        configDir: "/xdg/config/revoir",
        configFile: "/xdg/config/revoir/config.json",
        cacheDir: "/xdg/cache/revoir",
        stateDir: "/xdg/state/revoir",
        dataDir: "/xdg/data/revoir",
      },
    );
  });

  it("rejects relative XDG overrides", () => {
    assert.throws(
      () => resolveApplicationPaths({ XDG_CONFIG_HOME: "relative/config" }, "/Users/test"),
      /XDG_CONFIG_HOME must be an absolute path/u,
    );
  });
});

describe("configuration schema", () => {
  it("applies model, reasoning, and timeout defaults", () => {
    const configuration = createConfiguration({
      github: {
        userId: 42,
        appId: 7,
        installationId: 8,
        privateKey: TEST_PRIVATE_KEY,
        repositories: [{ id: 99, owner: "owner", name: "repo" }],
      },
      cloudflare: {
        accountId: "account",
        queueId: "queue",
        apiToken: "token",
      },
      paths: {
        cacheDir: "/cache",
        stateDir: "/state",
        dataDir: "/data",
      },
    });

    assert.equal(configuration.model.id, DEFAULT_MODEL);
    assert.equal(configuration.model.reasoning, DEFAULT_REASONING);
    assert.equal(configuration.timeouts.reviewMs, 1_200_000);
    assert.equal(configuration.timeouts.shellCommandMs, 120_000);
  });

  it("accepts positive timeout overrides and rejects invalid durations", () => {
    const input = {
      github: {
        userId: 42,
        appId: 7,
        installationId: 8,
        privateKey: TEST_PRIVATE_KEY,
        repositories: [{ id: 99, owner: "owner", name: "repo" }],
      },
      cloudflare: {
        accountId: "account",
        queueId: "queue",
        apiToken: "token",
      },
      paths: {
        cacheDir: "/cache",
        stateDir: "/state",
        dataDir: "/data",
      },
    };

    assert.deepEqual(
      createConfiguration({
        ...input,
        timeouts: { reviewMs: 60_000, shellCommandMs: 5_000 },
      }).timeouts,
      { reviewMs: 60_000, shellCommandMs: 5_000 },
    );
    assert.throws(
      () =>
        createConfiguration({
          ...input,
          timeouts: { reviewMs: 0, shellCommandMs: 1.5 },
        }),
      /timeouts\.reviewMs must be a positive integer[\s\S]+timeouts\.shellCommandMs must be a positive integer/u,
    );
  });

  it("rejects malformed fields, unsupported providers, reasoning, and versions", () => {
    const base = createTestConfiguration({
      cacheDir: "/cache",
      stateDir: "/state",
      dataDir: "/data",
    });
    assert.throws(
      () =>
        validateConfiguration({
          ...base,
          version: 2,
          model: { id: "anthropic/opus", reasoning: "extreme" },
          github: { ...base.github, userId: "42", repositories: [] },
        }),
      (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.match(error.message, /version must be 1/u);
        assert.match(error.message, /openai-codex/u);
        assert.match(error.message, /model\.reasoning/u);
        assert.match(error.message, /github\.userId/u);
        assert.match(error.message, /at least one repository/u);
        return true;
      },
    );
  });

  it("rejects unknown fields and non-absolute runtime paths", () => {
    const base = createTestConfiguration({
      cacheDir: "/cache",
      stateDir: "/state",
      dataDir: "/data",
    });
    assert.throws(
      () =>
        validateConfiguration({
          ...base,
          unexpected: true,
          paths: { ...base.paths, cacheDir: "cache" },
        }),
      /configuration\.unexpected is not supported[\s\S]+paths\.cacheDir must be an absolute path/u,
    );
  });
});

describe("configuration file", () => {
  it("writes valid JSON with protected directories and file modes", async () => {
    const root = await temporaryDirectory();
    const paths = resolveApplicationPaths(
      {
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_DATA_HOME: join(root, "data"),
      },
      root,
    );
    const configuration = createTestConfiguration(paths);

    await writeConfiguration(paths.configFile, configuration);

    assert.equal((await lstat(paths.configDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.configFile)).mode & 0o777, 0o600);
    assert.equal((await lstat(paths.cacheDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.stateDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.dataDir)).mode & 0o777, 0o700);
    assert.deepEqual(await loadConfiguration(paths.configFile), configuration);
    assert.doesNotMatch(await readFile(paths.configFile, "utf8"), /\[REDACTED\]/u);
  });

  it("writes into an existing private configuration directory", async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, "private-config");
    const configFile = join(configDir, "revoir.json");
    await mkdir(configDir);
    await chmod(configDir, 0o700);
    const configuration = createTestConfiguration({
      cacheDir: join(root, "cache", "revoir"),
      stateDir: join(root, "state", "revoir"),
      dataDir: join(root, "data", "revoir"),
    });

    await writeConfiguration(configFile, configuration);

    assert.equal((await lstat(configDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(configFile)).mode & 0o777, 0o600);
  });

  it("refuses unsafe file and directory permissions with actionable errors", async () => {
    const root = await temporaryDirectory();
    const paths = resolveApplicationPaths({ XDG_CONFIG_HOME: join(root, "config") }, root);
    const configuration = createTestConfiguration(paths);
    await writeConfiguration(paths.configFile, configuration);

    await chmod(paths.configFile, 0o644);
    await assert.rejects(loadConfiguration(paths.configFile), (error) => {
      assert.ok(error instanceof ConfigurationFileError);
      assert.match(error.message, /chmod 600/u);
      return true;
    });

    await chmod(paths.configFile, 0o600);
    await chmod(paths.configDir, 0o755);
    await assert.rejects(loadConfiguration(paths.configFile), /chmod 700/u);
  });

  it("rejects malformed JSON and symbolic-link configuration files", async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, "config", "revoir");
    const configFile = join(configDir, "config.json");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(configFile, "{broken", { mode: 0o600 });
    await assert.rejects(loadConfiguration(configFile), /not valid JSON/u);

    const target = join(root, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await unlink(configFile);
    await symlink(target, configFile);
    await assert.rejects(loadConfiguration(configFile), /symbolic link/u);
  });
});
