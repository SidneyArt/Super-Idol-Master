"use client";

import { useEffect, useRef } from "react";

import { isAbortError, pollingInterval } from "./query";

type PollingQueryOptions<TKey, TValue> = {
  key: TKey;
  enabled?: boolean;
  foregroundMs: number;
  backgroundMs?: number;
  query: (key: TKey, signal: AbortSignal) => Promise<TValue>;
  onData: (value: TValue, key: TKey) => void;
  onError?: (reason: unknown, key: TKey) => void;
};

/**
 * Owns the complete lifecycle of one polled remote resource:
 * cancellation, no-overlap scheduling, visibility backoff, and stale-key guards.
 */
export function usePollingQuery<TKey, TValue>({
  key,
  enabled = true,
  foregroundMs,
  backgroundMs,
  query,
  onData,
  onError,
}: PollingQueryOptions<TKey, TValue>) {
  const queryRef = useRef(query);
  const onDataRef = useRef(onData);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    queryRef.current = query;
    onDataRef.current = onData;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timeout: number | null = null;
    let controller: AbortController | null = null;

    const schedule = () => {
      if (disposed) return;
      const interval = pollingInterval({
        active: enabled,
        visible: document.visibilityState !== "hidden",
        foregroundMs,
        backgroundMs,
      });
      if (interval !== null) timeout = window.setTimeout(run, interval);
    };

    const run = async () => {
      if (disposed || controller) return;
      controller = new AbortController();
      const activeController = controller;
      try {
        const value = await queryRef.current(key, activeController.signal);
        if (!disposed && !activeController.signal.aborted) {
          onDataRef.current(value, key);
        }
      } catch (reason) {
        if (!disposed && !isAbortError(reason)) onErrorRef.current?.(reason, key);
      } finally {
        if (controller === activeController) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = null;
      if (!controller) schedule();
    };

    void run();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      if (timeout !== null) window.clearTimeout(timeout);
      controller?.abort(new DOMException("Polling stopped", "AbortError"));
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [backgroundMs, enabled, foregroundMs, key]);
}
