import assert from "node:assert/strict";
import test from "node:test";

import { createAssetRoutes } from "./features/assets/routes.mjs";
import { createJobRoutes } from "./features/jobs/routes.mjs";
import { createSettingsRoutes } from "./features/settings/routes.mjs";
import { createSystemRoutes } from "./features/system/routes.mjs";
import { createWorkspaceRoutes } from "./features/workspaces/routes.mjs";
import { dispatchRoutes } from "./http/dispatch-routes.mjs";

function requestContext(method, path) {
  const url = new URL(path, "http://studio.test");
  return {
    req: { method },
    res: {},
    url,
    parts: url.pathname.split("/").filter(Boolean),
  };
}

test("route dispatcher stops after the owning feature handles a request", async () => {
  const visited = [];
  const handled = await dispatchRoutes([
    async () => {
      visited.push("approvals");
      return false;
    },
    async () => {
      visited.push("workspaces");
      return true;
    },
    async () => {
      visited.push("runs");
      return true;
    },
  ], requestContext("GET", "/api/workspaces"));

  assert.equal(handled, true);
  assert.deepEqual(visited, ["approvals", "workspaces"]);
});

test("workspace routes own workspace CRUD without claiming settings routes", async () => {
  const responses = [];
  const routes = createWorkspaceRoutes({
    json: (_res, status, body) => responses.push({ status, body }),
    readBody: async () => ({ name: "新项目" }),
    workspaces: {
      create: (body) => ({ id: "workspace-new", ...body }),
      list: () => [{ id: "workspace-a" }],
      remove: (id) => ({ deleted: id }),
    },
  });

  assert.equal(await routes(requestContext("GET", "/api/workspaces")), true);
  assert.deepEqual(responses.pop(), {
    status: 200,
    body: { workspaces: [{ id: "workspace-a" }] },
  });

  assert.equal(await routes(requestContext("POST", "/api/workspaces")), true);
  assert.deepEqual(responses.pop(), {
    status: 201,
    body: { id: "workspace-new", name: "新项目" },
  });

  assert.equal(await routes(requestContext("GET", "/api/settings")), false);
});

test("job routes preserve the public action-to-job mapping", async () => {
  const started = [];
  const responses = [];
  const routes = createJobRoutes({
    jobs: {
      accepts: (action) => action === "retopologize",
      start: (runId, action) => {
        started.push({ runId, kind: action === "retopologize" ? "topology" : action });
        return { accepted: true };
      },
    },
    json: (_res, status, body) => responses.push({ status, body }),
  });

  assert.equal(await routes(requestContext("POST", "/api/runs/run-a/retopologize")), true);
  assert.deepEqual(started, [{ runId: "run-a", kind: "topology" }]);
  assert.deepEqual(responses, [{ status: 202, body: { accepted: true } }]);
});

test("asset routes keep preview and download validation errors distinct", async () => {
  const routes = createAssetRoutes({
    assets: {
      animations: {},
      runAsset: () => undefined,
      streamDownload: () => undefined,
      streamPreview: () => undefined,
    },
    json: () => undefined,
    readBody: async () => ({}),
  });

  await assert.rejects(
    routes(requestContext("GET", "/api/runs/run-a/preview/unknown")),
    /未知资产类型/,
  );
  await assert.rejects(
    routes(requestContext("GET", "/api/runs/run-a/download/unknown")),
    /未知产物类型/,
  );
});

test("settings routes invalidate system probes after a saved change", async () => {
  let invalidations = 0;
  const responses = [];
  const routes = createSettingsRoutes({
    invalidateSystemCache: () => { invalidations += 1; },
    json: (_res, status, value) => responses.push({ status, value }),
    readBody: async () => ({ processes: {} }),
    settingsStore: {
      update: (value) => ({ saved: value }),
    },
  });

  assert.equal(await routes(requestContext("PUT", "/api/settings")), true);
  assert.equal(invalidations, 1);
  assert.deepEqual(responses, [{
    status: 200,
    value: { saved: { processes: {} } },
  }]);
});

test("system routes expose health without claiming an unknown endpoint", async () => {
  const responses = [];
  const routes = createSystemRoutes({
    assetAgent: { status: () => ({ configured: true }) },
    checkComfyUi: async () => ({ online: true }),
    databasePath: "/tmp/studio.db",
    gpuScheduler: { status: () => ({ active: 0 }) },
    json: (_res, status, value) => responses.push({ status, value }),
    sourceMtimeMs: 123,
  });

  assert.equal(await routes(requestContext("GET", "/api/health")), true);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].value.sourceMtimeMs, 123);
  assert.equal(await routes(requestContext("GET", "/api/unknown")), false);
});
