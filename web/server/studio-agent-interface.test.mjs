import assert from "node:assert/strict";
import test from "node:test";

import { createAgentMessageQueue } from "../app/studio/features/task-agent/agent-message-queue.ts";

test("task agent public queue processes messages serially and continues after a failure", async () => {
  const started = [];
  const releases = new Map();
  const queue = createAgentMessageQueue({
    execute: async (item) => {
      started.push(item.id);
      await new Promise((resolve, reject) => releases.set(item.id, { resolve, reject }));
    },
  });

  const first = queue.send({ id: 1, runId: "run-a", runName: "A", message: "first", attachment: null });
  const second = queue.send({ id: 2, runId: "run-b", runName: "B", message: "second", attachment: null });

  assert.deepEqual(started, [1]);
  assert.deepEqual(queue.state().queued.map((item) => item.id), [2]);
  assert.equal(queue.state().active?.id, 1);

  releases.get(1).reject(new Error("first failed"));
  await assert.rejects(first, /first failed/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, [1, 2]);

  releases.get(2).resolve();
  await second;
  assert.deepEqual(queue.state(), { active: null, queued: [] });
});
