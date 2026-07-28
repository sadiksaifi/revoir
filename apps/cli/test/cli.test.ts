import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, it } from "node:test";

import { CLI_VERSION, runCli, type CliIo } from "../src/cli.js";
import { resolveApplicationPaths } from "../src/config/paths.js";
import { loadConfiguration } from "../src/config/store.js";
import type { DiagnosticGateway } from "../src/diagnostics.js";
import { passingGateway, TEST_PRIVATE_KEY } from "./helpers.js";

class CapturingWritable extends Writable {
  output = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output += chunk.toString();
    callback();
  }
}

const temporaryDirectories: string[] = [];

async function createIo(): Promise<{
  root: string;
  io: CliIo;
  stdout: CapturingWritable;
  stderr: CapturingWritable;
}> {
  const root = await mkdtemp(join(tmpdir(), "revoir-cli-test-"));
  temporaryDirectories.push(root);
  const stdout = new CapturingWritable();
  const stderr = new CapturingWritable();
  return {
    root,
    stdout,
    stderr,
    io: {
      stdin: Readable.from([]),
      stdout,
      stderr,
      environment: {
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_DATA_HOME: join(root, "data"),
      },
      userHome: root,
      cwd: root,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeCredentials(root: string): Promise<{
  privateKeyFile: string;
  tokenFile: string;
}> {
  const secrets = join(root, "secrets");
  await mkdir(secrets, { recursive: true });
  const privateKeyFile = join(secrets, "github.pem");
  const tokenFile = join(secrets, "cloudflare-token");
  await Promise.all([
    writeFile(privateKeyFile, TEST_PRIVATE_KEY),
    writeFile(tokenFile, "cli-cloudflare-secret"),
  ]);
  return { privateKeyFile, tokenFile };
}

function setupArguments(privateKeyFile: string, tokenFile: string): string[] {
  return [
    "setup",
    "--non-interactive",
    "--github-user-id",
    "42",
    "--github-app-id",
    "7",
    "--github-installation-id",
    "8",
    "--github-private-key-file",
    privateKeyFile,
    "--repository",
    "99:owner/repository",
    "--cloudflare-account-id",
    "account",
    "--cloudflare-queue-id",
    "queue",
    "--cloudflare-api-token-file",
    tokenFile,
  ];
}

describe("CLI", () => {
  it("provides help and version without reading configuration", async () => {
    const { io, stdout } = await createIo();
    io.environment = { XDG_CONFIG_HOME: "invalid-relative-path" };

    assert.equal(await runCli(["--help"], { io }), 0);
    assert.match(stdout.output, /revoir setup/u);

    stdout.output = "";
    assert.equal(await runCli(["--version"], { io }), 0);
    assert.equal(stdout.output, `revoir ${CLI_VERSION}\n`);

    stdout.output = "";
    assert.equal(await runCli(["setup", "--help"], { io }), 0);
    assert.match(stdout.output, /Setup options:/u);
  });

  it("runs non-interactive setup, persists protected config, and diagnoses it", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);

    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    assert.match(stdout.output, /Configuration written/u);
    assert.match(stdout.output, /Diagnostics passed \(6\/6\)/u);
    assert.doesNotMatch(stdout.output + stderr.output, /cli-cloudflare-secret/u);

    const paths = resolveApplicationPaths(io.environment, root);
    const configuration = await loadConfiguration(paths.configFile);
    assert.equal(configuration.github.userId, 42);

    stdout.output = "";
    assert.equal(
      await runCli(["diagnose", "--json"], {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    const report = JSON.parse(stdout.output) as {
      ok: boolean;
      checks: unknown[];
    };
    assert.equal(report.ok, true);
    assert.equal(report.checks.length, 6);
  });

  it("supports interactive setup through the same validation path", async () => {
    const { root, io } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    const answers = [
      "",
      "",
      "42",
      "7",
      "8",
      privateKeyFile,
      "99:owner/repository",
      "account",
      "queue",
      tokenFile,
      "",
      "",
    ];

    assert.equal(
      await runCli(["setup"], {
        io,
        gateway: passingGateway(),
        prompt: async () => answers.shift() ?? "",
      }),
      0,
    );
  });

  it("returns a failed diagnostic result while redacting normal and verbose output", async () => {
    const { root, io, stdout, stderr } = await createIo();
    const { privateKeyFile, tokenFile } = await writeCredentials(root);
    assert.equal(
      await runCli(setupArguments(privateKeyFile, tokenFile), {
        io,
        gateway: passingGateway(),
      }),
      0,
    );
    stdout.output = "";
    stderr.output = "";

    const failingGateway: DiagnosticGateway = {
      ...passingGateway(),
      async checkCloudflare(configuration) {
        throw new Error(`rejected ${configuration.apiToken}`);
      },
    };
    assert.equal(await runCli(["diagnose", "--verbose"], { io, gateway: failingGateway }), 1);
    assert.match(stdout.output, /Diagnostics failed/u);
    assert.match(stdout.output, /\[REDACTED\]/u);
    assert.doesNotMatch(stdout.output + stderr.output, /cli-cloudflare-secret/u);
  });

  it("returns actionable errors for invalid input and missing configuration", async () => {
    const { io, stderr } = await createIo();
    assert.equal(
      await runCli(["setup", "--non-interactive"], {
        io,
        gateway: passingGateway(),
      }),
      2,
    );
    assert.match(stderr.output, /Missing required setup option/u);

    stderr.output = "";
    assert.equal(await runCli(["diagnose"], { io, gateway: passingGateway() }), 2);
    assert.match(stderr.output, /Run "revoir setup" first/u);
  });
});
