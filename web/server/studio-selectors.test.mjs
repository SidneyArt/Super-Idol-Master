import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDispatcherTimeline,
  preferredHomeWorkspaceId,
  selectRunPreview,
  workspaceAssetsFromRuns,
} from "../app/studio/shared/selectors.ts";

const emptyAssets = {
  sourceImageReady: false,
  imageReady: false,
  modelReady: false,
  topologyReady: false,
  riggedReady: false,
  sourceImageDownloadUrl: null,
  imageDownloadUrl: null,
  modelDownloadUrl: null,
  topologyDownloadUrl: null,
  riggedDownloadUrl: null,
};

test("home workspace selection prefers the busiest non-default workspace", () => {
  const workspaces = [
    { id: "default", taskCount: 20 },
    { id: "quiet", taskCount: 1 },
    { id: "busy", taskCount: 3 },
  ];
  assert.equal(preferredHomeWorkspaceId(workspaces), "busy");
  assert.equal(preferredHomeWorkspaceId([{ id: "default", taskCount: 0 }]), "default");
});

test("workspace assets expose only ready downloadable outputs", () => {
  const run = {
    id: "run-1",
    workspaceId: "workspace-1",
    name: "Nova",
    updatedAt: "2026-07-30T10:00:00.000Z",
    previewPath: "/preview/nova.png",
    assets: {
      ...emptyAssets,
      imageReady: true,
      imageDownloadUrl: "/assets/nova.png",
      modelReady: true,
      modelDownloadUrl: "/assets/nova.glb",
    },
  };

  assert.deepEqual(
    workspaceAssetsFromRuns([run], "workspace-1").map((asset) => ({
      id: asset.id,
      group: asset.group,
      previewUrl: asset.previewUrl,
    })),
    [
      { id: "run-1:image", group: "2d", previewUrl: "/preview/nova.png" },
      { id: "run-1:model", group: "3d", previewUrl: "/assets/nova.glb" },
    ],
  );
});

test("dispatcher timeline places generated work after the matching assistant reply", () => {
  const messages = [
    { id: 1, role: "user", content: "生成角色", createdAt: "2026-07-30T10:00:00.000Z" },
    { id: 2, role: "assistant", content: "开始生成", createdAt: "2026-07-30T10:00:02.000Z" },
  ];
  const generations = [{
    id: "generation-1",
    createdAt: "2026-07-30T10:00:01.000Z",
  }];
  const timeline = buildDispatcherTimeline(messages, generations, [], []);

  assert.deepEqual(
    timeline.map((entry) => `${entry.kind}:${entry.item.id}`),
    ["message:1", "message:2", "generation:generation-1"],
  );
});

test("run preview is derived from stage and ready assets", () => {
  const run = {
    previewPath: "/preview.png",
    qaOverlayPath: "/qa.png",
    assets: {
      ...emptyAssets,
      modelReady: true,
      modelDownloadUrl: "/model.glb",
    },
  };
  assert.deepEqual(selectRunPreview(run, 3), {
    kind: "model",
    label: "静态 GLB",
    url: "/model.glb",
  });
  assert.deepEqual(selectRunPreview(run, 2), {
    kind: "qa",
    label: "SDPose 覆盖图",
    url: "/qa.png",
  });
});
