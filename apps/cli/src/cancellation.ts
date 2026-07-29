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
