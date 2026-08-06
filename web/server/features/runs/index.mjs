import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const RUN_SELECT = `
  SELECT id, workspace_id AS workspaceId, pipeline_type AS pipelineType, name, positive_prompt AS positivePrompt,
         negative_prompt AS negativePrompt, current_stage AS currentStage,
         status, qa_status AS qaStatus, generation_status AS jobStatus,
         generation_message AS jobMessage, generation_progress AS jobProgress,
         generation_prompt_id AS jobPromptId, generation_current_node AS jobCurrentNode,
         job_type AS jobType, preview_path AS previewPath,
         image_path AS imagePathInternal, model_path AS modelPathInternal,
         topology_path AS topologyPathInternal,
         source_image_path AS sourceImagePathInternal, source_preview_path AS sourcePreviewPath,
         rigged_model_path AS riggedModelPathInternal,
         qa_score AS qaScore, qa_summary AS qaSummary, qa_metrics AS qaMetricsJson,
         qa_overlay_path AS qaOverlayPath,
         created_at AS createdAt, updated_at AS updatedAt
  FROM runs
`;

function normalizePipelineType(value) {
  if (value === undefined || value === null || value === "") return "text_to_model";
  if (!["text_to_model", "image_to_model"].includes(value)) throw new Error("未知任务工作流");
  return value;
}

export function createRunsFeature({
  db,
  activeJobs,
  cleanText,
  exists = existsSync,
  id = randomUUID,
  now = () => new Date().toISOString(),
  notify = () => {},
  resolveSourceImage = () => null,
  canPreserveRepairSource = () => false,
}) {
  function getInternal(runId) {
    return db.prepare(`${RUN_SELECT} WHERE id = ?`).get(runId);
  }

  function serialize(row) {
    if (!row) return null;
    const {
      imagePathInternal,
      sourceImagePathInternal,
      modelPathInternal,
      topologyPathInternal,
      riggedModelPathInternal,
      qaMetricsJson,
      ...publicRow
    } = row;
    let qaMetrics = {};
    try {
      qaMetrics = JSON.parse(qaMetricsJson || "{}");
    } catch {
      qaMetrics = {};
    }
    return {
      ...publicRow,
      qaMetrics,
      assets: {
        sourceImageReady: Boolean(sourceImagePathInternal && exists(sourceImagePathInternal)),
        imageReady: Boolean(imagePathInternal && exists(imagePathInternal)),
        modelReady: Boolean(modelPathInternal && exists(modelPathInternal)),
        topologyReady: Boolean(topologyPathInternal && exists(topologyPathInternal)),
        riggedReady: Boolean(riggedModelPathInternal && exists(riggedModelPathInternal)),
        sourceImageDownloadUrl: sourceImagePathInternal ? `/api/runs/${row.id}/download/source` : null,
        imageDownloadUrl: imagePathInternal ? `/api/runs/${row.id}/download/image` : null,
        modelDownloadUrl: modelPathInternal ? `/api/runs/${row.id}/download/model` : null,
        topologyDownloadUrl: topologyPathInternal ? `/api/runs/${row.id}/download/topology` : null,
        riggedDownloadUrl: riggedModelPathInternal ? `/api/runs/${row.id}/download/rigged` : null,
      },
    };
  }

  function addEvent(runId, eventType, stage, message, createdAt = now()) {
    db.prepare(`
      INSERT INTO run_events (run_id, event_type, stage, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, eventType, stage, message, createdAt);
    const notificationKinds = {
      generation_succeeded: ["generation_completed", "图片生成完成"],
      qa_passed: ["stage_completed", "T-Pose 质检完成"],
      qa_failed: ["generation_failed", "T-Pose 质检未通过"],
      model_succeeded: ["generation_completed", "3D 模型生成完成"],
      topology_succeeded: ["generation_completed", "自动拓扑完成"],
      rig_succeeded: ["generation_completed", "自动绑骨完成"],
      pipeline_completed: ["pipeline_completed", "角色资产流程已完成"],
      "2d_failed": ["generation_failed", "图片生成失败"],
      "3d_failed": ["generation_failed", "3D 模型生成失败"],
      topology_failed: ["generation_failed", "自动拓扑失败"],
      rig_failed: ["generation_failed", "自动绑骨失败"],
    };
    const notification = notificationKinds[eventType];
    if (notification) {
      const run = getInternal(runId);
      notify({
        kind: notification[0],
        title: notification[1],
        message: run ? `${run.name}：${message}` : message,
        workspaceId: run?.workspaceId || null,
        runId,
      });
    }
  }

  function events(runId) {
    return db.prepare(`
      SELECT id, event_type AS eventType, stage, message, created_at AS createdAt
      FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 100
    `).all(runId);
  }

  function get(runId) {
    return { run: serialize(getInternal(runId)), events: events(runId) };
  }

  function list(workspaceId = null) {
    const rows = workspaceId
      ? db.prepare(`${RUN_SELECT} WHERE workspace_id = ? ORDER BY updated_at DESC`).all(workspaceId)
      : db.prepare(`${RUN_SELECT} ORDER BY updated_at DESC`).all();
    return rows.map(serialize);
  }

  function create(input = {}) {
    const workspaceId = typeof input.workspaceId === "string" && input.workspaceId ? input.workspaceId : "default";
    if (!db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId)) throw new Error("工作空间不存在");
    const kind = normalizePipelineType(input.pipelineType);
    const source = resolveSourceImage(input);
    if (kind === "image_to_model" && !source && input.requireSourceImage === true) throw new Error("图生模型工作流需要角色原画");
    const runId = id();
    const createdAt = now();
    db.prepare(`
      INSERT INTO runs (
        id, workspace_id, pipeline_type, name, positive_prompt, negative_prompt,
        source_image_path, source_preview_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      workspaceId,
      kind,
      cleanText(input.name, 80, "资产名称", true),
      cleanText(input.positivePrompt, 4000, "正向提示词"),
      cleanText(input.negativePrompt, 2000, "反向提示词"),
      source?.filePath || null,
      source?.previewPath || null,
      createdAt,
      createdAt,
    );
    addEvent(runId, "created", 0, kind === "image_to_model" ? "创建图生模型角色任务" : "创建文生模型角色任务", createdAt);
    db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(createdAt, workspaceId);
    return get(runId);
  }

  function remove(runId) {
    const run = getInternal(runId);
    if (!run) throw new Error("任务不存在");
    if (activeJobs.has(runId) || run.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能删除");
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    return { ok: true };
  }

  function reset(runId) {
    const run = getInternal(runId);
    if (!run) throw new Error("任务不存在");
    if (activeJobs.has(runId) || run.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能重置");
    const updatedAt = now();
    db.prepare(`
      UPDATE runs SET current_stage = 0, status = 'active', qa_status = 'pending',
        job_type = 'none', generation_status = 'idle', generation_message = '', generation_progress = 0,
        generation_prompt_id = NULL, generation_current_node = NULL, preview_path = NULL,
        image_path = NULL, model_path = NULL, topology_path = NULL, rigged_model_path = NULL,
        qa_score = NULL, qa_summary = '', qa_metrics = '{}', qa_overlay_path = NULL, updated_at = ? WHERE id = ?
    `).run(updatedAt, runId);
    addEvent(runId, "reset", 0, "流程和产物引用已重置", updatedAt);
    return get(runId);
  }

  function confirm(runId, input = {}) {
    const run = getInternal(runId);
    if (!run) throw new Error("任务不存在");
    if (run.jobStatus === "running") throw new Error("当前任务仍在执行");
    if (run.currentStage !== 0) throw new Error("角色设定已经确认");
    const positivePrompt = cleanText(input.positivePrompt ?? run.positivePrompt, 4000, "正向提示词", true);
    const negativePrompt = cleanText(input.negativePrompt ?? run.negativePrompt, 2000, "负向提示词");
    const updatedAt = now();
    db.prepare(`
      UPDATE runs SET positive_prompt = ?, negative_prompt = ?, current_stage = 1,
        status = 'active', updated_at = ? WHERE id = ?
    `).run(positivePrompt, negativePrompt, updatedAt, runId);
    addEvent(runId, "idea_confirmed", 0, "角色设定已确认，进入 2D 生成", updatedAt);
    return get(runId);
  }

  function advance(runId, reason = "用户确认当前阶段产物") {
    const run = getInternal(runId);
    if (!run) throw new Error("任务不存在");
    if (activeJobs.has(runId) || run.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能确认阶段");
    const stage = run.currentStage;
    if (stage < 1 || stage > 5) throw new Error("当前阶段不能执行完成确认");
    if (stage === 1 && (!run.imagePathInternal || !exists(run.imagePathInternal))) throw new Error("2D 概念图尚未生成完成");
    if (stage === 2 && run.qaStatus !== "passed") throw new Error("T-Pose 检查尚未通过");
    if (stage === 3 && (!run.modelPathInternal || !exists(run.modelPathInternal))) throw new Error("静态 GLB 尚未生成完成");
    if (stage === 4 && (!run.topologyPathInternal || !exists(run.topologyPathInternal))) throw new Error("拓扑 GLB 尚未生成完成");
    if (stage === 5 && (!run.riggedModelPathInternal || !exists(run.riggedModelPathInternal))) throw new Error("绑骨 GLB 尚未生成完成");
    const nextStage = stage + 1;
    const updatedAt = now();
    const stageNames = ["角色描述", "概念图生成", "T-Pose 检查", "3D 模型生成", "自动拓扑", "自动绑骨", "资产导出"];
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        UPDATE runs SET current_stage = ?, status = ?, job_type = 'none',
          generation_status = 'idle', generation_message = '', generation_progress = 0,
          generation_prompt_id = NULL, generation_current_node = NULL, updated_at = ? WHERE id = ?
      `).run(nextStage, nextStage === 6 ? "completed" : "active", updatedAt, runId);
      addEvent(runId, "stage_confirmed", stage, `${cleanText(reason, 240, "推进原因", true)}；进入“${stageNames[nextStage]}”`, updatedAt);
      if (nextStage === 6) addEvent(runId, "pipeline_completed", 6, "角色资产流水线完成，可下载最终 GLB", updatedAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return get(runId);
  }

  function revert(runId, targetStage) {
    const run = getInternal(runId);
    if (!run) throw new Error("任务不存在");
    if (activeJobs.has(runId) || run.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能回退");
    if (!Number.isInteger(targetStage)) throw new Error("回退阶段必须是整数");
    if (targetStage < 0) throw new Error("回退阶段不能小于 0");
    if (targetStage >= run.currentStage) throw new Error("只能回退到当前阶段之前的已完成阶段");
    if (run.pipelineType === "image_to_model" && targetStage === 0 && run.sourceImagePathInternal && !exists(run.sourceImagePathInternal)) {
      throw new Error("角色原画文件已丢失，请重新创建任务");
    }
    const updatedAt = now();
    const keepQa = targetStage >= 3;
    const stageNames = ["角色描述", "概念图生成", "T-Pose 检查", "3D 模型生成", "自动拓扑", "自动绑骨", "资产导出"];
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        UPDATE runs SET current_stage = ?, status = 'active', job_type = 'none',
          generation_status = 'idle', generation_message = '', generation_progress = 0,
          generation_prompt_id = NULL, generation_current_node = NULL,
          preview_path = ?, image_path = ?, model_path = ?, topology_path = ?, rigged_model_path = NULL,
          qa_status = ?, qa_score = ?, qa_summary = ?, qa_metrics = ?, qa_overlay_path = ?, updated_at = ? WHERE id = ?
      `).run(
        targetStage,
        targetStage >= 2 ? run.previewPath : null,
        targetStage >= 2 ? run.imagePathInternal : null,
        targetStage >= 4 ? run.modelPathInternal : null,
        targetStage >= 5 ? run.topologyPathInternal : null,
        keepQa ? run.qaStatus : "pending",
        keepQa ? run.qaScore : null,
        keepQa ? run.qaSummary : "",
        keepQa ? run.qaMetricsJson : "{}",
        keepQa ? run.qaOverlayPath : null,
        updatedAt,
        runId,
      );
      addEvent(runId, "stage_reverted", targetStage, `流程回退到“${stageNames[targetStage]}”，下游产物引用已清除`, updatedAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return get(runId);
  }

  function updatePrompts(runId, {
    positivePrompt,
    negativePrompt,
    reason = "Agent 更新角色提示词",
    preserveTposeRepairSource = false,
  }) {
    const run = getInternal(runId);
    if (!run) throw new Error("任务不存在");
    if (activeJobs.has(runId) || run.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能修改提示词");
    const preservesRepairSource = preserveTposeRepairSource && canPreserveRepairSource(run) && exists(run.imagePathInternal);
    if (run.currentStage > 1 && !preservesRepairSource) throw new Error("已有下游资产，请先回退到概念图生成阶段再修改提示词");
    if (positivePrompt === undefined && negativePrompt === undefined) throw new Error("至少需要更新一项提示词");
    const nextPositive = cleanText(positivePrompt ?? run.positivePrompt, 4000, "正向提示词", true);
    const nextNegative = cleanText(negativePrompt ?? run.negativePrompt, 2000, "负向提示词");
    const updatedAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        UPDATE runs SET positive_prompt = ?, negative_prompt = ?,
          generation_status = 'idle', generation_message = '', generation_progress = 0,
          generation_prompt_id = NULL, generation_current_node = NULL,
          preview_path = CASE WHEN current_stage = 1 THEN NULL ELSE preview_path END,
          image_path = CASE WHEN current_stage = 1 THEN NULL ELSE image_path END,
          model_path = CASE WHEN current_stage = 1 THEN NULL ELSE model_path END,
          topology_path = CASE WHEN current_stage = 1 THEN NULL ELSE topology_path END,
          rigged_model_path = CASE WHEN current_stage = 1 THEN NULL ELSE rigged_model_path END,
          qa_status = CASE WHEN current_stage = 1 THEN 'pending' ELSE qa_status END,
          qa_score = CASE WHEN current_stage = 1 THEN NULL ELSE qa_score END,
          qa_summary = CASE WHEN current_stage = 1 THEN '' ELSE qa_summary END,
          qa_metrics = CASE WHEN current_stage = 1 THEN '{}' ELSE qa_metrics END,
          qa_overlay_path = CASE WHEN current_stage = 1 THEN NULL ELSE qa_overlay_path END,
          updated_at = ? WHERE id = ?
      `).run(nextPositive, nextNegative, updatedAt, runId);
      addEvent(runId, "agent_prompt_updated", run.currentStage, cleanText(reason, 240, "更新原因", true), updatedAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return get(runId);
  }

  function advanceWorkflow(runId, reason = "用户确认当前阶段产物") {
    const run = getInternal(runId);
    if (!run) throw new Error("任务不存在");
    return run.currentStage === 0 ? confirm(runId) : advance(runId, reason);
  }

  return {
    addEvent,
    advance,
    advanceWorkflow,
    confirm,
    create,
    events,
    get,
    getInternal,
    list,
    remove,
    reset,
    revert,
    serialize,
    updatePrompts,
  };
}
