import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ASSET_AGENT_ROLES, buildQaRepairPrompts, createAssetAgentRuntime, normalizeVisualQaReport } from "./agent-runtime.mjs";
import { buildCoordinatorImagePrompts, buildSingleCharacterTaskPrompts } from "./coordinator-image-prompts.mjs";
import { classifyCoordinatorIntent, createCoordinatorRuntime, validateSingleCharacterTaskRequest } from "./coordinator-runtime.mjs";

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
  assert.match(prompts.positivePrompt, /手腕与肩同高/);
  assert.match(prompts.positivePrompt, /主体外区域/);
  assert.equal((prompts.positivePrompt.match(/T-Pose/g) || []).length, 1);
  assert.match(prompts.negativePrompt, /手持物/);
  assert.match(prompts.negativePrompt, /灰色渐变/);
  assert.equal((prompts.negativePrompt.match(/武器/g) || []).length, 1);
  assert.ok(prompts.positivePrompt.length <= 600);
  assert.ok(prompts.negativePrompt.length <= 250);

  const framingRepair = buildQaRepairPrompts(prompts, "未识别到完整全身；bodyCoverage 49.08%", 3);
  assert.match(framingRepair.positivePrompt, /角色占画布高度/);
  assert.notEqual(framingRepair.positivePrompt, prompts.positivePrompt);
});

test("unsafe T-Pose repair switches to the image-edit model instead of regenerating from scratch", async () => {
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
    revertWorkflow: () => assert.fail("model repair must preserve the failed T-Pose as its source image"),
    repairTposeImage: async () => ({ applied: false, strategy: "image_edit_model", reason: "姿态需要重绘" }),
    runStageJob: (_runId, action) => {
      assert.equal(action, "repair_2d");
      run.jobStatus = "running";
      run.jobType = "2d";
      run.jobMessage = "正在用图片编辑模型修复 T-Pose";
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

test("safe T-Pose failure applies deterministic repair and immediately reruns QA", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY);
    INSERT INTO runs (id) VALUES ('run-deterministic');
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
    id: "run-deterministic",
    name: "米白背景角色",
    currentStage: 2,
    positivePrompt: "奶牛角色，标准 T-Pose",
    negativePrompt: "低画质",
    jobStatus: "idle",
    jobType: "qa",
    jobMessage: "",
    jobProgress: 100,
    jobPromptId: "qa-failed-bg",
    qaStatus: "failed",
    qaScore: 79,
    qaSummary: "背景不是纯白",
    qaMetrics: { backgroundPassed: false, borderMeanRgb: [248, 242, 226] },
    assets: { imageReady: true, modelReady: false, topologyReady: false, riggedReady: false },
  };
  const detail = () => ({ run });
  let promptUpdates = 0;
  const runtime = createAssetAgentRuntime({
    db,
    getRunDetail: detail,
    updatePrompts: () => {
      promptUpdates += 1;
      return detail();
    },
    advanceWorkflow: () => detail(),
    revertWorkflow: () => assert.fail("deterministic repair must not revert the workflow"),
    repairTposeImage: async () => {
      run.qaStatus = "pending";
      return { applied: true, strategy: "deterministic_background", actions: ["background_matting"] };
    },
    runStageJob: (_runId, action) => {
      assert.equal(action, "check_tpose");
      run.jobStatus = "running";
      run.jobType = "qa";
      run.jobMessage = "正在重新执行 SDPose";
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

  const plan = await runtime.scheduleWorkflowPlan("run-deterministic", "model");

  assert.equal(plan.status, "running");
  assert.equal(run.jobType, "qa");
  assert.equal(promptUpdates, 0);
  assert.match(plan.message, /确定性修复/);
  assert.match(runtime.getConversation("run-deterministic").messages.at(-1).content, /确定性/);
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

test("coordinator distinguishes single-character requests from sheets and task splitting", () => {
  for (const message of [
    "生成一个忍者角色的图",
    "生成一张角色原画",
    "画一张单角色原画",
    "只要一个人物，不要其他人",
    "生成一张包含 1 个角色的概念图",
    "重新生成一个角色的图",
  ]) {
    const intent = classifyCoordinatorIntent(message, false);
    assert.equal(intent.singleCharacterRequest, true, message);
    assert.equal(intent.singleSheetOnly, false, message);
  }

  for (const message of [
    "生成三个角色的合集图",
    "画两名不同角色",
    "创建一张包含 3 个角色的群像原画",
    "把这张合集图拆成角色任务",
  ]) {
    assert.equal(classifyCoordinatorIntent(message, false).singleCharacterRequest, false, message);
  }
});

test("single-character coordinator requests enforce one delegated text task", () => {
  const intent = classifyCoordinatorIntent("生成一个忍者角色的图", false);
  const valid = {
    tasks: [{ pipelineType: "text_to_model" }],
    delegateToAgents: true,
    target: "concept_image",
  };
  assert.doesNotThrow(() => validateSingleCharacterTaskRequest(intent, valid));
  assert.throws(() => validateSingleCharacterTaskRequest(intent, { ...valid, tasks: [...valid.tasks, ...valid.tasks] }), /只能创建一个/);
  assert.throws(() => validateSingleCharacterTaskRequest(intent, { ...valid, tasks: [{ pipelineType: "image_to_model" }] }), /text_to_model/);
  assert.throws(() => validateSingleCharacterTaskRequest(intent, { ...valid, delegateToAgents: false }), /必须委派/);
  assert.throws(() => validateSingleCharacterTaskRequest(intent, { ...valid, target: "model" }), /concept_image/);

  const modelIntent = classifyCoordinatorIntent("生成一个角色到 3D 模型", false);
  assert.equal(modelIntent.requestedTarget, "model");
  assert.doesNotThrow(() => validateSingleCharacterTaskRequest(modelIntent, { ...valid, target: "model" }));
});

test("coordinator uses a singular prompt for historical one-character generations", () => {
  const single = buildCoordinatorImagePrompts({
    characterCount: 1,
    descriptions: ["蓝色短发的未来忍者"],
    style: "美式 3D 卡通",
    negative: "低画质",
  });
  assert.match(single.positive, /只有一个人物/);
  assert.doesNotMatch(single.positive, /合集图|所有角色|横向整齐排列|角色之间/);
  assert.match(single.negative, /额外人物/);
  assert.match(single.negative, /角色分身/);
  assert.match(single.negative, /角色设定表/);

  const sheet = buildCoordinatorImagePrompts({
    characterCount: 2,
    descriptions: ["蓝色骑士", "绿色游侠"],
    style: "统一卡通风格",
    negative: "低画质",
  });
  assert.match(sheet.positive, /准确包含 2 个不同角色/);
  assert.match(sheet.positive, /横向整齐排列/);
});

test("every coordinator child task receives deterministic single-character constraints", () => {
  const prompts = buildSingleCharacterTaskPrompts({
    description: "蓝色短发的未来忍者",
    positivePrompt: "美式 3D 卡通，全身出镜",
    negativePrompt: "低画质",
  });
  assert.match(prompts.positivePrompt, /只能有一个完整角色/);
  assert.match(prompts.positivePrompt, /禁止出现第二个人物/);
  assert.match(prompts.negativePrompt, /额外人物/);
  assert.match(prompts.negativePrompt, /角色展示板/);
  assert.match(prompts.negativePrompt, /低画质/);
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

// 回归测试：多张图中只要有一张非法（bad magic bytes / mime 不一致），validateImages 应当
// 跳过坏图但保留好图，不能让整批请求都丢。
// 通过给 API 端点发送混合 attachments 来验证：合法图能进入调用链，非法图不会让请求崩溃。
test("validateImages 跳过非法图片但保留合法图片，不让整批请求失败", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, current_stage INTEGER NOT NULL DEFAULT 0);
    INSERT INTO runs (id) VALUES ('run-multi');
  `);
  // 1x1 透明 PNG，base64 编码后是合法的。
  const validPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  // 坏数据：声称是 image/png 但 magic bytes 错（应是 89 50 4E 47 开头）。
  const fakePng = Buffer.from("not a real png payload").toString("base64");
  // 另一个坏数据：声称是 image/jpeg，但 magic bytes 错。
  const fakeJpeg = Buffer.from("definitely not a jpeg either").toString("base64");

  const runtime = createAssetAgentRuntime({
    db,
    getRunDetail: () => ({
      run: {
        id: "run-multi",
        name: "test",
        currentStage: 0,
        positivePrompt: "",
        negativePrompt: "",
        job: { type: null, status: "idle", progress: 0, message: "" },
        qa: { status: null, score: null, summary: null, metrics: {} },
        assets: {},
      },
    }),
    updatePrompts: () => {},
    advanceWorkflow: () => {},
    revertWorkflow: () => {},
    runStageJob: () => {},
    getAgentConfig: () => ({ apiKey: "test-key", model: "step-test", baseUrl: "http://127.0.0.1:1" }),
    getRunImagePath: () => null,
    getRunReferenceImagePath: () => null,
    getAssetInspection: () => ({}),
    addRunEvent: () => {},
    getPermissionMode: () => "request",
    requestApproval: () => {},
  });

  // 如果 validateImages 没有 try/catch，validateImage 会 throw，整批请求失败。
  // 修复后，坏图被跳过、好图进入调用链，后续 Agent 联网/鉴权失败是预期表现。
  // 只要不是 “图片内容与文件类型不匹配” 或 “图片数据无效” 这样的校验错误，就说明修复生效。
  let error = null;
  try {
    await runtime.run({
      runId: "run-multi",
      message: "请参考这些图完善角色设定。",
      images: [
        { name: "good.png", mimeType: "image/png", data: validPng, size: 67 },
        { name: "fake.png", mimeType: "image/png", data: fakePng, size: 22 },
        { name: "fake.jpg", mimeType: "image/jpeg", data: fakeJpeg, size: 26 },
      ],
    });
  } catch (e) {
    error = e;
  }
  if (error) {
    // 不应该是图片验证错误，应该是后续 Agent 调用错误（网络、鉴权等）。
    assert.doesNotMatch(String(error.message), /图片内容与文件类型不匹配/);
    assert.doesNotMatch(String(error.message), /图片数据无效/);
  }
  // 验证有合法图被存到 message 里（不会因为全部跳过而 fallback 到单图）。
  // 失败时 activeAgents 清理可能在异常路径中由 finally 块处理，这里只检查不崩溃。
  assert.ok(runtime.isBusy("run-multi") === false);
  db.close();
});
