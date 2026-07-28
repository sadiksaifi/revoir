import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { ReasoningLevel, RevoirConfiguration } from "../config/schema.js";
import type { PullRequestReference, PullRequestSnapshot } from "./pull-request.js";
import type { PreparedWorkspace } from "./workspace.js";

const REVIEW_SYSTEM_PROMPT = `You are Revoir's read-only pull-request reviewer.
Inspect the complete base-to-head change for correctness, regressions, security, and missing tests.
Use read, search, and host bash only for evidence. Do not modify files, install dependencies, run
package lifecycle scripts, or use repository-provided Pi extensions, skills, prompts, or settings.
This tracer accepts only a clean result. If the change has no actionable P0-P3 finding, finish with
exactly {"findings":[]}. Do not include Markdown, praise, a summary, or any other prose.`;

export interface ReviewEngineInput {
  reference: PullRequestReference;
  pullRequest: PullRequestSnapshot;
  workspace: PreparedWorkspace;
}

export interface ReviewEngine {
  review(input: ReviewEngineInput, signal: AbortSignal): Promise<void>;
}

export interface PiSession {
  run(prompt: string, signal: AbortSignal): Promise<string>;
  dispose(): void;
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

function waitForSessionCreation(
  creation: Promise<PiSession>,
  signal: AbortSignal,
): Promise<PiSession> {
  return new Promise((resolve, reject) => {
    let state: "pending" | "resolved" | "aborted" = "pending";
    const abort = () => {
      if (state !== "pending") {
        return;
      }
      state = "aborted";
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };

    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }

    void creation.then(
      (session) => {
        if (state === "aborted") {
          try {
            session.dispose();
          } catch {
            // The review has already failed; best-effort disposal prevents a late session leak.
          }
          return;
        }
        state = "resolved";
        signal.removeEventListener("abort", abort);
        resolve(session);
      },
      (error: unknown) => {
        if (state !== "pending") {
          return;
        }
        state = "resolved";
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
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
      session.dispose();
      throw abortReason(signal);
    }

    return {
      async run(prompt, runSignal) {
        if (runSignal.aborted) {
          await session.abort();
          throw runSignal.reason instanceof Error
            ? runSignal.reason
            : new Error("Review was cancelled.");
        }
        let finalText: string | undefined;
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "message_end") {
            finalText = assistantText(event.message) ?? finalText;
          }
        });
        const abort = () => {
          void session.abort();
        };
        runSignal.addEventListener("abort", abort, { once: true });
        try {
          await session.prompt(prompt);
          if (runSignal.aborted) {
            throw runSignal.reason instanceof Error
              ? runSignal.reason
              : new Error("Review was cancelled.");
          }
          if (finalText === undefined) {
            throw new Error("Pi completed without a structured review result.");
          }
          return finalText;
        } finally {
          runSignal.removeEventListener("abort", abort);
          unsubscribe();
        }
      },
      dispose() {
        session.dispose();
      },
    };
  }
}

function validateCleanResult(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch (error) {
    throw new Error('Pi must return exactly {"findings":[]}.', { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !("findings" in parsed) ||
    !Array.isArray(parsed.findings) ||
    parsed.findings.length !== 0
  ) {
    throw new Error('This tracer accepts only the validated clean result {"findings":[]}.');
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

  async review(input: ReviewEngineInput, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const session = await waitForSessionCreation(
      this.#sessionFactory.create(
        {
          cwd: input.workspace.checkout,
          model: this.#model.id,
          reasoning: this.#model.reasoning,
          systemPrompt: REVIEW_SYSTEM_PROMPT,
        },
        signal,
      ),
      signal,
    );
    try {
      validateCleanResult(await session.run(reviewPrompt(input), signal));
    } finally {
      session.dispose();
    }
  }
}
