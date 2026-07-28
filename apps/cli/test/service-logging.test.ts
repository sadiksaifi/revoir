import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { SecretRedactor } from "../src/redaction.js";
import { JsonLineServiceLogger, readServiceLogs, serviceLogPaths } from "../src/service/logging.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("service logging", () => {
  it("writes private structured records, redacts secrets, flushes, and reads launchd diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "revoir-logging-test-"));
    temporaryDirectories.push(root);
    const stateDir = join(root, "state", "revoir");
    const paths = serviceLogPaths(stateDir);
    const logger = await JsonLineServiceLogger.open(
      paths.structured,
      new SecretRedactor({ apiToken: "private-queue-token" }),
      () => new Date("2026-07-29T08:00:00.000Z"),
    );

    await logger.write("daemon_failed", {
      error: new Error("Cloudflare rejected private-queue-token"),
      pullRequest: 17,
      repository: "owner/repository",
    });
    await logger.close();
    await writeFile(paths.launchdStderr, "launchd diagnostic\n", { flag: "a", mode: 0o600 });

    const record = JSON.parse((await readFile(paths.structured, "utf8")).trim()) as {
      timestamp: string;
      event: string;
      data: { error: { message: string } };
    };
    assert.equal(record.timestamp, "2026-07-29T08:00:00.000Z");
    assert.equal(record.event, "daemon_failed");
    assert.equal(record.data.error.message, "Cloudflare rejected [REDACTED]");
    assert.doesNotMatch(JSON.stringify(record), /private-queue-token/u);
    assert.equal((await lstat(join(stateDir, "logs"))).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.structured)).mode & 0o777, 0o600);

    const rendered = await readServiceLogs(stateDir);
    assert.match(rendered, /"event":"daemon_failed"/u);
    assert.match(rendered, /\[launchd stderr\]\nlaunchd diagnostic/u);
    assert.doesNotMatch(rendered, /private-queue-token/u);
  });
});
