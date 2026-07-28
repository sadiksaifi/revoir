import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  LaunchdServiceManager,
  resolveServiceExecutableArguments,
  type LaunchctlGateway,
  type LaunchctlInspection,
} from "../src/service/manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<{
  configFile: string;
  executable: string;
  homeDir: string;
  manager: LaunchdServiceManager;
  operations: string[];
  setInspection(value: LaunchctlInspection | undefined): void;
  unrelatedFile: string;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "revoir-service-test-"));
  temporaryDirectories.push(homeDir);
  const executable = join(homeDir, ".local", "bin", "revoir");
  const configFile = join(homeDir, ".config", "revoir", "config.json");
  const unrelatedFile = join(homeDir, ".local", "state", "revoir", "keep-me");
  await Promise.all([
    mkdir(join(homeDir, ".local", "bin"), { recursive: true }),
    mkdir(join(homeDir, ".config", "revoir"), { recursive: true }),
    mkdir(join(homeDir, ".local", "state", "revoir"), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(executable, "#!/bin/sh\n", { mode: 0o700 }),
    writeFile(configFile, '{"preserve":true}\n', { mode: 0o600 }),
    writeFile(unrelatedFile, "unrelated\n", { mode: 0o600 }),
  ]);
  await chmod(executable, 0o700);

  const operations: string[] = [];
  let inspection: LaunchctlInspection | undefined;
  const launchctl: LaunchctlGateway = {
    async inspect() {
      operations.push("inspect");
      return inspection;
    },
    async bootstrap(_domain, plistFile) {
      operations.push(`bootstrap:${plistFile}`);
      inspection = { state: "running", pid: 123, lastExitCode: undefined };
    },
    async bootout() {
      operations.push("bootout");
      inspection = undefined;
    },
    async kickstart() {
      operations.push("kickstart");
      inspection = { state: "running", pid: 124, lastExitCode: undefined };
    },
  };
  const manager = new LaunchdServiceManager(
    {
      configFile,
      executableArguments: [executable],
      homeDir,
      paths: {
        configDir: join(homeDir, ".config", "revoir"),
        configFile,
        cacheDir: join(homeDir, ".cache", "revoir"),
        stateDir: join(homeDir, ".local", "state", "revoir"),
        dataDir: join(homeDir, ".local", "share", "revoir"),
      },
      uid: 501,
    },
    launchctl,
  );
  return {
    configFile,
    executable,
    homeDir,
    manager,
    operations,
    setInspection(value) {
      inspection = value;
    },
    unrelatedFile,
  };
}

describe("launchd service manager", () => {
  it("runs a packaged service directly from its standalone executable", () => {
    assert.deepEqual(
      resolveServiceExecutableArguments({
        executable: "/Users/test/.local/bin/revoir",
        entryPoint: "/snapshot/revoir/apps/cli/dist/main.js",
        runtimeArguments: ["--enable-source-maps"],
        packaged: true,
      }),
      ["/Users/test/.local/bin/revoir"],
    );
    assert.deepEqual(
      resolveServiceExecutableArguments({
        executable: "/opt/homebrew/bin/node",
        entryPoint: "/workspace/apps/cli/dist/main.js",
        runtimeArguments: ["--enable-source-maps"],
        packaged: false,
      }),
      ["/opt/homebrew/bin/node", "--enable-source-maps", "/workspace/apps/cli/dist/main.js"],
    );
  });

  it("installs and upgrades one service definition, then uninstalls only the plist", async () => {
    const { configFile, manager, operations, unrelatedFile } = await createFixture();

    await manager.install();
    const firstPlist = await readFile(manager.plistFile, "utf8");
    await manager.install();
    const secondPlist = await readFile(manager.plistFile, "utf8");

    assert.equal(secondPlist, firstPlist);
    assert.deepEqual(operations, [
      "inspect",
      `bootstrap:${manager.plistFile}`,
      "inspect",
      "bootout",
      `bootstrap:${manager.plistFile}`,
    ]);
    assert.equal(await readFile(configFile, "utf8"), '{"preserve":true}\n');

    await manager.uninstall();
    await assert.rejects(readFile(manager.plistFile, "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(configFile, "utf8"), '{"preserve":true}\n');
    assert.equal(await readFile(unrelatedFile, "utf8"), "unrelated\n");
  });

  it("starts and stops idempotently while distinguishing every actionable service state", async () => {
    const { manager, operations, setInspection } = await createFixture();

    assert.deepEqual(await manager.status(), {
      state: "uninstalled",
      detail: `LaunchAgent is not installed at "${manager.plistFile}". Run "revoir install".`,
    });

    await manager.install();
    assert.deepEqual(await manager.status(), {
      state: "healthy",
      detail: "LaunchAgent is healthy with process 123.",
      pid: 123,
    });
    const operationsBeforeHealthyStart = operations.length;
    await manager.start();
    assert.equal(operations.length, operationsBeforeHealthyStart + 1);

    await manager.stop();
    await manager.stop();
    assert.deepEqual(await manager.status(), {
      state: "stopped",
      detail: 'LaunchAgent is installed but stopped. Run "revoir start".',
    });

    await manager.start();
    setInspection({ state: "waiting", pid: undefined, lastExitCode: undefined });
    assert.deepEqual(await manager.status(), {
      state: "starting",
      detail: "LaunchAgent is loaded and waiting for launchd to start it.",
    });
    const operationsBeforeStartingStart = operations.length;
    await manager.start();
    assert.equal(operations.length, operationsBeforeStartingStart + 1);

    setInspection({ state: "exited", pid: undefined, lastExitCode: 0 });
    assert.deepEqual(await manager.status(), {
      state: "stopped",
      detail: 'LaunchAgent is loaded but stopped. Run "revoir start".',
    });

    setInspection({ state: "exited", pid: undefined, lastExitCode: 78 });
    assert.deepEqual(await manager.status(), {
      state: "failed",
      detail:
        'LaunchAgent failed with exit code 78. Inspect "revoir logs", fix the reported configuration or executable problem, then run "revoir start".',
    });
    await manager.start();
    assert.equal(operations.at(-1), "kickstart");

    setInspection({ state: "running", pid: undefined, lastExitCode: undefined });
    assert.deepEqual(await manager.status(), {
      state: "failed",
      detail:
        'launchd reports the service as "running" without a process identifier. Run "revoir stop", then "revoir start"; reinstall if the problem persists.',
    });
  });

  it("refuses an unavailable executable before mutating launchd or the plist", async () => {
    const { executable, manager, operations } = await createFixture();
    await rm(executable);

    await assert.rejects(
      manager.install(),
      /executable .* is unavailable or not executable.*absolute executable path/iu,
    );
    assert.deepEqual(operations, []);
    await assert.rejects(readFile(manager.plistFile, "utf8"), { code: "ENOENT" });
  });

  it("reports an installed service as failed when its executable disappears", async () => {
    const { executable, manager } = await createFixture();
    await manager.install();
    await rm(executable);

    const status = await manager.status();
    assert.equal(status.state, "failed");
    assert.match(status.detail, /executable .* is unavailable or not executable/iu);
  });
});
