import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const workspace = fileURLToPath(new URL("../../..", import.meta.url));

function excludeBuildArtifacts(source: string): boolean {
  return !["dist", "node_modules"].includes(basename(source));
}

describe("clean-checkout development entry point", () => {
  let checkout = "";

  before(async () => {
    checkout = await mkdtemp(join(tmpdir(), "revoir-dev-smoke-"));
    await Promise.all([
      cp(join(workspace, "package.json"), join(checkout, "package.json")),
      cp(join(workspace, "patches"), join(checkout, "patches"), { recursive: true }),
      cp(join(workspace, "pnpm-lock.yaml"), join(checkout, "pnpm-lock.yaml")),
      cp(join(workspace, "pnpm-workspace.yaml"), join(checkout, "pnpm-workspace.yaml")),
      mkdir(join(checkout, "apps"), { recursive: true }),
      mkdir(join(checkout, "packages"), { recursive: true }),
    ]);
    await Promise.all([
      cp(join(workspace, "apps/cli"), join(checkout, "apps/cli"), {
        recursive: true,
        filter: excludeBuildArtifacts,
      }),
      cp(join(workspace, "packages/contracts"), join(checkout, "packages/contracts"), {
        recursive: true,
        filter: excludeBuildArtifacts,
      }),
    ]);
    await execute("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: checkout,
    });
  });

  after(async () => {
    await rm(checkout, { recursive: true, force: true });
  });

  it("resolves workspace runtime dependencies before showing CLI help", async () => {
    const { stdout, stderr } = await execute("pnpm", ["dev", "--", "--help"], {
      cwd: checkout,
    });

    assert.match(stdout, /revoir review <GitHub PR URL>/u);
    assert.equal(stderr, "");
  });
});
