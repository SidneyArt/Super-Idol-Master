import assert from "node:assert/strict";
import test from "node:test";
import { runJsonSubprocess } from "./subprocess-json.mjs";

test("JSON subprocess execution does not block the Node event loop", async () => {
  const startedAt = performance.now();
  const resultPromise = runJsonSubprocess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => console.log(JSON.stringify({ ok: true })), 150)"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 1_000,
  });
  const callDurationMs = performance.now() - startedAt;

  assert.ok(callDurationMs < 50, `subprocess call blocked for ${callDurationMs.toFixed(1)}ms`);
  assert.deepEqual(await resultPromise, { ok: true });
});

test("JSON subprocess failures and timeouts remain observable", async () => {
  await assert.rejects(
    runJsonSubprocess({
      command: process.execPath,
      args: ["-e", "process.stderr.write('fixture failed'); process.exit(2)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 1_000,
    }),
    /fixture failed/,
  );
  await assert.rejects(
    runJsonSubprocess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 500)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 25,
      failureMessage: "fixture timeout",
    }),
    /fixture timeout.*25ms/,
  );
});
