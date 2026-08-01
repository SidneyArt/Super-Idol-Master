import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiError,
  createApiClient,
} from "../app/studio/shared/api-client.ts";
import {
  createLatestRequest,
  pollingInterval,
} from "../app/studio/shared/query.ts";

test("API client deduplicates concurrent reads and exposes structured failures", async () => {
  let calls = 0;
  let resolveResponse;
  const response = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const client = createApiClient({
    baseUrl: "http://studio.test",
    fetch: async () => {
      calls += 1;
      return response;
    },
  });

  const first = client.get("/api/runs");
  const second = client.get("/api/runs");
  assert.equal(calls, 1);

  resolveResponse(new Response(JSON.stringify({ runs: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  assert.deepEqual(await first, { runs: [] });
  assert.deepEqual(await second, { runs: [] });

  const failingClient = createApiClient({
    baseUrl: "http://studio.test",
    fetch: async () => new Response(JSON.stringify({ error: "服务忙" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    failingClient.get("/api/system"),
    (error) => error instanceof ApiError
      && error.status === 503
      && error.message === "服务忙",
  );
});

test("latest request aborts the old selection and ignores its late response", async () => {
  const requests = new Map();
  const applied = [];
  const latest = createLatestRequest(async (key, signal) => new Promise((resolve, reject) => {
    requests.set(key, { resolve, signal });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));

  const oldRun = latest.run("old", (value) => applied.push(value)).catch(() => undefined);
  const newRun = latest.run("new", (value) => applied.push(value));

  assert.equal(requests.get("old").signal.aborted, true);
  requests.get("new").resolve("new detail");
  await newRun;
  requests.get("old").resolve("old detail");
  await oldRun;

  assert.deepEqual(applied, ["new detail"]);
});

test("polling backs off while hidden and stops for inactive resources", () => {
  assert.equal(pollingInterval({ active: false, visible: true, foregroundMs: 3_000 }), null);
  assert.equal(pollingInterval({ active: true, visible: true, foregroundMs: 3_000 }), 3_000);
  assert.equal(pollingInterval({
    active: true,
    visible: false,
    foregroundMs: 3_000,
    backgroundMs: 30_000,
  }), 30_000);
});
