export function isCallerCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted !== true) {
    return false;
  }

  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === signal.reason) {
      return true;
    }
    if (seen.has(current) || !(current instanceof Error)) {
      continue;
    }
    seen.add(current);
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return false;
}

export class TargetedReviewCancellationError extends Error {
  constructor() {
    super("Review cancelled by an authorized request for this pull request.");
    this.name = "TargetedReviewCancellationError";
  }
}

export function isTargetedReviewCancellation(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current instanceof TargetedReviewCancellationError) {
      return true;
    }
    if (seen.has(current) || !(current instanceof Error)) {
      continue;
    }
    seen.add(current);
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return false;
}

export function isOnlyTargetedReviewCancellation(error: unknown): boolean {
  let foundCancellation = false;
  let foundOtherFailure = false;
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof TargetedReviewCancellationError) {
      foundCancellation = true;
      continue;
    }
    if (!(current instanceof Error)) {
      foundOtherFailure = true;
      continue;
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    } else if (current.cause !== undefined) {
      pending.push(current.cause);
    } else {
      foundOtherFailure = true;
    }
  }
  return foundCancellation && !foundOtherFailure;
}
