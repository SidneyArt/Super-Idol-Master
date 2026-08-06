import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { createCoordinatorRuntime } from "../../coordinator-runtime.mjs";
import { buildCoordinatorImagePrompts, buildSingleCharacterTaskPrompts } from "../../coordinator-image-prompts.mjs";
import { RUN_SELECT } from "../runs/index.mjs";

export function createCoordinatorFeature({
  activeDispatcherJobs, approvalRuntime, assetStorage, cleanText, db, generatedDir,
  getAgents, getAssetAgent, gpuScheduler, outputRoot, pythonCommand, repoRoot,
  runs, scripts, settingsStore, workspaces,
}) {
  const { addEvent, events: getEvents, getInternal: getRunRow, serialize: serializeRun } = runs;
  const getWorkspace = workspaces.get;
  let runtime;
  function publishCoordinatorAgentActivity({ runId, kind, agentRole, status, message }) {
    const batches = db.prepare(`
      SELECT workspace_id AS workspaceId, session_id AS sessionId, run_ids AS runIds
      FROM dispatcher_task_batches ORDER BY created_at DESC LIMIT 100
    `).all();
    const batch = batches.find((item) => {
      try {
        return JSON.parse(item.runIds || "[]").includes(runId);
      } catch {
        return false;
      }
    });
    if (!batch?.sessionId) return;
    const run = getRunRow(runId);
    if (!run) return;
    const roleLabels = {
      art_director: "Art Director",
      visual_qa: "Visual QA",
      character_consistency: "Character Consistency",
      asset_inspector: "Asset Inspector",
      rigging_qa: "Rigging QA",
      export_specialist: "Export Specialist",
      workflow_doctor: "Workflow Doctor",
    };
    const statusLabels = { running: "执行中", succeeded: "已完成", failed: "失败", completed: "已完成", blocked: "已暂停" };
    const source = kind === "role" ? roleLabels[agentRole] || agentRole : "Supervisor 自动流水线";
    runtime.addActivityMessage(
      batch.workspaceId,
      batch.sessionId,
      `**子 Agent · ${run.name} · ${source}（${statusLabels[status] || status || "更新"}）**\n\n${String(message || "状态已更新").slice(0, 1000)}`,
    );
  }
  
  async function createCoordinatorTasks({ workspaceId, tasks, image, sessionId = "", target = "model" }) {
    if (!getWorkspace(workspaceId)) throw new Error("工作空间不存在");
    const usesImage = tasks.some((task) => task.pipelineType === "image_to_model");
    let cropPaths = [];
    if (usesImage) {
      if (!image) throw new Error("图生模型批量任务需要上传合集原画");
      if (tasks.some((task) => task.pipelineType === "image_to_model" && !task.bounds)) throw new Error("每个图生模型任务都需要角色裁切框");
      const uploaded = assetStorage.saveSourceImage(image, `sheet-${randomUUID()}`);
      const imageTasks = tasks.filter((task) => task.pipelineType === "image_to_model");
      const cropDir = join(outputRoot, "crops", randomUUID());
      mkdirSync(cropDir, { recursive: true });
      const result = spawnSync(pythonCommand, [
        scripts.crop,
        uploaded.filePath,
        cropDir,
        JSON.stringify(imageTasks.map((task) => task.bounds)),
      ], {
        cwd: repoRoot,
        windowsHide: true,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, PYTHONUTF8: "1" },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error((result.stderr || "角色原画裁切失败").trim().slice(-1200));
      const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      cropPaths = JSON.parse(lines.at(-1) || "[]");
      if (cropPaths.length !== imageTasks.length) throw new Error("角色原画裁切结果数量不一致");
    }
  
    let imageIndex = 0;
    const created = [];
    for (const task of tasks) {
      let sourceImagePath = null;
      let sourcePreviewPath = null;
      if (task.pipelineType === "image_to_model") {
        const cropPath = resolve(cropPaths[imageIndex]);
        imageIndex += 1;
        if (!cropPath.startsWith(`${outputRoot}${sep}`) || !existsSync(cropPath)) throw new Error("角色裁切结果不在受控目录中");
        const previewName = `source-${randomUUID()}.png`;
        const previewFile = join(generatedDir, previewName);
        copyFileSync(cropPath, previewFile);
        sourceImagePath = previewFile;
        sourcePreviewPath = `/generated/${previewName}?v=${Date.now()}`;
      }
      const taskPrompts = buildSingleCharacterTaskPrompts(task);
      created.push(runs.create({
        workspaceId,
        pipelineType: task.pipelineType,
        name: task.name,
        positivePrompt: taskPrompts.positivePrompt,
        negativePrompt: taskPrompts.negativePrompt,
        sourceImagePath,
        sourcePreviewPath,
        requireSourceImage: task.pipelineType === "image_to_model",
      }));
    }
    if (sessionId && created.length) {
      db.prepare(`
        INSERT INTO dispatcher_task_batches (id, workspace_id, session_id, target, run_ids, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        workspaceId,
        String(sessionId).trim().slice(0, 80),
        String(target || "model").trim().slice(0, 40),
        JSON.stringify(created.map((item) => item.run.id)),
        new Date().toISOString(),
      );
    }
    return created;
  }
  
  function getDispatcherGeneration(id) {
    return db.prepare(`
      SELECT id, workspace_id AS workspaceId, session_id AS sessionId, title, character_count AS characterCount,
             prompt, status, message, preview_path AS previewPath,
             created_at AS createdAt, updated_at AS updatedAt
      FROM dispatcher_generations WHERE id = ?
    `).get(id) || null;
  }
  
  const COORDINATOR_STAGE_NAMES = ["角色描述", "概念图生成", "T-Pose 检查", "3D 模型生成", "自动拓扑", "自动绑骨", "资产导出"];
  
  function coordinatorTaskStageState(run, plan) {
    if (run.status === "completed") return "completed";
    if (run.jobStatus === "running") return "running";
    if (run.jobStatus === "failed") return "failed";
    if (plan?.status === "blocked" || plan?.status === "failed") return plan.status;
    if (plan?.status === "completed") return "completed";
    if (plan?.status === "running") return "running";
    return "waiting";
  }
  
  function getCoordinatorTaskExecutionStatus(workspaceId, runId = null) {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) throw new Error("工作空间不存在");
    const rows = runId
      ? [getRunRow(runId)].filter((run) => run?.workspaceId === workspaceId)
      : db.prepare(`${RUN_SELECT} WHERE workspace_id = ? ORDER BY updated_at DESC`).all(workspaceId);
    if (runId && !rows.length) throw new Error("当前工作空间中不存在该任务");
  
    const tasks = rows.map((row) => {
      const run = serializeRun(row);
      const plan = getAssetAgent().getWorkflowPlan(row.id);
      const roleRuns = getAssetAgent().getRoleRuns(row.id, 12).map((roleRun) => ({
        id: roleRun.id,
        agentRole: roleRun.agentRole,
        triggerType: roleRun.triggerType,
        status: roleRun.status,
        summary: roleRun.report?.summary || roleRun.errorMessage || null,
        createdAt: roleRun.createdAt,
        completedAt: roleRun.completedAt,
      }));
      const runningRole = roleRuns.find((roleRun) => roleRun.status === "running");
      const stageState = coordinatorTaskStageState(run, plan);
      const activeStep = run.jobStatus === "running"
        ? { kind: "job", type: run.jobType, node: run.jobCurrentNode, progress: run.jobProgress, message: run.jobMessage }
        : runningRole
          ? { kind: "agent_role", role: runningRole.agentRole, message: runningRole.summary }
          : plan?.status === "running"
            ? { kind: "workflow", target: plan.target, message: plan.message }
            : { kind: stageState, message: run.jobMessage || plan?.message || null };
      return {
        id: run.id,
        name: run.name,
        pipelineType: run.pipelineType,
        currentStage: run.currentStage,
        currentStageName: COORDINATOR_STAGE_NAMES[run.currentStage] || "未知阶段",
        stageState,
        stages: COORDINATOR_STAGE_NAMES.map((name, index) => ({
          index,
          name,
          status: index < run.currentStage ? "completed" : index === run.currentStage ? stageState : "pending",
        })),
        status: run.status,
        qa: { status: run.qaStatus, score: run.qaScore, summary: run.qaSummary },
        job: {
          status: run.jobStatus,
          type: run.jobType,
          progress: run.jobProgress,
          currentNode: run.jobCurrentNode,
          message: run.jobMessage,
        },
        activeStep,
        workflowPlan: plan,
        agentRoles: roleRuns,
        assets: run.assets,
        recentEvents: getEvents(row.id).slice(0, 12),
        updatedAt: run.updatedAt,
      };
    });
  
    return {
      workspace: { id: workspace.id, name: workspace.name },
      taskCount: tasks.length,
      tasks,
      queriedAt: new Date().toISOString(),
    };
  }
  
  function getLatestDispatcherGenerationImage(workspaceId, sessionId = "") {
    const select = `
      SELECT id, title, output_path AS outputPath, updated_at AS updatedAt
      FROM dispatcher_generations
      WHERE workspace_id = ? AND status = 'succeeded' AND output_path IS NOT NULL
    `;
    const candidates = sessionId
      ? db.prepare(`${select} AND session_id = ? ORDER BY updated_at DESC LIMIT 30`).all(workspaceId, sessionId)
      : db.prepare(`${select} ORDER BY updated_at DESC LIMIT 30`).all(workspaceId);
  
    const visited = new Set();
    for (const candidate of candidates) {
      if (visited.has(candidate.id)) continue;
      visited.add(candidate.id);
      try {
        const filePath = safeOutputPath(candidate.outputPath, "file");
        const stats = statSync(filePath);
        if (stats.size > 12 * 1024 * 1024) continue;
        const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
        const mimeType = mimeTypes[extname(filePath).toLowerCase()];
        if (!mimeType) continue;
        return {
          generationId: candidate.id,
          title: candidate.title,
          name: basename(filePath),
          mimeType,
          data: readFileSync(filePath).toString("base64"),
        };
      } catch {
        // A stale generation row must not prevent an older valid result from being inherited.
      }
    }
    return null;
  }
  
  function normalizeCharacterSheetRequest(value) {
    if (!value || typeof value !== "object") return null;
    const characterCount = Number(value.characterCount);
    const characterDescriptions = Array.isArray(value.characterDescriptions)
      ? value.characterDescriptions.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    if (!Number.isInteger(characterCount) || characterCount < 1 || characterCount > 12 || characterDescriptions.length !== characterCount) return null;
    return {
      title: String(value.title || "角色合集图").trim().slice(0, 80) || "角色合集图",
      characterCount,
      styleDescription: String(value.styleDescription || "统一角色美术风格").trim().slice(0, 1000),
      characterDescriptions: characterDescriptions.map((item) => item.slice(0, 500)),
      additionalPrompt: String(value.additionalPrompt || "").trim().slice(0, 2000),
      negativePrompt: String(value.negativePrompt || "").trim().slice(0, 2000),
    };
  }
  
  function getCharacterSheetRequest(workspaceId, sessionId, generationId) {
    const generation = db.prepare(`
      SELECT title, character_count AS characterCount, prompt, request_json AS requestJson
      FROM dispatcher_generations
      WHERE id = ? AND workspace_id = ? AND session_id = ? AND status = 'succeeded'
    `).get(generationId, workspaceId, sessionId);
    if (!generation) return null;
  
    try {
      const normalized = normalizeCharacterSheetRequest(JSON.parse(generation.requestJson || "{}"));
      if (normalized) return normalized;
    } catch {
      // Older completed generations may not have structured request data.
    }
  
    const characterCount = Math.max(1, Math.min(12, Number(generation.characterCount) || 1));
    return {
      title: String(generation.title || "角色合集图").slice(0, 80),
      characterCount,
      styleDescription: "保持所选版本的角色身份、统一美术风格与整体设计语言",
      characterDescriptions: Array.from({ length: characterCount }, (_, index) => `保持所选版本第 ${index + 1} 个角色的身份、服装、配色和职业特征`),
      additionalPrompt: `所选版本完整生成要求：${String(generation.prompt || "").slice(0, 1900)}`,
      negativePrompt: "缺少角色，多余角色，角色重复，角色融合，人物重叠，裁切身体，风格不一致，低质量，模糊，文字，水印",
    };
  }
  
  function getLatestCharacterSheetRequest(workspaceId, sessionId) {
    const generations = db.prepare(`
      SELECT title, character_count AS characterCount, prompt, request_json AS requestJson
      FROM dispatcher_generations
      WHERE workspace_id = ? AND session_id = ? AND status = 'succeeded'
      ORDER BY updated_at DESC LIMIT 30
    `).all(workspaceId, sessionId);
  
    for (const generation of generations) {
      try {
        const normalized = normalizeCharacterSheetRequest(JSON.parse(generation.requestJson || "{}"));
        if (normalized) return normalized;
      } catch {
        // Older rows may not have structured request data.
      }
    }
  
    const approvals = db.prepare(`
      SELECT payload FROM approval_requests
      WHERE scope_type = 'coordinator' AND workspace_id = ? AND operation = 'generate_character_sheet'
      ORDER BY id DESC LIMIT 30
    `).all(workspaceId);
    for (const approval of approvals) {
      try {
        const payload = JSON.parse(approval.payload || "{}");
        if (payload.sessionId !== sessionId) continue;
        const normalized = normalizeCharacterSheetRequest(payload);
        if (normalized) return normalized;
      } catch {
        // Ignore malformed historical approval payloads.
      }
    }
  
    const latest = generations[0];
    if (!latest) return null;
    const characterCount = Math.max(1, Math.min(12, Number(latest.characterCount) || 1));
    return {
      title: String(latest.title || "角色合集图").slice(0, 80),
      characterCount,
      styleDescription: "保持上一版的角色身份、统一美术风格与整体设计语言",
      characterDescriptions: Array.from({ length: characterCount }, (_, index) => `保持上一版第 ${index + 1} 个角色的身份、服装、配色和职业特征`),
      additionalPrompt: `上一版完整生成要求：${String(latest.prompt || "").slice(0, 1900)}`,
      negativePrompt: "缺少角色，多余角色，角色重复，角色融合，人物重叠，裁切身体，风格不一致，低质量，模糊，文字，水印",
    };
  }
  
  function startCharacterSheetGeneration(input = {}) {
    const workspaceId = cleanText(input.workspaceId, 80, "工作空间 ID", true);
    if (!getWorkspace(workspaceId)) throw new Error("工作空间不存在");
    const title = cleanText(input.title, 80, "合集图名称", true);
    const characterCount = Number(input.characterCount);
    if (!Number.isInteger(characterCount) || characterCount < 1 || characterCount > 12) throw new Error("合集图角色数量必须为 1–12 个");
    const descriptions = Array.isArray(input.characterDescriptions)
      ? input.characterDescriptions.map((item, index) => cleanText(item, 500, `角色 ${index + 1} 描述`, true))
      : [];
    if (descriptions.length !== characterCount) throw new Error("角色描述数量必须与合集图角色数量一致");
    const style = cleanText(input.styleDescription, 1000, "统一风格", true);
    const additional = cleanText(input.additionalPrompt, 2000, "补充要求");
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim().slice(0, 80) : "";
    const requestedNegative = cleanText(input.negativePrompt, 2000, "反向提示词");
    const defaultNegative = "角色重复，角色融合，人物重叠，裁切身体，多余人物，文字，水印，低画质，肢体畸形，风格不一致";
    const prompts = buildCoordinatorImagePrompts({
      characterCount,
      descriptions,
      style,
      additional,
      negative: requestedNegative || defaultNegative,
    });
    const { positive, negative } = prompts;
    const imageConfig = settingsStore.coordinatorImageConfig("text_to_model");
    if (!imageConfig.apiKey) throw new Error("总调度文生图 API Key 未配置");
  
    const id = randomUUID();
    const now = new Date().toISOString();
    const requestJson = JSON.stringify({
      workspaceId,
      sessionId,
      title,
      characterCount,
      styleDescription: style,
      characterDescriptions: descriptions,
      additionalPrompt: additional,
      negativePrompt: negative,
    });
    db.prepare(`
      INSERT INTO dispatcher_generations (
        id, workspace_id, session_id, title, character_count, prompt, status, message, request_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', '已加入全局 GPU 队列，等待生成单张角色合集图', ?, ?, ?)
    `).run(id, workspaceId, sessionId, title, characterCount, positive, requestJson, now, now);
    db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(now, workspaceId);
  
    const failGeneration = (errorMessage) => {
      const message = String(errorMessage || "合集图生成失败").trim().slice(-1200);
      db.prepare("UPDATE dispatcher_generations SET status = 'failed', message = ?, updated_at = ? WHERE id = ?")
        .run(message, new Date().toISOString(), id);
      approvalRuntime.addNotification({
        kind: "generation_failed",
        title: "角色合集图生成失败",
        message: `${title}：${message}`,
        workspaceId,
      });
    };
  
    try {
      gpuScheduler.schedule({
        id: `dispatcher:${id}`,
        label: `${title} · 角色合集图`,
        onQueued: ({ position }) => {
          db.prepare(`
            UPDATE dispatcher_generations SET message = ?, updated_at = ?
            WHERE id = ? AND status = 'running'
          `).run(`正在等待全局 GPU 资源（队列第 ${position} 位）`, new Date().toISOString(), id);
        },
        onStartError: (error) => {
          failGeneration(error instanceof Error ? error.message : "合集图生成进程启动失败");
        },
        onCancel: failGeneration,
        start: (lease) => {
          db.prepare(`
            UPDATE dispatcher_generations
            SET message = '正在调用文生图模型生成单张角色合集图', updated_at = ?
            WHERE id = ? AND status = 'running'
          `).run(new Date().toISOString(), id);
          const args = [
            scripts["2d-api"],
            "--positive", positive,
            "--negative", negative,
            "--base-url", imageConfig.baseUrl,
            "--model", imageConfig.model,
          ];
          const child = spawn(pythonCommand, args, {
            cwd: repoRoot,
            windowsHide: true,
            env: { ...process.env, PYTHONUTF8: "1", STEPFUN_IMAGE_API_KEY: imageConfig.apiKey },
          });
          const active = { child, stdout: "", stderr: "", finalized: false, lease };
          activeDispatcherJobs.set(id, active);
          child.stdout.on("data", (chunk) => { active.stdout = `${active.stdout}${chunk.toString("utf8")}`.slice(-100_000); });
          child.stderr.on("data", (chunk) => { active.stderr = `${active.stderr}${chunk.toString("utf8")}`.slice(-100_000); });
  
          const finalize = (success, errorMessage = "") => {
            if (active.finalized) return;
            active.finalized = true;
            activeDispatcherJobs.delete(id);
            const completedAt = new Date().toISOString();
            try {
              if (!success) throw new Error((errorMessage || active.stderr || "合集图生成失败").trim().slice(-1200));
              const lines = active.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
              const source = safeOutputPath(lines.at(-1), "file");
              const previewName = `character-sheet-${id}.png`;
              copyFileSync(source, join(generatedDir, previewName));
              const previewPath = `/generated/${previewName}?v=${Date.now()}`;
              db.prepare(`
                UPDATE dispatcher_generations SET status = 'succeeded', message = '单张角色合集图生成完成',
                  preview_path = ?, output_path = ?, updated_at = ? WHERE id = ?
              `).run(previewPath, source, completedAt, id);
              approvalRuntime.addNotification({
                kind: "generation_completed",
                title: "角色合集图生成完成",
                message: `${title}：已生成包含 ${characterCount} 个角色的单张合集原画`,
                workspaceId,
              });
            } catch (error) {
              failGeneration(error instanceof Error ? error.message : "合集图生成失败");
            } finally {
              lease.release();
            }
          };
          child.on("error", (error) => finalize(false, error.message));
          child.on("close", (code) => finalize(code === 0, code === 0 ? "" : active.stderr || `Python 退出代码 ${code}`));
          return { cancel: () => child.kill() };
        },
      });
    } catch (error) {
      if (getDispatcherGeneration(id)?.status === "running") {
        failGeneration(error instanceof Error ? error.message : "合集图调度失败");
      }
      throw error;
    }
    return getDispatcherGeneration(id);
  }
  
  const COORDINATOR_DELEGATION_REASONS = new Set([
    "总调度 Agent 委派持续执行目标",
    "已批准的总调度任务委派",
  ]);
  
  async function delegateCoordinatorTask(runId, target, reason = "总调度 Agent 委派持续执行目标") {
    const run = getRunRow(runId);
    if (!run) throw new Error("任务不存在");
    addEvent(runId, "coordinator_delegated", run.currentStage, reason);
    return getAssetAgent().scheduleWorkflowPlan(runId, target);
  }

  runtime = createCoordinatorRuntime({
    db,
    getAgentConfig: settingsStore.coordinatorAgentConfig,
    getWorkspaces: workspaces.list,
    createWorkspace: workspaces.create,
    createCharacterTasks: createCoordinatorTasks,
    generateCharacterSheet: startCharacterSheetGeneration,
    getLatestGeneratedImage: getLatestDispatcherGenerationImage,
    getLatestCharacterSheetRequest,
    getCharacterSheetRequest,
    getLatestTaskBatch: (workspaceId, sessionId) => getAgents().dispatcher.taskBatches(workspaceId, sessionId)[0] || null,
    getTaskExecutionStatus: getCoordinatorTaskExecutionStatus,
    delegateTask: (runId, target) => delegateCoordinatorTask(runId, target),
    getImageModelStatus: () => settingsStore.publicSettings().coordinator.imageModels,
    getPermissionMode: () => approvalRuntime.permission("coordinator", "global"),
    requestApproval: approvalRuntime.requestApproval,
  });

  return {
    delegateTask: delegateCoordinatorTask,
    isDelegationReason: (reason) => COORDINATOR_DELEGATION_REASONS.has(reason),
    publishActivity: publishCoordinatorAgentActivity,
    runtime,
  };
}
