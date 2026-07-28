import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { ReasoningLevel, RevoirConfiguration } from "../config/schema.js";
import {
  validateModelReviewOutput,
  type FindingDiagnostic,
  type ReviewFindingV1,
} from "./findings.js";
import type { PullRequestReference, PullRequestSnapshot } from "./pull-request.js";
import type { PreparedWorkspace } from "./workspace.js";

const REVIEW_SYSTEM_PROMPT = `You are Revoir's read-only pull-request reviewer.
Inspect the complete base-to-head change for correctness, regressions, security, and missing tests.
Use read, search, and host bash only for evidence. Do not modify files, install dependencies, run
package lifecycle scripts, or use repository-provided Pi extensions, skills, prompts, or settings.
Report only observed, actionable P0-P3 issues. Suppress style preferences and anything already
enforced by standard formatting or lint automation. Return exactly one JSON value with this shape:
{"version":1,"findings":[{"priority":"P0|P1|P2|P3","path":"repository/relative/path","range":{"start":1,"end":1,"side":"RIGHT|LEFT"},"defectKind":"correctness|validation|resource-lifecycle|concurrency|security|compatibility|error-handling|test-coverage","impactKind":"incorrect-result|operation-failure|data-loss|resource-leak|execution-stall|security-exposure|compatibility-break|regression-risk","fixAction":"guard|validate|preserve|propagate|synchronize|release|restore|add-test","anchor":"exact technical text copied from the selected changed lines or file change"}]}.
Use RIGHT only for added head lines and LEFT only for deleted base lines. Use range:null only for a
valid file-level issue with no exact changed-line anchor. Do not include a fingerprint; Revoir
derives it deterministically after validation. Choose only the listed semantic enum values. Copy
anchor exactly, including Unicode normalization and case; never paraphrase it. Revoir verifies the
anchor against the authoritative diff and renders all review prose locally. Do not include unknown
fields, prose, Markdown, praise, summaries, severity explanations, merge instructions, boilerplate,
or speculative concerns.`;

export interface ReviewEngineInput {
  reference: PullRequestReference;
  pullRequest: PullRequestSnapshot;
  workspace: PreparedWorkspace;
}

export interface ReviewEngine {
  review(input: ReviewEngineInput, signal: AbortSignal): Promise<ReviewEngineResult | void>;
}

export interface ReviewEngineResult {
  findings: readonly ReviewFindingV1[];
  diagnostics: readonly FindingDiagnostic[];
}

export interface PiSession {
  abort(): void | Promise<void>;
  run(prompt: string, signal: AbortSignal): Promise<string>;
  dispose(): void | Promise<void>;
}

export interface PiSessionOptions {
  cwd: string;
  model: string;
  reasoning: ReasoningLevel;
  systemPrompt: string;
}

export interface PiSessionFactory {
  create(options: PiSessionOptions, signal: AbortSignal): Promise<PiSession>;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Review was cancelled.");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

function emptyResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function assistantText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || !("role" in message)) {
    return undefined;
  }
  const value = message as { role: unknown; content?: unknown };
  if (value.role !== "assistant" || !Array.isArray(value.content)) {
    return undefined;
  }
  return value.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export class SdkPiSessionFactory implements PiSessionFactory {
  readonly #modelRuntime: Promise<ModelRuntime>;

  constructor(modelRuntime: Promise<ModelRuntime> = ModelRuntime.create()) {
    this.#modelRuntime = modelRuntime;
  }

  async create(options: PiSessionOptions, signal: AbortSignal): Promise<PiSession> {
    throwIfAborted(signal);
    const separator = options.model.indexOf("/");
    if (separator <= 0 || separator === options.model.length - 1) {
      throw new Error(`Configured model "${options.model}" is invalid.`);
    }
    const provider = options.model.slice(0, separator);
    const modelId = options.model.slice(separator + 1);
    const modelRuntime = await this.#modelRuntime;
    throwIfAborted(signal);
    const model = modelRuntime.getModel(provider, modelId);
    if (model === undefined) {
      throw new Error(`Configured Pi model "${options.model}" is unavailable.`);
    }

    const resourceLoader = emptyResourceLoader(options.systemPrompt);
    const { session } = await createAgentSession({
      cwd: options.cwd,
      model,
      thinkingLevel: options.reasoning,
      modelRuntime,
      resourceLoader,
      tools: ["read", "bash", "grep", "find", "ls"],
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        packages: [],
        extensions: [],
        skills: [],
        prompts: [],
      }),
    });
    if (signal.aborted) {
      try {
        await session.abort();
      } finally {
        await session.dispose();
      }
      throw abortReason(signal);
    }

    let abortPromise: Promise<void> | undefined;
    const abortSession = (): Promise<void> => {
      abortPromise ??= Promise.resolve().then(() => session.abort());
      return abortPromise;
    };

    return {
      abort: abortSession,
      async run(prompt, runSignal) {
        throwIfAborted(runSignal);
        let finalText: string | undefined;
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "message_end") {
            finalText = assistantText(event.message) ?? finalText;
          }
        });
        try {
          await session.prompt(prompt);
          throwIfAborted(runSignal);
          if (finalText === undefined) {
            throw new Error("Pi completed without a structured review result.");
          }
          return finalText;
        } finally {
          unsubscribe();
        }
      },
      async dispose() {
        await session.dispose();
      },
    };
  }
}

function reviewPrompt(input: ReviewEngineInput): string {
  return `Review ${input.reference.url}.
Base revision: ${input.pullRequest.baseSha}
Head revision: ${input.pullRequest.headSha}

The complete base-to-head diff follows:

${input.workspace.diff}`;
}

export class PiReviewEngine implements ReviewEngine {
  readonly #model: RevoirConfiguration["model"];
  readonly #sessionFactory: PiSessionFactory;

  constructor(
    model: RevoirConfiguration["model"],
    sessionFactory: PiSessionFactory = new SdkPiSessionFactory(),
  ) {
    this.#model = model;
    this.#sessionFactory = sessionFactory;
  }

  async review(input: ReviewEngineInput, signal: AbortSignal): Promise<ReviewEngineResult> {
    throwIfAborted(signal);
    const session = await this.#sessionFactory.create(
      {
        cwd: input.workspace.checkout,
        model: this.#model.id,
        reasoning: this.#model.reasoning,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
      },
      signal,
    );
    let abortPromise: Promise<void> | undefined;
    const abortSession = (): Promise<void> => {
      abortPromise ??= Promise.resolve().then(() => session.abort());
      return abortPromise;
    };
    const abort = (): void => {
      void abortSession().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) {
        await abortSession();
        throw abortReason(signal);
      }
      const result = await session.run(reviewPrompt(input), signal);
      throwIfAborted(signal);
      const validated = await validateModelReviewOutput(result, {
        checkout: input.workspace.checkout,
        diff: input.workspace.diff,
      });
      return {
        findings: validated.findings,
        diagnostics: validated.diagnostics,
      };
    } finally {
      signal.removeEventListener("abort", abort);
      try {
        if (abortPromise !== undefined) {
          await abortPromise;
        }
      } finally {
        await session.dispose();
      }
    }
  }
}
