#!/usr/bin/env node

import { runCli } from "./cli.js";

const rawCliArguments = process.argv.slice(2);
const cliArguments = rawCliArguments[0] === "--" ? rawCliArguments.slice(1) : rawCliArguments;
const isDaemonMode = cliArguments[0] === "run";
const shutdownController = new AbortController();
const requestShutdown = (signal: NodeJS.Signals): void => {
  shutdownController.abort(new Error(`${signal} requested graceful shutdown.`));
};
const onSigint = (): void => requestShutdown("SIGINT");
const onSigterm = (): void => requestShutdown("SIGTERM");
if (isDaemonMode) {
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
}
try {
  process.exitCode = await runCli(cliArguments, {
    shutdownSignal: shutdownController.signal,
  });
} finally {
  if (isDaemonMode) {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
