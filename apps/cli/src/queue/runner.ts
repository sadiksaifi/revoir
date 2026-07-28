import { parseReviewJob, ReviewJobSchemaError, type ReviewJobV1 } from "@revoir/contracts";

import type { RevoirConfiguration } from "../config/schema.js";
import {
  GitHubReviewFailureReporter,
  type ReviewFailureReporter,
} from "../review/failure-reporter.js";
import {
  createDefaultManualReviewService,
  type ManualReviewService,
} from "../review/orchestrator.js";
import { PullRequestEligibilityError, type PullRequestReference } from "../review/pull-request.js";
import { CloudflareQueueClient, type QueueDelivery } from "./client.js";

const IDLE_POLL_DELAY_MS = 1_000;
const MAX_OPERATIONAL_ATTEMPTS = 3;
const OPERATIONAL_RETRY_DELAYS_SECONDS = [30, 120] as const;

export interface QueueClient {
  pullOne(signal?: AbortSignal): Promise<QueueDelivery | undefined>;
  acknowledge(leaseId: string, signal?: AbortSignal): Promise<void>;
  retry(leaseId: string, delaySeconds: number, signal?: AbortSignal): Promise<void>;
}

export type QueueConsumption = "idle" | "settled";

export interface QueueRunService {
  run(signal?: AbortSignal): Promise<void>;
}

function locallyEligible(job: ReviewJobV1, configuration: RevoirConfiguration["github"]): boolean {
  if (
    job.installationId !== configuration.installationId ||
    job.pullRequest.authorId !== configuration.userId ||
    job.pullRequest.senderId !== configuration.userId
  ) {
    return false;
  }
  return configuration.repositories.some(
    (repository) =>
      repository.id === job.repository.id &&
      repository.owner.toLowerCase() === job.repository.owner.toLowerCase() &&
      repository.name.toLowerCase() === job.repository.name.toLowerCase(),
  );
}

function referenceFor(job: ReviewJobV1): PullRequestReference {
  const { owner, name } = job.repository;
  const number = job.pullRequest.number;
  return {
    owner,
    repository: name,
    number,
    url: `https://github.com/${owner}/${name}/pull/${number}`,
  };
}

function waitForNextPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(done, IDLE_POLL_DELAY_MS);
    function done(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Queue runner was cancelled.");
  }
}

async function waitForFailureReport(report: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    function done(): void {
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
    void report.then(done, done);
  });
}

export class QueueReviewRunner implements QueueRunService {
  readonly #configuration: RevoirConfiguration;
  readonly #failures: ReviewFailureReporter;
  readonly #queue: QueueClient;
  readonly #reviews: ManualReviewService;

  constructor(
    configuration: RevoirConfiguration,
    queue: QueueClient,
    reviews: ManualReviewService,
    failures: ReviewFailureReporter = new GitHubReviewFailureReporter(configuration.github),
  ) {
    this.#configuration = configuration;
    this.#queue = queue;
    this.#reviews = reviews;
    this.#failures = failures;
  }

  async consumeOne(signal?: AbortSignal): Promise<QueueConsumption> {
    const delivery = await this.#queue.pullOne(signal);
    if (delivery === undefined) {
      return "idle";
    }

    let job: ReviewJobV1;
    try {
      job = parseReviewJob(delivery.body);
    } catch (error) {
      if (!(error instanceof ReviewJobSchemaError)) {
        throw error;
      }
      await this.#queue.acknowledge(delivery.leaseId, signal);
      return "settled";
    }

    if (!locallyEligible(job, this.#configuration.github)) {
      await this.#queue.acknowledge(delivery.leaseId, signal);
      return "settled";
    }

    try {
      await this.#reviews.review(referenceFor(job), {
        expectedHeadSha: job.pullRequest.headSha,
        ...(signal === undefined ? {} : { signal }),
      });
      throwIfCancelled(signal);
      await this.#queue.acknowledge(delivery.leaseId, signal);
    } catch (error) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : error;
      }
      if (error instanceof PullRequestEligibilityError) {
        await this.#queue.acknowledge(delivery.leaseId, signal);
      } else {
        const timeoutSignal = AbortSignal.timeout(this.#configuration.timeouts.shellCommandMs);
        const reportingSignal =
          signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
        const report = Promise.resolve().then(() =>
          this.#failures.report(
            referenceFor(job),
            error,
            delivery.attempt,
            MAX_OPERATIONAL_ATTEMPTS,
            reportingSignal,
          ),
        );
        // The report promise is joined when the provider cooperates and safely observed if it
        // ignores cancellation. Queue settlement cannot be held indefinitely by that provider.
        await waitForFailureReport(report, reportingSignal);
        throwIfCancelled(signal);
        if (delivery.attempt >= MAX_OPERATIONAL_ATTEMPTS) {
          await this.#queue.acknowledge(delivery.leaseId, signal);
        } else {
          await this.#queue.retry(
            delivery.leaseId,
            OPERATIONAL_RETRY_DELAYS_SECONDS[delivery.attempt - 1]!,
            signal,
          );
        }
      }
    }
    return "settled";
  }

  async run(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted === true) {
        return;
      }
      // Pull and settlement are deliberately serialized to keep one review in flight.
      // eslint-disable-next-line no-await-in-loop
      const result = await this.consumeOne(signal);
      if (result === "idle") {
        // eslint-disable-next-line no-await-in-loop
        await waitForNextPoll(signal);
      }
    }
  }
}

export function createDefaultQueueRunService(configuration: RevoirConfiguration): QueueRunService {
  return new QueueReviewRunner(
    configuration,
    new CloudflareQueueClient(configuration.cloudflare, configuration.timeouts.reviewMs),
    createDefaultManualReviewService(configuration),
  );
}
