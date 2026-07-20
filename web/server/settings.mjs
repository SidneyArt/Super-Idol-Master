import { readFileSync } from "node:fs";

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
  if (Buffer.byteLength(serialized) > 500_000) throw new Error(`${PROCESS_LABELS[kind]}工作流不能超过 500 KB`);
  return JSON.parse(serialized);
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

  function processConfig(kind) {
    if (!PROCESS_KINDS.includes(kind)) throw new Error("未知工作流类型");
    const url = normalizeUrl(read(`comfy.${kind}.url`, defaultUrls[kind]), `${PROCESS_LABELS[kind]} ComfyUI 地址`);
    const storedWorkflow = read(`comfy.${kind}.workflow`, null);
    return {
      url,
      workflow: storedWorkflow ? normalizeWorkflow(storedWorkflow, kind) : clone(defaultWorkflows[kind]),
    };
  }

  function agentConfig() {
    return {
      baseUrl: normalizeUrl(read("agent.base_url", agentDefaults.baseUrl), "Agent Base URL"),
      model: read("agent.model", agentDefaults.model).trim() || agentDefaults.model,
      apiKey: read("agent.api_key", agentDefaults.apiKey).trim(),
    };
  }

  function publicSettings() {
    return {
      processes: Object.fromEntries(PROCESS_KINDS.map((kind) => {
        const current = processConfig(kind);
        return [kind, {
          label: PROCESS_LABELS[kind],
          url: current.url,
          workflow: current.workflow,
          defaultUrl: defaultUrls[kind],
          defaultWorkflow: clone(defaultWorkflows[kind]),
        }];
      })),
      agent: {
        baseUrl: agentConfig().baseUrl,
        model: agentConfig().model,
        apiKeyConfigured: Boolean(agentConfig().apiKey),
        defaultBaseUrl: agentDefaults.baseUrl,
        defaultModel: agentDefaults.model,
      },
    };
  }

  function update(input) {
    const processes = input?.processes;
    if (!processes || typeof processes !== "object" || Array.isArray(processes)) throw new Error("缺少流程配置");
    const normalizedProcesses = Object.fromEntries(PROCESS_KINDS.map((kind) => {
      const current = processConfig(kind);
      const next = processes[kind] || current;
      return [kind, {
        url: normalizeUrl(next.url ?? current.url, `${PROCESS_LABELS[kind]} ComfyUI 地址`),
        workflow: normalizeWorkflow(next.workflow ?? current.workflow, kind),
      }];
    }));

    const currentAgent = agentConfig();
    const agentInput = input.agent && typeof input.agent === "object" ? input.agent : {};
    const nextAgent = {
      baseUrl: normalizeUrl(agentInput.baseUrl ?? currentAgent.baseUrl, "Agent Base URL"),
      model: typeof agentInput.model === "string" ? agentInput.model.trim() : currentAgent.model,
      apiKey: currentAgent.apiKey,
    };
    if (!nextAgent.model) throw new Error("Agent 模型不能为空");
    if (nextAgent.model.length > 160) throw new Error("Agent 模型不能超过 160 个字符");
    if (agentInput.clearApiKey === true) nextAgent.apiKey = "";
    else if (typeof agentInput.apiKey === "string" && agentInput.apiKey.trim()) nextAgent.apiKey = agentInput.apiKey.trim();
    if (nextAgent.apiKey.length > 1000) throw new Error("Agent API Key 不能超过 1,000 个字符");

    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const kind of PROCESS_KINDS) {
        saveSetting.run(`comfy.${kind}.url`, normalizedProcesses[kind].url, now);
        saveSetting.run(`comfy.${kind}.workflow`, JSON.stringify(normalizedProcesses[kind].workflow), now);
      }
      saveSetting.run("agent.base_url", nextAgent.baseUrl, now);
      saveSetting.run("agent.model", nextAgent.model, now);
      saveSetting.run("agent.api_key", nextAgent.apiKey, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return publicSettings();
  }

  return { processConfig, agentConfig, publicSettings, update };
}
