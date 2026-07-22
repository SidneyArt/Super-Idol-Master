import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ASSET_AGENT_ROLES, buildQaRepairPrompts, createAssetAgentRuntime, normalizeVisualQaReport } from "./agent-runtime.mjs";
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
    getTaskExecutionStatus: (workspaceId, runId) => ({
      workspace: { id: workspaceId, name: "测试空间" },
      taskCount: 1,
      tasks: [{ id: runId || "run-1", currentStage: 2, currentStageName: "T-Pose 检查", stageState: "running" }],
    }),
    getImageModelStatus: () => ({}),
    getPermissionMode: () => "request",
    requestApproval: () => {},
  });
  const first = runtime.getConversation("workspace-1");
  assert.deepEqual(runtime.inspectTaskExecutionStatus("workspace-1", "run-1").tasks[0], {
    id: "run-1",
    currentStage: 2,
    currentStageName: "T-Pose 检查",
    stageState: "running",
  });
  assert.ok(runtime.addActivityMessage("workspace-1", first.sessionId, "子 Agent 已完成 Visual QA"));
  assert.equal(runtime.addActivityMessage("workspace-1", first.sessionId, "子 Agent 已完成 Visual QA"), null);
  assert.equal(runtime.getConversation("workspace-1").messages.at(-1).content, "子 Agent 已完成 Visual QA");
  db.prepare("INSERT INTO dispatcher_generations (id, workspace_id, session_id) VALUES ('generation-1', 'workspace-1', ?)").run(first.sessionId);
  db.prepare("INSERT INTO dispatcher_task_batches (id, workspace_id, session_id) VALUES ('batch-1', 'workspace-1', ?)").run(first.sessionId);

  const result = runtime.deleteSession("workspace-1", first.sessionId);
  assert.notEqual(result.sessionId, first.sessionId);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM dispatcher_generations").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM dispatcher_task_batches").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspaces").get().count, 1);
  db.close();
});

test("QA repair prompts stay concise and replace prior repair text", () => {
  const prompts = buildQaRepairPrompts({
    positivePrompt: "蓝色王国法师，手持法杖，T-Pose，单人全身，QA 自动修复第 1 轮，失败证据：旧错误，双臂不够水平",
    negativePrompt: "低画质，武器，武器，A-Pose",
  }, "双臂不够水平；背景不是纯白", 2);

  assert.doesNotMatch(prompts.positivePrompt, /第 [12] 轮|失败证据/);
  assert.doesNotMatch(prompts.positivePrompt, /法杖/);
  assert.match(prompts.positivePrompt, /RGB\(255,255,255\)/);
  assert.match(prompts.positivePrompt, /标准 T-Pose/);
  assert.match(prompts.positivePrompt, /双手完全空置且不拿任何道具/);
  assert.equal((prompts.positivePrompt.match(/T-Pose/g) || []).length, 1);
  assert.match(prompts.negativePrompt, /手持物/);
  assert.equal((prompts.negativePrompt.match(/武器/g) || []).length, 1);
  assert.ok(prompts.positivePrompt.length <= 600);
  assert.ok(prompts.negativePrompt.length <= 250);

  const secondRepair = buildQaRepairPrompts(prompts, "仍未通过", 3);
  assert.equal(secondRepair.positivePrompt, prompts.positivePrompt);
  assert.equal(secondRepair.negativePrompt, prompts.negativePrompt);
});

test("failed T-Pose QA repairs prompts and regenerates instead of blocking", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY);
    INSERT INTO runs (id) VALUES ('run-repair');
    CREATE TABLE run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      stage INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const run = {
    id: "run-repair",
    name: "白底修复角色",
    currentStage: 2,
    positivePrompt: "蓝色法师，手持法杖",
    negativePrompt: "低画质",
    jobStatus: "idle",
    jobType: "qa",
    jobMessage: "",
    jobProgress: 100,
    jobPromptId: "qa-failed-1",
    qaStatus: "failed",
    qaScore: 72,
    qaSummary: "双臂不够水平；背景不是纯白",
    qaMetrics: { backgroundPassed: false, whiteBorderRatio: 0.64 },
    assets: { imageReady: true, modelReady: false, topologyReady: false, riggedReady: false },
  };
  const detail = () => ({ run });
  const runtime = createAssetAgentRuntime({
    db,
    getRunDetail: detail,
    updatePrompts: (_runId, prompts) => {
      run.positivePrompt = prompts.positivePrompt;
      run.negativePrompt = prompts.negativePrompt;
      return detail();
    },
    advanceWorkflow: () => detail(),
    revertWorkflow: () => {
      run.currentStage = 1;
      run.qaStatus = "pending";
      run.assets.imageReady = false;
      return detail();
    },
    runStageJob: (_runId, action) => {
      assert.equal(action, "generate_2d");
      run.jobStatus = "running";
      run.jobType = "2d";
      run.jobMessage = "正在重新生成 T-Pose";
      return detail();
    },
    getAgentConfig: () => ({ apiKey: "", model: "step-3.7-flash" }),
    getRunImagePath: () => null,
    getRunReferenceImagePath: () => null,
    getAssetInspection: () => ({}),
    addRunEvent: (runId, eventType, stage, message, createdAt = new Date().toISOString()) => {
      db.prepare("INSERT INTO run_events (run_id, event_type, stage, message, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(runId, eventType, stage, message, createdAt);
    },
    getPermissionMode: () => "auto",
    requestApproval: () => {},
  });

  const plan = await runtime.scheduleWorkflowPlan("run-repair", "model");

  assert.equal(plan.status, "running");
  assert.equal(run.jobStatus, "running");
  assert.match(run.positivePrompt, /RGB\(255,255,255\)/);
  assert.match(run.positivePrompt, /双手完全空置且不拿任何道具/);
  assert.doesNotMatch(run.positivePrompt, /法杖/);
  assert.match(run.negativePrompt, /非纯白背景/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_events WHERE event_type = 'agent_qa_repair_started'").get().count, 1);
  assert.match(runtime.getConversation("run-repair").messages.at(-1).content, /自动修复/);
  db.close();
});

test("coordinator regenerates the selected character sheet with its saved request", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces (id) VALUES ('workspace-1')");
  let generated = null;
  const runtime = createCoordinatorRuntime({
    db,
    getAgentConfig: () => ({ apiKey: "", model: "step-3.7-flash" }),
    getWorkspaces: () => [{ id: "workspace-1", name: "测试空间" }],
    createWorkspace: () => {},
    createCharacterTasks: () => {},
    delegateTask: () => {},
    generateCharacterSheet: (params) => {
      generated = params;
      return { id: "regenerated-1" };
    },
    getLatestGeneratedImage: () => null,
    getLatestCharacterSheetRequest: () => null,
    getCharacterSheetRequest: (workspaceId, sessionId, generationId) => {
      assert.equal(workspaceId, "workspace-1");
      assert.equal(generationId, "generation-older");
      assert.ok(sessionId);
      return {
        title: "三人骑士合集",
        characterCount: 3,
        styleDescription: "统一卡通风格",
        characterDescriptions: ["蓝甲骑士", "森林游侠", "白甲骑士"],
        additionalPrompt: "三人横向排列",
        negativePrompt: "角色重复",
      };
    },
    getLatestTaskBatch: () => null,
    getImageModelStatus: () => ({}),
    getPermissionMode: () => "auto",
    requestApproval: () => {},
  });
  const initial = runtime.getConversation("workspace-1");

  const result = runtime.regenerateCharacterSheet({
    workspaceId: "workspace-1",
    sessionId: initial.sessionId,
    generationId: "generation-older",
  });

  assert.equal(generated.characterCount, 3);
  assert.deepEqual(generated.characterDescriptions, ["蓝甲骑士", "森林游侠", "白甲骑士"]);
  assert.match(generated.styleDescription, /统一卡通风格/);
  assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant"]);
  assert.match(result.messages[1].content, /regenerated-1/);
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

test("visual QA treats cream background evidence as non-white", () => {
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
    summary: "角色姿态正确，但背景为米白色。",
  }, { status: "passed" });

  assert.equal(report.whiteBackground, false);
  assert.equal(report.decision, "repairable");
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
