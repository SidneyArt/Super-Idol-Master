import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_TURNS = 12;
const MAX_TOOL_CALLS = 12;

function textResult(message, details) {
  return { content: [{ type: "text", text: message }], details };
}

function messageText(message) {
  return (message?.content || []).filter((item) => item.type === "text").map((item) => item.text).join("").trim();
}

function createModel(config) {
  return {
    id: config.model,
    name: "Stepfun Workspace Coordinator",
    api: "openai-completions",
    provider: "stepfun",
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    },
  };
}

function validateImage(image) {
  if (!image) return null;
  const mimeType = typeof image.mimeType === "string" ? image.mimeType.toLowerCase() : "";
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) throw new Error("合集原画只支持 PNG、JPEG 或 WebP");
  const raw = typeof image.data === "string" ? image.data.replace(/^data:[^;]+;base64,/, "") : "";
  if (!raw || !/^[a-zA-Z0-9+/=\r\n]+$/.test(raw)) throw new Error("合集原画数据无效");
  const data = Buffer.from(raw, "base64");
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error("合集原画不能超过 12 MB");
  return {
    name: typeof image.name === "string" ? image.name.slice(0, 160) : "character-sheet",
    mimeType,
    data: data.toString("base64"),
  };
}

export function createCoordinatorRuntime({
  db,
  getAgentConfig,
  getWorkspaces,
  createWorkspace,
  createCharacterTasks,
  delegateTask,
  getImageModelStatus,
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatcher_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      attachment_name TEXT,
      attachment_mime TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS dispatcher_messages_workspace_idx ON dispatcher_messages(workspace_id, id DESC)");

  let activeAgent = null;

  function getMessages(workspaceId = null, limit = 100) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
    const rows = workspaceId
      ? db.prepare(`
          SELECT id, role, content, attachment_name AS attachmentName, attachment_mime AS attachmentMime,
                 created_at AS createdAt FROM dispatcher_messages
          WHERE workspace_id = ? ORDER BY id DESC LIMIT ?
        `).all(workspaceId, safeLimit)
      : db.prepare(`
          SELECT id, role, content, attachment_name AS attachmentName, attachment_mime AS attachmentMime,
                 created_at AS createdAt FROM dispatcher_messages
          WHERE workspace_id IS NULL ORDER BY id DESC LIMIT ?
        `).all(safeLimit);
    return rows.reverse();
  }

  function addMessage(workspaceId, role, content, image = null) {
    const createdAt = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO dispatcher_messages (workspace_id, role, content, attachment_name, attachment_mime, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(workspaceId, role, content, image?.name || null, image?.mimeType || null, createdAt);
    return {
      id: Number(result.lastInsertRowid), role, content,
      attachmentName: image?.name || null, attachmentMime: image?.mimeType || null, createdAt,
    };
  }

  function systemPrompt(workspaceId, history, hasImage) {
    const workspaces = getWorkspaces();
    const current = workspaces.find((item) => item.id === workspaceId) || null;
    const transcript = history.map((item) => `${item.role === "user" ? "用户" : "总调度 Agent"}：${item.content}`).join("\n");
    return `你是 Super Idol Master 的总调度 Agent，负责管理工作空间并把大型角色资产需求拆分给不同任务的专属 Asset Agent。

规则：
1. 创建任何任务前，先确定目标工作空间；用户未指定时使用当前工作空间，仍不存在则先创建工作空间。
2. 用户上传包含多个不同角色的合集原画时，必须视觉分析每个独立角色，为每个角色给出名称、角色描述、提示词和归一化裁切框，再调用 create_character_tasks。裁切框 x/y/width/height 均为 0–1，相对于整张图片，必须完整包住单个角色且尽量不包含相邻角色。
3. 有合集原画时每个拆分任务使用 image_to_model；纯文本批量需求使用 text_to_model。
4. 用户要求直接执行、生成到模型或绑骨时，把 delegateToAgents 设为 true，并选择对应 target。系统会让每个任务的专属 Agent 独立质检和持续执行。
5. 不得声称未创建的工作空间、任务或产物已经完成。工具失败时解释真实原因。
6. API Key 不通过聊天收集；需要配置时提醒用户使用首页的模型配置区域。
7. 最终用 Markdown 简洁汇总创建的工作空间、任务数量、工作流和委派目标。

当前工作空间：${JSON.stringify(current)}
全部工作空间：${JSON.stringify(workspaces)}
本轮是否附带合集原画：${hasImage ? "是" : "否"}
最近会话：
${transcript.slice(-12000)}`;
  }

  function tools(workspaceId, attachment, execution) {
    return [
      {
        name: "list_workspaces",
        label: "读取工作空间",
        description: "读取全部工作空间、任务数量和运行状态。",
        parameters: Type.Object({}),
        executionMode: "sequential",
        execute: async () => textResult(JSON.stringify(getWorkspaces()), getWorkspaces()),
      },
      {
        name: "get_image_model_status",
        label: "读取图片模型配置",
        description: "检查文生图和图生图 API 是否都已配置；不会返回 API Key。",
        parameters: Type.Object({}),
        executionMode: "sequential",
        execute: async () => {
          const status = getImageModelStatus();
          return textResult(JSON.stringify(status), status);
        },
      },
      {
        name: "create_workspace",
        label: "创建工作空间",
        description: "创建用于收纳一组相关角色任务的工作空间。",
        parameters: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 80 }),
          description: Type.String({ maxLength: 500 }),
        }),
        executionMode: "sequential",
        execute: async (_id, params) => {
          const workspace = createWorkspace(params);
          execution.actions.push({ tool: "create_workspace", workspace });
          return textResult(`已创建工作空间“${workspace.name}”。`, workspace);
        },
      },
      {
        name: "create_character_tasks",
        label: "拆分并创建角色任务",
        description: "批量创建角色任务；有合集图片时会按归一化裁切框生成单体原画，并可委派每个任务的专属 Agent 自动执行。",
        parameters: Type.Object({
          workspaceId: Type.String({ minLength: 1, maxLength: 80 }),
          delegateToAgents: Type.Boolean(),
          target: Type.Union([
            Type.Literal("concept_image"), Type.Literal("validated_tpose"), Type.Literal("model"),
            Type.Literal("rigged_model"), Type.Literal("export"),
          ]),
          tasks: Type.Array(Type.Object({
            name: Type.String({ minLength: 1, maxLength: 80 }),
            description: Type.String({ minLength: 1, maxLength: 1000 }),
            positivePrompt: Type.String({ minLength: 1, maxLength: 4000 }),
            negativePrompt: Type.String({ maxLength: 2000 }),
            pipelineType: Type.Union([Type.Literal("text_to_model"), Type.Literal("image_to_model")]),
            bounds: Type.Optional(Type.Object({
              x: Type.Number({ minimum: 0, maximum: 1 }),
              y: Type.Number({ minimum: 0, maximum: 1 }),
              width: Type.Number({ minimum: 0.02, maximum: 1 }),
              height: Type.Number({ minimum: 0.02, maximum: 1 }),
            })),
          }), { minItems: 1, maxItems: 12 }),
        }),
        executionMode: "sequential",
        execute: async (_id, params) => {
          const tasks = await createCharacterTasks({ ...params, image: attachment });
          const delegated = [];
          if (params.delegateToAgents) {
            for (const task of tasks) {
              try {
                await delegateTask(task.run.id, params.target);
                delegated.push({ runId: task.run.id, status: "running" });
              } catch (error) {
                delegated.push({ runId: task.run.id, status: "failed", error: error instanceof Error ? error.message : "委派失败" });
              }
            }
          }
          execution.actions.push({ tool: "create_character_tasks", count: tasks.length, delegated });
          return textResult(`已创建 ${tasks.length} 个角色任务${params.delegateToAgents ? "，并已委派专属 Agent" : ""}。`, { tasks, delegated });
        },
      },
    ];
  }

  async function run({ workspaceId = null, message, image }) {
    const config = getAgentConfig();
    if (!config.apiKey) throw new Error("总调度 Agent 未配置 API Key");
    if (activeAgent) throw new Error("总调度 Agent 正在处理上一条消息");
    if (workspaceId && !getWorkspaces().some((item) => item.id === workspaceId)) throw new Error("工作空间不存在");
    const attachment = validateImage(image);
    const userText = typeof message === "string" && message.trim()
      ? message.trim().slice(0, 6000)
      : attachment ? "请分析这张角色合集原画，拆分每个独立角色，并在当前工作空间创建图生模型任务。" : "";
    if (!userText) throw new Error("消息不能为空");
    const history = getMessages(workspaceId, 24);
    const execution = { actions: [], toolCalls: 0, turns: 0 };
    const agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(workspaceId, history, Boolean(attachment)),
        model: createModel(config),
        thinkingLevel: "off",
        tools: tools(workspaceId, attachment, execution),
      },
      getApiKey: () => config.apiKey,
      toolExecution: "sequential",
      maxRetryDelayMs: 5000,
      beforeToolCall: async () => {
        execution.toolCalls += 1;
        if (execution.toolCalls > MAX_TOOL_CALLS) return { block: true, reason: "工具调用次数已达到上限" };
        return undefined;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "turn_end") {
        execution.turns += 1;
        if (execution.turns >= MAX_TURNS) agent.abort();
      }
    });
    activeAgent = agent;
    addMessage(workspaceId, "user", userText, attachment);
    try {
      await agent.prompt(userText, attachment ? [{ type: "image", data: attachment.data, mimeType: attachment.mimeType }] : undefined);
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      const assistantText = [...agent.state.messages].reverse().filter((item) => item.role === "assistant").map(messageText).find(Boolean);
      if (!assistantText) throw new Error("总调度 Agent 没有返回可显示的回复");
      addMessage(workspaceId, "assistant", assistantText);
      return { messages: getMessages(workspaceId), actions: execution.actions, workspaces: getWorkspaces() };
    } finally {
      activeAgent = null;
    }
  }

  function cancel() {
    if (!activeAgent) return false;
    activeAgent.abort();
    return true;
  }

  return { run, cancel, getMessages, status: () => ({ running: Boolean(activeAgent) }) };
}
