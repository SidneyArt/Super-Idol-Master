import assert from "node:assert/strict";
import test from "node:test";
import { createGpuResourceScheduler } from "./gpu-resource-scheduler.mjs";

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("global GPU scheduler admits only one job and preserves FIFO order", async () => {
  const scheduler = createGpuResourceScheduler({ capacity: 1 });
  const started = [];
  const leases = new Map();
  const positions = [];

  const schedule = (id) => scheduler.schedule({
    id,
    label: id,
    onQueued: ({ position }) => positions.push([id, position]),
    start: (lease) => {
      started.push(id);
      leases.set(id, lease);
    },
  });

  const first = schedule("run:1");
  assert.deepEqual(
    { id: first.id, label: first.label, state: first.state, queuePosition: first.queuePosition },
    { id: "run:1", label: "run:1", state: "running", queuePosition: 0 },
  );
  assert.ok(Date.parse(first.enqueuedAt));
  assert.ok(Date.parse(first.startedAt));
  schedule("dispatcher:1");
  schedule("run:2");

  assert.deepEqual(started, ["run:1"]);
  assert.deepEqual(scheduler.status().queued.map((item) => item.id), ["dispatcher:1", "run:2"]);
  assert.ok(positions.some(([id, position]) => id === "dispatcher:1" && position === 1));
  assert.ok(positions.some(([id, position]) => id === "run:2" && position === 2));

  leases.get("run:1").release();
  await flushMicrotasks();
  assert.deepEqual(started, ["run:1", "dispatcher:1"]);
  assert.deepEqual(scheduler.status().queued.map((item) => item.id), ["run:2"]);

  leases.get("dispatcher:1").release();
  await flushMicrotasks();
  assert.deepEqual(started, ["run:1", "dispatcher:1", "run:2"]);
  assert.equal(scheduler.status().active.length, 1);
  assert.equal(scheduler.status().active[0].id, "run:2");

  leases.get("run:2").release();
  await flushMicrotasks();
  assert.deepEqual(scheduler.status(), { capacity: 1, active: [], queued: [] });
});

test("launch failure releases the global slot and starts the next queued job", async () => {
  const scheduler = createGpuResourceScheduler();
  const errors = [];
  let firstLease;
  let secondStarted = false;

  scheduler.schedule({
    id: "first",
    start: (lease) => {
      firstLease = lease;
    },
  });
  scheduler.schedule({
    id: "broken",
    start: () => {
      throw new Error("spawn failed");
    },
    onStartError: (error) => errors.push(error.message),
  });
  scheduler.schedule({
    id: "second",
    start: () => {
      secondStarted = true;
    },
  });

  firstLease.release();
  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(errors, ["spawn failed"]);
  assert.equal(secondStarted, true);
  assert.equal(scheduler.status().active[0].id, "second");
});

test("queued cancellation removes work without consuming the GPU slot", async () => {
  const scheduler = createGpuResourceScheduler();
  const cancelled = [];
  const started = [];
  let activeLease;

  scheduler.schedule({
    id: "active",
    start: (lease) => {
      activeLease = lease;
      started.push("active");
    },
  });
  scheduler.schedule({
    id: "cancelled",
    start: () => started.push("cancelled"),
    onCancel: (reason) => cancelled.push(reason),
  });
  scheduler.schedule({
    id: "next",
    start: () => started.push("next"),
  });

  assert.equal(scheduler.cancel("cancelled", "user cancelled"), true);
  assert.equal(scheduler.cancel("missing"), false);
  activeLease.release();
  await flushMicrotasks();

  assert.deepEqual(cancelled, ["user cancelled"]);
  assert.deepEqual(started, ["active", "next"]);
});

test("shutdown cancels active and queued jobs and rejects new work", () => {
  const scheduler = createGpuResourceScheduler();
  const cancelled = [];
  let activeHandleCancelled = false;

  scheduler.schedule({
    id: "active",
    start: () => ({ cancel: () => { activeHandleCancelled = true; } }),
    onCancel: (reason) => cancelled.push(["active", reason]),
  });
  scheduler.schedule({
    id: "queued",
    start: () => {},
    onCancel: (reason) => cancelled.push(["queued", reason]),
  });

  scheduler.shutdown("shutdown");

  assert.equal(activeHandleCancelled, true);
  assert.deepEqual(cancelled.sort(), [["active", "shutdown"], ["queued", "shutdown"]]);
  assert.deepEqual(scheduler.status(), { capacity: 1, active: [], queued: [] });
  assert.throws(
    () => scheduler.schedule({ id: "late", start: () => {} }),
    /正在关闭/,
  );
});
