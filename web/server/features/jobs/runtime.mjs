import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, openSync, readSync, readdirSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";
import { createGpuResourceScheduler } from "../../gpu-resource-scheduler.mjs";
import { jobStartMessage } from "../../job-messages.mjs";
import { runJsonSubprocess } from "../../subprocess-json.mjs";
import { select2dExecution } from "./2d-execution-policy.mjs";
import {
  canStartTposeModelRepair, captureTposeRepairSource, hasRepairableTposeSource,
  isCurrentTposeRepairSource,
} from "../quality-gates/index.mjs";

export function createJobRuntime({
  db, runs, activeJobs, generatedDir, getAssetAgent, outputRoot,
  pythonCommand, repoRoot, runtimeWorkflowDir, scripts, settingsStore,
}) {
  const { addEvent, get: runDetail, getInternal: getRunRow, serialize: serializeRun } = runs;
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
  
  async function repairTposeImage(runId, context = {}) {
    const run = getRunRow(runId);
    if (!run) throw new Error("任务不存在");
    if (!hasRepairableTposeSource(run)) throw new Error("只有待修复的阶段 2 T-Pose 可以执行确定性修复");
    if (!run.imagePathInternal || !existsSync(run.imagePathInternal)) throw new Error("待修复的 T-Pose 图片不存在");
    const repairSource = captureTposeRepairSource(run);
    const staleResult = () => ({
      applied: false,
      strategy: "stale_source",
      actions: [],
      reason: "T-Pose 修复期间源图片或任务状态已变化，旧结果已丢弃",
      outputPath: null,
    });
    const metrics = serializeRun(run).qaMetrics;
    const result = await runJsonSubprocess({
      command: pythonCommand,
      args: [
        scripts["tpose-repair"],
        run.imagePathInternal,
        "--metrics-json", JSON.stringify(metrics),
        "--output-root", outputRoot,
      ],
      cwd: repoRoot,
      env: { ...process.env, PYTHONUTF8: "1" },
      timeoutMs: 30_000,
      failureMessage: "确定性 T-Pose 修复失败",
    });
    if (!isCurrentTposeRepairSource(repairSource, getRunRow(runId))) {
      return staleResult();
    }
    if (result.applied !== true) return result;
  
    const source = safeOutputPath(result.outputPath, "file");
    const suffix = extname(source).toLowerCase() || ".png";
    const filename = `${runId}${suffix}`;
    const previewPath = `/generated/${filename}?v=${Date.now()}`;
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      const update = db.prepare(`
        UPDATE runs SET current_stage = 2, status = 'active', qa_status = 'pending',
          job_type = 'none', generation_status = 'idle', generation_message = '确定性 T-Pose 修复完成，等待重新质检',
          generation_progress = 100, generation_prompt_id = NULL, generation_current_node = NULL,
          preview_path = ?, image_path = ?, model_path = NULL, topology_path = NULL, rigged_model_path = NULL,
          qa_score = NULL, qa_summary = '', qa_metrics = '{}', qa_overlay_path = NULL, updated_at = ?
        WHERE id = ? AND current_stage = ? AND qa_status = ? AND image_path = ? AND updated_at = ?
      `).run(
        previewPath,
        source,
        now,
        runId,
        repairSource.currentStage,
        repairSource.qaStatus,
        repairSource.imagePathInternal,
        repairSource.updatedAt,
      );
      if (update.changes !== 1) {
        db.exec("ROLLBACK");
        return staleResult();
      }
      copyFileSync(source, join(generatedDir, filename));
      addEvent(
        runId,
        "qa_deterministic_repair_applied",
        2,
        `第 ${Number(context.attempt) || 1} 轮确定性修复：${Array.isArray(result.actions) ? result.actions.join("、") : result.strategy}`,
        now,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { ...result, outputPath: source, previewPath };
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
  
  const gpuScheduler = createGpuResourceScheduler({ capacity: 1 });
  
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
  
  function launchJob(run, jobType, processConfig, lease, execution2d = null) {
    const usesImageApi = jobType === "2d" && processConfig.mode === "api";
    const usesTopologyApi = jobType === "topology";
    const workflowPath = usesImageApi || usesTopologyApi ? null : join(runtimeWorkflowDir, `${run.id}-${jobType}-${randomUUID()}.json`);
    if (workflowPath) writeFileSync(workflowPath, JSON.stringify(processConfig.workflow), "utf8");
    const sourceImage = execution2d?.sourceImage ?? run.imagePathInternal;
    const args = usesImageApi
      ? [
          scripts["2d-api"],
          "--positive", run.positivePrompt,
          "--negative", run.negativePrompt || "",
          "--base-url", processConfig.api.baseUrl,
          "--model", processConfig.api.model,
          ...(sourceImage && existsSync(sourceImage) ? ["--source-image", sourceImage] : []),
          ...(execution2d?.tposeOutput ? ["--tpose-output"] : []),
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
      child = spawn(pythonCommand, args, {
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
    const activeJob = { runId: run.id, jobType, child, socket: null, workflowPath, lease };
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
          // The scheduler ID is released in finally. Deferring the Agent hook by
          // one microtask prevents an automatic next stage from reusing the same
          // run ID while the completed lease is still registered.
          queueMicrotask(() => {
            void getAssetAgent().handleJobCompleted(completion).catch((error) => {
              console.error(`[Agent] ${jobType} completion hook failed:`, error);
            });
          });
        } else {
          const message = errorMessage || stderr || `Python 退出代码非零`;
          failJob(run.id, jobType, message);
          queueMicrotask(() => {
            void getAssetAgent().handleJobFailed({ runId: run.id, jobType, message: message.trim().slice(-1200) }).catch((error) => {
              console.error(`[Agent] ${jobType} failure diagnosis hook failed:`, error);
            });
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "任务结果处理失败";
        failJob(run.id, jobType, message);
        queueMicrotask(() => {
          void getAssetAgent().handleJobFailed({ runId: run.id, jobType, message }).catch((diagnosisError) => {
            console.error(`[Agent] ${jobType} failure diagnosis hook failed:`, diagnosisError);
          });
        });
      } finally {
        lease.release();
      }
    };
  
    child.on("error", (error) => finalize(false, error.message));
    child.on("close", (code) => finalize(code === 0, code === 0 ? "" : stderr || `Python 退出代码 ${code}`));
    return {
      cancel: () => {
        if (activeJob.socket) activeJob.socket.close();
        child.kill();
      },
    };
  }
  
  function startJob(runId, jobType, options = {}) {
    const run = getRunRow(runId);
    if (!run) throw new Error("任务不存在");
    if (run.jobStatus === "running") throw new Error("当前任务仍在执行");
    if (jobType === "2d" && run.currentStage !== 1 && !canStartTposeModelRepair(run, options.repairMode)) throw new Error("当前阶段不能生成 2D 概念图");
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
    const execution2d = jobType === "2d"
      ? select2dExecution({
          run,
          repairMode: options.repairMode === true,
          defaultProcessConfig: processConfig,
          imageEditConfig: settingsStore.imageConfig("image_to_model"),
        })
      : null;
    if (execution2d) {
      processConfig = execution2d.processConfig;
      if (options.repairMode && (!execution2d.sourceImage || !existsSync(execution2d.sourceImage))) {
        throw new Error("图片编辑修复缺少失败的 T-Pose 输入图");
      }
      if (!options.repairMode && run.pipelineType === "image_to_model" && (!execution2d.sourceImage || !existsSync(execution2d.sourceImage))) {
        throw new Error("图生模型工作流缺少角色原画");
      }
    }
    if (jobType === "2d" && processConfig.mode === "api" && !processConfig.api.apiKey) throw new Error("2D API Key 未配置，请在请求设置中填写或配置 Agent API Key");
  
    const stage = { "2d": 1, qa: 2, "3d": 3, topology: 4, rig: 5 }[jobType];
    const message = jobStartMessage(jobType, processConfig);
    const schedulerId = `run:${runId}`;
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
      `).run(jobType, `已加入全局 GPU 队列：${message}`, now, runId);
      addEvent(runId, `${jobType}_queued`, stage, `已加入全局 GPU 队列：${message.replace("正在调用 ", "")}`, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    try {
      gpuScheduler.schedule({
        id: schedulerId,
        label: `${getRunRow(runId).name} · ${jobType}`,
        onQueued: ({ position }) => {
          db.prepare(`
            UPDATE runs SET generation_message = ?, updated_at = ?
            WHERE id = ? AND generation_status = 'running' AND job_type = ?
          `).run(`正在等待全局 GPU 资源（队列第 ${position} 位）：${message}`, new Date().toISOString(), runId, jobType);
        },
        start: (lease) => {
          const startedAt = new Date().toISOString();
          db.prepare(`
            UPDATE runs SET generation_message = ?, updated_at = ?
            WHERE id = ? AND generation_status = 'running' AND job_type = ?
          `).run(message, startedAt, runId, jobType);
          addEvent(runId, `${jobType}_started`, stage, `获得全局 GPU 资源，启动${message.replace("正在调用 ", "")}`, startedAt);
          return launchJob(getRunRow(runId), jobType, processConfig, lease, execution2d);
        },
        onStartError: (error) => {
          failJob(runId, jobType, error instanceof Error ? error.message : "任务进程启动失败");
        },
        onCancel: (reason) => {
          failJob(runId, jobType, reason);
        },
      });
    } catch (error) {
      if (getRunRow(runId)?.jobStatus === "running") {
        failJob(runId, jobType, error instanceof Error ? error.message : "任务调度失败");
      }
      throw error;
    }
    return runDetail(runId);
  }
  

  function runStage(runId, action) {
    const jobTypes = { generate_2d: "2d", repair_2d: "2d", check_tpose: "qa", generate_3d: "3d", retopologize: "topology", rig: "rig" };
    const jobType = jobTypes[action];
    if (!jobType) throw new Error("未知阶段任务");
    return startJob(runId, jobType, { repairMode: action === "repair_2d" });
  }

  return { activeJobs, inspectGlb, repairTposeImage, runStage, safeOutputPath, scheduler: gpuScheduler, start: startJob };
}
