import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { createAssetAgentRuntime } from "./agent-runtime.mjs";
import { createSettingsStore, PROCESS_KINDS } from "./settings.mjs";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..");
const localEnvPath = join(webRoot, ".env.local");
if (existsSync(localEnvPath)) loadEnvFile(localEnvPath);

const HOST = process.env.API_HOST || "127.0.0.1";
const PORT = Number(process.env.API_PORT || 8787);
const DEFAULT_COMFYUI_URL = process.env.COMFYUI_URL || "http://100.120.236.113:8188";
const PYTHON_COMMAND = process.env.PYTHON_COMMAND || "python";
const outputRoot = resolve(repoRoot, "output");
const generatedDir = join(webRoot, "public", "generated");
const dataDir = join(webRoot, "data");
const runtimeWorkflowDir = join(dataDir, "runtime-workflows");
const dbPath = process.env.DATABASE_PATH || join(dataDir, "super-idol-master.db");
const workflowDir = join(repoRoot, "scripts", "comfy_workflow");

const scripts = {
  "2d": join(workflowDir, "run_2d_generation.py"),
  qa: join(workflowDir, "run_tpose_qa.py"),
  "3d": join(workflowDir, "run_3d_generation.py"),
  rig: join(workflowDir, "run_3d_skinning.py"),
};
const workflowFiles = {
  "2d": join(workflowDir, "2D_Gen_QwenImage2512.json"),
  qa: join(workflowDir, "TPose_QA_SDPose.json"),
  "3d": join(workflowDir, "3D_Gen_Pixal3D.json"),
  rig: join(workflowDir, "3D_Skin_SkinTokens.json"),
};

mkdirSync(dataDir, { recursive: true });
mkdirSync(generatedDir, { recursive: true });
mkdirSync(runtimeWorkflowDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
const settingsStore = createSettingsStore({ db, workflowFiles, defaultComfyUrl: DEFAULT_COMFYUI_URL });
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    positive_prompt TEXT NOT NULL DEFAULT '',
    negative_prompt TEXT NOT NULL DEFAULT '',
    current_stage INTEGER NOT NULL DEFAULT 0 CHECK(current_stage BETWEEN 0 AND 5),
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
    model_path TEXT,
    rigged_model_path TEXT,
    qa_score INTEGER,
    qa_summary TEXT NOT NULL DEFAULT '',
    qa_metrics TEXT NOT NULL DEFAULT '{}',
    qa_overlay_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    stage INTEGER NOT NULL CHECK(stage BETWEEN 0 AND 5),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events(run_id, id DESC)");

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

db.prepare(`
  UPDATE runs SET generation_status = 'failed', generation_message = '本地服务重启，原 DGX 任务已中断'
  WHERE generation_status = 'running'
`).run();

// Never advance a stage during startup repair. Only move backward when a stage's
// required upstream artifact is missing.
for (const row of db.prepare("SELECT id, current_stage, qa_status, preview_path, image_path, model_path, rigged_model_path FROM runs").all()) {
  let imagePath = row.image_path;
  const migratedImage = join(generatedDir, `${row.id}.png`);
  if (!imagePath && row.preview_path && existsSync(migratedImage)) imagePath = migratedImage;
  const hasImage = Boolean(imagePath && existsSync(imagePath));
  const hasModel = Boolean(row.model_path && existsSync(row.model_path));
  const hasRig = Boolean(row.rigged_model_path && existsSync(row.rigged_model_path));
  let stage = Number(row.current_stage || 0);
  if (stage >= 2 && !hasImage) stage = 1;
  if (stage >= 3 && row.qa_status !== "passed") stage = 2;
  if (stage >= 4 && !hasModel) stage = 3;
  if (stage >= 5 && !hasRig) stage = 4;
  const status = stage === 5 && hasRig ? "completed" : "active";
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
  SELECT id, name, positive_prompt AS positivePrompt,
         negative_prompt AS negativePrompt, current_stage AS currentStage,
         status, qa_status AS qaStatus, generation_status AS jobStatus,
         generation_message AS jobMessage, generation_progress AS jobProgress,
         generation_prompt_id AS jobPromptId, generation_current_node AS jobCurrentNode,
         job_type AS jobType, preview_path AS previewPath,
         image_path AS imagePathInternal, model_path AS modelPathInternal,
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
}

function getRunRow(id) {
  return db.prepare(`${runSelect} WHERE id = ?`).get(id);
}

function serializeRun(row) {
  if (!row) return null;
  const {
    imagePathInternal,
    modelPathInternal,
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
      imageReady: Boolean(imagePathInternal && existsSync(imagePathInternal)),
      modelReady: Boolean(modelPathInternal && existsSync(modelPathInternal)),
      riggedReady: Boolean(riggedModelPathInternal && existsSync(riggedModelPathInternal)),
      imageDownloadUrl: imagePathInternal ? `/api/runs/${row.id}/download/image` : null,
      modelDownloadUrl: modelPathInternal ? `/api/runs/${row.id}/download/model` : null,
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
  const stageNames = ["角色描述", "概念图生成", "T-Pose 检查", "3D 模型生成", "自动绑骨", "资产导出"];

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE runs SET current_stage = ?, status = 'active', job_type = 'none',
        generation_status = 'idle', generation_message = '', generation_progress = 0,
        generation_prompt_id = NULL, generation_current_node = NULL,
        preview_path = ?, image_path = ?, model_path = ?, rigged_model_path = NULL,
        qa_status = ?, qa_score = ?, qa_summary = ?, qa_metrics = ?, qa_overlay_path = ?,
        updated_at = ? WHERE id = ?
    `).run(
      targetStage,
      keepPreview,
      keepImage,
      keepModel,
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

function advanceRun(runId) {
  const run = getRunRow(runId);
  if (!run) throw new Error("任务不存在");
  if (activeJobs.has(runId) || run.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能确认阶段");

  const stage = run.currentStage;
  if (stage < 1 || stage > 4) throw new Error("当前阶段不能执行完成确认");
  if (stage === 1 && (!run.imagePathInternal || !existsSync(run.imagePathInternal))) throw new Error("2D 概念图尚未生成完成");
  if (stage === 2 && run.qaStatus !== "passed") throw new Error("T-Pose 检查尚未通过");
  if (stage === 3 && (!run.modelPathInternal || !existsSync(run.modelPathInternal))) throw new Error("静态 GLB 尚未生成完成");
  if (stage === 4 && (!run.riggedModelPathInternal || !existsSync(run.riggedModelPathInternal))) throw new Error("绑骨 GLB 尚未生成完成");

  const nextStage = stage + 1;
  const now = new Date().toISOString();
  const stageNames = ["角色描述", "概念图生成", "T-Pose 检查", "3D 模型生成", "自动绑骨", "资产导出"];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE runs SET current_stage = ?, status = ?, job_type = 'none',
        generation_status = 'idle', generation_message = '', generation_progress = 0,
        generation_prompt_id = NULL, generation_current_node = NULL, updated_at = ?
      WHERE id = ?
    `).run(nextStage, nextStage === 5 ? "completed" : "active", now, runId);
    addEvent(runId, "stage_confirmed", stage, `用户确认“${stageNames[stage]}”已完成，进入“${stageNames[nextStage]}”`, now);
    if (nextStage === 5) addEvent(runId, "pipeline_completed", 5, "角色资产流水线完成，可下载最终 GLB", now);
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

function advanceWorkflow(runId) {
  const run = getRunRow(runId);
  if (!run) throw new Error("任务不存在");
  return run.currentStage === 0 ? confirmCharacterIdea(runId) : advanceRun(runId);
}

function runStageJob(runId, action) {
  const jobTypes = { generate_2d: "2d", check_tpose: "qa", generate_3d: "3d", rig: "rig" };
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
    if (meshCount < 1) throw new Error("GLB 中没有可用 mesh");
    if (requireRig && (skinCount < 1 || jointCount < 1)) throw new Error("SkinTokens 产物没有 skin/joints，拒绝标记为绑骨完成");
    return { meshCount, skinCount, jointCount, nodeCount: document.nodes?.length || 0 };
  } finally {
    closeSync(descriptor);
  }
}

const activeJobs = new Map();

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
  if (jobType === "rig") return [run.modelPathInternal];
  throw new Error("未知 DGX 任务类型");
}

function completeJob(runId, jobType, stdout) {
  const now = new Date().toISOString();
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines.at(-1) || "";
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
          model_path = NULL, rigged_model_path = NULL, qa_score = NULL, qa_summary = '', qa_metrics = '{}',
          qa_overlay_path = NULL, updated_at = ? WHERE id = ?
      `).run(previewPath, source, now, runId);
      addEvent(runId, "generation_succeeded", 1, "DGX Qwen Image 已返回真实 PNG", now);
    } else if (jobType === "qa") {
      const result = JSON.parse(lastLine);
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
          rigged_model_path = NULL, updated_at = ? WHERE id = ?
      `).run(modelPath, now, runId);
      addEvent(runId, "model_succeeded", 3, `DGX Pixal3D 已返回真实静态 GLB（${glb.meshCount} mesh）`, now);
    } else if (jobType === "rig") {
      const riggedPath = findLatestGlb(lastLine);
      const glb = inspectGlb(riggedPath, true);
      db.prepare(`
        UPDATE runs SET current_stage = 4, status = 'active', job_type = 'rig',
          generation_status = 'succeeded', generation_message = 'SkinTokens 已返回带骨骼 GLB，等待用户确认',
          generation_progress = 100, generation_current_node = NULL, rigged_model_path = ?, updated_at = ? WHERE id = ?
      `).run(riggedPath, now, runId);
      addEvent(runId, "rig_succeeded", 4, `DGX SkinTokens 已返回真实带骨骼 GLB（${glb.skinCount} skin / ${glb.jointCount} joints）`, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function failJob(runId, jobType, errorMessage) {
  const message = (errorMessage || `${jobType} 任务失败`).trim().slice(-1200);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE runs SET generation_status = 'failed', generation_message = ?, updated_at = ? WHERE id = ?
  `).run(message, now, runId);
  addEvent(runId, `${jobType}_failed`, { "2d": 1, qa: 2, "3d": 3, rig: 4 }[jobType], `${jobType.toUpperCase()} 任务失败：${message}`, now);
}

function launchJob(run, jobType) {
  const processConfig = settingsStore.processConfig(jobType);
  const workflowPath = join(runtimeWorkflowDir, `${run.id}-${jobType}-${randomUUID()}.json`);
  writeFileSync(workflowPath, JSON.stringify(processConfig.workflow), "utf8");
  const args = [
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
      env: { ...process.env, PYTHONUTF8: "1" },
    });
  } catch (error) {
    unlinkSync(workflowPath);
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
    if (!activeJob.socket) {
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
    if (existsSync(workflowPath)) unlinkSync(workflowPath);
    if (activeJobs.get(run.id) === activeJob) activeJobs.delete(run.id);
    try {
      if (success) completeJob(run.id, jobType, stdout);
      else failJob(run.id, jobType, errorMessage || stderr || `Python 退出代码非零`);
    } catch (error) {
      failJob(run.id, jobType, error instanceof Error ? error.message : "任务结果处理失败");
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
  if (jobType === "rig" && run.currentStage !== 4) throw new Error("请先确认 3D 模型生成完成");
  if (jobType === "2d" && !run.positivePrompt.trim()) throw new Error("请先填写正向提示词");
  if (jobType === "qa" && (!run.imagePathInternal || !existsSync(run.imagePathInternal))) throw new Error("没有可供 SDPose 检查的 2D 图片");
  if (jobType === "3d" && run.qaStatus !== "passed") throw new Error("SDPose 自动检查未通过，不能生成 3D");
  if (jobType === "3d" && (!run.imagePathInternal || !existsSync(run.imagePathInternal))) throw new Error("合格的 2D 图片不存在");
  if (jobType === "rig" && (!run.modelPathInternal || !existsSync(run.modelPathInternal))) throw new Error("静态 GLB 不存在，不能绑骨");

  const stage = { "2d": 1, qa: 2, "3d": 3, rig: 4 }[jobType];
  const messages = {
    "2d": "正在调用 DGX Qwen Image 生成 2D 概念图",
    qa: "正在调用 DGX SDPose 自动检查 T-Pose",
    "3d": "正在调用 DGX Pixal3D 生成静态 GLB",
    rig: "正在调用 DGX SkinTokens 自动绑骨",
  };
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (jobType === "2d") {
      db.prepare(`
        UPDATE runs SET current_stage = 1, status = 'active', qa_status = 'pending',
          model_path = NULL, rigged_model_path = NULL, qa_score = NULL, qa_summary = '',
          qa_metrics = '{}', qa_overlay_path = NULL WHERE id = ?
      `).run(runId);
    } else if (jobType === "qa") {
      db.prepare("UPDATE runs SET current_stage = 2, status = 'active', qa_status = 'pending' WHERE id = ?").run(runId);
    } else if (jobType === "3d") {
      db.prepare("UPDATE runs SET current_stage = 3, status = 'active', model_path = NULL, rigged_model_path = NULL WHERE id = ?").run(runId);
    } else if (jobType === "rig") {
      db.prepare("UPDATE runs SET current_stage = 4, status = 'active', rigged_model_path = NULL WHERE id = ?").run(runId);
    }
    db.prepare(`
      UPDATE runs SET job_type = ?, generation_status = 'running', generation_message = ?,
        generation_progress = 1, generation_prompt_id = NULL, generation_current_node = NULL, updated_at = ?
      WHERE id = ?
    `).run(jobType, messages[jobType], now, runId);
    addEvent(runId, `${jobType}_started`, stage, `启动${messages[jobType].replace("正在调用 ", "")}`, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  try {
    launchJob(getRunRow(runId), jobType);
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

async function checkComfyUi(force = false) {
  if (!force && systemCache && Date.now() - systemCacheAt < 15_000) return systemCache;
  const configs = Object.fromEntries(PROCESS_KINDS.map((kind) => [kind, settingsStore.processConfig(kind)]));
  const endpointPromises = new Map();
  for (const config of Object.values(configs)) {
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
  const endpoints = new Map();
  await Promise.all([...endpointPromises.entries()].map(async ([url, promise]) => endpoints.set(url, await promise)));
  const checks = {};
  for (const kind of PROCESS_KINDS) {
    const config = configs[kind];
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
  const value = {
    online: endpointValues.every((item) => item.online),
    url: urls.length === 1 ? urls[0] : "多个端点",
    latencyMs: Math.max(0, ...endpointValues.map((item) => item.latencyMs)),
    version: [...new Set(endpointValues.map((item) => item.stats?.system?.comfyui_version).filter(Boolean))].join(", ") || null,
    queue: {
      running: endpointValues.reduce((total, item) => total + (item.queue.queue_running?.length || 0), 0),
      pending: endpointValues.reduce((total, item) => total + (item.queue.queue_pending?.length || 0), 0),
    },
    workflows: checks,
    pipelineReady: Object.values(checks).every((item) => item.ready),
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
});

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
      json(res, 200, { ok: true, database: "sqlite", databasePath: dbPath, agent: assetAgent.status() });
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
    if (req.method === "GET" && url.pathname === "/api/runs") {
      json(res, 200, { runs: db.prepare(`${runSelect} ORDER BY updated_at DESC`).all().map(serializeRun) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/runs") {
      const body = await readBody(req);
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO runs (id, name, positive_prompt, negative_prompt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        cleanText(body.name, 80, "资产名称", true),
        cleanText(body.positivePrompt, 4000, "正向提示词"),
        cleanText(body.negativePrompt, 2000, "反向提示词"),
        now,
        now,
      );
      addEvent(id, "created", 0, "创建角色任务", now);
      json(res, 201, runDetail(id));
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
        json(res, 200, runDetail(id));
        return;
      }
      if (req.method === "GET" && parts[3] === "agent" && parts[4] === "messages") {
        json(res, 200, { messages: assetAgent.getMessages(id) });
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
      if (req.method === "POST" && parts[3] === "start") {
        const body = await readBody(req);
        json(res, 200, confirmCharacterIdea(id, body));
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
      if (req.method === "GET" && parts[3] === "download" && parts[4]) {
        const paths = {
          image: existing.imagePathInternal,
          model: existing.modelPathInternal,
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
            image_path = NULL, model_path = NULL, rigged_model_path = NULL,
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
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
