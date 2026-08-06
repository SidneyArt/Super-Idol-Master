import { existsSync, statSync, unlinkSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { RUN_SELECT } from "../runs/index.mjs";

const DEFINITIONS = {
  source: { column: "sourceImagePathInternal", group: "2d", label: "原始原画", downloadKind: "source", rigged: false },
  image: { column: "imagePathInternal", group: "2d", label: "2D 概念图", downloadKind: "image", rigged: false },
  model: { column: "modelPathInternal", group: "3d", label: "静态 GLB", downloadKind: "model", rigged: false },
  topology: { column: "topologyPathInternal", group: "3d", label: "拓扑 GLB", downloadKind: "topology", rigged: false },
  rigged: { column: "riggedModelPathInternal", group: "3d", label: "绑定 GLB", downloadKind: "rigged", rigged: true },
};

const CASCADE = {
  source: ["source", "image", "model", "topology", "rigged"],
  image: ["image", "model", "topology", "rigged"],
  model: ["model", "topology", "rigged"],
  topology: ["topology", "rigged"],
  rigged: ["rigged"],
};

export function createAssetsFeature({
  db,
  runs,
  activeJobs,
  outputRoot,
  generatedDir,
  getWorkspace,
  now = () => new Date().toISOString(),
}) {
  function isControlledPath(filePath) {
    const candidate = resolve(filePath);
    const normalized = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    return [outputRoot, generatedDir].some((root) => {
      const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
      return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${sep}`);
    });
  }

  function deleteFile(filePath) {
    if (!filePath) return;
    if (!isControlledPath(filePath)) throw new Error("拒绝删除工作目录之外的文件");
    if (existsSync(filePath) && statSync(filePath).isFile()) unlinkSync(filePath);
  }

  function generatedFileFromPreviewUrl(value) {
    if (typeof value !== "string" || !value.startsWith("/generated/")) return null;
    return join(generatedDir, basename(value.split("?")[0]));
  }

  function listWorkspace(workspaceId) {
    if (!getWorkspace(workspaceId)) throw new Error("工作空间不存在");
    const rows = db.prepare(`${RUN_SELECT} WHERE workspace_id = ? ORDER BY updated_at DESC`).all(workspaceId);
    return rows.flatMap((row) => Object.entries(DEFINITIONS).flatMap(([kind, definition]) => {
      const filePath = row[definition.column];
      if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return [];
      const file = statSync(filePath);
      return [{
        id: `${row.id}:${kind}`,
        workspaceId,
        runId: row.id,
        runName: row.name,
        kind,
        group: definition.group,
        label: definition.label,
        downloadUrl: `/api/runs/${row.id}/download/${definition.downloadKind}`,
        previewUrl: definition.group === "3d" ? `/api/runs/${row.id}/download/${definition.downloadKind}` : `/api/runs/${row.id}/preview/${definition.downloadKind}`,
        filename: basename(filePath),
        size: file.size,
        createdAt: file.mtime.toISOString(),
        rigged: definition.rigged,
      }];
    }));
  }

  function removeWorkspaceAsset(workspaceId, runId, kind) {
    const run = runs.getInternal(runId);
    if (!run || run.workspaceId !== workspaceId) throw new Error("资产不存在或不属于该工作空间");
    if (activeJobs.has(runId) || run.jobStatus === "running") throw new Error("任务正在执行，暂时不能删除资产");
    const cascadeKinds = CASCADE[kind];
    if (!cascadeKinds) throw new Error("未知资产类型");
    for (const cascadeKind of cascadeKinds) deleteFile(run[DEFINITIONS[cascadeKind].column]);
    if (kind === "source") deleteFile(generatedFileFromPreviewUrl(run.sourcePreviewPath));
    if (kind === "image") {
      deleteFile(generatedFileFromPreviewUrl(run.previewPath));
      deleteFile(generatedFileFromPreviewUrl(run.qaOverlayPath));
    }
    const updatedAt = now();
    const updates = {
      source: `current_stage = 0, source_image_path = NULL, source_preview_path = NULL, image_path = NULL, preview_path = NULL, model_path = NULL, topology_path = NULL, rigged_model_path = NULL, qa_status = 'pending', qa_score = NULL, qa_summary = '', qa_metrics = '{}', qa_overlay_path = NULL`,
      image: `current_stage = MIN(current_stage, 1), image_path = NULL, preview_path = NULL, model_path = NULL, topology_path = NULL, rigged_model_path = NULL, qa_status = 'pending', qa_score = NULL, qa_summary = '', qa_metrics = '{}', qa_overlay_path = NULL`,
      model: `current_stage = MIN(current_stage, 3), model_path = NULL, topology_path = NULL, rigged_model_path = NULL`,
      topology: `current_stage = MIN(current_stage, 4), topology_path = NULL, rigged_model_path = NULL`,
      rigged: `current_stage = MIN(current_stage, 5), rigged_model_path = NULL`,
    };
    db.prepare(`
      UPDATE runs SET ${updates[kind]}, status = 'active', job_type = 'none',
        generation_status = 'idle', generation_message = '', generation_progress = 0,
        generation_prompt_id = NULL, generation_current_node = NULL, updated_at = ? WHERE id = ?
    `).run(updatedAt, runId);
    runs.addEvent(runId, "asset_deleted", Math.min(run.currentStage, { source: 0, image: 1, model: 3, topology: 4, rigged: 5 }[kind]), `从资产库删除 ${DEFINITIONS[kind].label}`, updatedAt);
    return { ok: true, deletedKinds: cascadeKinds, assets: listWorkspace(workspaceId) };
  }

  function runAsset(runId, kind) {
    const run = runs.getInternal(runId);
    if (!run) return null;
    const paths = {
      source: run.sourceImagePathInternal,
      image: run.imagePathInternal,
      model: run.modelPathInternal,
      topology: run.topologyPathInternal,
      rigged: run.riggedModelPathInternal,
    };
    return Object.hasOwn(paths, kind) ? { run, filePath: paths[kind] } : undefined;
  }

  return {
    deleteFile,
    generatedFileFromPreviewUrl,
    isControlledPath,
    listWorkspace,
    removeWorkspaceAsset,
    runAsset,
  };
}
