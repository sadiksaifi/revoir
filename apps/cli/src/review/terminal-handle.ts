export type TerminalHandle = () => Promise<void>;

type TerminalState =
  | { kind: "pending" }
  | { kind: "inFlight"; promise: Promise<void> }
  | { kind: "done" };

export function createTerminalHandle(operation: () => Promise<void>): TerminalHandle {
  let state: TerminalState = { kind: "pending" };

  return (): Promise<void> => {
    if (state.kind === "done") {
      return Promise.resolve();
    }
    if (state.kind === "inFlight") {
      return state.promise;
    }

    const promise = Promise.resolve().then(operation);
    state = { kind: "inFlight", promise };
    void promise.then(
      () => {
        if (state.kind === "inFlight" && state.promise === promise) {
          state = { kind: "done" };
        }
      },
      () => {
        if (state.kind === "inFlight" && state.promise === promise) {
          state = { kind: "pending" };
        }
      },
    );
    return promise;
  };
}
