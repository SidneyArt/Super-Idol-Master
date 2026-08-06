import assert from "node:assert/strict";
import test from "node:test";
import {
  canStartTposeModelRepair,
  captureTposeRepairSource,
  hasRepairableTposeSource,
  isCurrentTposeRepairSource,
} from "./features/quality-gates/tpose-repair-policy.mjs";

function stageTwoRun(qaStatus) {
  return {
    currentStage: 2,
    qaStatus,
    imagePathInternal: "/tmp/current-tpose.png",
  };
}

test("a deterministic SDPose pass remains repairable when semantic QA rejects the current T-Pose", () => {
  const run = stageTwoRun("passed");

  assert.equal(hasRepairableTposeSource(run), true);
  assert.equal(canStartTposeModelRepair(run, true), true);
});

test("T-Pose model repair still requires explicit repair mode and a stage-two image", () => {
  assert.equal(canStartTposeModelRepair(stageTwoRun("failed"), false), false);
  assert.equal(hasRepairableTposeSource(null), false);
  assert.equal(hasRepairableTposeSource({ ...stageTwoRun("failed"), currentStage: 1 }), false);
  assert.equal(hasRepairableTposeSource({ ...stageTwoRun("failed"), imagePathInternal: null }), false);
});

test("an asynchronous repair result is stale after the source run changes", () => {
  const source = {
    id: "run-1",
    ...stageTwoRun("failed"),
    qaMetricsJson: '{"backgroundPassed":false}',
    updatedAt: "2026-08-05T10:00:00.000Z",
  };
  const snapshot = captureTposeRepairSource(source);

  assert.equal(isCurrentTposeRepairSource(snapshot, source), true);
  assert.equal(isCurrentTposeRepairSource(snapshot, {
    ...source,
    imagePathInternal: "/tmp/replaced-tpose.png",
    updatedAt: "2026-08-05T10:00:01.000Z",
  }), false);
  assert.equal(isCurrentTposeRepairSource(snapshot, {
    ...source,
    currentStage: 1,
    qaStatus: "pending",
    imagePathInternal: null,
    updatedAt: "2026-08-05T10:00:01.000Z",
  }), false);
});
