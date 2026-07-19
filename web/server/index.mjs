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
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HOST = process.env.API_HOST || "127.0.0.1";
const PORT = Number(process.env.API_PORT || 8787);
const COMFYUI_URL = process.env.COMFYUI_URL || "http://100.120.236.113:8188";
const PYTHON_COMMAND = process.env.PYTHON_COMMAND || "python";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..");
const outputRoot = resolve(repoRoot, "output");
const generatedDir = join(webRoot, "public", "generated");
const dataDir = join(webRoot, "data");
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
  "3d": join(workflowDir, "3D_Gen_Pixal3D.json"),
  rig: join(workflowDir, "3D_Skin_SkinTokens.json"),
};
const workflowGraphs = Object.fromEntries(
  Object.entries(workflowFiles).map(([kind, file]) => [kind, JSON.parse(readFileSync(file, "utf8"))]),
);
const qaClasses = [
  "LoadImage",
  "CheckpointLoaderSimple",
  "SDPoseKeypointExtractor",
  "SavePoseKpsAsJsonFile",
  "SDPoseDrawKeypoints",
  "PreviewImage",
];

mkdirSync(dataDir, { recursive: true });
mkdirSync(generatedDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
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

// Repair state produced by the old clickable prototype. A stage is only restored
// when a corresponding real local artifact or automatic QA record exists.
for (const row of db.prepare("SELECT id, preview_path, image_path, model_path, rigged_model_path, qa_summary FROM runs").all()) {
  let imagePath = row.image_path;
  const migratedImage = join(generatedDir, `${row.id}.png`);
  if (!imagePath && row.preview_path && existsSync(migratedImage)) imagePath = migratedImage;
  const hasImage = Boolean(imagePath && existsSync(imagePath));
  const hasModel = Boolean(row.model_path && existsSync(row.model_path));
  const hasRig = Boolean(row.rigged_model_path && existsSync(row.rigged_model_path));
  let stage = 0;
  let status = "active";
  let qaStatus = "pending";
  if (hasImage) stage = 2;
  if (hasImage && row.qa_summary) {
    const savedQa = db.prepare("SELECT qa_status AS qaStatus FROM runs WHERE id = ?").get(row.id);
    qaStatus = savedQa.qaStatus;
    if (qaStatus === "passed") stage = 3;
  }
  if (hasModel) stage = 4;
  if (hasRig) {
    stage = 5;
    status = "completed";
  }
  db.prepare(`
    UPDATE runs SET image_path = ?, current_stage = ?, status = ?, qa_status = ?, updated_at = updated_at
    WHERE id = ?
  `).run(imagePath || null, stage, status, qaStatus, row.id);
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
  if (activeJob?.runId === runId || run.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能回退");
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
  const allowed = new Set(["http://127.0.0.1:3100", "http://localhost:3100"]);
  if (origin && allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("请求内容过大");
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

function dependencyCount(graph, outputIds) {
  const visited = new Set();
  const visit = (nodeId) => {
    if (visited.has(nodeId) || !graph[nodeId]) return;
    visited.add(nodeId);
    for (const value of Object.values(graph[nodeId].inputs || {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") visit(value[0]);
    }
  };
  outputIds.forEach(visit);
  return Math.max(visited.size, 1);
}

const expectedNodeCounts = {
  "2d": dependencyCount(workflowGraphs["2d"], ["60"]),
  qa: 6,
  "3d": dependencyCount(workflowGraphs["3d"], ["308"]),
  rig: dependencyCount(workflowGraphs.rig, ["30", "31"]),
};

let activeJob = null;

function persistJobProgress(runId, jobType, progress, message, node = null) {
  db.prepare(`
    UPDATE runs
    SET generation_progress = ?, generation_message = ?, generation_current_node = ?, updated_at = ?
    WHERE id = ? AND generation_status = 'running' AND job_type = ?
  `).run(Math.max(1, Math.min(99, Math.round(progress))), message, node, new Date().toISOString(), runId, jobType);
}

function connectComfyProgress(runId, jobType, promptId, clientId) {
  const wsUrl = `${COMFYUI_URL.replace(/^http/i, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`;
  const socket = new WebSocket(wsUrl);
  const expected = expectedNodeCounts[jobType] || 1;
  const completed = new Set();
  let currentNode = null;
  let lastProgress = 5;

  const update = (fraction, message, node = currentNode) => {
    const progress = Math.max(lastProgress, 5 + Math.min(1, fraction) * 90);
    lastProgress = progress;
    persistJobProgress(runId, jobType, progress, message, node ? String(node) : null);
  };

  socket.addEventListener("open", () => update(0.01, "已连接 ComfyUI 实时事件流"));
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
        UPDATE runs SET current_stage = 2, status = 'active', qa_status = 'pending',
          job_type = '2d', generation_status = 'succeeded', generation_message = '2D 图片生成完成，正在启动 SDPose 自动检查',
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
        UPDATE runs SET current_stage = ?, status = 'active', qa_status = ?, job_type = 'qa',
          generation_status = 'succeeded', generation_message = ?, generation_progress = 100,
          generation_prompt_id = COALESCE(?, generation_prompt_id), generation_current_node = NULL,
          qa_score = ?, qa_summary = ?, qa_metrics = ?, qa_overlay_path = ?, updated_at = ? WHERE id = ?
      `).run(
        passed ? 3 : 2,
        passed ? "passed" : "failed",
        result.summary || "SDPose 自动检查完成",
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
        UPDATE runs SET current_stage = 4, status = 'active', job_type = '3d',
          generation_status = 'succeeded', generation_message = 'Pixal3D 已返回静态 GLB',
          generation_progress = 100, generation_current_node = NULL, model_path = ?,
          rigged_model_path = NULL, updated_at = ? WHERE id = ?
      `).run(modelPath, now, runId);
      addEvent(runId, "model_succeeded", 3, `DGX Pixal3D 已返回真实静态 GLB（${glb.meshCount} mesh）`, now);
    } else if (jobType === "rig") {
      const riggedPath = findLatestGlb(lastLine);
      const glb = inspectGlb(riggedPath, true);
      db.prepare(`
        UPDATE runs SET current_stage = 5, status = 'completed', job_type = 'rig',
          generation_status = 'succeeded', generation_message = 'SkinTokens 已返回带骨骼 GLB',
          generation_progress = 100, generation_current_node = NULL, rigged_model_path = ?, updated_at = ? WHERE id = ?
      `).run(riggedPath, now, runId);
      addEvent(runId, "rig_succeeded", 4, `DGX SkinTokens 已返回真实带骨骼 GLB（${glb.skinCount} skin / ${glb.jointCount} joints）`, now);
      addEvent(runId, "pipeline_completed", 5, "角色资产流水线完成，可下载最终 GLB", now);
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
  const args = [scripts[jobType], ...jobArguments(run, jobType), "--comfyui-url", COMFYUI_URL];
  const child = spawn(PYTHON_COMMAND, args, {
    cwd: repoRoot,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  activeJob = { runId: run.id, jobType, child, socket: null };
  let stdout = "";
  let stderr = "";
  let finalized = false;
  const comfyKind = jobType === "rig" ? "skin" : jobType;

  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-100_000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-100_000);
    if (!activeJob?.socket) {
      const match = stderr.match(new RegExp(`\\[${comfyKind}\\] submitted prompt_id=(\\S+) client_id=(\\S+)`));
      if (match) {
        const [, promptId, clientId] = match;
        db.prepare(`
          UPDATE runs SET generation_prompt_id = ?, generation_progress = 5,
            generation_message = 'ComfyUI 已接收任务', updated_at = ?
          WHERE id = ? AND generation_status = 'running'
        `).run(promptId, new Date().toISOString(), run.id);
        activeJob.socket = connectComfyProgress(run.id, jobType, promptId, clientId);
      }
    }
  });

  const finalize = (success, errorMessage = "") => {
    if (finalized) return;
    finalized = true;
    const socket = activeJob?.socket;
    if (socket) socket.close();
    activeJob = null;
    try {
      if (success) completeJob(run.id, jobType, stdout);
      else failJob(run.id, jobType, errorMessage || stderr || `Python 退出代码非零`);
    } catch (error) {
      failJob(run.id, jobType, error instanceof Error ? error.message : "任务结果处理失败");
    }
    if (success && jobType === "2d") {
      setTimeout(() => {
        try {
          startJob(run.id, "qa", true);
        } catch (error) {
          failJob(run.id, "qa", error instanceof Error ? error.message : "自动检查启动失败");
        }
      }, 150);
    }
  };

  child.on("error", (error) => finalize(false, error.message));
  child.on("close", (code) => finalize(code === 0, code === 0 ? "" : stderr || `Python 退出代码 ${code}`));
}

function startJob(runId, jobType, automatic = false) {
  if (activeJob) throw new Error(`已有 ${activeJob.jobType.toUpperCase()} 任务正在 DGX 执行，请等待完成`);
  const run = getRunRow(runId);
  if (!run) throw new Error("任务不存在");
  if (run.jobStatus === "running") throw new Error("当前任务仍在执行");
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
    addEvent(runId, `${jobType}_started`, stage, `${automatic ? "自动启动" : "启动"}${messages[jobType].replace("正在调用 ", "")}`, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  launchJob(getRunRow(runId), jobType);
  return runDetail(runId);
}

let systemCache = null;
let systemCacheAt = 0;

async function fetchComfy(path, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let response = await fetch(`${COMFYUI_URL}/${path}`, { signal: controller.signal });
    if (response.status === 404) response = await fetch(`${COMFYUI_URL}/api/${path}`, { signal: controller.signal });
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
  const started = Date.now();
  try {
    const [stats, queue, objectInfo] = await Promise.all([
      fetchComfy("system_stats", 5000),
      fetchComfy("queue", 5000),
      fetchComfy("object_info", 15_000),
    ]);
    const checks = {};
    for (const kind of ["2d", "3d", "rig"]) {
      const required = workflowClasses(workflowGraphs[kind]);
      const missing = required.filter((name) => !objectInfo[name]);
      checks[kind] = { ready: missing.length === 0, missing };
    }
    const qaMissing = qaClasses.filter((name) => !objectInfo[name]);
    const checkpointOptions = objectInfo.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    if (!checkpointOptions.includes("sdpose_wholebody_fp16.safetensors")) qaMissing.push("sdpose_wholebody_fp16.safetensors");
    checks.qa = { ready: qaMissing.length === 0, missing: qaMissing };
    const value = {
      online: true,
      url: COMFYUI_URL,
      latencyMs: Date.now() - started,
      version: stats.system?.comfyui_version || null,
      queue: {
        running: queue.queue_running?.length || 0,
        pending: queue.queue_pending?.length || 0,
      },
      workflows: checks,
      pipelineReady: Object.values(checks).every((item) => item.ready),
    };
    systemCache = value;
    systemCacheAt = Date.now();
    return value;
  } catch {
    return {
      online: false,
      url: COMFYUI_URL,
      latencyMs: Date.now() - started,
      queue: { running: 0, pending: 0 },
      workflows: {},
      pipelineReady: false,
    };
  }
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
      json(res, 200, { ok: true, database: "sqlite", databasePath: dbPath });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/system") {
      json(res, 200, { api: true, database: true, comfyui: await checkComfyUi(url.searchParams.get("force") === "1") });
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
      if (req.method === "POST" && parts[3] === "start") {
        if (existing.jobStatus === "running") throw new Error("当前任务仍在执行");
        const body = await readBody(req);
        const positivePrompt = cleanText(body.positivePrompt ?? existing.positivePrompt, 4000, "正向提示词", true);
        const negativePrompt = cleanText(body.negativePrompt ?? existing.negativePrompt, 2000, "负向提示词");
        const now = new Date().toISOString();
        db.prepare(`
          UPDATE runs SET positive_prompt = ?, negative_prompt = ?, current_stage = 1,
            status = 'active', updated_at = ? WHERE id = ?
        `).run(positivePrompt, negativePrompt, now, id);
        addEvent(id, "idea_confirmed", 0, "角色设定已确认，进入 2D 生成", now);
        json(res, 200, runDetail(id));
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
        if (activeJob?.runId === id || existing.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能重置");
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
        if (activeJob?.runId === id || existing.jobStatus === "running") throw new Error("DGX 任务正在执行，暂时不能删除");
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
  console.log(`[DGX] ${COMFYUI_URL}`);
});

function shutdown() {
  if (activeJob?.socket) activeJob.socket.close();
  if (activeJob?.child) activeJob.child.kill();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
