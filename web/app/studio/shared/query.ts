type PollingOptions = {
  active: boolean;
  visible: boolean;
  foregroundMs: number;
  backgroundMs?: number;
};

export function pollingInterval({
  active,
  visible,
  foregroundMs,
  backgroundMs = Math.max(foregroundMs * 5, 15_000),
}: PollingOptions): number | null {
  if (!active) return null;
  return visible ? foregroundMs : backgroundMs;
}

export type LatestRequest<TKey, TValue> = {
  run(key: TKey, apply: (value: TValue) => void): Promise<TValue | undefined>;
  cancel(): void;
};

export function createLatestRequest<TKey, TValue>(
  request: (key: TKey, signal: AbortSignal) => Promise<TValue>,
): LatestRequest<TKey, TValue> {
  let sequence = 0;
  let controller: AbortController | null = null;

  return {
    async run(key, apply) {
      const requestSequence = ++sequence;
      controller?.abort(new DOMException("Selection changed", "AbortError"));
      controller = new AbortController();
      const activeController = controller;
      try {
        const value = await request(key, activeController.signal);
        if (
          requestSequence === sequence
          && controller === activeController
          && !activeController.signal.aborted
        ) {
          apply(value);
          return value;
        }
        return undefined;
      } finally {
        if (controller === activeController) controller = null;
      }
    },
    cancel() {
      sequence += 1;
      controller?.abort(new DOMException("Request cancelled", "AbortError"));
      controller = null;
    },
  };
}

export function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}
