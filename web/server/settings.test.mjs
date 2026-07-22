import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createSettingsStore } from "./settings.mjs";

const workflowFiles = {
  "2d": fileURLToPath(new URL("./pipeline/2D_Gen_QwenImage2512.json", import.meta.url)),
  qa: fileURLToPath(new URL("./pipeline/TPose_QA_SDPose.json", import.meta.url)),
  "3d": fileURLToPath(new URL("./pipeline/3D_Gen_Pixal3D.json", import.meta.url)),
  rig: fileURLToPath(new URL("./pipeline/3D_Skin_SkinTokens.json", import.meta.url)),
};

test("topology API settings persist without exposing the token", () => {
  const previousTopologyEnv = Object.fromEntries(
    ["TOPOLOGY_SERVICE_URL", "TOPOLOGY_SERVICE_TOKEN", "TOPOLOGY_TARGET_QUADS", "TOPOLOGY_TIMEOUT_SECONDS"]
      .map((key) => [key, process.env[key]]),
  );
  for (const key of Object.keys(previousTopologyEnv)) delete process.env[key];
  const db = new DatabaseSync(":memory:");
  try {
    const store = createSettingsStore({ db, workflowFiles, defaultComfyUrl: "http://127.0.0.1:8188" });
    const initial = store.publicSettings();

    assert.equal(initial.topology.tokenConfigured, false);
    assert.equal(Object.hasOwn(initial.topology, "token"), false);

    const saved = store.update({
      processes: initial.processes,
      topology: {
        url: "http://100.64.0.10:8190/v1/remesh",
        token: "secret-token",
        targetQuads: 80_000,
        timeoutSeconds: 7_200,
      },
    });

    assert.equal(saved.topology.url, "http://100.64.0.10:8190/v1/remesh");
    assert.equal(saved.topology.tokenConfigured, true);
    assert.equal(Object.hasOwn(saved.topology, "token"), false);
    assert.deepEqual(store.topologyConfig(), {
      url: "http://100.64.0.10:8190/v1/remesh",
      token: "secret-token",
      targetQuads: 80_000,
      timeoutSeconds: 7_200,
    });

    const cleared = store.update({
      processes: saved.processes,
      topology: { ...saved.topology, clearToken: true },
    });
    assert.equal(cleared.topology.tokenConfigured, false);
    assert.equal(store.topologyConfig().token, "");
  } finally {
    db.close();
    for (const [key, value] of Object.entries(previousTopologyEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
