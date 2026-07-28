import { parseReviewJob, ReviewJobSchemaError, type ReviewJobV1 } from "@revoir/contracts";

import type { RevoirConfiguration } from "../config/schema.js";
import {
  createDefaultManualReviewService,
  type ManualReviewService,
} from "../review/orchestrator.js";
import { PullRequestEligibilityError, type PullRequestReference } from "../review/pull-request.js";
import { CloudflareQueueClient, type QueueDelivery } from "./client.js";

const IDLE_POLL_DELAY_MS = 1_000;

export interface QueueClient {
  pullOne(signal?: AbortSignal): Promise<QueueDelivery | undefined>;
  acknowledge(leaseId: string, signal?: AbortSignal): Promise<void>;
  retry(leaseId: string, signal?: AbortSignal): Promise<void>;
}

export type QueueConsumption = "idle" | "settled";

export interface QueueRunService {
  run(signal?: AbortSignal): Promise<void>;
}

export interface QueueRunLogger {
  write(event: string, data?: Readonly<Record<string, unknown>>): Promise<void>;
}

const NOOP_LOGGER: QueueRunLogger = {
  async write() {},
};

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

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export class QueueReviewRunner implements QueueRunService {
  readonly #configuration: RevoirConfiguration;
  readonly #queue: QueueClient;
  readonly #reviews: ManualReviewService;
  readonly #logger: QueueRunLogger;

  constructor(
    configuration: RevoirConfiguration,
    queue: QueueClient,
    reviews: ManualReviewService,
    logger: QueueRunLogger = NOOP_LOGGER,
  ) {
    this.#configuration = configuration;
    this.#queue = queue;
    this.#reviews = reviews;
    this.#logger = logger;
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
      await this.#queue.acknowledge(delivery.leaseId);
      return "settled";
    }

    if (!locallyEligible(job, this.#configuration.github)) {
      await this.#queue.acknowledge(delivery.leaseId);
      return "settled";
    }

    const metadata = {
      deliveryId: job.deliveryId,
      repository: `${job.repository.owner}/${job.repository.name}`,
      pullRequest: job.pullRequest.number,
      headSha: job.pullRequest.headSha,
    };
    const startedAt = Date.now();
    await this.#logger.write("queue_review_started", metadata);
    try {
      const result = await this.#reviews.review(referenceFor(job), {
        expectedHeadSha: job.pullRequest.headSha,
        ...(signal === undefined ? {} : { signal }),
      });
      await this.#queue.acknowledge(delivery.leaseId);
      await this.#logger.write("queue_review_settled", {
        ...metadata,
        outcome: result.status,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (error instanceof PullRequestEligibilityError) {
        await this.#queue.acknowledge(delivery.leaseId);
        await this.#logger.write("queue_review_rejected", {
          ...metadata,
          durationMs: Date.now() - startedAt,
          error,
        });
      } else {
        await this.#queue.retry(delivery.leaseId);
        await this.#logger.write("queue_review_retried", {
          ...metadata,
          durationMs: Date.now() - startedAt,
          error,
        });
      }
    }
    return "settled";
  }

  async run(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (aborted(signal)) {
        return;
      }
      // Pull and settlement are deliberately serialized to keep one review in flight.
      let result: QueueConsumption;
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await this.consumeOne(signal);
      } catch (error) {
        if (aborted(signal)) {
          return;
        }
        throw error;
      }
      if (result === "idle") {
        // eslint-disable-next-line no-await-in-loop
        await waitForNextPoll(signal);
      }
    }
  }
}

export function createDefaultQueueRunService(
  configuration: RevoirConfiguration,
  logger: QueueRunLogger = NOOP_LOGGER,
): QueueRunService {
  return new QueueReviewRunner(
    configuration,
    new CloudflareQueueClient(configuration.cloudflare, configuration.timeouts.reviewMs),
    createDefaultManualReviewService(configuration),
    logger,
  );
}
