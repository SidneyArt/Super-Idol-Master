import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ASSET_AGENT_ROLES, createAssetAgentRuntime, normalizeVisualQaReport } from "./agent-runtime.mjs";

test("asset agent status exposes every implemented role", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, current_stage INTEGER NOT NULL DEFAULT 0)");
  const runtime = createAssetAgentRuntime({
    db,
    getRunDetail: () => ({ run: { currentStage: 0 } }),
    updatePrompts: () => {},
    advanceWorkflow: () => {},
    revertWorkflow: () => {},
    runStageJob: () => {},
    getAgentConfig: () => ({ apiKey: "", model: "step-3.7-flash" }),
    getRunImagePath: () => null,
    getRunReferenceImagePath: () => null,
    getAssetInspection: () => ({}),
    addRunEvent: () => {},
    getPermissionMode: () => "request",
    requestApproval: () => {},
  });

  assert.deepEqual(runtime.status().roles, ASSET_AGENT_ROLES);
  assert.deepEqual(ASSET_AGENT_ROLES, [
    "supervisor",
    "art_director",
    "visual_qa",
    "character_consistency",
    "asset_inspector",
    "rigging_qa",
    "export_specialist",
    "workflow_doctor",
  ]);
  db.close();
});

test("visual QA cannot pass when its own summary identifies held weapons", () => {
  const report = normalizeVisualQaReport({
    assetKind: "humanoid",
    fullBody: true,
    singleSubject: true,
    frontFacing: true,
    armsHorizontal: true,
    limbsUnoccluded: true,
    handsEmpty: true,
    whiteBackground: true,
    identityConsistent: null,
    confidence: 0.96,
    issues: [],
    decision: "pass",
    summary: "角色保持标准 T-Pose，但画面中手持双刀和苦无，背景为纯白。",
  }, { status: "passed" });

  assert.equal(report.handsEmpty, false);
  assert.equal(report.decision, "repairable");
  assert.match(report.issues.join(" "), /仍持有道具或武器/);
});

test("visual QA cannot pass when its own summary identifies a gradient background", () => {
  const report = normalizeVisualQaReport({
    assetKind: "humanoid",
    fullBody: true,
    singleSubject: true,
    frontFacing: true,
    armsHorizontal: true,
    limbsUnoccluded: true,
    handsEmpty: true,
    whiteBackground: true,
    identityConsistent: null,
    confidence: 0.93,
    issues: [],
    decision: "pass",
    summary: "人物完整清晰，背景为灰色渐变背景。",
  }, { status: "passed" });

  assert.equal(report.whiteBackground, false);
  assert.equal(report.decision, "repairable");
  assert.match(report.issues.join(" "), /背景不是纯白/);
});

test("visual QA does not treat explicit negative evidence as a held prop", () => {
  const report = normalizeVisualQaReport({
    assetKind: "humanoid",
    fullBody: true,
    singleSubject: true,
    frontFacing: true,
    armsHorizontal: true,
    limbsUnoccluded: true,
    handsEmpty: true,
    whiteBackground: true,
    identityConsistent: null,
    confidence: 0.95,
    issues: [],
    decision: "pass",
    summary: "角色双手完全空置，没有手持任何武器，背景为纯白。",
  }, { status: "passed" });

  assert.equal(report.handsEmpty, true);
  assert.equal(report.decision, "pass");
});
