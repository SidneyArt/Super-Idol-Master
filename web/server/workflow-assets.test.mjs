import assert from "node:assert/strict";
import test from "node:test";
import { rigInputPath } from "./workflow-assets.mjs";

test("rigging uses the retopologized model on the normal path", () => {
  assert.equal(rigInputPath({
    topologySkipped: false,
    modelPathInternal: "original.glb",
    topologyPathInternal: "retopologized.glb",
  }), "retopologized.glb");
});

test("rigging uses the original model when topology was skipped", () => {
  assert.equal(rigInputPath({
    topologySkipped: true,
    modelPathInternal: "original.glb",
    topologyPathInternal: "retopologized.glb",
  }), "original.glb");
});
