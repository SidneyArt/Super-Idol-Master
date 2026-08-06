import { randomUUID } from "node:crypto";
import { RUN_SELECT } from "../runs/index.mjs";

export function createWorkspacesFeature({
  db,
  activeJobs,
  activeDispatcherJobs,
  cleanText,
  deleteControlledAssetFile,
  generatedFileFromPreviewUrl,
  isControlledAssetPath,
  taskAgent,
  coordinatorAgent,
  id = randomUUID,
  now = () => new Date().toISOString(),
}) {
  function get(workspaceId) {
    return db.prepare(`
      SELECT id, name, description, created_at AS createdAt, updated_at AS updatedAt
      FROM workspaces WHERE id = ?
    `).get(workspaceId);
  }

  function list() {
    return db.prepare(`
      SELECT workspaces.id, workspaces.name, workspaces.description,
             workspaces.created_at AS createdAt, workspaces.updated_at AS updatedAt,
             COUNT(runs.id) AS taskCount,
             SUM(CASE WHEN runs.status = 'completed' THEN 1 ELSE 0 END) AS completedCount,
             SUM(CASE WHEN runs.generation_status = 'running' THEN 1 ELSE 0 END) AS runningCount
      FROM workspaces LEFT JOIN runs ON runs.workspace_id = workspaces.id
      GROUP BY workspaces.id ORDER BY workspaces.updated_at DESC
    `).all().map((item) => ({
      ...item,
      taskCount: Number(item.taskCount || 0),
      completedCount: Number(item.completedCount || 0),
      runningCount: Number(item.runningCount || 0),
    }));
  }

  function create(input = {}) {
    const workspaceId = id();
    const createdAt = now();
    db.prepare(`
      INSERT INTO workspaces (id, name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      workspaceId,
      cleanText(input.name, 80, "工作空间名称", true),
      cleanText(input.description, 500, "工作空间描述"),
      createdAt,
      createdAt,
    );
    return get(workspaceId);
  }

  function remove(value) {
    const workspaceId = cleanText(value, 80, "工作空间 ID", true);
    if (workspaceId === "default") throw new Error("默认工作空间不能删除");
    if (!get(workspaceId)) throw new Error("工作空间不存在");
    const workspaceRuns = db.prepare(`${RUN_SELECT} WHERE workspace_id = ?`).all(workspaceId);
    if (workspaceRuns.some((run) => activeJobs.has(run.id) || run.jobStatus === "running" || taskAgent().isBusy(run.id))) {
      throw new Error("该工作空间仍有任务正在执行，完成或停止后才能删除");
    }
    const generations = db.prepare(`
      SELECT id, status, preview_path AS previewPath, output_path AS outputPath
      FROM dispatcher_generations WHERE workspace_id = ?
    `).all(workspaceId);
    if (generations.some((generation) => generation.status === "running" || activeDispatcherJobs.has(generation.id))) {
      throw new Error("该工作空间仍有合集图生成任务正在执行，完成或停止后才能删除");
    }
    if (coordinatorAgent().status().running) throw new Error("总调度 Agent 正在处理消息，完成或停止后才能删除工作空间");
    if (db.prepare(`SELECT 1 FROM approval_requests WHERE workspace_id = ? AND status = 'executing' LIMIT 1`).get(workspaceId)) {
      throw new Error("该工作空间仍有审批操作正在执行，完成后才能删除");
    }

    const files = new Set();
    for (const run of workspaceRuns) {
      files.add(run.sourceImagePathInternal);
      files.add(run.imagePathInternal);
      files.add(run.modelPathInternal);
      files.add(run.topologyPathInternal);
      files.add(run.riggedModelPathInternal);
      files.add(generatedFileFromPreviewUrl(run.sourcePreviewPath));
      files.add(generatedFileFromPreviewUrl(run.previewPath));
      files.add(generatedFileFromPreviewUrl(run.qaOverlayPath));
    }
    for (const generation of generations) {
      files.add(generation.outputPath);
      files.add(generatedFileFromPreviewUrl(generation.previewPath));
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        DELETE FROM agent_permission_modes
        WHERE scope_type = 'task' AND scope_id IN (SELECT id FROM runs WHERE workspace_id = ?)
      `).run(workspaceId);
      db.prepare("DELETE FROM approval_requests WHERE workspace_id = ?").run(workspaceId);
      db.prepare("DELETE FROM app_notifications WHERE workspace_id = ?").run(workspaceId);
      db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    let cleanupFailedCount = 0;
    for (const filePath of files) {
      if (!filePath || !isControlledAssetPath(filePath)) continue;
      try {
        deleteControlledAssetFile(filePath);
      } catch {
        cleanupFailedCount += 1;
      }
    }
    return { ok: true, cleanupFailedCount, workspaces: list() };
  }

  return { create, get, list, remove };
}
