import assert from "node:assert/strict";
import test from "node:test";

import { select2dExecution } from "./features/jobs/2d-execution-policy.mjs";

test("QA model repair forces image-edit config and uses the failed T-Pose as source", () => {
  const execution = select2dExecution({
    run: {
      pipelineType: "text_to_model",
      imagePathInternal: "/output/failed-tpose.png",
      sourceImagePathInternal: "/output/original.png",
    },
    repairMode: true,
    defaultProcessConfig: { mode: "comfyui", url: "http://dgx" },
    imageEditConfig: { model: "step-image-edit-2", baseUrl: "https://api.example", apiKey: "secret" },
  });

  assert.deepEqual(execution.processConfig, {
    mode: "api",
    repairMode: true,
    api: { model: "step-image-edit-2", baseUrl: "https://api.example", apiKey: "secret" },
  });
  assert.equal(execution.sourceImage, "/output/failed-tpose.png");
  assert.equal(execution.tposeOutput, true);
});

test("normal image-to-model generation keeps the original reference as source", () => {
  const execution = select2dExecution({
    run: {
      pipelineType: "image_to_model",
      imagePathInternal: "/output/failed-tpose.png",
      sourceImagePathInternal: "/output/original.png",
    },
    repairMode: false,
    defaultProcessConfig: { mode: "comfyui", url: "http://dgx" },
    imageEditConfig: { model: "step-image-edit-2", baseUrl: "https://api.example", apiKey: "secret" },
  });

  assert.equal(execution.processConfig.mode, "api");
  assert.equal(execution.sourceImage, "/output/original.png");
  assert.equal(execution.tposeOutput, true);
});
