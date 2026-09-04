import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  assertPrivateDirectory,
  assertProtectedFile,
  ensurePrivateDirectory,
  writeProtectedJson,
} from "../config/protected-file.js";
import type { PullRequestReference } from "./pull-request.js";

const STATE_DIRECTORY = "review-cancellations";
const STATE_VERSION = 1;

export interface ReviewCancellationMarker {
  readonly cancelledAt: string;
}

export interface ReviewCancellationStore {
  read(
    reference: PullRequestReference,
    signal?: AbortSignal,
  ): Promise<ReviewCancellationMarker | undefined>;
  record(reference: PullRequestReference, signal?: AbortSignal): Promise<ReviewCancellationMarker>;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function canonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function identity(reference: PullRequestReference): string {
  return `${reference.owner.toLowerCase()}/${reference.repository.toLowerCase()}#${reference.number}`;
}

function parseMarker(value: unknown, reference: PullRequestReference): ReviewCancellationMarker {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !("version" in value) ||
    value.version !== STATE_VERSION ||
    !("pullRequest" in value) ||
    value.pullRequest !== identity(reference) ||
    !("cancelledAt" in value) ||
    !canonicalTimestamp(value.cancelledAt)
  ) {
    throw new Error("Review cancellation marker is invalid.");
  }
  return { cancelledAt: value.cancelledAt };
}

export class FileReviewCancellationStore implements ReviewCancellationStore {
  readonly #directory: string;
  readonly #now: () => Date;

  constructor(stateDirectory: string, now: () => Date = () => new Date()) {
    this.#directory = resolve(stateDirectory, STATE_DIRECTORY);
    this.#now = now;
  }

  async read(
    reference: PullRequestReference,
    signal?: AbortSignal,
  ): Promise<ReviewCancellationMarker | undefined> {
    signal?.throwIfAborted();
    const path = this.#path(reference);
    try {
      await assertPrivateDirectory(this.#directory, "Review cancellation directory");
      await assertProtectedFile(path, "Review cancellation marker");
      const contents = await readFile(path, { encoding: "utf8", signal });
      return parseMarker(JSON.parse(contents) as unknown, reference);
    } catch (error) {
      if (
        isMissingFile(error) ||
        (error instanceof Error && error.cause !== undefined && isMissingFile(error.cause))
      ) {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        throw new Error("Review cancellation marker is not valid JSON.", { cause: error });
      }
      throw error;
    }
  }

  async record(
    reference: PullRequestReference,
    signal?: AbortSignal,
  ): Promise<ReviewCancellationMarker> {
    signal?.throwIfAborted();
    await ensurePrivateDirectory(this.#directory, "Review cancellation directory");
    const marker = { cancelledAt: this.#now().toISOString() };
    await writeProtectedJson(this.#path(reference), "Review cancellation marker", {
      version: STATE_VERSION,
      pullRequest: identity(reference),
      ...marker,
    });
    signal?.throwIfAborted();
    return marker;
  }

  #path(reference: PullRequestReference): string {
    const name = `${createHash("sha256").update(identity(reference)).digest("hex")}.json`;
    return join(this.#directory, name);
  }
}
