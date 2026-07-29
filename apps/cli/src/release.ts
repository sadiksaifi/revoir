import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const MACOS_RELEASE = {
  nodeVersion: "24.16.0",
  pnpmVersion: "10.33.2",
  packager: {
    name: "@yao-pkg/pkg",
    version: "6.21.0",
    mode: "enhanced-sea",
  },
  fallbackPackager: {
    name: "@cdxgen/caxa",
    version: "3.1.0",
  },
} as const;

export type MacArchitecture = "arm64" | "x64";

export interface ReleaseMetadataInput {
  architecture: MacArchitecture;
  commit: string;
  lockfileSha256: string;
  unsignedSha256: string;
}

function assertHex(value: string, length: number, label: string): void {
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value)) {
    throw new Error(`${label} must be a lowercase ${length}-character hexadecimal value.`);
  }
}

export function createReleaseMetadata(input: ReleaseMetadataInput) {
  assertHex(input.commit, 40, "Git commit");
  assertHex(input.lockfileSha256, 64, "Lockfile checksum");
  assertHex(input.unsignedSha256, 64, "Unsigned artifact checksum");
  return {
    schemaVersion: 1,
    artifact: {
      fileName: "revoir",
      platform: "darwin",
      architecture: input.architecture,
      unsignedSha256: input.unsignedSha256,
    },
    build: {
      commit: input.commit,
      nodeVersion: MACOS_RELEASE.nodeVersion,
      pnpmVersion: MACOS_RELEASE.pnpmVersion,
      lockfileSha256: input.lockfileSha256,
      target: `node${MACOS_RELEASE.nodeVersion}-macos-${input.architecture}`,
      packager: MACOS_RELEASE.packager,
      useCodeCache: false,
      useSnapshot: false,
    },
    signature: {
      kind: "ad-hoc",
      strictVerification: true,
    },
  } as const;
}

async function assertSafeExecutable(source: string): Promise<void> {
  const sourceStats = await lstat(source);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw new Error(`Standalone artifact "${source}" must be a regular file, not a symbolic link.`);
  }
  await access(source, constants.X_OK);
}

export async function installStandaloneExecutable(
  source: string,
  homeDir: string,
): Promise<string> {
  const resolvedSource = resolve(source);
  await assertSafeExecutable(resolvedSource);
  const target = join(resolve(homeDir), ".local", "bin", "revoir");
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace unsafe standalone install path "${target}".`);
    }
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
    ) {
      throw error;
    }
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(resolvedSource, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o755);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return target;
}
