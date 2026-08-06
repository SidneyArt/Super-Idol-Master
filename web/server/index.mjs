import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { createAssetAgentRuntime, imageContent } from "./agent-runtime.mjs";
import { createApprovalRuntime } from "./approval-runtime.mjs";
import { createSettingsStore } from "./settings.mjs";
import { createAgentRoutes } from "./features/agents/routes.mjs";
import { createAgentsFeature } from "./features/agents/index.mjs";
import { createCoordinatorFeature } from "./features/agents/coordinator.mjs";
import { createApprovalRoutes } from "./features/approvals/routes.mjs";
import { createAssetRoutes } from "./features/assets/routes.mjs";
import { createAssetsFeature } from "./features/assets/index.mjs";
import { createAssetStorage } from "./features/assets/storage.mjs";
import { createJobRoutes } from "./features/jobs/routes.mjs";
import { createJobsFeature } from "./features/jobs/index.mjs";
import { createJobRuntime } from "./features/jobs/runtime.mjs";
import { createQualityGateRoutes } from "./features/quality-gates/routes.mjs";
import { createQualityGatesFeature, hasRepairableTposeSource } from "./features/quality-gates/index.mjs";
import { createRunRoutes } from "./features/runs/routes.mjs";
import { createRunsFeature } from "./features/runs/index.mjs";
import { createSettingsRoutes } from "./features/settings/routes.mjs";
import { createSystemRoutes } from "./features/system/routes.mjs";
import { createSystemProbes } from "./features/system/probes.mjs";
import { createWorkspaceRoutes } from "./features/workspaces/routes.mjs";
import { createWorkspacesFeature } from "./features/workspaces/index.mjs";
import { dispatchRoutes } from "./http/dispatch-routes.mjs";
import { bootstrapDatabase } from "./database/bootstrap.mjs";

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
  "tpose-repair": join(pipelineDir, "repair_tpose_image.py"),
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

// Hard cap for a single source-image payload. Mirrors the 12 MB limit enforced
// in the Studio UI (`readImage(file, 12 * 1024 * 1024, ...)`); the create-run
// handler below also reads it before persisting.
const SOURCE_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
// Base64 inflates binary payloads by ~4/3, so a 12 MB image can produce a
// ~16 MB string. Add headroom for the JSON wrapper, mimeType, file name and
// the rest of the request body before we hit the request body cap.
const CREATE_RUN_BODY_MAX_BYTES = Math.ceil(SOURCE_IMAGE_MAX_BYTES * 4 / 3) + 2 * 1024 * 1024;

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
const settingsStore = createSettingsStore({ db, workflowFiles, defaultComfyUrl: DEFAULT_COMFYUI_URL });
bootstrapDatabase({ db, generatedDir });
const approvalRuntime = createApprovalRuntime({ db });
const activeJobs = new Map();
const assetStorage = createAssetStorage({
  animationDir,
  db,
  formatBytes,
  generatedDir,
  outputRoot,
  sourceImageMaxBytes: SOURCE_IMAGE_MAX_BYTES,
});
const runs = createRunsFeature({
  db,
  activeJobs,
  cleanText,
  exists: existsSync,
  notify: (notification) => approvalRuntime.addNotification(notification),
  resolveSourceImage: assetStorage.resolveRunSourceImage,
  canPreserveRepairSource: hasRepairableTposeSource,
});
const {
  addEvent,
  advanceWorkflow,
  get: runDetail,
  getInternal: getRunRow,
  revert: revertRun,
  updatePrompts: updateRunPrompts,
} = runs;

if (runs.list().length === 0) {
  runs.create({
    name: "特种兵 / 53 SHAPES",
    positivePrompt: "美式3d卡通，1个3d女性角色，Ninjala风格，任天堂风格，潮流配色，(严格正视图:1.3)，完全正对镜头，(严格的T-Pose:1.3)，双臂水平伸展，全身出镜，纯白色背景，极简服装设计，纯净模型，1:1比例，高品质，杰作",
    negativePrompt: "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲",
  });
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}

async function readBody(req, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const detail = maxBytes >= 1024 * 1024
        ? `请求内容不能超过 ${formatBytes(maxBytes)}（约 ${formatBytes(Math.max(0, maxBytes - size + chunk.length))} 可用，已超过上限）`
        : `请求内容不能超过 ${formatBytes(maxBytes)}`;
      throw new Error(detail);
    }
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

let assetAgent;
let coordinatorAgent;
let agents;
const jobRuntime = createJobRuntime({
  db,
  runs,
  activeJobs,
  generatedDir,
  getAssetAgent: () => assetAgent,
  outputRoot,
  pythonCommand: PYTHON_COMMAND,
  repoRoot,
  runtimeWorkflowDir,
  scripts,
  settingsStore,
});
const { inspectGlb, repairTposeImage } = jobRuntime;
const gpuScheduler = jobRuntime.scheduler;
const activeDispatcherJobs = new Map();

const systemProbes = createSystemProbes({ settingsStore });
const checkComfyUi = systemProbes.check;
const invalidateSystemCache = systemProbes.invalidate;

let workspaces;
const assets = createAssetsFeature({
  db,
  runs,
  activeJobs,
  outputRoot,
  generatedDir,
  getWorkspace: (workspaceId) => workspaces.get(workspaceId),
});
Object.assign(assets, {
  animations: assetStorage.animations,
  streamPreview: streamAssetPreview,
  streamDownload,
});
workspaces = createWorkspacesFeature({
  db,
  activeJobs,
  activeDispatcherJobs,
  cleanText,
  deleteControlledAssetFile: assets.deleteFile,
  generatedFileFromPreviewUrl: assets.generatedFileFromPreviewUrl,
  isControlledAssetPath: assets.isControlledPath,
  taskAgent: () => assetAgent,
  coordinatorAgent: () => coordinatorAgent,
});
const coordinatorFeature = createCoordinatorFeature({
  activeDispatcherJobs,
  approvalRuntime,
  assetStorage,
  cleanText,
  db,
  generatedDir,
  getAgents: () => agents,
  getAssetAgent: () => assetAgent,
  gpuScheduler,
  outputRoot,
  pythonCommand: PYTHON_COMMAND,
  repoRoot,
  runs,
  scripts,
  settingsStore,
  workspaces,
});
coordinatorAgent = coordinatorFeature.runtime;

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

assetAgent = createAssetAgentRuntime({
  db,
  getRunDetail: runDetail,
  updatePrompts: updateRunPrompts,
  advanceWorkflow,
  revertWorkflow: revertRun,
  repairTposeImage,
  runStageJob: jobRuntime.runStage,
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
  publishActivity: coordinatorFeature.publishActivity,
  getPermissionMode: (runId) => approvalRuntime.permission("task", runId),
  requestApproval: approvalRuntime.requestApproval,
});

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
    && coordinatorFeature.isDelegationReason(approval?.payload?.reason);
}

approvalRuntime.setExecutor(async (approval) => {
  if (approval.scopeType === "task") {
    return assetAgent.executeApprovedOperation(approval.runId, approval.operation, approval.payload);
  }
  if (approval.operation === "create_workspace") return workspaces.create(approval.payload);
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
        const result = await coordinatorFeature.delegateTask(runId, target, "已批准继续推进现有任务");
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
          const result = await coordinatorFeature.delegateTask(task.run.id, params.target, "已批准的总调度任务委派");
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

agents = createAgentsFeature({
  db,
  runs,
  workspaces,
  taskRuntime: assetAgent,
  coordinatorRuntime: coordinatorAgent,
  cleanText,
});
const qualityGates = createQualityGatesFeature({
  runs,
  agents: assetAgent,
  imageContent,
});
const jobs = createJobsFeature({ runs, startJob: jobRuntime.start });

const featureRoutes = [
  createSystemRoutes({
    assetAgent,
    checkComfyUi,
    databasePath: dbPath,
    gpuScheduler,
    json,
    sourceMtimeMs: serverSourceMtimeMs,
  }),
  createSettingsRoutes({
    invalidateSystemCache,
    json,
    readBody,
    settingsStore,
  }),
  createApprovalRoutes({
    approvalRuntime,
    cleanText,
    getRunRow,
    json,
    readBody,
  }),
  createWorkspaceRoutes({
    json,
    readBody,
    workspaces,
  }),
  createAssetRoutes({
    assets,
    json,
    readBody,
  }),
  createAgentRoutes({
    agents,
    json,
    readBody,
  }),
  createJobRoutes({
    jobs,
    json,
  }),
  createQualityGateRoutes({
    json,
    qualityGates,
    readBody,
  }),
  createRunRoutes({
    agents: agents.task,
    createRunBodyMaxBytes: CREATE_RUN_BODY_MAX_BYTES,
    json,
    readBody,
    runs,
  }),
];

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
    //todo：目前两套路由，请保证稳定后，删除一个
    if (await dispatchRoutes(featureRoutes, { req, res, url, parts })) return;
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
  gpuScheduler.shutdown("本地服务关闭，GPU 任务已取消");
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
