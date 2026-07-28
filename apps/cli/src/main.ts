#!/usr/bin/env node

import { runCli } from "./cli.js";

const cliArguments = process.argv.slice(2);
process.exitCode = await runCli(cliArguments[0] === "--" ? cliArguments.slice(1) : cliArguments);
