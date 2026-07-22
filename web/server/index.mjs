import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { createAssetAgentRuntime } from "./agent-runtime.mjs";
import { createApprovalRuntime } from "./approval-runtime.mjs";
import { createCoordinatorRuntime } from "./coordinator-runtime.mjs";
import { jobStartMessage } from "./job-messages.mjs";
import { createSettingsStore, PROCESS_KINDS } from "./settings.mjs";

const serverEntry = fileURLToPath(import.meta.url);
const serverSourceMtimeMs = Math.trunc(statSync(serverEntry).mtimeMs);
const webRoot = join(dirname(serverEntry), "..");
const repoRoot = resolve(webRoot, "..");
const localEnvPath = join(webRoot, ".env.local");
if (existsSync(localEnvPath)) loadEnvFile(localEnvPath);

const HOST = process.env.API_HOST || "127.0.0.1";
const PORT = Number(process.env.API_PORT || 8787);
const DEFAULT_COMFYUI_URL = process.env.COMFYUI_URL || "http://100.120.236.113:8188";
const outputRoot = resolve(repoRoot, "output");
const generatedDir = join(webRoot, "public", "generated");
const dataDir = join(webRoot, "data");
const runtimeWorkflowDir = join(dataDir, "runtime-workflows");
const animationDir = join(dataDir, "mixamo-animations");
const dbPath = process.env.DATABASE_PATH || join(dataDir, "super-idol-master.db");
const pipelineDir = join(webRoot, "server", "pipeline");
const managedPython = process.platform === "win32"
  ? join(pipelineDir, ".venv", "Scripts", "python.exe")
  : join(pipelineDir, ".venv", "bin", "python");
const PYTHON_OVERRIDE = process.env.PYTHON_COMMAND?.trim() || "";
const PYTHON_COMMAND = PYTHON_OVERRIDE || managedPython;
if (!PYTHON_OVERRIDE && !existsSync(managedPython)) {
  throw new Error(`Python 执行环境不存在：${PYTHON_COMMAND}\n请先运行 uv sync --locked --project "${pipelineDir}"`);
}

const scripts = {
  "2d": join(pipelineDir, "run_2d_generation.py"),
  "2d-api": join(pipelineDir, "run_2d_stepfun_api.py"),
  qa: join(pipelineDir, "run_tpose_qa.py"),
  "3d": join(pipelineDir, "run_3d_generation.py"),
  topology: join(pipelineDir, "run_3d_retopology.py"),
  rig: join(pipelineDir, "run_3d_skinning.py"),
  crop: join(pipelineDir, "crop_character_sheet.py"),
};
const workflowFiles = {
  "2d": join(pipelineDir, "2D_Gen_QwenImage2512.json"),
  qa: join(pipelineDir, "TPose_QA_SDPose.json"),
  "3d": join(pipelineDir, "3D_Gen_Pixal3D.json"),
  rig: join(pipelineDir, "3D_Skin_SkinTokens.json"),
};

mkdirSync(dataDir, { recursive: true });
mkdirSync(generatedDir, { recursive: true });
mkdirSync(runtimeWorkflowDir, { recursive: true });
mkdirSync(animationDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
const settingsStore = createSettingsStore({ db, workflowFiles, defaultComfyUrl: DEFAULT_COMFYUI_URL });
db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
const defaultWorkspace = db.prepare("SELECT id FROM workspaces WHERE id = 'default'").get();
if (!defaultWorkspace) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO workspaces (id, name, description, created_at, updated_at)
    VALUES ('default', '默认工作空间', '由现有角色任务自动迁移而来', ?, ?)
  `).run(now, now);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL DEFAULT 'default',
    pipeline_type TEXT NOT NULL DEFAULT 'text_to_model',
    name TEXT NOT NULL,
    positive_prompt TEXT NOT NULL DEFAULT '',
    negative_prompt TEXT NOT NULL DEFAULT '',
    current_stage INTEGER NOT NULL DEFAULT 0 CHECK(current_stage BETWEEN 0 AND 6),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
    qa_status TEXT NOT NULL DEFAULT 'pending' CHECK(qa_status IN ('pending', 'passed', 'failed')),
    generation_status TEXT NOT NULL DEFAULT 'idle' CHECK(generation_status IN ('idle', 'running', 'succeeded', 'failed')),
    generation_message TEXT NOT NULL DEFAULT '',
    generation_progress INTEGER NOT NULL DEFAULT 0 CHECK(generation_progress BETWEEN 0 AND 100),
    generation_prompt_id TEXT,
    generation_current_node TEXT,
    preview_path TEXT,
    job_type TEXT NOT NULL DEFAULT 'none',
    image_path TEXT,
    source_image_path TEXT,
    source_preview_path TEXT,
    model_path TEXT,
    topology_path TEXT,
    rigged_model_path TEXT,
    qa_score INTEGER,
    qa_summary TEXT NOT NULL DEFAULT '',
    qa_metrics TEXT NOT NULL DEFAULT '{}',
    qa_overlay_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    stage INTEGER NOT NULL CHECK(stage BETWEEN 0 AND 6),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events(run_id, id DESC)");
db.exec(`
  CREATE TABLE IF NOT EXISTS animation_assets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    duration REAL NOT NULL,
    track_count INTEGER NOT NULL,
    bone_count INTEGER NOT NULL,
    mapped_bone_count INTEGER NOT NULL,
    compatible INTEGER NOT NULL DEFAULT 0,
    bone_names TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

function addColumn(name, definition) {
  const columns = db.prepare("PRAGMA table_info(runs)").all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
  }
}

addColumn("qa_status", "TEXT NOT NULL DEFAULT 'pending'");
addColumn("generation_status", "TEXT NOT NULL DEFAULT 'idle'");
addColumn("generation_message", "TEXT NOT NULL DEFAULT ''");
addColumn("generation_progress", "INTEGER NOT NULL DEFAULT 0");
addColumn("generation_prompt_id", "TEXT");
addColumn("generation_current_node", "TEXT");
addColumn("job_type", "TEXT NOT NULL DEFAULT 'none'");
addColumn("image_path", "TEXT");
addColumn("model_path", "TEXT");
addColumn("rigged_model_path", "TEXT");
addColumn("qa_score", "INTEGER");
addColumn("qa_summary", "TEXT NOT NULL DEFAULT ''");
addColumn("qa_metrics", "TEXT NOT NULL DEFAULT '{}'");
addColumn("qa_overlay_path", "TEXT");
addColumn("workspace_id", "TEXT NOT NULL DEFAULT 'default'");
addColumn("pipeline_type", "TEXT NOT NULL DEFAULT 'text_to_model'");
addColumn("source_image_path", "TEXT");
addColumn("source_preview_path", "TEXT");
addColumn("topology_path", "TEXT");

function migrateTopologyStage() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get()?.sql || "";
  if (!/current_stage\s+BETWEEN\s+0\s+AND\s+5/i.test(schema)) return;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      CREATE TABLE runs_topology_v2 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        pipeline_type TEXT NOT NULL DEFAULT 'text_to_model',
        name TEXT NOT NULL,
        positive_prompt TEXT NOT NULL DEFAULT '',
        negative_prompt TEXT NOT NULL DEFAULT '',
        current_stage INTEGER NOT NULL DEFAULT 0 CHECK(current_stage BETWEEN 0 AND 6),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
        qa_status TEXT NOT NULL DEFAULT 'pending' CHECK(qa_status IN ('pending', 'passed', 'failed')),
        generation_status TEXT NOT NULL DEFAULT 'idle' CHECK(generation_status IN ('idle', 'running', 'succeeded', 'failed')),
        generation_message TEXT NOT NULL DEFAULT '',
        generation_progress INTEGER NOT NULL DEFAULT 0 CHECK(generation_progress BETWEEN 0 AND 100),
        generation_prompt_id TEXT,
        generation_current_node TEXT,
        preview_path TEXT,
        job_type TEXT NOT NULL DEFAULT 'none',
        image_path TEXT,
        source_image_path TEXT,
        source_preview_path TEXT,
        model_path TEXT,
        topology_path TEXT,
        rigged_model_path TEXT,
        qa_score INTEGER,
        qa_summary TEXT NOT NULL DEFAULT '',
        qa_metrics TEXT NOT NULL DEFAULT '{}',
        qa_overlay_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      INSERT INTO runs_topology_v2 (
        id, workspace_id, pipeline_type, name, positive_prompt, negative_prompt,
        current_stage, status, qa_status, generation_status, generation_message,
        generation_progress, generation_prompt_id, generation_current_node,
        preview_path, job_type, image_path, source_image_path, source_preview_path,
        model_path, topology_path, rigged_model_path, qa_score, qa_summary,
        qa_metrics, qa_overlay_path, created_at, updated_at
      )
      SELECT id, workspace_id, pipeline_type, name, positive_prompt, negative_prompt,
        CASE WHEN current_stage >= 4 THEN current_stage + 1 ELSE current_stage END,
        CASE WHEN current_stage >= 4 THEN 'active' ELSE status END,
        qa_status, generation_status, generation_message, generation_progress,
        generation_prompt_id, generation_current_node, preview_path, job_type,
        image_path, source_image_path, source_preview_path, model_path, NULL,
        CASE WHEN current_stage >= 4 THEN NULL ELSE rigged_model_path END,
        qa_score, qa_summary, qa_metrics, qa_overlay_path, created_at, updated_at
      FROM runs;
      CREATE TABLE run_events_topology_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        stage INTEGER NOT NULL CHECK(stage BETWEEN 0 AND 6),
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      INSERT INTO run_events_topology_v2 (id, run_id, event_type, stage, message, created_at)
      SELECT id, run_id, event_type, CASE WHEN stage >= 4 THEN stage + 1 ELSE stage END, message, created_at
      FROM run_events;
      DROP TABLE run_events;
      DROP TABLE runs;
      ALTER TABLE runs_topology_v2 RENAME TO runs;
      ALTER TABLE run_events_topology_v2 RENAME TO run_events;
      CREATE INDEX run_events_run_id_idx ON run_events(run_id, id DESC);
      CREATE INDEX IF NOT EXISTS runs_workspace_id_idx ON runs(workspace_id, updated_at DESC);
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

migrateTopologyStage();
db.prepare("UPDATE runs SET workspace_id = 'default' WHERE workspace_id IS NULL OR workspace_id = ''").run();
db.prepare("UPDATE runs SET pipeline_type = 'text_to_model' WHERE pipeline_type IS NULL OR pipeline_type = ''").run();
db.exec("CREATE INDEX IF NOT EXISTS runs_workspace_id_idx ON runs(workspace_id, updated_at DESC)");
const approvalRuntime = createApprovalRuntime({ db });
db.exec(`
  CREATE TABLE IF NOT EXISTS dispatcher_generations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    character_count INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
    message TEXT NOT NULL DEFAULT '',
    preview_path TEXT,
    output_path TEXT,
    request_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )
`);
const dispatcherGenerationColumns = db.prepare("PRAGMA table_info(dispatcher_generations)").all();
if (!dispatcherGenerationColumns.some((column) => column.name === "session_id")) {
  db.exec("ALTER TABLE dispatcher_generations ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
}
if (!dispatcherGenerationColumns.some((column) => column.name === "request_json")) {
  db.exec("ALTER TABLE dispatcher_generations ADD COLUMN request_json TEXT NOT NULL DEFAULT '{}'");
}
db.exec("CREATE INDEX IF NOT EXISTS dispatcher_generations_workspace_idx ON dispatcher_generations(workspace_id, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS dispatcher_generations_session_idx ON dispatcher_generations(workspace_id, session_id, updated_at DESC)");
db.prepare("UPDATE dispatcher_generations SET status = 'failed', message = '本地服务重启，合集图生成已中断', updated_at = ? WHERE status = 'running'").run(new Date().toISOString());
db.exec(`
  CREATE TABLE IF NOT EXISTS dispatcher_task_batches (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL,
    run_ids TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS dispatcher_task_batches_session_idx ON dispatcher_task_batches(workspace_id, session_id, created_at DESC)");

db.prepare(`
  UPDATE runs SET generation_status = 'failed', generation_message = '本地服务重启，原 DGX 任务已中断'
  WHERE generation_status = 'running'
`).run();

// Never advance a stage during startup repair. Only move backward when a stage's
// required upstream artifact is missing.
for (const row of db.prepare("SELECT id, current_stage, qa_status, preview_path, image_path, model_path, topology_path, rigged_model_path FROM runs").all()) {
  let imagePath = row.image_path;
  const migratedImage = join(generatedDir, `${row.id}.png`);
  if (!imagePath && row.preview_path && existsSync(migratedImage)) imagePath = migratedImage;
  const hasImage = Boolean(imagePath && existsSync(imagePath));
  const hasModel = Boolean(row.model_path && existsSync(row.model_path));
  const hasTopology = Boolean(row.topology_path && existsSync(row.topology_path));
  const hasRig = Boolean(row.rigged_model_path && existsSync(row.rigged_model_path));
  let stage = Number(row.current_stage || 0);
  if (stage >= 2 && !hasImage) stage = 1;
  if (stage >= 3 && row.qa_status !== "passed") stage = 2;
  if (stage >= 4 && !hasModel) stage = 3;
  if (stage >= 5 && !hasTopology) stage = 4;
  if (stage >= 6 && !hasRig) stage = 5;
  const status = stage === 6 && hasRig ? "completed" : "active";
  db.prepare(`
    UPDATE runs SET image_path = ?, current_stage = ?, status = ?, updated_at = updated_at
    WHERE id = ?
  `).run(imagePath || null, stage, status, row.id);
}

const count = db.prepare("SELECT COUNT(*) AS count FROM runs").get().count;
if (count === 0) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO runs (
      id, name, positive_prompt, negative_prompt, current_stage, status,
      qa_status, generation_status, generation_message, generation_progress,
      preview_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 'active', 'pending', 'idle', '', 0, NULL, ?, ?)
  `).run(
    id,
    "特种兵 / 53 SHAPES",
    "美式3d卡通，1个3d女性角色，Ninjala风格，任天堂风格，潮流配色，(严格正视图:1.3)，完全正对镜头，(严格的T-Pose:1.3)，双臂水平伸展，全身出镜，纯白色背景，极简服装设计，纯净模型，1:1比例，高品质，杰作",
    "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲",
    now,
    now,
  );
  addEvent(id, "created", 0, "创建角色任务", now);
}

const runSelect = `
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

function addEvent(runId, eventType, stage, message, createdAt = new Date().toISOString()) {
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
    const run = getRunRow(runId);
    approvalRuntime.addNotification({
      kind: notification[0],
      title: notification[1],
      message: run ? `${run.name}：${message}` : message,
      workspaceId: run?.workspaceId || null,
      runId,
    });
  }
}

function getRunRow(id) {
  return db.prepare(`${runSelect} WHERE id = ?`).get(id);
}

function serializeRun(row) {
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
      sourceImageReady: Boolean(sourceImagePathInternal && existsSync(sourceImagePathInternal)),
      imageReady: Boolean(imagePathInternal && existsSync(imagePathInternal)),
      modelReady: Boolean(modelPathInternal && existsSync(modelPathInternal)),
      topologyReady: Boolean(topologyPathInternal && existsSync(topologyPathInternal)),
      riggedReady: Boolean(riggedModelPathInternal && existsSync(riggedModelPathInternal)),
      sourceImageDownloadUrl: sourceImagePathInternal ? `/api/runs/${row.id}/download/source` : null,
      imageDownloadUrl: imagePathInternal ? `/api/runs/${row.id}/download/image` : null,
      modelDownloadUrl: modelPathInternal ? `/api/runs/${row.id}/download/model` : null,
      topologyDownloadUrl: topologyPathInternal ? `/api/runs/${row.id}/download/topology` : null,
      riggedDownloadUrl: riggedModelPathInternal ? `/api/runs/${row.id}/download/rigged` : null,
    },
  };
}

function getEvents(id) {
  return db.prepare(`
    SELECT id, event_type AS eventType, stage, message, created_at AS createdAt
    FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 100
  `).all(id);
}

function runDetail(id) {
  return { run: serializeRun(getRunRow(id)), events: getEvents(id) };
}

function revertRun(runId, targetStage) {
  const run = getRunRow(runId);
  if (!run) throw new Error("任务不存在");
  if (activeJobs.has(runId) || run.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能回退");
  if (!Number.isInteger(targetStage) || targetStage < 0 || targetStage >= run.currentStage) {
    throw new Error("只能回退到当前阶段之前的已完成阶段");
  }

  const now = new Date().toISOString();
  const keepImage = targetStage >= 2 ? run.imagePathInternal : null;
  const keepPreview = targetStage >= 2 ? run.previewPath : null;
  const keepQa = targetStage >= 3;
  const keepModel = targetStage >= 4 ? run.modelPathInternal : null;
  const keepTopology = targetStage >= 5 ? run.topologyPathInternal : null;
  const stageNames = ["角色描述", "概念图生成", "T-Pose 检查", "3D 模型生成", "自动拓扑", "自动绑骨", "资产导出"];

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE runs SET current_stage = ?, status = 'active', job_type = 'none',
        generation_status = 'idle', generation_message = '', generation_progress = 0,
        generation_prompt_id = NULL, generation_current_node = NULL,
        preview_path = ?, image_path = ?, model_path = ?, topology_path = ?, rigged_model_path = NULL,
        qa_status = ?, qa_score = ?, qa_summary = ?, qa_metrics = ?, qa_overlay_path = ?,
        updated_at = ? WHERE id = ?
    `).run(
      targetStage,
      keepPreview,
      keepImage,
      keepModel,
      keepTopology,
      keepQa ? run.qaStatus : "pending",
      keepQa ? run.qaScore : null,
      keepQa ? run.qaSummary : "",
      keepQa ? run.qaMetricsJson : "{}",
      keepQa ? run.qaOverlayPath : null,
      now,
      runId,
    );
    addEvent(runId, "stage_reverted", targetStage, `流程回退到“${stageNames[targetStage]}”，下游产物引用已清除`, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return runDetail(runId);
}

function advanceRun(runId, reason = "用户确认当前阶段产物") {
  const run = getRunRow(runId);
  if (!run) throw new Error("任务不存在");
  if (activeJobs.has(runId) || run.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能确认阶段");

  const stage = run.currentStage;
  if (stage < 1 || stage > 5) throw new Error("当前阶段不能执行完成确认");
  if (stage === 1 && (!run.imagePathInternal || !existsSync(run.imagePathInternal))) throw new Error("2D 概念图尚未生成完成");
  if (stage === 2 && run.qaStatus !== "passed") throw new Error("T-Pose 检查尚未通过");
  if (stage === 3 && (!run.modelPathInternal || !existsSync(run.modelPathInternal))) throw new Error("静态 GLB 尚未生成完成");
  if (stage === 4 && (!run.topologyPathInternal || !existsSync(run.topologyPathInternal))) throw new Error("拓扑 GLB 尚未生成完成");
  if (stage === 5 && (!run.riggedModelPathInternal || !existsSync(run.riggedModelPathInternal))) throw new Error("绑骨 GLB 尚未生成完成");

  const nextStage = stage + 1;
  const now = new Date().toISOString();
  const stageNames = ["角色描述", "概念图生成", "T-Pose 检查", "3D 模型生成", "自动拓扑", "自动绑骨", "资产导出"];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE runs SET current_stage = ?, status = ?, job_type = 'none',
        generation_status = 'idle', generation_message = '', generation_progress = 0,
        generation_prompt_id = NULL, generation_current_node = NULL, updated_at = ?
      WHERE id = ?
    `).run(nextStage, nextStage === 6 ? "completed" : "active", now, runId);
    addEvent(runId, "stage_confirmed", stage, `${cleanText(reason, 240, "推进原因", true)}；进入“${stageNames[nextStage]}”`, now);
    if (nextStage === 6) addEvent(runId, "pipeline_completed", 6, "角色资产流水线完成，可下载最终 GLB", now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return runDetail(runId);
}

function updateRunPrompts(runId, { positivePrompt, negativePrompt, reason = "Agent 更新角色提示词" }) {
  const run = getRunRow(runId);
  if (!run) throw new Error("任务不存在");
  if (activeJobs.has(runId) || run.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能修改提示词");
  if (run.currentStage > 1) throw new Error("已有下游资产，请先回退到概念图生成阶段再修改提示词");
  if (positivePrompt === undefined && negativePrompt === undefined) throw new Error("至少需要更新一项提示词");

  const nextPositive = cleanText(positivePrompt ?? run.positivePrompt, 4000, "正向提示词", true);
  const nextNegative = cleanText(negativePrompt ?? run.negativePrompt, 2000, "负向提示词");
  const now = new Date().toISOString();
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
    `).run(nextPositive, nextNegative, now, runId);
    addEvent(runId, "agent_prompt_updated", run.currentStage, cleanText(reason, 240, "更新原因", true), now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return runDetail(runId);
}

function confirmCharacterIdea(runId, input = {}) {
  const run = getRunRow(runId);
  if (!run) throw new Error("任务不存在");
  if (run.jobStatus === "running") throw new Error("当前任务仍在执行");
  if (run.currentStage !== 0) throw new Error("角色设定已经确认");
  const positivePrompt = cleanText(input.positivePrompt ?? run.positivePrompt, 4000, "正向提示词", true);
  const negativePrompt = cleanText(input.negativePrompt ?? run.negativePrompt, 2000, "负向提示词");
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE runs SET positive_prompt = ?, negative_prompt = ?, current_stage = 1,
      status = 'active', updated_at = ? WHERE id = ?
  `).run(positivePrompt, negativePrompt, now, runId);
  addEvent(runId, "idea_confirmed", 0, "角色设定已确认，进入 2D 生成", now);
  return runDetail(runId);
}

function advanceWorkflow(runId, reason = "用户确认当前阶段产物") {
  const run = getRunRow(runId);
  if (!run) throw new Error("任务不存在");
  return run.currentStage === 0 ? confirmCharacterIdea(runId) : advanceRun(runId, reason);
}

function runStageJob(runId, action) {
  const jobTypes = { generate_2d: "2d", check_tpose: "qa", generate_3d: "3d", retopologize: "topology", rig: "rig" };
  const jobType = jobTypes[action];
  if (!jobType) throw new Error("未知阶段任务");
  return startJob(runId, jobType);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = new Set([
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:3100",
    "http://localhost:3100",
    "http://127.0.0.1:3101",
    "http://localhost:3101",
  ]);
  if (origin && allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readBody(req, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function cleanText(value, maxLength, field, required = false) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new Error(`${field}不能为空`);
  if (text.length > maxLength) throw new Error(`${field}不能超过 ${maxLength} 个字符`);
  return text;
}

const MIXAMO_TARGET_BONES = new Set([
  "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
  "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
  "RightShoulder", "RightArm", "RightForeArm", "RightHand",
  "LeftHandThumb1", "LeftHandThumb2", "LeftHandThumb3",
  "LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3",
  "LeftHandMiddle1", "LeftHandMiddle2", "LeftHandMiddle3",
  "LeftHandRing1", "LeftHandRing2", "LeftHandRing3",
  "RightHandThumb1", "RightHandThumb2", "RightHandThumb3",
  "RightHandIndex1", "RightHandIndex2", "RightHandIndex3",
  "RightHandMiddle1", "RightHandMiddle2", "RightHandMiddle3",
  "RightHandRing1", "RightHandRing2", "RightHandRing3",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
  "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
]);
const MIXAMO_REQUIRED_BONES = new Set([
  "Hips", "Spine", "Head",
  "LeftArm", "LeftForeArm", "LeftHand",
  "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot",
  "RightUpLeg", "RightLeg", "RightFoot",
]);

function normalizeMixamoBoneName(value) {
  return String(value || "").replace(/^mixamorig[:_]?/i, "");
}

async function inspectAnimationFbx(buffer) {
  if (!buffer.length || buffer.length > 15 * 1024 * 1024) throw new Error("动画 FBX 不能为空且不能超过 15 MB");
  if (!globalThis.self) globalThis.self = globalThis;
  const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  let object;
  try {
    object = new FBXLoader().parse(bytes, "");
  } catch (error) {
    throw new Error(`FBX 解析失败：${error instanceof Error ? error.message : "文件格式不受支持"}`);
  }
  const clip = object.animations?.[0];
  if (!clip || !clip.tracks.length || !(clip.duration > 0)) throw new Error("FBX 中没有可播放的动画片段");
  const boneNames = [...new Set(clip.tracks.map((track) => normalizeMixamoBoneName(track.name.split(".")[0])).filter(Boolean))];
  const mappedBoneCount = boneNames.filter((name) => MIXAMO_TARGET_BONES.has(name)).length;
  const compatible = [...MIXAMO_REQUIRED_BONES].every((name) => boneNames.includes(name));
  return {
    clipName: clip.name || "mixamo.com",
    duration: Number(clip.duration.toFixed(4)),
    trackCount: clip.tracks.length,
    boneCount: boneNames.length,
    mappedBoneCount,
    compatible,
    boneNames,
  };
}

const animationSelect = `
  SELECT id, name, filename, file_path AS filePath, size, duration,
    track_count AS trackCount, bone_count AS boneCount, mapped_bone_count AS mappedBoneCount,
    compatible, bone_names AS boneNamesJson, created_at AS createdAt, updated_at AS updatedAt
  FROM animation_assets
`;

function serializeAnimationAsset(row) {
  if (!row) return null;
  let boneNames = [];
  try {
    boneNames = JSON.parse(row.boneNamesJson || "[]");
  } catch {
    boneNames = [];
  }
  const publicRow = { ...row };
  delete publicRow.filePath;
  delete publicRow.boneNamesJson;
  return {
    ...publicRow,
    compatible: Boolean(row.compatible),
    boneNames,
    fileUrl: `/api/animations/${encodeURIComponent(row.id)}/file`,
  };
}

function getAnimationAsset(id) {
  return db.prepare(`${animationSelect} WHERE id = ?`).get(id);
}

function listAnimationAssets() {
  return db.prepare(`${animationSelect} ORDER BY created_at ASC`).all()
    .filter((row) => row.filePath && existsSync(row.filePath) && statSync(row.filePath).isFile())
    .map(serializeAnimationAsset);
}

async function createAnimationAsset(input = {}) {
  const filename = basename(cleanText(input.filename, 180, "动画文件名", true));
  if (extname(filename).toLowerCase() !== ".fbx") throw new Error("只支持 Mixamo FBX 动画文件");
  const encoded = typeof input.data === "string" ? input.data.replace(/^data:[^,]+,/, "").replace(/\s+/g, "") : "";
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("动画文件内容无效");
  const buffer = Buffer.from(encoded, "base64");
  const inspection = await inspectAnimationFbx(buffer);
  const id = randomUUID();
  const filePath = join(animationDir, `${id}.fbx`);
  const now = new Date().toISOString();
  const name = cleanText(input.name, 80, "动画名称") || basename(filename, extname(filename));
  writeFileSync(filePath, buffer, { flag: "wx" });
  try {
    db.prepare(`
      INSERT INTO animation_assets (
        id, name, filename, file_path, size, duration, track_count, bone_count,
        mapped_bone_count, compatible, bone_names, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, filename, filePath, buffer.length, inspection.duration, inspection.trackCount,
      inspection.boneCount, inspection.mappedBoneCount, inspection.compatible ? 1 : 0,
      JSON.stringify(inspection.boneNames), now, now,
    );
  } catch (error) {
    if (existsSync(filePath)) unlinkSync(filePath);
    throw error;
  }
  return serializeAnimationAsset(getAnimationAsset(id));
}

function deleteAnimationAsset(id) {
  const row = getAnimationAsset(id);
  if (!row) throw new Error("动画不存在");
  const candidate = resolve(row.filePath);
  const root = resolve(animationDir);
  const normalized = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  if (!(normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${sep}`))) throw new Error("拒绝删除动画目录之外的文件");
  if (existsSync(candidate) && statSync(candidate).isFile()) unlinkSync(candidate);
  db.prepare("DELETE FROM animation_assets WHERE id = ?").run(id);
  return { ok: true, animations: listAnimationAssets() };
}

function pipelineType(value) {
  if (value === undefined || value === null || value === "") return "text_to_model";
  if (!["text_to_model", "image_to_model"].includes(value)) throw new Error("未知任务工作流");
  return value;
}

function getWorkspace(id) {
  return db.prepare(`
    SELECT id, name, description, created_at AS createdAt, updated_at AS updatedAt
    FROM workspaces WHERE id = ?
  `).get(id);
}

function getWorkspacesSummary() {
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

function createWorkspaceRecord(input = {}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO workspaces (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    cleanText(input.name, 80, "工作空间名称", true),
    cleanText(input.description, 500, "工作空间描述"),
    now,
    now,
  );
  return getWorkspace(id);
}

function saveSourceImage(image, prefix = randomUUID()) {
  if (!image || typeof image !== "object") return null;
  const mimeType = typeof image.mimeType === "string" ? image.mimeType.toLowerCase() : "";
  const extensions = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
  const extension = extensions[mimeType];
  if (!extension) throw new Error("原画只支持 PNG、JPEG 或 WebP");
  const raw = typeof image.data === "string" ? image.data.replace(/^data:[^;]+;base64,/, "") : "";
  if (!raw || !/^[a-zA-Z0-9+/=\r\n]+$/.test(raw)) throw new Error("原画数据无效");
  const data = Buffer.from(raw, "base64");
  if (!data.length || data.length > 12 * 1024 * 1024) throw new Error("原画不能超过 12 MB");
  const isPng = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const isWebp = data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  if ((mimeType === "image/png" && !isPng) || (mimeType === "image/jpeg" && !isJpeg) || (mimeType === "image/webp" && !isWebp)) {
    throw new Error("原画内容与文件类型不匹配");
  }
  const filename = `${prefix}${extension}`;
  const filePath = join(generatedDir, filename);
  writeFileSync(filePath, data);
  return { filePath, previewPath: `/generated/${filename}?v=${Date.now()}`, mimeType };
}

function createRunRecord(input = {}) {
  const workspaceId = typeof input.workspaceId === "string" && input.workspaceId ? input.workspaceId : "default";
  if (!getWorkspace(workspaceId)) throw new Error("工作空间不存在");
  const kind = pipelineType(input.pipelineType);
  const source = input.sourceImagePath
    ? (() => {
        const filePath = resolve(input.sourceImagePath);
        const inGenerated = filePath.startsWith(`${generatedDir}${sep}`);
        const inOutput = filePath.startsWith(`${outputRoot}${sep}`);
        if ((!inGenerated && !inOutput) || !existsSync(filePath) || !statSync(filePath).isFile()) throw new Error("角色原画不在受控目录中");
        return { filePath, previewPath: input.sourcePreviewPath || null };
      })()
    : saveSourceImage(input.sourceImage, `source-${randomUUID()}`);
  if (kind === "image_to_model" && !source && input.requireSourceImage === true) throw new Error("图生模型工作流需要角色原画");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO runs (
      id, workspace_id, pipeline_type, name, positive_prompt, negative_prompt,
      source_image_path, source_preview_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    workspaceId,
    kind,
    cleanText(input.name, 80, "资产名称", true),
    cleanText(input.positivePrompt, 4000, "正向提示词"),
    cleanText(input.negativePrompt, 2000, "反向提示词"),
    source?.filePath || null,
    source?.previewPath || null,
    now,
    now,
  );
  addEvent(id, "created", 0, kind === "image_to_model" ? "创建图生模型角色任务" : "创建文生模型角色任务", now);
  db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(now, workspaceId);
  return runDetail(id);
}

function safeOutputPath(value, expected = "any") {
  if (!value) throw new Error("生成脚本没有返回产物路径");
  const candidate = resolve(value);
  if (candidate !== outputRoot && !candidate.startsWith(`${outputRoot}${sep}`)) {
    throw new Error("生成结果不在项目 output 目录中");
  }
  if (!existsSync(candidate)) throw new Error("生成脚本返回的产物不存在");
  const stats = statSync(candidate);
  if (expected === "file" && !stats.isFile()) throw new Error("生成脚本没有返回有效文件");
  return candidate;
}

function findLatestGlb(value) {
  const rootPath = safeOutputPath(value);
  if (statSync(rootPath).isFile()) {
    if (extname(rootPath).toLowerCase() !== ".glb") throw new Error("绑骨任务没有返回 GLB");
    return rootPath;
  }
  const candidates = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const target = join(folder, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (extname(entry.name).toLowerCase() === ".glb") candidates.push(target);
    }
  };
  visit(rootPath);
  if (!candidates.length) throw new Error("SkinTokens 已完成，但没有下载到绑骨 GLB");
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

function inspectGlb(filePath, requireRig = false) {
  const descriptor = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(20);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) throw new Error("GLB 文件头不完整");
    if (header.toString("ascii", 0, 4) !== "glTF" || header.readUInt32LE(4) !== 2) throw new Error("产物不是有效的 glTF 2.0 GLB");
    const declaredLength = header.readUInt32LE(8);
    if (declaredLength !== statSync(filePath).size) throw new Error("GLB 声明长度与文件大小不一致");
    const jsonLength = header.readUInt32LE(12);
    if (header.toString("ascii", 16, 20) !== "JSON" || jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) throw new Error("GLB JSON chunk 无效");
    const jsonChunk = Buffer.alloc(jsonLength);
    if (readSync(descriptor, jsonChunk, 0, jsonLength, 20) !== jsonLength) throw new Error("GLB JSON chunk 不完整");
    const document = JSON.parse(jsonChunk.toString("utf8").replace(/[\u0000 ]+$/g, ""));
    const meshCount = document.meshes?.length || 0;
    const skinCount = document.skins?.length || 0;
    const jointCount = (document.skins || []).reduce((total, skin) => total + (skin.joints?.length || 0), 0);
    const primitiveCount = (document.meshes || []).reduce((total, mesh) => total + (mesh.primitives?.length || 0), 0);
    const morphTargetCount = (document.meshes || []).reduce(
      (total, mesh) => total + (mesh.primitives || []).reduce((sum, primitive) => sum + (primitive.targets?.length || 0), 0),
      0,
    );
    if (meshCount < 1) throw new Error("GLB 中没有可用 mesh");
    if (requireRig && (skinCount < 1 || jointCount < 1)) throw new Error("SkinTokens 产物没有 skin/joints，拒绝标记为绑骨完成");
    return {
      fileSizeBytes: declaredLength,
      meshCount,
      primitiveCount,
      morphTargetCount,
      materialCount: document.materials?.length || 0,
      textureCount: document.textures?.length || 0,
      imageCount: document.images?.length || 0,
      animationCount: document.animations?.length || 0,
      skinCount,
      jointCount,
      nodeCount: document.nodes?.length || 0,
      sceneCount: document.scenes?.length || 0,
      defaultScenePresent: Number.isInteger(document.scene) && Boolean(document.scenes?.[document.scene]),
    };
  } finally {
    closeSync(descriptor);
  }
}

const activeJobs = new Map();
const activeDispatcherJobs = new Map();

function persistJobProgress(runId, jobType, progress, message, node = null) {
  db.prepare(`
    UPDATE runs
    SET generation_progress = ?, generation_message = ?, generation_current_node = ?, updated_at = ?
    WHERE id = ? AND generation_status = 'running' AND job_type = ?
  `).run(Math.max(1, Math.min(99, Math.round(progress))), message, node, new Date().toISOString(), runId, jobType);
}

function connectComfyProgress(runId, jobType, promptId, clientId, comfyUrl, workflow) {
  const wsUrl = `${comfyUrl.replace(/^http/i, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`;
  const socket = new WebSocket(wsUrl);
  const expected = Math.max(Object.keys(workflow).length, 1);
  const completed = new Set();
  let currentNode = null;
  let lastProgress = 5;

  const update = (fraction, message, node = currentNode) => {
    const progress = Math.max(lastProgress, 5 + Math.min(1, fraction) * 90);
    lastProgress = progress;
    persistJobProgress(runId, jobType, progress, message, node ? String(node) : null);
  };

  socket.addEventListener("open", () => update(0.01, "ComfyUI 已进入队列，等待执行"));
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data);
      const data = message.data || {};
      if (data.prompt_id && data.prompt_id !== promptId) return;
      if (message.type === "execution_start") {
        update(0.02, "ComfyUI 已开始执行工作流");
      } else if (message.type === "execution_cached") {
        for (const node of data.nodes || []) completed.add(String(node));
        update(completed.size / expected, `复用 ${completed.size} 个缓存节点`);
      } else if (message.type === "executed" && data.node) {
        completed.add(String(data.node));
        update(completed.size / expected, `节点 ${data.node} 执行完成`, data.node);
      } else if (message.type === "executing" && data.node) {
        currentNode = String(data.node);
        update(completed.size / expected, `正在执行节点 ${data.node}`, data.node);
      } else if (message.type === "progress" && Number(data.max) > 0) {
        currentNode = String(data.node || currentNode || "");
        const nodeFraction = Number(data.value) / Number(data.max);
        update((completed.size + nodeFraction) / expected, `节点 ${currentNode || "-"}：${data.value}/${data.max}`, currentNode);
      }
    } catch {
      // Binary preview frames and messages from other clients are ignored.
    }
  });
  socket.addEventListener("error", () => {
    persistJobProgress(runId, jobType, lastProgress, "实时事件流中断，后端仍在核对 ComfyUI 历史", currentNode);
  });
  return socket;
}

function jobArguments(run, jobType) {
  if (jobType === "2d") {
    return [
      "--positive", run.positivePrompt,
      "--negative", run.negativePrompt || "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲",
    ];
  }
  if (jobType === "qa") return [run.imagePathInternal];
  if (jobType === "3d") return [run.imagePathInternal];
  if (jobType === "topology") return [run.modelPathInternal];
  if (jobType === "rig") return [run.topologyPathInternal];
  throw new Error("未知 DGX 任务类型");
}

function completeJob(runId, jobType, stdout, execution = {}) {
  const now = new Date().toISOString();
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines.at(-1) || "";
  const jobPromptId = getRunRow(runId)?.jobPromptId;
  let sourceKey = `${jobType}:${jobPromptId || now}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (jobType === "2d") {
      const source = safeOutputPath(lastLine, "file");
      const suffix = extname(source).toLowerCase() || ".png";
      const filename = `${runId}${suffix}`;
      copyFileSync(source, join(generatedDir, filename));
      const previewPath = `/generated/${filename}?v=${Date.now()}`;
      db.prepare(`
        UPDATE runs SET current_stage = 1, status = 'active', qa_status = 'pending',
          job_type = '2d', generation_status = 'succeeded', generation_message = '2D 图片生成完成，等待用户确认',
          generation_progress = 100, generation_current_node = NULL, preview_path = ?, image_path = ?,
          model_path = NULL, topology_path = NULL, rigged_model_path = NULL, qa_score = NULL, qa_summary = '', qa_metrics = '{}',
          qa_overlay_path = NULL, updated_at = ? WHERE id = ?
      `).run(previewPath, source, now, runId);
      const imageProvider = execution.imageProvider || "DGX Qwen Image";
      addEvent(runId, "generation_succeeded", 1, `${imageProvider} 已返回真实 PNG`, now);
    } else if (jobType === "qa") {
      const result = JSON.parse(lastLine);
      sourceKey = `qa:${result.promptId || now}`;
      const overlaySource = result.overlayPath ? safeOutputPath(result.overlayPath, "file") : null;
      let overlayPath = null;
      if (overlaySource) {
        const overlayName = `${runId}-pose.png`;
        copyFileSync(overlaySource, join(generatedDir, overlayName));
        overlayPath = `/generated/${overlayName}?v=${Date.now()}`;
      }
      const passed = result.passed === true;
      db.prepare(`
        UPDATE runs SET current_stage = 2, status = 'active', qa_status = ?, job_type = 'qa',
          generation_status = 'succeeded', generation_message = ?, generation_progress = 100,
          generation_prompt_id = COALESCE(?, generation_prompt_id), generation_current_node = NULL,
          qa_score = ?, qa_summary = ?, qa_metrics = ?, qa_overlay_path = ?, updated_at = ? WHERE id = ?
      `).run(
        passed ? "passed" : "failed",
        passed ? `${result.summary || "SDPose 自动检查完成"}，等待用户确认` : result.summary || "SDPose 自动检查未通过",
        result.promptId || null,
        Number(result.score || 0),
        result.summary || "",
        JSON.stringify(result.metrics || {}),
        overlayPath,
        now,
        runId,
      );
      addEvent(runId, passed ? "qa_passed" : "qa_failed", 2, `${result.summary}（${result.score ?? 0} 分）`, now);
    } else if (jobType === "3d") {
      const modelPath = safeOutputPath(lastLine, "file");
      if (extname(modelPath).toLowerCase() !== ".glb") throw new Error("3D 工作流没有返回 GLB");
      const glb = inspectGlb(modelPath);
      db.prepare(`
        UPDATE runs SET current_stage = 3, status = 'active', job_type = '3d',
          generation_status = 'succeeded', generation_message = 'Pixal3D 已返回静态 GLB，等待用户确认',
          generation_progress = 100, generation_current_node = NULL, model_path = ?,
          topology_path = NULL, rigged_model_path = NULL, updated_at = ? WHERE id = ?
      `).run(modelPath, now, runId);
      addEvent(runId, "model_succeeded", 3, `DGX Pixal3D 已返回真实静态 GLB（${glb.meshCount} mesh）`, now);
    } else if (jobType === "topology") {
      const topologyPath = safeOutputPath(lastLine, "file");
      if (extname(topologyPath).toLowerCase() !== ".glb") throw new Error("自动拓扑服务没有返回 GLB");
      const glb = inspectGlb(topologyPath);
      db.prepare(`
        UPDATE runs SET current_stage = 4, status = 'active', job_type = 'topology',
          generation_status = 'succeeded', generation_message = 'AutoRemesher 已返回拓扑 GLB，等待用户确认',
          generation_progress = 100, generation_current_node = NULL, topology_path = ?,
          rigged_model_path = NULL, updated_at = ? WHERE id = ?
      `).run(topologyPath, now, runId);
      addEvent(runId, "topology_succeeded", 4, `DGX AutoRemesher 已返回真实拓扑 GLB（${glb.meshCount} mesh）`, now);
    } else if (jobType === "rig") {
      const riggedPath = findLatestGlb(lastLine);
      const glb = inspectGlb(riggedPath, true);
      db.prepare(`
        UPDATE runs SET current_stage = 5, status = 'active', job_type = 'rig',
          generation_status = 'succeeded', generation_message = 'SkinTokens 已返回带骨骼 GLB，等待用户确认',
          generation_progress = 100, generation_current_node = NULL, rigged_model_path = ?, updated_at = ? WHERE id = ?
      `).run(riggedPath, now, runId);
      addEvent(runId, "rig_succeeded", 5, `DGX SkinTokens 已返回真实带骨骼 GLB（${glb.skinCount} skin / ${glb.jointCount} joints）`, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { runId, jobType, sourceKey };
}

function failJob(runId, jobType, errorMessage) {
  const message = (errorMessage || `${jobType} 任务失败`).trim().slice(-1200);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE runs SET generation_status = 'failed', generation_message = ?, updated_at = ? WHERE id = ?
  `).run(message, now, runId);
  addEvent(runId, `${jobType}_failed`, { "2d": 1, qa: 2, "3d": 3, topology: 4, rig: 5 }[jobType], `${jobType.toUpperCase()} 任务失败：${message}`, now);
}

function launchJob(run, jobType, processConfig) {
  const usesImageApi = jobType === "2d" && processConfig.mode === "api";
  const usesTopologyApi = jobType === "topology";
  const workflowPath = usesImageApi || usesTopologyApi ? null : join(runtimeWorkflowDir, `${run.id}-${jobType}-${randomUUID()}.json`);
  if (workflowPath) writeFileSync(workflowPath, JSON.stringify(processConfig.workflow), "utf8");
  const sourceImage = run.pipelineType === "image_to_model" ? run.sourceImagePathInternal : run.imagePathInternal;
  const args = usesImageApi
    ? [
        scripts["2d-api"],
        "--positive", run.positivePrompt,
        "--negative", run.negativePrompt || "",
        "--base-url", processConfig.api.baseUrl,
        "--model", processConfig.api.model,
        ...(sourceImage && existsSync(sourceImage) ? ["--source-image", sourceImage] : []),
        ...(run.pipelineType === "image_to_model" ? ["--tpose-output"] : []),
      ]
    : usesTopologyApi
      ? [
          scripts.topology,
          ...jobArguments(run, jobType),
          "--service-url", processConfig.url,
          "--target-quads", String(processConfig.targetQuads),
          "--timeout", String(processConfig.timeoutSeconds),
        ]
      : [
        scripts[jobType],
        ...jobArguments(run, jobType),
        "--comfyui-url", processConfig.url,
        "--workflow-file", workflowPath,
      ];
  let child;
  try {
    child = spawn(PYTHON_COMMAND, args, {
      cwd: repoRoot,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        ...(usesImageApi ? { STEPFUN_IMAGE_API_KEY: processConfig.api.apiKey } : {}),
        ...(usesTopologyApi ? { TOPOLOGY_SERVICE_TOKEN: processConfig.token } : {}),
      },
    });
  } catch (error) {
    if (workflowPath && existsSync(workflowPath)) unlinkSync(workflowPath);
    throw error;
  }
  const activeJob = { runId: run.id, jobType, child, socket: null, workflowPath };
  activeJobs.set(run.id, activeJob);
  let stdout = "";
  let stderr = "";
  let finalized = false;
  const comfyKind = jobType === "rig" ? "skin" : jobType;

  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-100_000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-100_000);
    if (usesTopologyApi) {
      const progressMatches = [...stderr.matchAll(/\[topology\]\s+progress=(\d+)\s+message=([^\r\n]+)/g)];
      const latest = progressMatches.at(-1);
      if (latest) persistJobProgress(run.id, jobType, Number(latest[1]), `自动拓扑：${latest[2].replaceAll("_", " ")}`);
    } else if (!usesImageApi && !activeJob.socket) {
      const match = stderr.match(new RegExp(`\\[${comfyKind}\\] submitted prompt_id=(\\S+) client_id=(\\S+)`));
      if (match) {
        const [, promptId, clientId] = match;
        db.prepare(`
          UPDATE runs SET generation_prompt_id = ?, generation_progress = 5,
            generation_message = 'ComfyUI 已进入队列，等待执行', updated_at = ?
          WHERE id = ? AND generation_status = 'running'
        `).run(promptId, new Date().toISOString(), run.id);
        activeJob.socket = connectComfyProgress(
          run.id,
          jobType,
          promptId,
          clientId,
          processConfig.url,
          processConfig.workflow,
        );
      }
    }
  });

  const finalize = (success, errorMessage = "") => {
    if (finalized) return;
    finalized = true;
    const socket = activeJob.socket;
    if (socket) socket.close();
    if (workflowPath && existsSync(workflowPath)) unlinkSync(workflowPath);
    if (activeJobs.get(run.id) === activeJob) activeJobs.delete(run.id);
    try {
      if (success) {
        const completion = completeJob(run.id, jobType, stdout, {
          imageProvider: usesImageApi ? `图片 API ${processConfig.api.model}` : "DGX Qwen Image",
        });
        void assetAgent.handleJobCompleted(completion).catch((error) => {
          console.error(`[Agent] ${jobType} completion hook failed:`, error);
        });
      } else {
        const message = errorMessage || stderr || `Python 退出代码非零`;
        failJob(run.id, jobType, message);
        void assetAgent.handleJobFailed({ runId: run.id, jobType, message: message.trim().slice(-1200) }).catch((error) => {
          console.error(`[Agent] ${jobType} failure diagnosis hook failed:`, error);
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "任务结果处理失败";
      failJob(run.id, jobType, message);
      void assetAgent.handleJobFailed({ runId: run.id, jobType, message }).catch((diagnosisError) => {
        console.error(`[Agent] ${jobType} failure diagnosis hook failed:`, diagnosisError);
      });
    }
  };

  child.on("error", (error) => finalize(false, error.message));
  child.on("close", (code) => finalize(code === 0, code === 0 ? "" : stderr || `Python 退出代码 ${code}`));
}

function startJob(runId, jobType) {
  const run = getRunRow(runId);
  if (!run) throw new Error("任务不存在");
  if (run.jobStatus === "running") throw new Error("当前任务仍在执行");
  if (jobType === "2d" && run.currentStage !== 1 && !(run.currentStage === 2 && run.qaStatus === "failed")) throw new Error("当前阶段不能生成 2D 概念图");
  if (jobType === "qa" && run.currentStage !== 2) throw new Error("请先确认 2D 阶段完成");
  if (jobType === "3d" && run.currentStage !== 3) throw new Error("请先确认 T-Pose 检查完成");
  if (jobType === "topology" && run.currentStage !== 4) throw new Error("请先确认 3D 模型生成完成");
  if (jobType === "rig" && run.currentStage !== 5) throw new Error("请先确认自动拓扑完成");
  if (jobType === "2d" && !run.positivePrompt.trim()) throw new Error("请先填写正向提示词");
  if (jobType === "qa" && (!run.imagePathInternal || !existsSync(run.imagePathInternal))) throw new Error("没有可供 SDPose 检查的 2D 图片");
  if (jobType === "3d" && run.qaStatus !== "passed") throw new Error("SDPose 自动检查未通过，不能生成 3D");
  if (jobType === "3d" && (!run.imagePathInternal || !existsSync(run.imagePathInternal))) throw new Error("合格的 2D 图片不存在");
  if (jobType === "topology" && (!run.modelPathInternal || !existsSync(run.modelPathInternal))) throw new Error("静态 GLB 不存在，不能执行自动拓扑");
  if (jobType === "rig" && (!run.topologyPathInternal || !existsSync(run.topologyPathInternal))) throw new Error("拓扑 GLB 不存在，不能绑骨");
  let processConfig = jobType === "topology"
    ? { mode: "api", ...settingsStore.topologyConfig() }
    : settingsStore.processConfig(jobType);
  if (jobType === "topology" && !processConfig.url) throw new Error("拓扑 API 未配置，请在“请求设置 → 拓扑 API”中填写服务地址");
  if (jobType === "topology" && (!Number.isInteger(processConfig.targetQuads) || processConfig.targetQuads < 1_000 || processConfig.targetQuads > 1_000_000)) throw new Error("TOPOLOGY_TARGET_QUADS 必须在 1,000 到 1,000,000 之间");
  if (jobType === "2d" && run.pipelineType === "image_to_model") {
    processConfig = { ...processConfig, mode: "api", api: settingsStore.imageConfig("image_to_model") };
    if (!run.sourceImagePathInternal || !existsSync(run.sourceImagePathInternal)) {
      throw new Error("图生模型工作流缺少角色原画");
    }
  }
  if (jobType === "2d" && processConfig.mode === "api" && !processConfig.api.apiKey) throw new Error("2D API Key 未配置，请在请求设置中填写或配置 Agent API Key");

  const stage = { "2d": 1, qa: 2, "3d": 3, topology: 4, rig: 5 }[jobType];
  const message = jobStartMessage(jobType, processConfig);
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (jobType === "2d") {
      db.prepare(`
        UPDATE runs SET current_stage = 1, status = 'active', qa_status = 'pending',
          model_path = NULL, topology_path = NULL, rigged_model_path = NULL, qa_score = NULL, qa_summary = '',
          qa_metrics = '{}', qa_overlay_path = NULL WHERE id = ?
      `).run(runId);
    } else if (jobType === "qa") {
      db.prepare("UPDATE runs SET current_stage = 2, status = 'active', qa_status = 'pending' WHERE id = ?").run(runId);
    } else if (jobType === "3d") {
      db.prepare("UPDATE runs SET current_stage = 3, status = 'active', model_path = NULL, topology_path = NULL, rigged_model_path = NULL WHERE id = ?").run(runId);
    } else if (jobType === "topology") {
      db.prepare("UPDATE runs SET current_stage = 4, status = 'active', topology_path = NULL, rigged_model_path = NULL WHERE id = ?").run(runId);
    } else if (jobType === "rig") {
      db.prepare("UPDATE runs SET current_stage = 5, status = 'active', rigged_model_path = NULL WHERE id = ?").run(runId);
    }
    db.prepare(`
      UPDATE runs SET job_type = ?, generation_status = 'running', generation_message = ?,
        generation_progress = 1, generation_prompt_id = NULL, generation_current_node = NULL, updated_at = ?
      WHERE id = ?
    `).run(jobType, message, now, runId);
    addEvent(runId, `${jobType}_started`, stage, `启动${message.replace("正在调用 ", "")}`, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  try {
    launchJob(getRunRow(runId), jobType, processConfig);
  } catch (error) {
    failJob(runId, jobType, error instanceof Error ? error.message : "任务进程启动失败");
    throw error;
  }
  return runDetail(runId);
}

let systemCache = null;
let systemCacheAt = 0;

async function fetchComfy(baseUrl, path, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let response = await fetch(`${baseUrl}/${path}`, { signal: controller.signal });
    if (response.status === 404) response = await fetch(`${baseUrl}/api/${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function workflowClasses(graph) {
  return [...new Set(Object.values(graph).map((node) => node.class_type))];
}

const workspaceAssetDefinitions = {
  image: { column: "imagePathInternal", group: "2d", label: "2D 概念图", downloadKind: "image", rigged: false },
  model: { column: "modelPathInternal", group: "3d", label: "静态 GLB", downloadKind: "model", rigged: false },
  topology: { column: "topologyPathInternal", group: "3d", label: "拓扑 GLB", downloadKind: "topology", rigged: false },
  rigged: { column: "riggedModelPathInternal", group: "3d", label: "绑定 GLB", downloadKind: "rigged", rigged: true },
};

const workspaceAssetCascade = {
  image: ["image", "model", "topology", "rigged"],
  model: ["model", "topology", "rigged"],
  topology: ["topology", "rigged"],
  rigged: ["rigged"],
};

function listWorkspaceAssets(workspaceId) {
  if (!getWorkspace(workspaceId)) throw new Error("工作空间不存在");
  const rows = db.prepare(`${runSelect} WHERE workspace_id = ? ORDER BY updated_at DESC`).all(workspaceId);
  return rows.flatMap((row) => Object.entries(workspaceAssetDefinitions).flatMap(([kind, definition]) => {
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
      previewUrl: kind === "image" ? `/api/runs/${row.id}/preview/image` : `/api/runs/${row.id}/download/${definition.downloadKind}`,
      filename: basename(filePath),
      size: file.size,
      createdAt: file.mtime.toISOString(),
      rigged: definition.rigged,
    }];
  }));
}

function isControlledAssetPath(filePath) {
  const candidate = resolve(filePath);
  const normalized = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  return [outputRoot, generatedDir].some((root) => {
    const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${sep}`);
  });
}

function deleteControlledAssetFile(filePath) {
  if (!filePath) return;
  if (!isControlledAssetPath(filePath)) throw new Error("拒绝删除工作目录之外的文件");
  if (existsSync(filePath) && statSync(filePath).isFile()) unlinkSync(filePath);
}

function generatedFileFromPreviewUrl(value) {
  if (typeof value !== "string" || !value.startsWith("/generated/")) return null;
  return join(generatedDir, basename(value.split("?")[0]));
}

function deleteWorkspaceAsset(workspaceId, runId, kind) {
  const run = getRunRow(runId);
  if (!run || run.workspaceId !== workspaceId) throw new Error("资产不存在或不属于该工作空间");
  if (activeJobs.has(runId) || run.jobStatus === "running") throw new Error("任务正在执行，暂时不能删除资产");
  const cascadeKinds = workspaceAssetCascade[kind];
  if (!cascadeKinds) throw new Error("未知资产类型");

  for (const cascadeKind of cascadeKinds) {
    const definition = workspaceAssetDefinitions[cascadeKind];
    deleteControlledAssetFile(run[definition.column]);
  }
  if (kind === "image") {
    deleteControlledAssetFile(generatedFileFromPreviewUrl(run.previewPath));
    deleteControlledAssetFile(generatedFileFromPreviewUrl(run.qaOverlayPath));
  }

  const now = new Date().toISOString();
  if (kind === "image") {
    db.prepare(`
      UPDATE runs SET current_stage = MIN(current_stage, 1), status = 'active',
        image_path = NULL, preview_path = NULL, model_path = NULL, topology_path = NULL, rigged_model_path = NULL,
        qa_status = 'pending', qa_score = NULL, qa_summary = '', qa_metrics = '{}', qa_overlay_path = NULL,
        job_type = 'none', generation_status = 'idle', generation_message = '', generation_progress = 0,
        generation_prompt_id = NULL, generation_current_node = NULL, updated_at = ? WHERE id = ?
    `).run(now, runId);
  } else if (kind === "model") {
    db.prepare(`
      UPDATE runs SET current_stage = MIN(current_stage, 3), status = 'active',
        model_path = NULL, topology_path = NULL, rigged_model_path = NULL,
        job_type = 'none', generation_status = 'idle', generation_message = '', generation_progress = 0,
        generation_prompt_id = NULL, generation_current_node = NULL, updated_at = ? WHERE id = ?
    `).run(now, runId);
  } else if (kind === "topology") {
    db.prepare(`
      UPDATE runs SET current_stage = MIN(current_stage, 4), status = 'active',
        topology_path = NULL, rigged_model_path = NULL,
        job_type = 'none', generation_status = 'idle', generation_message = '', generation_progress = 0,
        generation_prompt_id = NULL, generation_current_node = NULL, updated_at = ? WHERE id = ?
    `).run(now, runId);
  } else {
    db.prepare(`
      UPDATE runs SET current_stage = MIN(current_stage, 5), status = 'active', rigged_model_path = NULL,
        job_type = 'none', generation_status = 'idle', generation_message = '', generation_progress = 0,
        generation_prompt_id = NULL, generation_current_node = NULL, updated_at = ? WHERE id = ?
    `).run(now, runId);
  }
  addEvent(runId, "asset_deleted", Math.min(run.currentStage, { image: 1, model: 3, topology: 4, rigged: 5 }[kind]), `从资产库删除 ${workspaceAssetDefinitions[kind].label}`, now);
  return { ok: true, deletedKinds: cascadeKinds, assets: listWorkspaceAssets(workspaceId) };
}

function deleteWorkspaceRecord(workspaceId) {
  if (workspaceId === "default") throw new Error("默认工作空间不能删除");
  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw new Error("工作空间不存在");

  const runs = db.prepare(`${runSelect} WHERE workspace_id = ?`).all(workspaceId);
  if (runs.some((run) => activeJobs.has(run.id) || run.jobStatus === "running" || assetAgent.isBusy(run.id))) {
    throw new Error("该工作空间仍有任务正在执行，完成或停止后才能删除");
  }
  const generations = db.prepare(`
    SELECT id, status, preview_path AS previewPath, output_path AS outputPath
    FROM dispatcher_generations WHERE workspace_id = ?
  `).all(workspaceId);
  if (generations.some((generation) => generation.status === "running" || activeDispatcherJobs.has(generation.id))) {
    throw new Error("该工作空间仍有合集图生成任务正在执行，完成或停止后才能删除");
  }
  if (coordinatorAgent.status().running) {
    throw new Error("总调度 Agent 正在处理消息，完成或停止后才能删除工作空间");
  }
  const executingApproval = db.prepare(`
    SELECT 1 FROM approval_requests
    WHERE workspace_id = ? AND status = 'executing' LIMIT 1
  `).get(workspaceId);
  if (executingApproval) throw new Error("该工作空间仍有审批操作正在执行，完成后才能删除");

  const files = new Set();
  for (const run of runs) {
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
  return { ok: true, cleanupFailedCount, workspaces: getWorkspacesSummary() };
}

async function checkTopologyService(config) {
  const started = Date.now();
  const baseline = {
    configured: Boolean(config.url),
    online: false,
    ready: false,
    url: config.url || "",
    latencyMs: 0,
    architecture: null,
  };
  if (!config.url) return baseline;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${config.url}/healthz`, { signal: controller.signal });
    const health = response.ok ? await response.json() : {};
    return {
      ...baseline,
      online: response.ok,
      ready: response.ok && health.ready === true,
      latencyMs: Date.now() - started,
      architecture: typeof health.architecture === "string" ? health.architecture : null,
    };
  } catch {
    return { ...baseline, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function checkComfyUi(force = false) {
  if (!force && systemCache && Date.now() - systemCacheAt < 15_000) return systemCache;
  const configs = Object.fromEntries(PROCESS_KINDS.map((kind) => [kind, settingsStore.processConfig(kind)]));
  const endpointPromises = new Map();
  for (const config of Object.values(configs)) {
    if (config.mode === "api") continue;
    if (endpointPromises.has(config.url)) continue;
    endpointPromises.set(config.url, (async () => {
      const endpointStarted = Date.now();
      try {
        const [stats, queue, objectInfo] = await Promise.all([
          fetchComfy(config.url, "system_stats", 5000),
          fetchComfy(config.url, "queue", 5000),
          fetchComfy(config.url, "object_info", 15_000),
        ]);
        return { online: true, stats, queue, objectInfo, latencyMs: Date.now() - endpointStarted };
      } catch {
        return { online: false, queue: {}, objectInfo: {}, latencyMs: Date.now() - endpointStarted };
      }
    })());
  }
  const topologyPromise = checkTopologyService(settingsStore.topologyConfig());
  const endpoints = new Map();
  await Promise.all([...endpointPromises.entries()].map(async ([url, promise]) => endpoints.set(url, await promise)));
  const topology = await topologyPromise;
  const checks = {};
  for (const kind of PROCESS_KINDS) {
    const config = configs[kind];
    if (config.mode === "api") {
      checks[kind] = {
        ready: Boolean(config.api.apiKey),
        online: Boolean(config.api.apiKey),
        missing: config.api.apiKey ? [] : ["API Key"],
        url: config.api.baseUrl,
        latencyMs: 0,
      };
      continue;
    }
    const endpoint = endpoints.get(config.url);
    const missing = workflowClasses(config.workflow).filter((name) => !endpoint.objectInfo[name]);
    const checkpointOptions = endpoint.objectInfo.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    for (const node of Object.values(config.workflow)) {
      if (node.class_type === "CheckpointLoaderSimple" && node.inputs?.ckpt_name && !checkpointOptions.includes(node.inputs.ckpt_name)) {
        missing.push(node.inputs.ckpt_name);
      }
    }
    checks[kind] = {
      ready: endpoint.online && missing.length === 0,
      online: endpoint.online,
      missing: [...new Set(missing)],
      url: config.url,
      latencyMs: endpoint.latencyMs,
    };
  }
  const endpointValues = [...endpoints.values()];
  const urls = [...endpoints.keys()];
  const devices = endpointValues.flatMap((item) => Array.isArray(item.stats?.devices) ? item.stats.devices : []).map((device) => ({
    name: typeof device.name === "string" ? device.name : "NVIDIA GPU",
    type: typeof device.type === "string" ? device.type : "cuda",
    index: Number.isFinite(Number(device.index)) ? Number(device.index) : null,
    vramTotal: Number.isFinite(Number(device.vram_total)) ? Number(device.vram_total) : null,
    vramFree: Number.isFinite(Number(device.vram_free)) ? Number(device.vram_free) : null,
    torchVramTotal: Number.isFinite(Number(device.torch_vram_total)) ? Number(device.torch_vram_total) : null,
    torchVramFree: Number.isFinite(Number(device.torch_vram_free)) ? Number(device.torch_vram_free) : null,
  }));
  const value = {
    online: endpointValues.every((item) => item.online),
    url: urls.length === 1 ? urls[0] : "多个端点",
    latencyMs: Math.max(0, ...endpointValues.map((item) => item.latencyMs)),
    version: [...new Set(endpointValues.map((item) => item.stats?.system?.comfyui_version).filter(Boolean))].join(", ") || null,
    queue: {
      running: endpointValues.reduce((total, item) => total + (item.queue.queue_running?.length || 0), 0),
      pending: endpointValues.reduce((total, item) => total + (item.queue.queue_pending?.length || 0), 0),
    },
    devices,
    topology,
    workflows: checks,
    pipelineReady: Object.values(checks).every((item) => item.ready) && topology.ready,
  };
  systemCache = value;
  systemCacheAt = Date.now();
  return value;
}

function streamDownload(res, filePath, label) {
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) throw new Error("产物文件不存在");
  const filename = `${label}-${basename(filePath)}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  res.writeHead(200, {
    "Content-Type": extname(filePath).toLowerCase() === ".glb" ? "model/gltf-binary" : "application/octet-stream",
    "Content-Length": statSync(filePath).size,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

const assetAgent = createAssetAgentRuntime({
  db,
  getRunDetail: runDetail,
  updatePrompts: updateRunPrompts,
  advanceWorkflow,
  revertWorkflow: revertRun,
  runStageJob,
  getAgentConfig: settingsStore.agentConfig,
  getRunImagePath: (runId) => getRunRow(runId)?.imagePathInternal || null,
  getRunReferenceImagePath: (runId) => getRunRow(runId)?.sourceImagePathInternal || null,
  getAssetInspection: (runId, assetKind) => {
    const run = getRunRow(runId);
    const filePath = assetKind === "rigged_model" ? run?.riggedModelPathInternal : run?.modelPathInternal;
    if (!filePath || !existsSync(filePath)) throw new Error(`${assetKind === "rigged_model" ? "绑骨" : "静态"} GLB 不存在`);
    return inspectGlb(filePath, assetKind === "rigged_model");
  },
  addRunEvent: addEvent,
  getPermissionMode: (runId) => approvalRuntime.permission("task", runId),
  requestApproval: approvalRuntime.requestApproval,
});

async function createCoordinatorTasks({ workspaceId, tasks, image, sessionId = "", target = "model" }) {
  if (!getWorkspace(workspaceId)) throw new Error("工作空间不存在");
  const usesImage = tasks.some((task) => pipelineType(task.pipelineType) === "image_to_model");
  let cropPaths = [];
  if (usesImage) {
    if (!image) throw new Error("图生模型批量任务需要上传合集原画");
    if (tasks.some((task) => task.pipelineType === "image_to_model" && !task.bounds)) throw new Error("每个图生模型任务都需要角色裁切框");
    const uploaded = saveSourceImage(image, `sheet-${randomUUID()}`);
    const imageTasks = tasks.filter((task) => task.pipelineType === "image_to_model");
    const cropDir = join(outputRoot, "crops", randomUUID());
    mkdirSync(cropDir, { recursive: true });
    const result = spawnSync(PYTHON_COMMAND, [
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
    created.push(createRunRecord({
      workspaceId,
      pipelineType: task.pipelineType,
      name: task.name,
      positivePrompt: `${task.description}，${task.positivePrompt}`.slice(0, 4000),
      negativePrompt: task.negativePrompt,
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

function listDispatcherTaskBatches(workspaceId, sessionId) {
  return db.prepare(`
    SELECT id, workspace_id AS workspaceId, session_id AS sessionId, target,
           run_ids AS runIds, created_at AS createdAt
    FROM dispatcher_task_batches
    WHERE workspace_id = ? AND session_id = ?
    ORDER BY created_at DESC LIMIT 30
  `).all(workspaceId, sessionId).map((batch) => {
    let runIds = [];
    try {
      const parsed = JSON.parse(batch.runIds || "[]");
      if (Array.isArray(parsed)) runIds = parsed.filter((item) => typeof item === "string");
    } catch {
      runIds = [];
    }
    return {
      id: batch.id,
      workspaceId: batch.workspaceId,
      sessionId: batch.sessionId,
      target: batch.target,
      createdAt: batch.createdAt,
      tasks: runIds.map((runId) => serializeRun(getRunRow(runId))).filter(Boolean),
    };
  });
}

function getDispatcherGeneration(id) {
  return db.prepare(`
    SELECT id, workspace_id AS workspaceId, session_id AS sessionId, title, character_count AS characterCount,
           prompt, status, message, preview_path AS previewPath,
           created_at AS createdAt, updated_at AS updatedAt
    FROM dispatcher_generations WHERE id = ?
  `).get(id) || null;
}

function listDispatcherGenerations(workspaceId, sessionId) {
  return db.prepare(`
    SELECT id, workspace_id AS workspaceId, session_id AS sessionId, title, character_count AS characterCount,
           prompt, status, message, preview_path AS previewPath,
           created_at AS createdAt, updated_at AS updatedAt
    FROM dispatcher_generations
    WHERE workspace_id = ? AND session_id = ?
    ORDER BY created_at DESC LIMIT 30
  `).all(workspaceId, sessionId);
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
  const negative = cleanText(input.negativePrompt, 2000, "反向提示词") || "角色重复，角色融合，人物重叠，裁切身体，多余人物，文字，水印，低画质，肢体畸形，风格不一致";
  const enumerated = descriptions.map((item, index) => `${index + 1}. ${item}`).join("；");
  const positive = [
    `生成一张角色原画合集图，单张画布内准确包含 ${characterCount} 个不同角色。`,
    `所有角色保持完全一致的美术风格：${style}。`,
    `角色设定：${enumerated}。`,
    "横向整齐排列，每个角色及其全部装备占据独立的等宽安全区域，角色之间保留清晰可见的背景间隔。每个角色必须完整全身、彼此分离且不重叠；头发、帽檐、披风、手脚、武器、盾牌和法杖都不得伸入相邻角色区域或越出画布。比例统一，光照统一，背景简洁，清晰展示服装、配色和身份差异。不要拆成多张图片，不要生成角色卡边框或文字标签。",
    additional,
  ].filter(Boolean).join(" ").slice(0, 6000);
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
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', '正在调用文生图模型生成单张角色合集图', ?, ?, ?)
  `).run(id, workspaceId, sessionId, title, characterCount, positive, requestJson, now, now);
  db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(now, workspaceId);

  const args = [
    scripts["2d-api"],
    "--positive", positive,
    "--negative", negative,
    "--base-url", imageConfig.baseUrl,
    "--model", imageConfig.model,
  ];
  const child = spawn(PYTHON_COMMAND, args, {
    cwd: repoRoot,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1", STEPFUN_IMAGE_API_KEY: imageConfig.apiKey },
  });
  const active = { child, stdout: "", stderr: "", finalized: false };
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
      const message = error instanceof Error ? error.message : "合集图生成失败";
      db.prepare("UPDATE dispatcher_generations SET status = 'failed', message = ?, updated_at = ? WHERE id = ?").run(message.slice(0, 1200), completedAt, id);
      approvalRuntime.addNotification({ kind: "generation_failed", title: "角色合集图生成失败", message: `${title}：${message}`, workspaceId });
    }
  };
  child.on("error", (error) => finalize(false, error.message));
  child.on("close", (code) => finalize(code === 0, code === 0 ? "" : active.stderr || `Python 退出代码 ${code}`));
  return getDispatcherGeneration(id);
}

const coordinatorAgent = createCoordinatorRuntime({
  db,
  getAgentConfig: settingsStore.coordinatorAgentConfig,
  getWorkspaces: getWorkspacesSummary,
  createWorkspace: createWorkspaceRecord,
  createCharacterTasks: createCoordinatorTasks,
  generateCharacterSheet: startCharacterSheetGeneration,
  getLatestGeneratedImage: getLatestDispatcherGenerationImage,
  getLatestCharacterSheetRequest,
  getCharacterSheetRequest,
  getLatestTaskBatch: (workspaceId, sessionId) => listDispatcherTaskBatches(workspaceId, sessionId)[0] || null,
  delegateTask: (runId, target) => delegateCoordinatorTask(runId, target),
  getImageModelStatus: () => {
    const settings = settingsStore.publicSettings();
    return settings.coordinator.imageModels;
  },
  getPermissionMode: () => approvalRuntime.permission("coordinator", "global"),
  requestApproval: approvalRuntime.requestApproval,
});

const COORDINATOR_DELEGATION_REASONS = new Set([
  "总调度 Agent 委派持续执行目标",
  "已批准的总调度任务委派",
]);

async function delegateCoordinatorTask(runId, target, reason = "总调度 Agent 委派持续执行目标") {
  const run = getRunRow(runId);
  if (!run) throw new Error("任务不存在");
  addEvent(runId, "coordinator_delegated", run.currentStage, reason);
  return assetAgent.scheduleWorkflowPlan(runId, target);
}

function streamAssetPreview(res, filePath) {
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) throw new Error("资产文件不存在");
  const contentTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".glb": "model/gltf-binary",
    ".fbx": "application/octet-stream",
  };
  res.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": statSync(filePath).size,
    "Cache-Control": "private, max-age=60",
  });
  createReadStream(filePath).pipe(res);
}

function isCoordinatorDelegationApproval(approval) {
  return approval?.scopeType === "task"
    && approval?.operation === "execute_pipeline_goal"
    && Boolean(approval?.runId)
    && COORDINATOR_DELEGATION_REASONS.has(approval?.payload?.reason);
}

approvalRuntime.setExecutor(async (approval) => {
  if (approval.scopeType === "task") {
    return assetAgent.executeApprovedOperation(approval.runId, approval.operation, approval.payload);
  }
  if (approval.operation === "create_workspace") return createWorkspaceRecord(approval.payload);
  if (approval.operation === "generate_character_sheet") return startCharacterSheetGeneration(approval.payload);
  if (approval.operation === "continue_character_tasks") {
    const workspaceId = String(approval.payload?.workspaceId || approval.workspaceId || "");
    const target = approval.payload?.target;
    const runIds = Array.isArray(approval.payload?.runIds) ? approval.payload.runIds : [];
    const delegated = [];
    for (const runId of runIds) {
      const run = getRunRow(runId);
      if (!run || run.workspaceId !== workspaceId) {
        delegated.push({ runId, status: "failed", error: "任务不存在或不属于目标工作空间" });
        continue;
      }
      try {
        const result = await delegateCoordinatorTask(runId, target, "已批准继续推进现有任务");
        delegated.push({ runId, status: result?.status || "submitted" });
      } catch (error) {
        delegated.push({ runId, status: "failed", error: error instanceof Error ? error.message : "委派失败" });
      }
    }
    return { target, delegated };
  }
  if (approval.operation === "create_character_tasks") {
    const { image, ...params } = approval.payload;
    const tasks = await createCoordinatorTasks({ ...params, image });
    const delegated = [];
    if (params.delegateToAgents) {
      for (const task of tasks) {
        try {
          const result = await delegateCoordinatorTask(task.run.id, params.target, "已批准的总调度任务委派");
          delegated.push({ runId: task.run.id, status: result?.status || "submitted" });
        } catch (error) {
          delegated.push({ runId: task.run.id, status: "failed", error: error instanceof Error ? error.message : "委派失败" });
        }
      }
    }
    return { tasks, delegated };
  }
  throw new Error("未知的总调度 Agent 审批操作");
});

for (const pending of approvalRuntime.listApprovals("pending")) {
  const approval = approvalRuntime.getApproval(pending.id);
  if (!isCoordinatorDelegationApproval(approval)) continue;
  try {
    await approvalRuntime.approve(approval.id);
  } catch (error) {
    console.error(`[coordinator] 恢复任务委派审批 ${approval.id} 失败`, error);
  }
}

const server = createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        database: "sqlite",
        databasePath: dbPath,
        sourceMtimeMs: serverSourceMtimeMs,
        capabilities: ["workspace-assets-v1", "workspace-delete-v1", "mixamo-animation-library-v1"],
        agent: assetAgent.status(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/system") {
      json(res, 200, {
        api: true,
        database: true,
        agent: assetAgent.status(),
        comfyui: await checkComfyUi(url.searchParams.get("force") === "1"),
      });
      return;
    }
    if (parts[0] === "api" && parts[1] === "settings" && parts[2] === "workflows" && parts[3]) {
      const kind = parts[3];
      if (req.method === "GET" && parts[4]) {
        json(res, 200, settingsStore.getWorkflow(kind, parts[4]));
        return;
      }
      if (req.method === "POST" && parts.length === 4) {
        const body = await readBody(req, 750_000);
        const result = settingsStore.uploadWorkflow(kind, body);
        systemCache = null;
        systemCacheAt = 0;
        json(res, 201, result);
        return;
      }
      if (req.method === "DELETE" && parts[4]) {
        const result = settingsStore.removeWorkflow(kind, parts[4]);
        systemCache = null;
        systemCacheAt = 0;
        json(res, 200, result);
        return;
      }
    }
    if (req.method === "POST" && url.pathname === "/api/settings/agent/models") {
      const body = await readBody(req, 50_000);
      json(res, 200, await settingsStore.fetchAgentModels(body));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/settings") {
      json(res, 200, settingsStore.publicSettings());
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/settings") {
      const body = await readBody(req, 2_500_000);
      const result = settingsStore.update(body);
      systemCache = null;
      systemCacheAt = 0;
      json(res, 200, result);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/agent-controls") {
      const runId = url.searchParams.get("runId");
      const workspaceId = url.searchParams.get("workspaceId");
      const sessionId = url.searchParams.get("sessionId");
      const approvals = approvalRuntime.listApprovals("pending").filter((item) => (
        item.scopeType === "coordinator"
          ? Boolean(workspaceId) && Boolean(sessionId) && item.workspaceId === workspaceId && item.sessionId === sessionId
          : Boolean(runId) && item.runId === runId
      ));
      json(res, 200, {
        coordinatorMode: approvalRuntime.permission("coordinator", "global"),
        taskMode: runId ? approvalRuntime.permission("task", runId) : null,
        approvals,
      });
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/agent-controls") {
      const body = await readBody(req, 50_000);
      const scopeType = body.scopeType === "coordinator" ? "coordinator" : body.scopeType === "task" ? "task" : null;
      if (!scopeType) throw new Error("未知 Agent 权限范围");
      const scopeId = scopeType === "coordinator" ? "global" : cleanText(body.runId, 80, "任务 ID", true);
      if (scopeType === "task" && !getRunRow(scopeId)) throw new Error("任务不存在");
      json(res, 200, approvalRuntime.setPermission(scopeType, scopeId, body.mode));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/notifications") {
      json(res, 200, { notifications: approvalRuntime.listNotifications(url.searchParams.get("limit")) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/notifications/read-all") {
      json(res, 200, approvalRuntime.markAllNotificationsRead());
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/notifications") {
      json(res, 200, approvalRuntime.clearNotifications());
      return;
    }
    if (parts[0] === "api" && parts[1] === "notifications" && parts[2] && parts.length === 3 && req.method === "DELETE") {
      const notificationId = Number(parts[2]);
      if (!Number.isInteger(notificationId) || notificationId <= 0) throw new Error("通知不存在");
      json(res, 200, approvalRuntime.deleteNotification(notificationId));
      return;
    }
    if (parts[0] === "api" && parts[1] === "notifications" && parts[2] && req.method === "POST" && parts[3] === "read") {
      json(res, 200, approvalRuntime.markNotificationRead(Number(parts[2])));
      return;
    }
    if (parts[0] === "api" && parts[1] === "approvals" && parts[2] && req.method === "POST") {
      if (parts[3] === "approve") {
        const approval = await approvalRuntime.approve(Number(parts[2]));
        json(res, 200, { ...approval, payload: undefined });
        return;
      }
      if (parts[3] === "reject") {
        const approval = approvalRuntime.reject(Number(parts[2]));
        json(res, 200, { ...approval, payload: undefined });
        return;
      }
    }
    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      json(res, 200, { workspaces: getWorkspacesSummary() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dispatcher/messages") {
      const workspaceId = url.searchParams.get("workspaceId");
      json(res, 200, coordinatorAgent.getConversation(workspaceId));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/dispatcher/sessions") {
      const body = await readBody(req);
      json(res, 201, coordinatorAgent.startSession(cleanText(body.workspaceId, 80, "工作空间 ID", true)));
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/dispatcher/sessions/current") {
      const body = await readBody(req);
      json(res, 200, coordinatorAgent.activateSession(
        cleanText(body.workspaceId, 80, "工作空间 ID", true),
        cleanText(body.sessionId, 80, "会话 ID", true),
      ));
      return;
    }
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "dispatcher" && parts[2] === "sessions" && parts[3]) {
      json(res, 200, coordinatorAgent.deleteSession(
        cleanText(url.searchParams.get("workspaceId"), 80, "工作空间 ID", true),
        cleanText(decodeURIComponent(parts[3]), 80, "会话 ID", true),
      ));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dispatcher/generations") {
      const workspaceId = url.searchParams.get("workspaceId") || "default";
      const sessionId = url.searchParams.get("sessionId") || "";
      if (!getWorkspace(workspaceId)) throw new Error("工作空间不存在");
      json(res, 200, { generations: listDispatcherGenerations(workspaceId, sessionId) });
      return;
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "dispatcher" && parts[2] === "generations" && parts[3] && parts[4] === "regenerate") {
      const body = await readBody(req);
      json(res, 200, coordinatorAgent.regenerateCharacterSheet({
        workspaceId: cleanText(body.workspaceId, 80, "工作空间 ID", true),
        sessionId: cleanText(body.sessionId, 80, "会话 ID", true),
        generationId: cleanText(decodeURIComponent(parts[3]), 80, "生成任务 ID", true),
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dispatcher/task-batches") {
      const workspaceId = url.searchParams.get("workspaceId") || "default";
      const sessionId = url.searchParams.get("sessionId") || "";
      if (!getWorkspace(workspaceId)) throw new Error("工作空间不存在");
      json(res, 200, { batches: listDispatcherTaskBatches(workspaceId, sessionId) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/dispatcher/messages") {
      const body = await readBody(req, 18_000_000);
      json(res, 200, await coordinatorAgent.run({
        workspaceId: typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : null,
        message: body.message,
        image: body.image,
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/dispatcher/cancel") {
      json(res, 200, { cancelled: coordinatorAgent.cancel() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      const body = await readBody(req);
      json(res, 201, createWorkspaceRecord(body));
      return;
    }
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "workspaces" && parts[2] && parts.length === 3) {
      json(res, 200, deleteWorkspaceRecord(cleanText(decodeURIComponent(parts[2]), 80, "工作空间 ID", true)));
      return;
    }
    if (parts[0] === "api" && parts[1] === "animations") {
      if (req.method === "GET" && parts.length === 2) {
        json(res, 200, { animations: listAnimationAssets() });
        return;
      }
      if (req.method === "POST" && parts.length === 2) {
        const body = await readBody(req, 22_000_000);
        json(res, 201, { animation: await createAnimationAsset(body), animations: listAnimationAssets() });
        return;
      }
      if (parts[2]) {
        const animationId = decodeURIComponent(parts[2]);
        const animation = getAnimationAsset(animationId);
        if (!animation) {
          json(res, 404, { error: "动画不存在" });
          return;
        }
        if (req.method === "GET" && parts[3] === "file" && parts.length === 4) {
          streamAssetPreview(res, animation.filePath);
          return;
        }
        if (req.method === "DELETE" && parts.length === 3) {
          json(res, 200, deleteAnimationAsset(animationId));
          return;
        }
      }
    }
    if (parts[0] === "api" && parts[1] === "workspaces" && parts[2] && parts[3] === "assets") {
      const workspaceId = decodeURIComponent(parts[2]);
      if (req.method === "GET" && parts.length === 4) {
        json(res, 200, { assets: listWorkspaceAssets(workspaceId) });
        return;
      }
      if (req.method === "DELETE" && parts[4] && parts[5] && parts.length === 6) {
        json(res, 200, deleteWorkspaceAsset(workspaceId, decodeURIComponent(parts[4]), decodeURIComponent(parts[5])));
        return;
      }
    }
    if (req.method === "GET" && url.pathname === "/api/runs") {
      const workspaceId = url.searchParams.get("workspaceId");
      const rows = workspaceId
        ? db.prepare(`${runSelect} WHERE workspace_id = ? ORDER BY updated_at DESC`).all(workspaceId)
        : db.prepare(`${runSelect} ORDER BY updated_at DESC`).all();
      json(res, 200, { runs: rows.map(serializeRun) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/runs") {
      const body = await readBody(req);
      json(res, 201, createRunRecord(body));
      return;
    }

    if (parts[0] === "api" && parts[1] === "runs" && parts[2]) {
      const id = parts[2];
      const existing = getRunRow(id);
      if (!existing) {
        json(res, 404, { error: "任务不存在" });
        return;
      }
      if (req.method === "GET" && parts.length === 3) {
        json(res, 200, {
          ...runDetail(id),
          agentRoleRuns: assetAgent.getRoleRuns(id),
          agentWorkflowPlan: assetAgent.getWorkflowPlan(id),
        });
        return;
      }
      if (req.method === "GET" && parts[3] === "agent" && parts[4] === "messages") {
        json(res, 200, assetAgent.getConversation(id));
        return;
      }
      if (req.method === "POST" && parts[3] === "agent" && parts[4] === "messages") {
        const body = await readBody(req, 6_000_000);
        json(res, 200, await assetAgent.run({ runId: id, message: body.message, image: body.image }));
        return;
      }
      if (req.method === "POST" && parts[3] === "agent" && parts[4] === "cancel") {
        json(res, 200, { cancelled: assetAgent.cancel(id) });
        return;
      }
      if (req.method === "POST" && parts[3] === "agent" && parts[4] === "sessions" && parts.length === 5) {
        json(res, 201, assetAgent.startSession(id));
        return;
      }
      if (req.method === "PUT" && parts[3] === "agent" && parts[4] === "sessions" && parts[5] === "current") {
        const body = await readBody(req);
        json(res, 200, assetAgent.activateSession(id, cleanText(body.sessionId, 80, "会话 ID", true)));
        return;
      }
      if (req.method === "DELETE" && parts[3] === "agent" && parts[4] === "sessions" && parts[5]) {
        json(res, 200, assetAgent.deleteSession(id, cleanText(decodeURIComponent(parts[5]), 80, "会话 ID", true)));
        return;
      }
      if (req.method === "POST" && parts[3] === "start") {
        const body = await readBody(req);
        let input = body;
        if (assetAgent.status().configured) {
          const prepared = await assetAgent.prepareCharacterPrompts(id, body, "确认角色设定前检查提示词");
          input = {
            positivePrompt: prepared.promptPlan.positivePrompt,
            negativePrompt: prepared.promptPlan.negativePrompt,
          };
        }
        json(res, 200, { ...confirmCharacterIdea(id, input), agentRoleRuns: assetAgent.getRoleRuns(id) });
        return;
      }
      if (req.method === "POST" && parts[3] === "generate-2d") {
        json(res, 202, startJob(id, "2d"));
        return;
      }
      if (req.method === "POST" && parts[3] === "check-tpose") {
        json(res, 202, startJob(id, "qa"));
        return;
      }
      if (req.method === "POST" && parts[3] === "generate-3d") {
        json(res, 202, startJob(id, "3d"));
        return;
      }
      if (req.method === "POST" && parts[3] === "retopologize") {
        json(res, 202, startJob(id, "topology"));
        return;
      }
      if (req.method === "POST" && parts[3] === "rig") {
        json(res, 202, startJob(id, "rig"));
        return;
      }
      if (req.method === "POST" && parts[3] === "advance") {
        json(res, 200, advanceRun(id));
        return;
      }
      if (req.method === "POST" && parts[3] === "revert") {
        const body = await readBody(req);
        json(res, 200, revertRun(id, Number(body.stage)));
        return;
      }
      if (req.method === "GET" && parts[3] === "preview" && parts[4]) {
        const paths = {
          image: existing.imagePathInternal,
          model: existing.modelPathInternal,
          topology: existing.topologyPathInternal,
          rigged: existing.riggedModelPathInternal,
        };
        if (!(parts[4] in paths)) throw new Error("未知资产类型");
        streamAssetPreview(res, paths[parts[4]]);
        return;
      }
      if (req.method === "GET" && parts[3] === "download" && parts[4]) {
        const paths = {
          source: existing.sourceImagePathInternal,
          image: existing.imagePathInternal,
          model: existing.modelPathInternal,
          topology: existing.topologyPathInternal,
          rigged: existing.riggedModelPathInternal,
        };
        if (!(parts[4] in paths)) throw new Error("未知产物类型");
        streamDownload(res, paths[parts[4]], `${existing.name}-${parts[4]}`);
        return;
      }
      if (req.method === "POST" && parts[3] === "reset") {
        if (activeJobs.has(id) || existing.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能重置");
        const now = new Date().toISOString();
        db.prepare(`
          UPDATE runs SET current_stage = 0, status = 'active', qa_status = 'pending',
            job_type = 'none', generation_status = 'idle', generation_message = '', generation_progress = 0,
            generation_prompt_id = NULL, generation_current_node = NULL, preview_path = NULL,
            image_path = NULL, model_path = NULL, topology_path = NULL, rigged_model_path = NULL,
            qa_score = NULL, qa_summary = '', qa_metrics = '{}', qa_overlay_path = NULL, updated_at = ? WHERE id = ?
        `).run(now, id);
        addEvent(id, "reset", 0, "流程和产物引用已重置", now);
        json(res, 200, runDetail(id));
        return;
      }
      if (req.method === "DELETE" && parts.length === 3) {
        if (activeJobs.has(id) || existing.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能删除");
        db.prepare("DELETE FROM runs WHERE id = ?").run(id);
        json(res, 200, { ok: true });
        return;
      }
    }
    json(res, 404, { error: "接口不存在" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "服务器错误";
    json(res, error instanceof SyntaxError ? 400 : 422, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[API] http://${HOST}:${PORT}`);
  console.log(`[DB]  ${dbPath}`);
  console.log(`[DGX] ${DEFAULT_COMFYUI_URL} (default)`);
});

function shutdown() {
  for (const activeJob of activeJobs.values()) {
    if (activeJob.socket) activeJob.socket.close();
    activeJob.child.kill();
  }
  for (const activeJob of activeDispatcherJobs.values()) activeJob.child.kill();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
