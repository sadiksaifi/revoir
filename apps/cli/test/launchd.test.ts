import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  type LaunchAgentDefinition,
  createLaunchAgentDefinition,
  renderLaunchAgentPlist,
} from "../src/service/launchd.js";

const execFileAsync = promisify(execFile);

async function waitForAttemptCount(
  path: string,
  expected: number,
  deadline: number,
): Promise<void> {
  const attempts = await readFile(path, "utf8").catch(() => "");
  if (attempts.trimEnd().split("\n").filter(Boolean).length >= expected) {
    return;
  }
  if (Date.now() >= deadline) {
    assert.fail(`launchd did not run the daemon ${expected} times`);
  }
  await delay(100);
  await waitForAttemptCount(path, expected, deadline);
}

describe("launchd service definition", () => {
  it("renders one deterministic per-user LaunchAgent with escaped XDG paths and bounded restarts", () => {
    const definition = createLaunchAgentDefinition({
      executableArguments: ["/Users/test & tools/.local/bin/revoir"],
      configFile: "/Users/test & tools/.config/revoir/config.json",
      homeDir: "/Users/test & tools",
      executablePath: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      xdgConfigHome: "/Users/test & tools/.config",
      paths: {
        configDir: "/Users/test & tools/.config/revoir",
        configFile: "/Users/test & tools/.config/revoir/config.json",
        policyFile: "/Users/test & tools/.config/revoir/policy.json",
        setupCheckpointFile: "/Users/test & tools/.config/revoir/setup-checkpoint.json",
        commandLockFile: "/Users/test & tools/.config/revoir/command.lock",
        cacheDir: "/Users/test & tools/.cache/revoir",
        stateDir: "/Users/test & tools/.local/state/revoir",
        dataDir: "/Users/test & tools/.local/share/revoir",
      },
    });

    const plist = renderLaunchAgentPlist(definition);

    assert.equal(plist, renderLaunchAgentPlist(definition));
    assert.deepEqual(definition.programArguments, [
      "/Users/test & tools/.local/bin/revoir",
      "run",
      "--config",
      "/Users/test & tools/.config/revoir/config.json",
    ]);
    assert.deepEqual(definition.environment, {
      HOME: "/Users/test & tools",
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      XDG_CACHE_HOME: "/Users/test & tools/.cache",
      XDG_CONFIG_HOME: "/Users/test & tools/.config",
      XDG_DATA_HOME: "/Users/test & tools/.local/share",
      XDG_STATE_HOME: "/Users/test & tools/.local/state",
    });
    assert.match(plist, /<string>\/Users\/test &amp; tools\/\.local\/bin\/revoir<\/string>/u);
    assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/u);
    assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/u);
    assert.match(
      plist,
      /<key>StandardOutPath<\/key>\s*<string>\/Users\/test &amp; tools\/\.local\/state\/revoir\/logs\/launchd\.stdout\.log<\/string>/u,
    );
    assert.match(
      plist,
      /<key>StandardErrorPath<\/key>\s*<string>\/Users\/test &amp; tools\/\.local\/state\/revoir\/logs\/launchd\.stderr\.log<\/string>/u,
    );
  });

  it("does not synthesize XDG_CONFIG_HOME from Revoir's default config path", () => {
    const definition = createLaunchAgentDefinition({
      executableArguments: ["/Users/test/.local/bin/revoir"],
      configFile: "/Users/test/.config/revoir/config.json",
      homeDir: "/Users/test",
      paths: {
        configDir: "/Users/test/.config/revoir",
        configFile: "/Users/test/.config/revoir/config.json",
        policyFile: "/Users/test/.config/revoir/policy.json",
        setupCheckpointFile: "/Users/test/.config/revoir/setup-checkpoint.json",
        commandLockFile: "/Users/test/.config/revoir/command.lock",
        cacheDir: "/Users/test/.cache/revoir",
        stateDir: "/Users/test/.local/state/revoir",
        dataDir: "/Users/test/.local/share/revoir",
      },
    });

    assert.equal(definition.environment["XDG_CONFIG_HOME"], undefined);
    assert.deepEqual(definition.programArguments.slice(-3), [
      "run",
      "--config",
      "/Users/test/.config/revoir/config.json",
    ]);
    assert.equal(definition.environment["XDG_STATE_HOME"], "/Users/test/.local/state");
  });

  it(
    "restarts a daemon that exits with status 1",
    {
      skip:
        process.platform !== "darwin" || process.env["REVOIR_LAUNCHD_SMOKE"] !== "1"
          ? "set REVOIR_LAUNCHD_SMOKE=1 on macOS to run the real launchd smoke test"
          : false,
      timeout: 10_000,
    },
    async (context) => {
      const uid = process.getuid?.();
      assert.notEqual(uid, undefined);

      const directory = await mkdtemp(join(tmpdir(), "revoir-launchd-smoke-"));
      const label = `io.github.sadiksaifi.revoir.smoke.${process.pid}`;
      const target = `gui/${uid}/${label}`;
      const plistFile = join(directory, `${label}.plist`);
      const attemptsFile = join(directory, "attempts.log");

      context.after(async () => {
        await execFileAsync("/bin/launchctl", ["bootout", target]).catch(() => undefined);
        await rm(directory, { force: true, recursive: true });
      });

      const definition: LaunchAgentDefinition = {
        label,
        programArguments: [
          "/bin/sh",
          "-c",
          'printf "attempt\\n" >> "$1"; exit 1',
          "revoir-launchd-smoke",
          attemptsFile,
        ],
        environment: {},
        standardOutputPath: join(directory, "stdout.log"),
        standardErrorPath: join(directory, "stderr.log"),
        throttleIntervalSeconds: 1,
        exitTimeoutSeconds: 5,
      };
      await writeFile(plistFile, renderLaunchAgentPlist(definition), { mode: 0o600 });
      await execFileAsync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistFile]);
      await waitForAttemptCount(attemptsFile, 2, Date.now() + 5_000);
    },
  );
});
