import assert from "node:assert/strict";
import test from "node:test";

import { jobStartMessage } from "./job-messages.mjs";

test("topology start message does not read image API model settings", () => {
  const topologyConfig = {
    mode: "api",
    url: "http://127.0.0.1:8190",
    targetQuads: 50_000,
    timeoutSeconds: 3_600,
  };

  assert.equal(
    jobStartMessage("topology", topologyConfig),
    "正在调用 DGX AutoRemesher 执行自动拓扑与纹理回烘",
  );
});

test("2D image API start message includes the configured model", () => {
  assert.equal(
    jobStartMessage("2d", { mode: "api", api: { model: "step-image-edit-2" } }),
    "正在调用图片 API step-image-edit-2 生成 2D 概念图",
  );
});
