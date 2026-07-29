import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { assertNoEnhancedSeaTemporaryEntrypoint } from "../scripts/release-validation.mjs";
import {
  createReleaseMetadata,
  installStandaloneExecutable,
  MACOS_RELEASE,
} from "../src/release.js";

describe("standalone macOS release", () => {
  it("rejects an Enhanced SEA entrypoint from a random packager temporary directory", () => {
    assert.throws(
      () =>
        assertNoEnhancedSeaTemporaryEntrypoint(
          Buffer.from(
            "\0/var/folders/t9/build/T/pkg-sea-SWm37x/sea-main.js\0relative:sea-main.js\0",
          ),
        ),
      /random Enhanced SEA temporary entrypoint/u,
    );
    assert.doesNotThrow(() =>
      assertNoEnhancedSeaTemporaryEntrypoint(Buffer.from("\0sea-main.js\0")),
    );
  });

  it("records the frozen runtime, packager, architecture, lockfile, and unsigned checksum", () => {
    assert.deepEqual(
      createReleaseMetadata({
        architecture: "arm64",
        commit: "a".repeat(40),
        lockfileSha256: "b".repeat(64),
        unsignedSha256: "c".repeat(64),
      }),
      {
        schemaVersion: 1,
        artifact: {
          fileName: "revoir",
          platform: "darwin",
          architecture: "arm64",
          unsignedSha256: "c".repeat(64),
        },
        build: {
          commit: "a".repeat(40),
          nodeVersion: "24.16.0",
          pnpmVersion: "10.33.2",
          lockfileSha256: "b".repeat(64),
          target: "node24.16.0-macos-arm64",
          packager: {
            name: "@yao-pkg/pkg",
            version: "6.21.0",
            mode: "enhanced-sea",
          },
          useCodeCache: false,
          useSnapshot: false,
        },
        signature: {
          kind: "ad-hoc",
          strictVerification: true,
        },
      },
    );
    assert.equal(MACOS_RELEASE.fallbackPackager.name, "@cdxgen/caxa");
    assert.equal(MACOS_RELEASE.fallbackPackager.version, "3.1.0");
  });

  it("installs an executable copy at the fixed user-local path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "revoir-release-test-"));
    try {
      const source = join(directory, "artifact", "revoir");
      await mkdir(join(directory, "artifact"));
      await writeFile(source, "#!/bin/sh\nprintf 'standalone\\n'\n", { mode: 0o755 });

      const installed = await installStandaloneExecutable(source, directory);

      assert.equal(installed, join(directory, ".local", "bin", "revoir"));
      assert.equal(await readFile(installed, "utf8"), "#!/bin/sh\nprintf 'standalone\\n'\n");
      assert.equal((await lstat(installed)).mode & 0o777, 0o755);
      await chmod(source, 0o700);
      assert.equal((await lstat(installed)).mode & 0o777, 0o755);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
