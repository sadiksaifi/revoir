import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import { resolveApplicationPaths, type PathEnvironment } from "./config/paths.js";
import { loadConfiguration, writeConfiguration } from "./config/store.js";
import {
  createDefaultDiagnosticGateway,
  diagnosticsPassed,
  type DiagnosticGateway,
  type DiagnosticResult,
  runDiagnostics,
} from "./diagnostics.js";
import { createDefaultQueueRunService, type QueueRunService } from "./queue/runner.js";
import { SecretRedactor } from "./redaction.js";
import { FindingContractError } from "./review/findings.js";
import {
  createDefaultManualReviewService,
  type ManualReviewService,
} from "./review/orchestrator.js";
import {
  parsePullRequestUrl,
  PullRequestEligibilityError,
  PullRequestUrlError,
} from "./review/pull-request.js";
import { collectSetupConfiguration, parseSetupOptions, type PromptFunction } from "./setup.js";

export const CLI_VERSION = "0.0.0";

const HELP = `Revoir ${CLI_VERSION}

Usage:
  revoir setup [options]
  revoir diagnose [--config <path>] [--json] [--verbose]
  revoir review <GitHub PR URL> [--config <path>] [--verbose]
  revoir run [--config <path>] [--verbose]
  revoir --help
  revoir --version

Commands:
  setup       Create the protected local configuration and validate the installation.
  diagnose    Non-interactively validate an existing installation.
  review      Review one eligible pull request and publish validated findings or a clean result.
  run         Pull and settle eligible webhook review jobs one at a time.

Setup options:
  --non-interactive
  --model <openai-codex/model>
  --reasoning <minimal|low|medium|high|xhigh>
  --github-user-id <id>
  --github-app-id <id>
  --github-installation-id <id>
  --github-private-key-file <path>
  --repository <id:owner/name>       Repeat for each allowed repository.
  --cloudflare-account-id <id>
  --cloudflare-queue-id <id>
  --cloudflare-api-token-file <path>
  --review-timeout-ms <milliseconds>
  --shell-command-timeout-ms <milliseconds>

Common options:
  --config <path>  Override the configuration file path.
  --json           Emit diagnostics as JSON.
  --verbose        Include redacted stack traces for command failures.
`;

export interface CliIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  environment: PathEnvironment;
  userHome?: string;
  cwd: string;
}

export interface CliDependencies {
  io: CliIo;
  gateway?: DiagnosticGateway;
  reviewService?: ManualReviewService;
  runService?: QueueRunService;
  prompt?: PromptFunction;
}

interface CommonOptions {
  arguments: string[];
  configFile: string | undefined;
  json: boolean;
  verbose: boolean;
}

function write(stream: Writable, value: string): void {
  stream.write(value);
}

function parseCommonOptions(arguments_: readonly string[]): CommonOptions {
  const remaining: string[] = [];
  let configFile: string | undefined;
  let json = false;
  let verbose = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === "--json") {
      json = true;
      continue;
    }
    if (option === "--verbose") {
      verbose = true;
      continue;
    }
    if (option === "--config") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--config requires a path.");
      }
      configFile = value;
      index += 1;
      continue;
    }
    if (option !== undefined) {
      remaining.push(option);
    }
  }
  return { arguments: remaining, configFile, json, verbose };
}

function renderDiagnostics(
  results: readonly DiagnosticResult[],
  json: boolean,
  verbose: boolean,
  redactor: SecretRedactor,
): string {
  const renderedResults = results.map((result) => ({
    id: result.id,
    label: result.label,
    status: result.status,
    detail:
      verbose && result.error !== undefined
        ? redactor.error(result.error, true)
        : redactor.text(result.detail),
  }));
  if (json) {
    return `${JSON.stringify(
      redactor.value({ ok: diagnosticsPassed(results), checks: renderedResults }),
      undefined,
      2,
    )}\n`;
  }
  const checks = renderedResults
    .map((result) => {
      const indicator = result.status === "passed" ? "✓" : "✗";
      return `${indicator} ${result.label}: ${result.detail}`;
    })
    .join("\n");
  const passed = results.filter((result) => result.status === "passed").length;
  return `${checks}\n${diagnosticsPassed(results) ? "Diagnostics passed" : "Diagnostics failed"} (${passed}/${results.length}).\n`;
}

function createPrompt(io: CliIo): { prompt: PromptFunction; close(): void } {
  const readlineInterface = createInterface({
    input: io.stdin,
    output: io.stdout,
    terminal: Boolean((io.stdout as Writable & { isTTY?: boolean }).isTTY),
  });
  return {
    prompt: (message) => readlineInterface.question(message),
    close: () => readlineInterface.close(),
  };
}

function defaultIo(): CliIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    environment: process.env,
    cwd: process.cwd(),
  };
}

export async function runCli(
  arguments_: readonly string[],
  dependencies: Partial<CliDependencies> = {},
): Promise<number> {
  const io = dependencies.io ?? defaultIo();
  if (
    arguments_.length === 0 ||
    arguments_[0] === "--help" ||
    arguments_[0] === "-h" ||
    arguments_[0] === "help"
  ) {
    write(io.stdout, HELP);
    return 0;
  }
  if (arguments_[0] === "--version" || arguments_[0] === "-v") {
    write(io.stdout, `revoir ${CLI_VERSION}\n`);
    return 0;
  }
  if (
    (arguments_[0] === "setup" ||
      arguments_[0] === "diagnose" ||
      arguments_[0] === "review" ||
      arguments_[0] === "run") &&
    (arguments_[1] === "--help" || arguments_[1] === "-h")
  ) {
    write(io.stdout, HELP);
    return 0;
  }

  const command = arguments_[0];
  let common: CommonOptions;
  try {
    common = parseCommonOptions(arguments_.slice(1));
  } catch (error) {
    write(
      io.stderr,
      `Error: ${new SecretRedactor().error(error, arguments_.includes("--verbose"))}\n`,
    );
    return 2;
  }

  let paths;
  try {
    paths = resolveApplicationPaths(io.environment, io.userHome);
  } catch (error) {
    write(io.stderr, `Error: ${new SecretRedactor().error(error, common.verbose)}\n`);
    return 2;
  }
  const configFile =
    common.configFile === undefined ? paths.configFile : resolve(io.cwd, common.configFile);

  if (command === "setup") {
    let promptHandle: ReturnType<typeof createPrompt> | undefined;
    try {
      const setupOptions = parseSetupOptions(common.arguments);
      if (!setupOptions.nonInteractive && dependencies.prompt === undefined) {
        promptHandle = createPrompt(io);
      }
      const configuration = await collectSetupConfiguration(
        setupOptions,
        paths,
        dependencies.prompt ?? promptHandle?.prompt,
      );
      const redactor = new SecretRedactor(configuration);
      await writeConfiguration(configFile, configuration);
      write(io.stdout, `Configuration written to ${configFile}.\n`);
      const results = await runDiagnostics(
        configuration,
        dependencies.gateway ?? createDefaultDiagnosticGateway(),
      );
      write(io.stdout, renderDiagnostics(results, common.json, common.verbose, redactor));
      return diagnosticsPassed(results) ? 0 : 1;
    } catch (error) {
      write(io.stderr, `Error: ${new SecretRedactor().error(error, common.verbose)}\n`);
      return 2;
    } finally {
      promptHandle?.close();
    }
  }

  if (command === "diagnose") {
    if (common.arguments.length > 0) {
      write(io.stderr, `Error: Unknown diagnose option "${common.arguments[0]}".\n`);
      return 2;
    }
    let configuration;
    try {
      configuration = await loadConfiguration(configFile);
    } catch (error) {
      write(io.stderr, `Error: ${new SecretRedactor().error(error, common.verbose)}\n`);
      return 2;
    }
    const redactor = new SecretRedactor(configuration);
    try {
      const results = await runDiagnostics(
        configuration,
        dependencies.gateway ?? createDefaultDiagnosticGateway(),
      );
      write(io.stdout, renderDiagnostics(results, common.json, common.verbose, redactor));
      return diagnosticsPassed(results) ? 0 : 1;
    } catch (error) {
      write(io.stderr, `Error: ${redactor.error(error, common.verbose)}\n`);
      return 2;
    }
  }

  if (command === "review") {
    if (common.json) {
      write(io.stderr, "Error: --json is not supported by the review command.\n");
      return 2;
    }
    if (common.arguments.length !== 1 || common.arguments[0] === undefined) {
      write(io.stderr, "Error: review requires exactly one canonical GitHub pull-request URL.\n");
      return 2;
    }

    let reference;
    try {
      reference = parsePullRequestUrl(common.arguments[0]);
    } catch (error) {
      write(io.stderr, `Error: ${new SecretRedactor().error(error, common.verbose)}\n`);
      return 2;
    }

    let configuration;
    try {
      configuration = await loadConfiguration(configFile);
    } catch (error) {
      write(io.stderr, `Error: ${new SecretRedactor().error(error, common.verbose)}\n`);
      return 2;
    }
    const redactor = new SecretRedactor(configuration);
    try {
      const result = await (
        dependencies.reviewService ?? createDefaultManualReviewService(configuration)
      ).review(reference);
      if (result.status === "clean") {
        write(io.stdout, `Clean review completed for ${reference.url} at ${result.reviewedSha}.\n`);
      } else if (result.status === "findings") {
        write(
          io.stdout,
          `Published ${result.publishedFindings} finding${result.publishedFindings === 1 ? "" : "s"} for ${reference.url} at ${result.reviewedSha}.\n`,
        );
        if (result.rejectedFindings > 0) {
          const reasons = result.diagnostics
            .map(
              (diagnostic) =>
                `#${diagnostic.index < 0 ? "envelope" : diagnostic.index + 1}: ${diagnostic.message}`,
            )
            .join("; ");
          write(
            io.stderr,
            `Warning: rejected ${result.rejectedFindings} invalid or duplicate model finding${result.rejectedFindings === 1 ? "" : "s"} (${redactor.text(reasons)}).\n`,
          );
        }
      } else {
        write(
          io.stdout,
          `Review discarded because ${reference.url} moved from ${result.reviewedSha} to ${result.currentSha}.\n`,
        );
      }
      return 0;
    } catch (error) {
      write(io.stderr, `Error: ${redactor.error(error, common.verbose)}\n`);
      if (error instanceof FindingContractError && error.diagnostics.length > 0) {
        const reasons = error.diagnostics
          .map(
            (diagnostic) =>
              `- #${diagnostic.index < 0 ? "envelope" : diagnostic.index + 1}: ${diagnostic.message}`,
          )
          .join("\n");
        write(io.stderr, `Rejected model findings:\n${redactor.text(reasons)}\n`);
      }
      return error instanceof PullRequestEligibilityError || error instanceof PullRequestUrlError
        ? 2
        : 1;
    }
  }

  if (command === "run") {
    if (common.json) {
      write(io.stderr, "Error: --json is not supported by the run command.\n");
      return 2;
    }
    if (common.arguments.length > 0) {
      write(io.stderr, "Error: run does not accept positional arguments.\n");
      return 2;
    }

    let configuration;
    try {
      configuration = await loadConfiguration(configFile);
    } catch (error) {
      write(io.stderr, `Error: ${new SecretRedactor().error(error, common.verbose)}\n`);
      return 2;
    }
    const redactor = new SecretRedactor(configuration);
    try {
      await (dependencies.runService ?? createDefaultQueueRunService(configuration)).run();
      return 0;
    } catch (error) {
      write(io.stderr, `Error: ${redactor.error(error, common.verbose)}\n`);
      return 1;
    }
  }

  write(io.stderr, `Error: Unknown command "${String(command)}".\n\n${HELP}`);
  return 2;
}
