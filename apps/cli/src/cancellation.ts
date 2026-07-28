export function isCallerCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted !== true) {
    return false;
  }

  const seen = new Set<unknown>();
  let current = error;
  while (!seen.has(current)) {
    if (current === signal.reason) {
      return true;
    }
    if (!(current instanceof Error)) {
      return false;
    }
    seen.add(current);
    current = current.cause;
  }
  return false;
}
