import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runPackageSmoke } from "../src/package-smoke.js";
import type { PiSession, PiSessionFactory, PiSessionOptions } from "../src/review/pi.js";

describe("packaged runtime smoke", () => {
  it("uses external XDG and Pi state with one real-session boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "revoir-package-smoke-test-"));
    try {
      const options: PiSessionOptions[] = [];
      let disposed = 0;
      const sessions: PiSessionFactory = {
        async create(input): Promise<PiSession> {
          options.push(input);
          return {
            abort() {},
            async run() {
              return '{"version":1,"findings":[]}';
            },
            dispose() {
              disposed += 1;
            },
          };
        },
      };
      let oauthProbes = 0;
      let imageProbes = 0;
      let nativeRuntimeProbes = 0;
      let hostBoundaryProbes = 0;
      const output: string[] = [];

      await runPackageSmoke(
        {
          cwd: directory,
          environment: {
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, "xdg", "config"),
            XDG_CACHE_HOME: join(directory, "xdg", "cache"),
            XDG_STATE_HOME: join(directory, "xdg", "state"),
            XDG_DATA_HOME: join(directory, "xdg", "data"),
            PI_CODING_AGENT_DIR: join(directory, "pi"),
            REVOIR_PACKAGE_SMOKE_MODEL: "revoir-smoke/revoir-smoke",
          },
          write(value) {
            output.push(value);
          },
        },
        {
          sessions,
          async probeOAuth() {
            oauthProbes += 1;
          },
          async probeImageRuntime() {
            imageProbes += 1;
          },
          async probeNativeRuntime() {
            nativeRuntimeProbes += 1;
            return ["/snapshot/native.node"];
          },
          async probeHostBoundaries() {
            hostBoundaryProbes += 1;
          },
        },
      );

      assert.equal(options.length, 1);
      assert.equal(options[0]?.cwd, directory);
      assert.equal(options[0]?.model, "revoir-smoke/revoir-smoke");
      assert.match(options[0]?.systemPrompt ?? "", /packaged Revoir runtime probe/u);
      assert.equal(disposed, 1);
      assert.equal(oauthProbes, 1);
      assert.equal(imageProbes, 1);
      assert.equal(nativeRuntimeProbes, 1);
      assert.equal(hostBoundaryProbes, 1);
      assert.equal(output.length, 1);
      const summary = JSON.parse(output[0] ?? "") as Record<string, unknown>;
      assert.deepEqual(summary, {
        configDir: join(directory, "xdg", "config", "revoir"),
        model: "revoir-smoke/revoir-smoke",
        nativeAssets: ["/snapshot/native.node"],
        piAgentDir: join(directory, "pi"),
        result: "ok",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
