import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LaunchctlProcessAdapter,
  type ProcessResult,
  type ProcessRunner,
} from "../src/service/launchctl.js";

describe("launchctl process adapter", () => {
  it("maps launchctl output and failures to deterministic service operations", async () => {
    const calls: string[][] = [];
    const results: ProcessResult[] = [
      {
        exitCode: 0,
        stdout: `gui/501/io.github.sadiksaifi.revoir = {
\tstate = running
\tpid = 456
\tlast exit code = 0
}
`,
        stderr: "",
      },
      {
        exitCode: 113,
        stdout: "",
        stderr: "Could not find service in domain for system\n",
      },
      {
        exitCode: 5,
        stdout: "",
        stderr: "Bootstrap failed: 5: Input/output error\n",
      },
    ];
    const runner: ProcessRunner = {
      async run(executable, arguments_) {
        calls.push([executable, ...arguments_]);
        const result = results.shift();
        assert.ok(result);
        return result;
      },
    };
    const adapter = new LaunchctlProcessAdapter(runner);

    assert.deepEqual(await adapter.inspect("gui/501/io.github.sadiksaifi.revoir"), {
      state: "running",
      pid: 456,
      lastExitCode: 0,
    });
    assert.equal(await adapter.inspect("gui/501/io.github.sadiksaifi.revoir"), undefined);
    await assert.rejects(
      adapter.bootstrap(
        "gui/501",
        "/Users/test/Library/LaunchAgents/io.github.sadiksaifi.revoir.plist",
      ),
      /launchctl bootstrap failed.*unloadable plist.*Input\/output error/iu,
    );
    assert.deepEqual(calls, [
      ["/bin/launchctl", "print", "gui/501/io.github.sadiksaifi.revoir"],
      ["/bin/launchctl", "print", "gui/501/io.github.sadiksaifi.revoir"],
      [
        "/bin/launchctl",
        "bootstrap",
        "gui/501",
        "/Users/test/Library/LaunchAgents/io.github.sadiksaifi.revoir.plist",
      ],
    ]);
  });
});
