import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdir, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { resolveApplicationPaths, type ApplicationPaths } from "../src/config/paths.js";
import {
  ConfigurationValidationError,
  createConfiguration,
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  type RevoirConfiguration,
  validateConfiguration,
} from "../src/config/schema.js";
import {
  ConfigurationFileError,
  loadConfiguration,
  writeConfiguration,
} from "../src/config/store.js";

const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "revoir-config-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function testConfiguration(
  paths: Pick<ApplicationPaths, "cacheDir" | "stateDir" | "dataDir">,
): RevoirConfiguration {
  return createConfiguration({
    service: { executablePath: "/Users/test/.local/share/mise/shims:/usr/bin:/bin" },
    github: {
      appId: 7,
      appSlug: "revoir-test",
      privateKey: TEST_PRIVATE_KEY,
      webhookSecret: "webhook-secret",
    },
    cloudflare: {
      accountId: "account",
      queueId: "queue-id",
      queueName: "revoir-reviews",
      kvNamespaceId: "kv-id",
      workerName: "revoir-relay",
      apiToken: "queue-token",
      relayUrl: "https://revoir-relay.example.workers.dev/github/webhook",
    },
    paths: {
      cacheDir: paths.cacheDir,
      stateDir: paths.stateDir,
      dataDir: paths.dataDir,
    },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("XDG paths", () => {
  it("resolves separate config, policy, checkpoint, and lock files", () => {
    assert.deepEqual(resolveApplicationPaths({}, "/Users/test"), {
      configDir: "/Users/test/.config/revoir",
      configFile: "/Users/test/.config/revoir/config.json",
      policyFile: "/Users/test/.config/revoir/policy.json",
      setupCheckpointFile: "/Users/test/.config/revoir/setup-checkpoint.json",
      commandLockFile: "/Users/test/.config/revoir/command.lock",
      cacheDir: "/Users/test/.cache/revoir",
      stateDir: "/Users/test/.local/state/revoir",
      dataDir: "/Users/test/.local/share/revoir",
    });
  });

  it("honors XDG overrides and rejects relative roots", () => {
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
        policyFile: "/xdg/config/revoir/policy.json",
        setupCheckpointFile: "/xdg/config/revoir/setup-checkpoint.json",
        commandLockFile: "/xdg/config/revoir/command.lock",
        cacheDir: "/xdg/cache/revoir",
        stateDir: "/xdg/state/revoir",
        dataDir: "/xdg/data/revoir",
      },
    );
    assert.throws(
      () => resolveApplicationPaths({ XDG_CONFIG_HOME: "relative/config" }, "/Users/test"),
      /XDG_CONFIG_HOME must be an absolute path/u,
    );
  });
});

describe("greenfield configuration", () => {
  it("applies model and timeout defaults", () => {
    const configuration = testConfiguration({
      cacheDir: "/cache",
      stateDir: "/state",
      dataDir: "/data",
    });
    assert.equal(configuration.version, 1);
    assert.equal(configuration.model.id, DEFAULT_MODEL);
    assert.equal(configuration.model.reasoning, DEFAULT_REASONING);
    assert.deepEqual(configuration.timeouts, { reviewMs: 1_200_000, shellCommandMs: 120_000 });
  });

  it("rejects the old combined configuration instead of migrating it", () => {
    const configuration = testConfiguration({
      cacheDir: "/cache",
      stateDir: "/state",
      dataDir: "/data",
    });
    assert.throws(
      () =>
        validateConfiguration({
          ...configuration,
          version: 2,
          github: {
            ...configuration.github,
            userId: 42,
            installations: [{ id: 8, repositories: [] }],
          },
        }),
      (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.match(error.message, /version must be 1/u);
        assert.match(error.message, /github\.userId is not supported/u);
        assert.match(error.message, /github\.installations is not supported/u);
        return true;
      },
    );
  });

  it("rejects unknown fields, malformed relay URLs, and relative runtime paths", () => {
    const configuration = testConfiguration({
      cacheDir: "/cache",
      stateDir: "/state",
      dataDir: "/data",
    });
    assert.throws(
      () =>
        validateConfiguration({
          ...configuration,
          unexpected: true,
          cloudflare: {
            ...configuration.cloudflare,
            relayUrl: "http://user:pass@example.test/?secret=x",
          },
          service: { executablePath: "relative/bin:/usr/bin" },
          paths: { ...configuration.paths, cacheDir: "cache" },
        }),
      /configuration\.unexpected is not supported[\s\S]+service\.executablePath must contain only absolute directories[\s\S]+credential-free HTTPS URL[\s\S]+paths\.cacheDir must be an absolute path/u,
    );
  });
});

describe("protected configuration file", () => {
  it("writes atomically with private directories and file modes", async () => {
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
    const configuration = testConfiguration(paths);

    await writeConfiguration(paths.configFile, configuration);

    assert.equal((await lstat(paths.configDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.configFile)).mode & 0o777, 0o600);
    assert.equal((await lstat(paths.cacheDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.stateDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.dataDir)).mode & 0o777, 0o700);
    assert.deepEqual(await loadConfiguration(paths.configFile), configuration);
    assert.deepEqual((await readdir(paths.configDir)).toSorted(), ["config.json"]);
  });

  it("rejects unsafe modes, symlinks, and non-normalized paths", async () => {
    const root = await temporaryDirectory();
    const paths = resolveApplicationPaths({ XDG_CONFIG_HOME: join(root, "config") }, root);
    const configuration = testConfiguration(paths);
    await writeConfiguration(paths.configFile, configuration);

    await chmod(paths.configFile, 0o644);
    await assert.rejects(loadConfiguration(paths.configFile), (error) => {
      assert.ok(error instanceof ConfigurationFileError);
      assert.match(error.message, /chmod 600/u);
      return true;
    });

    await chmod(paths.configFile, 0o600);
    await unlink(paths.configFile);
    const target = join(root, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, paths.configFile);
    await assert.rejects(loadConfiguration(paths.configFile), /symbolic link/u);

    await assert.rejects(
      writeConfiguration(`${paths.configDir}/nested/../config.json`, configuration),
      /absolute normalized path/u,
    );
  });

  it("does not relax permissions on an existing directory", async () => {
    const root = await temporaryDirectory();
    const configDir = join(root, "config");
    await mkdir(configDir, { mode: 0o755 });
    await chmod(configDir, 0o755);
    const configuration = testConfiguration({
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      dataDir: join(root, "data"),
    });
    await assert.rejects(
      writeConfiguration(join(configDir, "config.json"), configuration),
      /unsafe mode 0755/u,
    );
    assert.deepEqual(await readdir(configDir), []);
  });
});
