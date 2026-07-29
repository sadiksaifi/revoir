import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const cliDirectory = fileURLToPath(new URL("..", import.meta.url));

function waitForOutput(stream: Readable, pattern: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`CLI did not prompt before timeout: ${output}`));
    }, 5_000);
    function cleanup(): void {
      clearTimeout(timeout);
      stream.removeListener("data", onData);
    }
    function onData(chunk: Buffer | string): void {
      output += chunk.toString();
      if (pattern.test(output)) {
        cleanup();
        resolve();
      }
    }
    stream.on("data", onData);
  });
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe("CLI process signals", () => {
  it("lets SIGTERM terminate an interactive non-daemon command immediately", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "setup"], {
      cwd: cliDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.ok(child.stdout);

    try {
      await waitForOutput(child.stdout, /Codex model/u);
      const exit = waitForExit(child, 1_000);
      assert.equal(child.kill("SIGTERM"), true);

      assert.deepEqual(await exit, { code: null, signal: "SIGTERM" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
});
