import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";

export const PROCESS_KINDS = ["2d", "qa", "3d", "rig"];

const PROCESS_LABELS = {
  "2d": "2D 概念图",
  qa: "T-Pose 检查",
  "3d": "3D 模型",
  rig: "自动绑骨",
};

const REQUIRED_NODES = {
  "2d": ["60", "268", "269", "282"],
  qa: ["1", "4"],
  "3d": ["122", "308", "309", "313"],
  rig: ["23"],
};

const MAX_WORKFLOW_BYTES = 500_000;
const MAX_CUSTOM_WORKFLOWS = 20;
const DEFAULT_IMAGE_API_BASE_URL = "https://api.stepfun.com/step_plan/v1";
const DEFAULT_IMAGE_API_MODEL = "step-image-edit-2";
const REASONING_EFFORTS = new Set(["off", "low", "high"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeUrl(value, field) {
  const text = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!text) throw new Error(`${field}不能为空`);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${field}不是有效 URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${field}只支持 HTTP 或 HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${field}不能包含用户名或密码`);
  return text;
}

function normalizeReasoningEffort(value, fallback = "high") {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  return REASONING_EFFORTS.has(effort) ? effort : fallback;
}

function validateReasoningEffort(value, field) {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!REASONING_EFFORTS.has(effort)) throw new Error(`${field}必须为 off、low 或 high`);
  return effort;
}

function normalizeWorkflow(value, kind) {
  let graph = value;
  if (typeof graph === "string") {
    try {
      graph = JSON.parse(graph);
    } catch {
      throw new Error(`${PROCESS_LABELS[kind]}工作流不是有效 JSON`);
    }
  }
  if (!graph || typeof graph !== "object" || Array.isArray(graph) || !Object.keys(graph).length) {
    throw new Error(`${PROCESS_LABELS[kind]}工作流必须是非空 JSON 对象`);
  }
  for (const nodeId of REQUIRED_NODES[kind]) {
    const node = graph[nodeId];
    if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object") {
      throw new Error(`${PROCESS_LABELS[kind]}工作流缺少可用节点 ${nodeId}`);
    }
  }
  const serialized = JSON.stringify(graph);
  if (Buffer.byteLength(serialized) > MAX_WORKFLOW_BYTES) throw new Error(`${PROCESS_LABELS[kind]}工作流不能超过 500 KB`);
  return JSON.parse(serialized);
}

function displayWorkflowName(value, fallback) {
  const name = typeof value === "string" ? value.trim().replace(/[\\/:*?"<>|]/g, "-") : "";
  return (name || fallback).slice(0, 160);
}

export function createSettingsStore({ db, workflowFiles, defaultComfyUrl }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const defaultWorkflows = Object.fromEntries(
    PROCESS_KINDS.map((kind) => [kind, normalizeWorkflow(JSON.parse(readFileSync(workflowFiles[kind], "utf8")), kind)]),
  );
  const defaultUrls = Object.fromEntries(
    PROCESS_KINDS.map((kind) => [
      kind,
      normalizeUrl(process.env[`COMFYUI_${kind.toUpperCase()}_URL`] || defaultComfyUrl, `${PROCESS_LABELS[kind]} ComfyUI 地址`),
    ]),
  );
  const agentDefaults = {
    baseUrl: normalizeUrl(process.env.STEPFUN_BASE_URL || "https://api.stepfun.com/step_plan/v1", "Agent Base URL"),
    model: process.env.STEPFUN_MODEL?.trim() || "step-3.7-flash",
    apiKey: process.env.STEPFUN_API_KEY?.trim() || "",
    reasoningEffort: normalizeReasoningEffort(process.env.STEPFUN_REASONING_EFFORT, "high"),
  };
  const coordinatorAgentDefaults = {
    baseUrl: normalizeUrl(process.env.COORDINATOR_BASE_URL || agentDefaults.baseUrl, "总调度 Agent Base URL"),
    model: process.env.COORDINATOR_MODEL?.trim() || agentDefaults.model,
    apiKey: process.env.COORDINATOR_API_KEY?.trim() || agentDefaults.apiKey,
    reasoningEffort: normalizeReasoningEffort(process.env.COORDINATOR_REASONING_EFFORT, agentDefaults.reasoningEffort),
  };
  const imageApiDefaults = {
    textToImage: {
      baseUrl: normalizeUrl(process.env.STEPFUN_TEXT_IMAGE_BASE_URL || process.env.STEPFUN_IMAGE_BASE_URL || DEFAULT_IMAGE_API_BASE_URL, "文生图 API Base URL"),
      model: process.env.STEPFUN_TEXT_IMAGE_MODEL?.trim() || process.env.STEPFUN_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_API_MODEL,
      apiKey: process.env.STEPFUN_TEXT_IMAGE_API_KEY?.trim() || process.env.STEPFUN_IMAGE_API_KEY?.trim() || "",
    },
    imageToImage: {
      baseUrl: normalizeUrl(process.env.STEPFUN_IMAGE_EDIT_BASE_URL || process.env.STEPFUN_IMAGE_BASE_URL || DEFAULT_IMAGE_API_BASE_URL, "图生图 API Base URL"),
      model: process.env.STEPFUN_IMAGE_EDIT_MODEL?.trim() || process.env.STEPFUN_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_API_MODEL,
      apiKey: process.env.STEPFUN_IMAGE_EDIT_API_KEY?.trim() || process.env.STEPFUN_IMAGE_API_KEY?.trim() || "",
    },
  };

  const findSetting = db.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = ?");
  const saveSetting = db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
  `);

  function read(key, fallback) {
    const row = findSetting.get(key);
    return row ? row.value : fallback;
  }

  function defaultRecord(kind) {
    return {
      id: "default",
      name: basename(workflowFiles[kind]),
      source: "default",
      workflow: clone(defaultWorkflows[kind]),
      createdAt: null,
    };
  }

  function workflowRecords(kind) {
    if (!PROCESS_KINDS.includes(kind)) throw new Error("未知工作流类型");
    const records = [defaultRecord(kind)];
    const stored = read(`comfy.${kind}.workflows`, null);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          for (const item of parsed.slice(0, MAX_CUSTOM_WORKFLOWS)) {
            if (!item || item.id === "default") continue;
            try {
              records.push({
                id: displayWorkflowName(item.id, randomUUID()),
                name: displayWorkflowName(item.name, "未命名工作流.json"),
                source: "uploaded",
                workflow: normalizeWorkflow(item.workflow, kind),
                createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
              });
            } catch {
              // Ignore a corrupted custom version and keep the default available.
            }
          }
        }
      } catch {
        // Ignore malformed storage and keep the default available.
      }
    } else {
      const legacy = read(`comfy.${kind}.workflow`, null);
      if (legacy) {
        try {
          const legacyWorkflow = normalizeWorkflow(legacy, kind);
          if (JSON.stringify(legacyWorkflow) !== JSON.stringify(defaultWorkflows[kind])) {
            records.push({
              id: "legacy",
              name: "已保存版本.json",
              source: "uploaded",
              workflow: legacyWorkflow,
              createdAt: null,
            });
          }
        } catch {
          // Ignore an invalid legacy setting.
        }
      }
    }
    return records;
  }

  function saveWorkflowRecords(kind, records) {
    const custom = records.filter((item) => item.id !== "default").slice(0, MAX_CUSTOM_WORKFLOWS);
    saveSetting.run(`comfy.${kind}.workflows`, JSON.stringify(custom), new Date().toISOString());
  }

  function selectedId(kind, records = workflowRecords(kind)) {
    const requested = read(`comfy.${kind}.active_workflow_id`, null)
      || (records.some((item) => item.id === "legacy") ? "legacy" : "default");
    return records.some((item) => item.id === requested) ? requested : "default";
  }

  function processConfig(kind) {
    const records = workflowRecords(kind);
    const activeWorkflowId = selectedId(kind, records);
    const url = normalizeUrl(read(`comfy.${kind}.url`, defaultUrls[kind]), `${PROCESS_LABELS[kind]} ComfyUI 地址`);
    const config = { mode: "comfyui", url, workflow: clone(records.find((item) => item.id === activeWorkflowId).workflow), activeWorkflowId };
    if (kind !== "2d") return config;
    const mode = read("process.2d.mode", "comfyui") === "api" ? "api" : "comfyui";
    const textImage = imageConfig("text_to_model");
    return {
      ...config,
      mode,
      api: {
        ...textImage,
      },
    };
  }

  function imageConfig(pipelineType) {
    const isImage = pipelineType === "image_to_model";
    const prefix = isImage ? "image.image_to_image" : "image.text_to_image";
    const defaults = isImage ? imageApiDefaults.imageToImage : imageApiDefaults.textToImage;
    const legacyPrefix = "image.2d";
    const storedApiKey = read(`${prefix}.api_key`, isImage ? null : read(`${legacyPrefix}.api_key`, null));
    return {
      baseUrl: normalizeUrl(read(`${prefix}.base_url`, isImage ? defaults.baseUrl : read(`${legacyPrefix}.base_url`, defaults.baseUrl)), isImage ? "图生图 API Base URL" : "文生图 API Base URL"),
      model: read(`${prefix}.model`, isImage ? defaults.model : read(`${legacyPrefix}.model`, defaults.model)).trim() || defaults.model,
      apiKey: storedApiKey === null ? defaults.apiKey || agentConfig().apiKey : storedApiKey.trim(),
    };
  }

  function agentConfig() {
    return {
      baseUrl: normalizeUrl(read("agent.base_url", agentDefaults.baseUrl), "Agent Base URL"),
      model: read("agent.model", agentDefaults.model).trim() || agentDefaults.model,
      apiKey: read("agent.api_key", agentDefaults.apiKey).trim(),
      reasoningEffort: normalizeReasoningEffort(read("agent.reasoning_effort", agentDefaults.reasoningEffort), agentDefaults.reasoningEffort),
    };
  }

  function coordinatorAgentConfig() {
    return {
      baseUrl: normalizeUrl(read("coordinator.agent.base_url", coordinatorAgentDefaults.baseUrl), "总调度 Agent Base URL"),
      model: read("coordinator.agent.model", coordinatorAgentDefaults.model).trim() || coordinatorAgentDefaults.model,
      apiKey: read("coordinator.agent.api_key", coordinatorAgentDefaults.apiKey).trim(),
      reasoningEffort: normalizeReasoningEffort(read("coordinator.agent.reasoning_effort", coordinatorAgentDefaults.reasoningEffort), coordinatorAgentDefaults.reasoningEffort),
    };
  }

  function coordinatorImageConfig(pipelineType) {
    const isImage = pipelineType === "image_to_model";
    const prefix = isImage ? "coordinator.image.image_to_image" : "coordinator.image.text_to_image";
    const defaults = isImage ? imageApiDefaults.imageToImage : imageApiDefaults.textToImage;
    return {
      baseUrl: normalizeUrl(read(`${prefix}.base_url`, defaults.baseUrl), isImage ? "总调度图生图 API Base URL" : "总调度文生图 API Base URL"),
      model: read(`${prefix}.model`, defaults.model).trim() || defaults.model,
      apiKey: read(`${prefix}.api_key`, defaults.apiKey).trim(),
    };
  }

  function seedCoordinatorSettings() {
    if (findSetting.get("coordinator.agent.base_url")) return;
    const now = new Date().toISOString();
    const currentAgent = agentConfig();
    const currentTextImage = imageConfig("text_to_model");
    const currentImageEdit = imageConfig("image_to_model");
    const seeds = [
      ["coordinator.agent.base_url", currentAgent.baseUrl],
      ["coordinator.agent.model", currentAgent.model],
      ["coordinator.agent.api_key", currentAgent.apiKey],
      ["coordinator.agent.reasoning_effort", currentAgent.reasoningEffort],
      ["coordinator.image.text_to_image.base_url", currentTextImage.baseUrl],
      ["coordinator.image.text_to_image.model", currentTextImage.model],
      ["coordinator.image.text_to_image.api_key", currentTextImage.apiKey],
      ["coordinator.image.image_to_image.base_url", currentImageEdit.baseUrl],
      ["coordinator.image.image_to_image.model", currentImageEdit.model],
      ["coordinator.image.image_to_image.api_key", currentImageEdit.apiKey],
    ];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of seeds) saveSetting.run(key, value, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  seedCoordinatorSettings();

  async function fetchAgentModels(input = {}) {
    const coordinator = input.scope === "coordinator";
    const current = coordinator ? coordinatorAgentConfig() : agentConfig();
    const baseUrl = normalizeUrl(input.baseUrl ?? current.baseUrl, coordinator ? "总调度 Agent Base URL" : "Asset Agent Base URL");
    const apiKey = input.clearApiKey === true
      ? ""
      : typeof input.apiKey === "string" && input.apiKey.trim()
        ? input.apiKey.trim()
        : current.apiKey;
    if (!apiKey) throw new Error("请先填写 Agent API Key");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`模型接口返回了非 JSON 响应（HTTP ${response.status}）`);
      }
      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
        throw new Error(`模型列表获取失败：${message}`);
      }
      const items = Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
      const models = [...new Map(items.flatMap((item) => {
        if (typeof item === "string" && item.trim()) return [[item.trim(), { id: item.trim(), name: item.trim() }]];
        const id = typeof item?.id === "string" ? item.id.trim() : "";
        if (!id) return [];
        const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
        return [[id, { id, name }]];
      })).values()].slice(0, 500);
      if (!models.length) throw new Error("模型接口没有返回可选择的模型");
      return { baseUrl, models };
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("获取模型列表超时");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function publicSettings() {
    return {
      processes: Object.fromEntries(PROCESS_KINDS.map((kind) => {
        const records = workflowRecords(kind);
        const current = processConfig(kind);
        return [kind, {
          label: PROCESS_LABELS[kind],
          mode: current.mode,
          url: current.url,
          workflow: current.workflow,
          activeWorkflowId: current.activeWorkflowId,
          defaultWorkflowId: "default",
          workflows: records.map(({ workflow, ...metadata }) => ({ ...metadata, nodeCount: Object.keys(workflow).length })),
          defaultUrl: defaultUrls[kind],
          defaultWorkflow: clone(defaultWorkflows[kind]),
          ...(kind === "2d" ? {
            defaultMode: "comfyui",
            api: {
              baseUrl: current.api.baseUrl,
              model: current.api.model,
              apiKeyConfigured: Boolean(current.api.apiKey),
              defaultBaseUrl: imageApiDefaults.textToImage.baseUrl,
              defaultModel: imageApiDefaults.textToImage.model,
            },
          } : {}),
        }];
      })),
      agent: {
        baseUrl: agentConfig().baseUrl,
        model: agentConfig().model,
        reasoningEffort: agentConfig().reasoningEffort,
        apiKeyConfigured: Boolean(agentConfig().apiKey),
        defaultBaseUrl: agentDefaults.baseUrl,
        defaultModel: agentDefaults.model,
        defaultReasoningEffort: agentDefaults.reasoningEffort,
      },
      imageModels: {
        textToImage: {
          baseUrl: imageConfig("text_to_model").baseUrl,
          model: imageConfig("text_to_model").model,
          apiKeyConfigured: Boolean(imageConfig("text_to_model").apiKey),
          defaultBaseUrl: imageApiDefaults.textToImage.baseUrl,
          defaultModel: imageApiDefaults.textToImage.model,
        },
        imageToImage: {
          baseUrl: imageConfig("image_to_model").baseUrl,
          model: imageConfig("image_to_model").model,
          apiKeyConfigured: Boolean(imageConfig("image_to_model").apiKey),
          defaultBaseUrl: imageApiDefaults.imageToImage.baseUrl,
          defaultModel: imageApiDefaults.imageToImage.model,
        },
      },
      coordinator: {
        agent: {
          baseUrl: coordinatorAgentConfig().baseUrl,
          model: coordinatorAgentConfig().model,
          reasoningEffort: coordinatorAgentConfig().reasoningEffort,
          apiKeyConfigured: Boolean(coordinatorAgentConfig().apiKey),
          defaultBaseUrl: coordinatorAgentDefaults.baseUrl,
          defaultModel: coordinatorAgentDefaults.model,
          defaultReasoningEffort: coordinatorAgentDefaults.reasoningEffort,
        },
        imageModels: {
          textToImage: {
            baseUrl: coordinatorImageConfig("text_to_model").baseUrl,
            model: coordinatorImageConfig("text_to_model").model,
            apiKeyConfigured: Boolean(coordinatorImageConfig("text_to_model").apiKey),
            defaultBaseUrl: imageApiDefaults.textToImage.baseUrl,
            defaultModel: imageApiDefaults.textToImage.model,
          },
          imageToImage: {
            baseUrl: coordinatorImageConfig("image_to_model").baseUrl,
            model: coordinatorImageConfig("image_to_model").model,
            apiKeyConfigured: Boolean(coordinatorImageConfig("image_to_model").apiKey),
            defaultBaseUrl: imageApiDefaults.imageToImage.baseUrl,
            defaultModel: imageApiDefaults.imageToImage.model,
          },
        },
      },
    };
  }

  function getWorkflow(kind, id) {
    const record = workflowRecords(kind).find((item) => item.id === id);
    if (!record) throw new Error("工作流版本不存在");
    return clone(record);
  }

  function update(input) {
    const processes = input?.processes;
    if (!processes || typeof processes !== "object" || Array.isArray(processes)) throw new Error("缺少流程配置");
    const normalizedProcesses = Object.fromEntries(PROCESS_KINDS.map((kind) => {
      const current = processConfig(kind);
      const next = processes[kind] || current;
      const records = workflowRecords(kind);
      const activeWorkflowId = next.activeWorkflowId || current.activeWorkflowId;
      if (!records.some((item) => item.id === activeWorkflowId)) throw new Error(`${PROCESS_LABELS[kind]}工作流版本不存在`);
      return [kind, {
        mode: kind === "2d" && next.mode === "api" ? "api" : "comfyui",
        url: normalizeUrl(next.url ?? current.url, `${PROCESS_LABELS[kind]} ComfyUI 地址`),
        activeWorkflowId,
        ...(kind === "2d" ? {
          api: {
            baseUrl: normalizeUrl(next.api?.baseUrl ?? current.api.baseUrl, "2D API Base URL"),
            model: typeof next.api?.model === "string" ? next.api.model.trim() : current.api.model,
            apiKey: typeof next.api?.apiKey === "string" ? next.api.apiKey.trim() : "",
          },
        } : {}),
      }];
    }));
    if (!normalizedProcesses["2d"].api.model) throw new Error("2D API 模型不能为空");
    if (normalizedProcesses["2d"].api.model.length > 160) throw new Error("2D API 模型不能超过 160 个字符");
    if (normalizedProcesses["2d"].api.apiKey.length > 1000) throw new Error("2D API Key 不能超过 1,000 个字符");

    const currentAgent = agentConfig();
    const agentInput = input.agent && typeof input.agent === "object" ? input.agent : {};
    const nextAgent = {
      baseUrl: normalizeUrl(agentInput.baseUrl ?? currentAgent.baseUrl, "Agent Base URL"),
      model: typeof agentInput.model === "string" ? agentInput.model.trim() : currentAgent.model,
      apiKey: currentAgent.apiKey,
      reasoningEffort: validateReasoningEffort(agentInput.reasoningEffort ?? currentAgent.reasoningEffort, "Agent 推理强度"),
    };
    if (!nextAgent.model) throw new Error("Agent 模型不能为空");
    if (nextAgent.model.length > 160) throw new Error("Agent 模型不能超过 160 个字符");
    if (agentInput.clearApiKey === true) nextAgent.apiKey = "";
    else if (typeof agentInput.apiKey === "string" && agentInput.apiKey.trim()) nextAgent.apiKey = agentInput.apiKey.trim();
    if (nextAgent.apiKey.length > 1000) throw new Error("Agent API Key 不能超过 1,000 个字符");

    const imageModelsInput = input.imageModels && typeof input.imageModels === "object" ? input.imageModels : {};
    const normalizeImageModel = (key, pipeline) => {
      const current = imageConfig(pipeline);
      const next = imageModelsInput[key] && typeof imageModelsInput[key] === "object" ? imageModelsInput[key] : {};
      const value = {
        baseUrl: normalizeUrl(next.baseUrl ?? current.baseUrl, key === "textToImage" ? "文生图 API Base URL" : "图生图 API Base URL"),
        model: typeof next.model === "string" ? next.model.trim() : current.model,
        apiKey: current.apiKey,
      };
      if (!value.model || value.model.length > 160) throw new Error(`${key === "textToImage" ? "文生图" : "图生图"}模型无效`);
      if (next.clearApiKey === true) value.apiKey = "";
      else if (typeof next.apiKey === "string" && next.apiKey.trim()) value.apiKey = next.apiKey.trim();
      if (value.apiKey.length > 1000) throw new Error("图片 API Key 不能超过 1,000 个字符");
      return value;
    };
    const nextImageModels = {
      textToImage: normalizeImageModel("textToImage", "text_to_model"),
      imageToImage: normalizeImageModel("imageToImage", "image_to_model"),
    };

    const coordinatorInput = input.coordinator && typeof input.coordinator === "object" ? input.coordinator : {};
    const currentCoordinatorAgent = coordinatorAgentConfig();
    const coordinatorAgentInput = coordinatorInput.agent && typeof coordinatorInput.agent === "object" ? coordinatorInput.agent : {};
    const nextCoordinatorAgent = {
      baseUrl: normalizeUrl(coordinatorAgentInput.baseUrl ?? currentCoordinatorAgent.baseUrl, "总调度 Agent Base URL"),
      model: typeof coordinatorAgentInput.model === "string" ? coordinatorAgentInput.model.trim() : currentCoordinatorAgent.model,
      apiKey: currentCoordinatorAgent.apiKey,
      reasoningEffort: validateReasoningEffort(coordinatorAgentInput.reasoningEffort ?? currentCoordinatorAgent.reasoningEffort, "总调度 Agent 推理强度"),
    };
    if (!nextCoordinatorAgent.model) throw new Error("总调度 Agent 模型不能为空");
    if (nextCoordinatorAgent.model.length > 160) throw new Error("总调度 Agent 模型不能超过 160 个字符");
    if (coordinatorAgentInput.clearApiKey === true) nextCoordinatorAgent.apiKey = "";
    else if (typeof coordinatorAgentInput.apiKey === "string" && coordinatorAgentInput.apiKey.trim()) nextCoordinatorAgent.apiKey = coordinatorAgentInput.apiKey.trim();
    if (nextCoordinatorAgent.apiKey.length > 1000) throw new Error("总调度 Agent API Key 不能超过 1,000 个字符");

    const coordinatorImageModelsInput = coordinatorInput.imageModels && typeof coordinatorInput.imageModels === "object" ? coordinatorInput.imageModels : {};
    const normalizeCoordinatorImageModel = (key, pipeline) => {
      const current = coordinatorImageConfig(pipeline);
      const next = coordinatorImageModelsInput[key] && typeof coordinatorImageModelsInput[key] === "object" ? coordinatorImageModelsInput[key] : {};
      const label = key === "textToImage" ? "总调度文生图" : "总调度图生图";
      const value = {
        baseUrl: normalizeUrl(next.baseUrl ?? current.baseUrl, `${label} API Base URL`),
        model: typeof next.model === "string" ? next.model.trim() : current.model,
        apiKey: current.apiKey,
      };
      if (!value.model || value.model.length > 160) throw new Error(`${label}模型无效`);
      if (next.clearApiKey === true) value.apiKey = "";
      else if (typeof next.apiKey === "string" && next.apiKey.trim()) value.apiKey = next.apiKey.trim();
      if (value.apiKey.length > 1000) throw new Error(`${label} API Key 不能超过 1,000 个字符`);
      return value;
    };
    const nextCoordinatorImageModels = {
      textToImage: normalizeCoordinatorImageModel("textToImage", "text_to_model"),
      imageToImage: normalizeCoordinatorImageModel("imageToImage", "image_to_model"),
    };

    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const kind of PROCESS_KINDS) {
        saveSetting.run(`comfy.${kind}.url`, normalizedProcesses[kind].url, now);
        saveSetting.run(`comfy.${kind}.active_workflow_id`, normalizedProcesses[kind].activeWorkflowId, now);
      }
      saveSetting.run("process.2d.mode", normalizedProcesses["2d"].mode, now);
      saveSetting.run("image.2d.base_url", normalizedProcesses["2d"].api.baseUrl, now);
      saveSetting.run("image.2d.model", normalizedProcesses["2d"].api.model, now);
      if (normalizedProcesses["2d"].api.apiKey) saveSetting.run("image.2d.api_key", normalizedProcesses["2d"].api.apiKey, now);
      saveSetting.run("agent.base_url", nextAgent.baseUrl, now);
      saveSetting.run("agent.model", nextAgent.model, now);
      saveSetting.run("agent.api_key", nextAgent.apiKey, now);
      saveSetting.run("agent.reasoning_effort", nextAgent.reasoningEffort, now);
      for (const [key, value] of Object.entries(nextImageModels)) {
        const prefix = key === "textToImage" ? "image.text_to_image" : "image.image_to_image";
        saveSetting.run(`${prefix}.base_url`, value.baseUrl, now);
        saveSetting.run(`${prefix}.model`, value.model, now);
        saveSetting.run(`${prefix}.api_key`, value.apiKey, now);
      }
      saveSetting.run("coordinator.agent.base_url", nextCoordinatorAgent.baseUrl, now);
      saveSetting.run("coordinator.agent.model", nextCoordinatorAgent.model, now);
      saveSetting.run("coordinator.agent.api_key", nextCoordinatorAgent.apiKey, now);
      saveSetting.run("coordinator.agent.reasoning_effort", nextCoordinatorAgent.reasoningEffort, now);
      for (const [key, value] of Object.entries(nextCoordinatorImageModels)) {
        const prefix = key === "textToImage" ? "coordinator.image.text_to_image" : "coordinator.image.image_to_image";
        saveSetting.run(`${prefix}.base_url`, value.baseUrl, now);
        saveSetting.run(`${prefix}.model`, value.model, now);
        saveSetting.run(`${prefix}.api_key`, value.apiKey, now);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return publicSettings();
  }

  function uploadWorkflow(kind, input) {
    const records = workflowRecords(kind);
    const customCount = records.filter((item) => item.id !== "default").length;
    if (customCount >= MAX_CUSTOM_WORKFLOWS) throw new Error(`每类最多保存 ${MAX_CUSTOM_WORKFLOWS} 个自定义工作流`);
    const workflow = normalizeWorkflow(input?.workflow, kind);
    const name = displayWorkflowName(input?.name, `${PROCESS_LABELS[kind]}.json`);
    const record = { id: randomUUID(), name, source: "uploaded", workflow, createdAt: new Date().toISOString() };
    saveWorkflowRecords(kind, [...records, record]);
    const { workflow: storedWorkflow, ...metadata } = record;
    return {
      settings: publicSettings(),
      uploaded: { ...metadata, nodeCount: Object.keys(storedWorkflow).length },
    };
  }

  function removeWorkflow(kind, id) {
    if (id === "default") throw new Error("默认工作流不能删除");
    const records = workflowRecords(kind);
    if (!records.some((item) => item.id === id)) throw new Error("工作流版本不存在");
    saveWorkflowRecords(kind, records.filter((item) => item.id !== id));
    if (selectedId(kind, records) === id) saveSetting.run(`comfy.${kind}.active_workflow_id`, "default", new Date().toISOString());
    return publicSettings();
  }

  return { processConfig, imageConfig, agentConfig, coordinatorAgentConfig, coordinatorImageConfig, publicSettings, getWorkflow, fetchAgentModels, update, uploadWorkflow, removeWorkflow };
}
