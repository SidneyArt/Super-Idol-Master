import type { AgentQueueItem } from "../../shared/contracts";

type QueueState = {
  active: AgentQueueItem | null;
  queued: AgentQueueItem[];
};

type PendingItem = {
  item: AgentQueueItem;
  resolve: () => void;
  reject: (reason: unknown) => void;
};

/**
 * Serializes Task Agent requests while keeping per-message completion observable.
 * The React hook owns one controller instance and exposes only its queue snapshot.
 */
export function createAgentMessageQueue(options: {
  execute: (item: AgentQueueItem) => Promise<void>;
  onChange?: (state: QueueState) => void;
}) {
  let active: PendingItem | null = null;
  let queued: PendingItem[] = [];

  const state = (): QueueState => ({
    active: active?.item ?? null,
    queued: queued.map(({ item }) => item),
  });

  const notify = () => options.onChange?.(state());

  const drain = async () => {
    if (active || queued.length === 0) return;
    active = queued[0];
    queued = queued.slice(1);
    notify();
    try {
      await options.execute(active.item);
      active.resolve();
    } catch (reason) {
      active.reject(reason);
    } finally {
      active = null;
      notify();
      void drain();
    }
  };

  return {
    state,
    send(item: AgentQueueItem) {
      const completion = new Promise<void>((resolve, reject) => {
        queued = [...queued, { item, resolve, reject }];
      });
      notify();
      void drain();
      return completion;
    },
    remove(id: number) {
      const next = queued.filter(({ item }) => item.id !== id);
      if (next.length === queued.length) return false;
      queued = next;
      notify();
      return true;
    },
  };
}
