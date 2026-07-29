import { homedir } from "node:os";
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
import {
  JsonLineServiceLogger,
  readServiceLogs,
  serviceLogPaths,
  type ServiceLogger,
} from "./service/logging.js";
import {
  createDefaultServiceManager,
  type ServiceManager,
  type ServiceStatus,
} from "./service/manager.js";
import { collectSetupConfiguration, parseSetupOptions, type PromptFunction } from "./setup.js";

export const CLI_VERSION = "0.0.0";

const HELP = `Revoir ${CLI_VERSION}

Usage:
  revoir setup [options]
  revoir diagnose [--config <path>] [--json] [--verbose]
  revoir review <GitHub PR URL> [--config <path>] [--verbose]
  revoir run [--config <path>] [--verbose]
  revoir install [--config <path>] [--verbose]
  revoir start [--config <path>] [--verbose]
  revoir stop [--verbose]
  revoir status [--config <path>] [--verbose]
  revoir logs [--verbose]
  revoir uninstall [--verbose]
  revoir --help
  revoir --version

Commands:
  setup       Create the protected local configuration and validate all installations.
  diagnose    Non-interactively validate the configured installations.
  review      Review one eligible pull request and publish validated findings or a clean result.
  run         Pull and settle eligible webhook review jobs one at a time.
  install     Generate, load, and start the per-user macOS LaunchAgent.
  start       Start the installed LaunchAgent without creating a duplicate worker.
  stop        Gracefully stop and unload the LaunchAgent.
  status      Inspect installation, launchd, process, and configuration health.
  logs        Print structured redacted service logs from XDG state.
  uninstall   Stop the service and remove only its generated plist.

Setup options:
  --non-interactive
  --model <openai-codex/model>
  --reasoning <minimal|low|medium|high|xhigh>
  --github-user-id <id>
  --github-app-id <id>
  --github-installation-id <id>      Repeat for each GitHub App installation.
  --github-private-key-file <path>
  --repository <installation-id:id:owner/name>
                                      Repeat for each allowed repository.
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
  serviceManager?: ServiceManager;
  serviceLogger?: ServiceLogger;
  shutdownSignal?: AbortSignal;
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
      arguments_[0] === "run" ||
      arguments_[0] === "install" ||
      arguments_[0] === "start" ||
      arguments_[0] === "stop" ||
      arguments_[0] === "status" ||
      arguments_[0] === "logs" ||
      arguments_[0] === "uninstall") &&
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

  if (command === "logs") {
    if (common.json) {
      write(io.stderr, "Error: --json is not supported by the logs command.\n");
      return 2;
    }
    if (common.arguments.length > 0) {
      write(io.stderr, "Error: logs does not accept positional arguments.\n");
      return 2;
    }
    let stateDir = paths.stateDir;
    try {
      stateDir = (await loadConfiguration(configFile)).paths.stateDir;
    } catch {
      // Logs remain available for diagnosing a missing or unsafe configuration.
    }
    try {
      write(io.stdout, await readServiceLogs(stateDir));
      return 0;
    } catch (error) {
      write(io.stderr, `Error: ${new SecretRedactor().error(error, common.verbose)}\n`);
      return 1;
    }
  }

  if (["install", "start", "stop", "status", "uninstall"].includes(command ?? "")) {
    if (common.json) {
      write(io.stderr, `Error: --json is not supported by the ${String(command)} command.\n`);
      return 2;
    }
    if (common.arguments.length > 0) {
      write(io.stderr, `Error: ${String(command)} does not accept positional arguments.\n`);
      return 2;
    }

    let configuration;
    let configurationError: unknown;
    if (command === "install" || command === "start" || command === "status") {
      try {
        configuration = await loadConfiguration(configFile);
      } catch (error) {
        configurationError = error;
      }
      if (command !== "status" && configuration === undefined) {
        write(
          io.stderr,
          `Error: ${new SecretRedactor().error(configurationError, common.verbose)}\n`,
        );
        return 2;
      }
    }
    const redactor = new SecretRedactor(configuration);
    const managerPaths =
      configuration === undefined
        ? paths
        : {
            configDir: paths.configDir,
            configFile,
            cacheDir: configuration.paths.cacheDir,
            stateDir: configuration.paths.stateDir,
            dataDir: configuration.paths.dataDir,
          };
    let serviceManager: ServiceManager;
    try {
      serviceManager =
        dependencies.serviceManager ??
        createDefaultServiceManager({
          configFile,
          homeDir: io.userHome ?? homedir(),
          paths: managerPaths,
        });
    } catch (error) {
      write(io.stderr, `Error: ${redactor.error(error, common.verbose)}\n`);
      return 2;
    }

    try {
      if (command === "install") {
        await serviceManager.install();
        write(io.stdout, "Service installed and started.\n");
        return 0;
      }
      if (command === "start") {
        await serviceManager.start();
        write(io.stdout, "Service started.\n");
        return 0;
      }
      if (command === "stop") {
        await serviceManager.stop();
        write(io.stdout, "Service stopped; configuration and XDG data were preserved.\n");
        return 0;
      }
      if (command === "uninstall") {
        await serviceManager.uninstall();
        write(io.stdout, "Service uninstalled; configuration and XDG data were preserved.\n");
        return 0;
      }

      const status: ServiceStatus = await serviceManager.status();
      if (configuration === undefined && status.state !== "uninstalled") {
        write(
          io.stdout,
          `Service failed: ${new SecretRedactor().error(configurationError, common.verbose)}\n`,
        );
        return 1;
      }
      write(io.stdout, `Service ${status.state}: ${status.detail}\n`);
      return status.state === "healthy" || status.state === "starting" ? 0 : 1;
    } catch (error) {
      write(io.stderr, `Error: ${redactor.error(error, common.verbose)}\n`);
      return 1;
    }
  }

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
    let logger: ServiceLogger;
    try {
      logger =
        dependencies.serviceLogger ??
        (await JsonLineServiceLogger.open(
          serviceLogPaths(configuration.paths.stateDir).structured,
          redactor,
        ));
    } catch (error) {
      write(io.stderr, `Error: ${redactor.error(error, common.verbose)}\n`);
      return 1;
    }

    let exitCode = 0;
    try {
      await logger.write("daemon_started", {
        pid: process.pid,
        model: configuration.model.id,
        reasoning: configuration.model.reasoning,
      });
      await (dependencies.runService ?? createDefaultQueueRunService(configuration, logger)).run(
        dependencies.shutdownSignal,
      );
      await logger.write("daemon_stopped", {
        pid: process.pid,
        reason: dependencies.shutdownSignal?.aborted === true ? "shutdown" : "completed",
      });
    } catch (error) {
      if (dependencies.shutdownSignal?.aborted === true) {
        try {
          await logger.write("daemon_stopped", {
            pid: process.pid,
            reason: "shutdown",
          });
        } catch (logError) {
          write(io.stderr, `Error: ${redactor.error(logError, common.verbose)}\n`);
          exitCode = 1;
        }
      } else {
        await logger.write("daemon_failed", { pid: process.pid, error }).catch(() => {});
        write(io.stderr, `Error: ${redactor.error(error, common.verbose)}\n`);
        exitCode = 1;
      }
    }
    try {
      await logger.flush();
      await logger.close();
    } catch (error) {
      write(io.stderr, `Error: ${redactor.error(error, common.verbose)}\n`);
      exitCode = 1;
    }
    return exitCode;
  }

  write(io.stderr, `Error: Unknown command "${String(command)}".\n\n${HELP}`);
  return 2;
}
