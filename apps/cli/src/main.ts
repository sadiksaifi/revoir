#!/usr/bin/env node

import { runCli } from "./cli.js";

const cliArguments = process.argv.slice(2);
const shutdownController = new AbortController();
const requestShutdown = (signal: NodeJS.Signals): void => {
  shutdownController.abort(new Error(`${signal} requested graceful shutdown.`));
};
const onSigint = (): void => requestShutdown("SIGINT");
const onSigterm = (): void => requestShutdown("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);
try {
  process.exitCode = await runCli(cliArguments[0] === "--" ? cliArguments.slice(1) : cliArguments, {
    shutdownSignal: shutdownController.signal,
  });
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
