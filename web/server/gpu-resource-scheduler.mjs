/**
 * Process-wide FIFO scheduler for expensive generation work.
 *
 * The application currently runs as a single local Node process, so one
 * scheduler instance is the authoritative owner of the shared GPU slot. Job
 * state remains persisted by the caller; this module only owns admission,
 * ordering, cancellation, and slot release.
 */
export function createGpuResourceScheduler({ capacity = 1 } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error("GPU 调度器 capacity 必须是正整数");
  }

  const queued = [];
  const entries = new Map();
  const active = new Map();
  let shuttingDown = false;
  let draining = false;

  function snapshot(entry) {
    if (!entry) return null;
    const queueIndex = queued.indexOf(entry);
    return {
      id: entry.id,
      label: entry.label,
      state: entry.state,
      queuePosition: queueIndex < 0 ? 0 : queueIndex + 1,
      enqueuedAt: entry.enqueuedAt,
      startedAt: entry.startedAt,
    };
  }

  function status() {
    return {
      capacity,
      active: [...active.values()].map(snapshot),
      queued: queued.map(snapshot),
    };
  }

  function notifyQueuePositions() {
    queued.forEach((entry, index) => {
      try {
        entry.onQueued?.({ position: index + 1, status: status() });
      } catch {
        // Status reporting must not break resource admission.
      }
    });
  }

  function settle(entry, state) {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    entry.state = state;
    active.delete(entry.id);
    entries.delete(entry.id);
    queueMicrotask(drain);
    return true;
  }

  function startEntry(entry) {
    entry.state = "running";
    entry.startedAt = new Date().toISOString();
    active.set(entry.id, entry);
    const lease = {
      id: entry.id,
      release: () => settle(entry, "completed"),
    };
    try {
      entry.handle = entry.start(lease) || null;
    } catch (error) {
      settle(entry, "failed");
      try {
        entry.onStartError?.(error);
      } catch {
        // Preserve the original launch error for the scheduler caller.
      }
      entry.startError = error;
    }
  }

  function drain() {
    if (draining || shuttingDown) return;
    draining = true;
    try {
      while (active.size < capacity && queued.length) {
        const entry = queued.shift();
        if (!entry || entry.settled) continue;
        startEntry(entry);
      }
      notifyQueuePositions();
    } finally {
      draining = false;
    }
  }

  function schedule({ id, label = "GPU Job", start, onQueued, onStartError, onCancel }) {
    if (shuttingDown) throw new Error("GPU 调度器正在关闭，不能接收新任务");
    if (typeof id !== "string" || !id.trim()) throw new Error("GPU 调度任务必须提供唯一 ID");
    if (typeof start !== "function") throw new Error("GPU 调度任务必须提供 start 回调");
    if (entries.has(id)) throw new Error(`GPU 调度任务已存在：${id}`);

    const entry = {
      id,
      label,
      start,
      onQueued,
      onStartError,
      onCancel,
      state: "queued",
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      settled: false,
      handle: null,
      startError: null,
    };
    entries.set(id, entry);
    queued.push(entry);
    drain();
    if (entry.startError) throw entry.startError;
    return snapshot(entry);
  }

  function cancel(id, reason = "GPU 排队任务已取消") {
    const entry = entries.get(id);
    if (!entry || entry.settled) return false;
    if (entry.state === "queued") {
      const index = queued.indexOf(entry);
      if (index >= 0) queued.splice(index, 1);
    } else if (entry.state === "running") {
      try {
        entry.handle?.cancel?.();
      } catch {
        // The caller's cancellation callback still records the cancellation.
      }
    }
    settle(entry, "cancelled");
    try {
      entry.onCancel?.(reason);
    } catch {
      // Cancellation is already final even if status reporting fails.
    }
    notifyQueuePositions();
    return true;
  }

  function shutdown(reason = "服务正在关闭") {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const entry of [...queued]) cancel(entry.id, reason);
    for (const entry of [...active.values()]) cancel(entry.id, reason);
  }

  return {
    schedule,
    cancel,
    shutdown,
    status,
    has: (id) => entries.has(id),
    isActive: (id) => active.has(id),
  };
}
