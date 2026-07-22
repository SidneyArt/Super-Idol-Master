import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ASSET_AGENT_ROLES, createAssetAgentRuntime, normalizeVisualQaReport } from "./agent-runtime.mjs";
import { createCoordinatorRuntime } from "./coordinator-runtime.mjs";

function createAssetRuntime(db) {
  return createAssetAgentRuntime({
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
}

test("asset agent status exposes every implemented role", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, current_stage INTEGER NOT NULL DEFAULT 0)");
  const runtime = createAssetRuntime(db);

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

test("asset agent session deletion selects a fallback and recreates the final empty session", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, current_stage INTEGER NOT NULL DEFAULT 0); INSERT INTO runs (id) VALUES ('run-1')");
  const runtime = createAssetRuntime(db);
  const first = runtime.getConversation("run-1");
  const second = runtime.startSession("run-1");

  assert.equal(second.sessions.length, 2);
  const afterCurrentDelete = runtime.deleteSession("run-1", second.sessionId);
  assert.equal(afterCurrentDelete.sessionId, first.sessionId);
  assert.equal(afterCurrentDelete.sessions.length, 1);

  const afterFinalDelete = runtime.deleteSession("run-1", first.sessionId);
  assert.notEqual(afterFinalDelete.sessionId, first.sessionId);
  assert.equal(afterFinalDelete.sessions.length, 1);
  assert.equal(afterFinalDelete.sessions[0].messageCount, 0);
  db.close();
});

test("coordinator session deletion removes its timeline metadata without deleting workspace", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    INSERT INTO workspaces (id) VALUES ('workspace-1');
    CREATE TABLE dispatcher_generations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL);
    CREATE TABLE dispatcher_task_batches (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL);
  `);
  const runtime = createCoordinatorRuntime({
    db,
    getAgentConfig: () => ({ apiKey: "", model: "step-3.7-flash" }),
    getWorkspaces: () => [{ id: "workspace-1", name: "测试空间" }],
    createWorkspace: () => {},
    createCharacterTasks: () => {},
    delegateTask: () => {},
    generateCharacterSheet: () => {},
    getLatestGeneratedImage: () => null,
    getLatestCharacterSheetRequest: () => null,
    getLatestTaskBatch: () => null,
    getImageModelStatus: () => ({}),
    getPermissionMode: () => "request",
    requestApproval: () => {},
  });
  const first = runtime.getConversation("workspace-1");
  db.prepare("INSERT INTO dispatcher_generations (id, workspace_id, session_id) VALUES ('generation-1', 'workspace-1', ?)").run(first.sessionId);
  db.prepare("INSERT INTO dispatcher_task_batches (id, workspace_id, session_id) VALUES ('batch-1', 'workspace-1', ?)").run(first.sessionId);

  const result = runtime.deleteSession("workspace-1", first.sessionId);
  assert.notEqual(result.sessionId, first.sessionId);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM dispatcher_generations").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM dispatcher_task_batches").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspaces").get().count, 1);
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
