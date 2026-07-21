import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { AGENT_CONTEXT_WINDOW, contextStats } from "./conversation-context.mjs";

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
    contextWindow: AGENT_CONTEXT_WINDOW,
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

export function classifyCoordinatorIntent(message, hasAttachment) {
  const text = typeof message === "string" ? message : "";
  const asksForSingleSheet = !hasAttachment && (
    /(一张|单张).{0,20}(合集|集合|群像).{0,8}(图|原画)/i.test(text)
    || /(创建|生成|制作).{0,20}(合集图|集合图|群像原画)/i.test(text)
  );
  const asksForTasks = /(拆分|拆成|分成).{0,12}(任务|角色)|创建.{0,8}(多个|数个|\d+\s*个).{0,8}任务|分别.{0,20}(模型|绑骨)|每个角色.{0,20}(任务|模型|绑骨)/i.test(text);
  const asksForSplit = /(拆分|拆开|分拆)(?:吧|一下|角色|任务|这张|上(?:一张|图)|合集|原画)?/i.test(text);
  return { asksForSplit, singleSheetOnly: asksForSingleSheet && !asksForTasks && !asksForSplit };
}

export function createCoordinatorRuntime({
  db,
  getAgentConfig,
  getWorkspaces,
  createWorkspace,
  createCharacterTasks,
  delegateTask,
  generateCharacterSheet,
  getLatestGeneratedImage,
  getImageModelStatus,
  getPermissionMode,
  requestApproval,
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
  const dispatcherMessageColumns = db.prepare("PRAGMA table_info(dispatcher_messages)").all();
  if (!dispatcherMessageColumns.some((column) => column.name === "session_id")) {
    db.exec("ALTER TABLE dispatcher_messages ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
  }
  db.exec("CREATE INDEX IF NOT EXISTS dispatcher_messages_workspace_idx ON dispatcher_messages(workspace_id, id DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS dispatcher_messages_session_idx ON dispatcher_messages(workspace_id, session_id, id DESC)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatcher_conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '新会话',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS dispatcher_conversations_workspace_idx ON dispatcher_conversations(workspace_id, updated_at DESC)");
  db.exec(`
    INSERT OR IGNORE INTO dispatcher_conversations (id, workspace_id, title, created_at, updated_at)
    SELECT messages.session_id, messages.workspace_id,
           COALESCE((SELECT substr(first.content, 1, 48) FROM dispatcher_messages first
                     WHERE first.workspace_id = messages.workspace_id AND first.session_id = messages.session_id AND first.role = 'user'
                     ORDER BY first.id ASC LIMIT 1), '新会话'),
           MIN(messages.created_at), MAX(messages.created_at)
    FROM dispatcher_messages messages
    WHERE messages.workspace_id IS NOT NULL AND messages.session_id <> ''
    GROUP BY messages.workspace_id, messages.session_id
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatcher_conversation_state (
      workspace_id TEXT PRIMARY KEY,
      current_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);

  let activeAgent = null;

  function ensureSession(workspaceId) {
    if (!workspaceId) throw new Error("请先选择工作空间");
    const state = db.prepare("SELECT current_session_id AS sessionId FROM dispatcher_conversation_state WHERE workspace_id = ?").get(workspaceId);
    if (state?.sessionId) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO dispatcher_conversations (id, workspace_id, title, created_at, updated_at)
        VALUES (?, ?, '新会话', ?, ?)
      `).run(state.sessionId, workspaceId, now, now);
      return state.sessionId;
    }
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE dispatcher_messages SET session_id = ? WHERE workspace_id = ? AND session_id = ''").run(sessionId, workspaceId);
      const firstMessage = db.prepare(`
        SELECT substr(content, 1, 48) AS title, MIN(created_at) AS createdAt, MAX(created_at) AS updatedAt
        FROM dispatcher_messages WHERE workspace_id = ? AND session_id = ? AND role = 'user'
      `).get(workspaceId, sessionId);
      db.prepare(`
        INSERT INTO dispatcher_conversations (id, workspace_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(sessionId, workspaceId, firstMessage?.title || "新会话", firstMessage?.createdAt || now, firstMessage?.updatedAt || now);
      db.prepare(`
        INSERT INTO dispatcher_conversation_state (workspace_id, current_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET current_session_id = excluded.current_session_id, updated_at = excluded.updated_at
      `).run(workspaceId, sessionId, now, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return sessionId;
  }

  function listSessions(workspaceId) {
    const currentSessionId = ensureSession(workspaceId);
    const rows = db.prepare(`
      SELECT conversations.id, conversations.title, conversations.created_at AS createdAt,
             conversations.updated_at AS updatedAt, COUNT(messages.id) AS messageCount
      FROM dispatcher_conversations conversations
      LEFT JOIN dispatcher_messages messages
        ON messages.workspace_id = conversations.workspace_id AND messages.session_id = conversations.id
      WHERE conversations.workspace_id = ?
      GROUP BY conversations.id
      ORDER BY conversations.id = ? DESC, conversations.updated_at DESC
    `).all(workspaceId, currentSessionId);
    return rows.map((item) => ({ ...item, isCurrent: item.id === currentSessionId }));
  }

  function getMessages(workspaceId, limit = 100, requestedSessionId = null) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
    const sessionId = requestedSessionId || ensureSession(workspaceId);
    const rows = db.prepare(`
      SELECT id, role, content, attachment_name AS attachmentName, attachment_mime AS attachmentMime,
             created_at AS createdAt FROM dispatcher_messages
      WHERE workspace_id = ? AND session_id = ? ORDER BY id DESC LIMIT ?
    `).all(workspaceId, sessionId, safeLimit);
    return rows.reverse();
  }

  function addMessage(workspaceId, role, content, image = null) {
    const sessionId = ensureSession(workspaceId);
    const createdAt = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO dispatcher_messages (workspace_id, session_id, role, content, attachment_name, attachment_mime, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(workspaceId, sessionId, role, content, image?.name || null, image?.mimeType || null, createdAt);
    db.prepare(`
      UPDATE dispatcher_conversations
      SET title = CASE WHEN title = '新会话' AND ? = 'user' THEN substr(?, 1, 48) ELSE title END,
          updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(role, content, createdAt, sessionId, workspaceId);
    return {
      id: Number(result.lastInsertRowid), role, content,
      attachmentName: image?.name || null, attachmentMime: image?.mimeType || null, createdAt,
    };
  }

  function getConversation(workspaceId) {
    const sessionId = ensureSession(workspaceId);
    const messages = getMessages(workspaceId, 100, sessionId);
    const contextMessages = messages.slice(-24);
    return {
      sessionId,
      messages,
      sessions: listSessions(workspaceId),
      context: contextStats(systemPrompt(workspaceId, contextMessages, false), contextMessages),
    };
  }

  function startSession(workspaceId) {
    if (activeAgent) throw new Error("总调度 Agent 正在处理消息，暂时不能新建会话");
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO dispatcher_conversations (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, '新会话', ?, ?)").run(sessionId, workspaceId, now, now);
      db.prepare(`
        INSERT INTO dispatcher_conversation_state (workspace_id, current_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET current_session_id = excluded.current_session_id, updated_at = excluded.updated_at
      `).run(workspaceId, sessionId, now, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return getConversation(workspaceId);
  }

  function activateSession(workspaceId, sessionId) {
    if (activeAgent) throw new Error("总调度 Agent 正在处理消息，暂时不能切换会话");
    const current = ensureSession(workspaceId);
    const exists = sessionId === current || db.prepare("SELECT 1 FROM dispatcher_conversations WHERE workspace_id = ? AND id = ? LIMIT 1").get(workspaceId, sessionId);
    if (!exists) throw new Error("会话不存在");
    db.prepare("UPDATE dispatcher_conversation_state SET current_session_id = ?, updated_at = ? WHERE workspace_id = ?").run(sessionId, new Date().toISOString(), workspaceId);
    return getConversation(workspaceId);
  }

  function systemPrompt(workspaceId, history, imageContext = null) {
    const workspaces = getWorkspaces();
    const current = workspaces.find((item) => item.id === workspaceId) || null;
    const transcript = history.map((item) => `${item.role === "user" ? "用户" : "总调度 Agent"}：${item.content}`).join("\n");
    return `你是 Super Idol Master 的总调度 Agent，负责管理工作空间并把大型角色资产需求拆分给不同任务的专属 Asset Agent。

规则：
1. 必须区分“生成一张角色合集图”和“创建多个角色任务”。用户说“创建/生成一张合集图、角色集合图、群像原画，里面有 N 个角色”时，N 只是画面内角色数量，必须只调用 generate_character_sheet，一张图对应一个生成 Job；绝对不要调用 create_character_tasks。
2. 只有用户明确要求“拆分角色、建立多个任务、分别生成模型/绑骨”，或者上传已有合集原画并要求拆分时，才调用 create_character_tasks。
3. 创建任何任务前，先确定目标工作空间；用户未指定时使用当前工作空间，仍不存在则先创建工作空间。
4. 用户上传包含多个不同角色的合集原画并要求拆分时，视觉分析每个独立角色，为每个角色给出名称、角色描述、提示词和归一化裁切框。裁切框 x/y/width/height 均为 0–1，相对于整张图片，必须完整包住单个角色且尽量不包含相邻角色。
5. 有合集原画的拆分任务使用 image_to_model；纯文本批量任务使用 text_to_model。
6. 用户要求多个任务直接执行、生成到模型或绑骨时，把 delegateToAgents 设为 true，并选择对应 target。系统会让每个任务的专属 Agent 独立质检和持续执行。
7. 不得声称未创建的工作空间、任务或产物已经完成。工具失败时解释真实原因。
8. API Key 不通过聊天收集；需要配置时提醒用户使用首页的模型配置区域。
9. 最终用 Markdown 简洁说明实际启动的是单张合集图生成，还是多个任务及其委派目标。

当前工作空间：${JSON.stringify(current)}
全部工作空间：${JSON.stringify(workspaces)}
本轮是否附带合集原画：${imageContext ? "是" : "否"}
本轮合集原画来源：${imageContext?.inherited ? `系统已自动继承最近成功生成的合集图“${imageContext.title || imageContext.name}”，必须直接分析这张图，不要要求用户重新上传` : imageContext ? "用户本轮上传" : "无"}
最近会话：
${transcript.slice(-12000)}

当前权限模式：${getPermissionMode() === "auto" ? "Auto（变更工具自动批准）" : "请求批准（变更工具只创建审批，批准前不得声称已执行）"}`;
  }

  function tools(workspaceId, attachment, execution, intent) {
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
          if (getPermissionMode() !== "auto") {
            const approval = requestApproval({
              scopeType: "coordinator",
              scopeId: "global",
              workspaceId,
              operation: "create_workspace",
              title: `创建工作空间“${params.name}”`,
              description: params.description || "总调度 Agent 请求创建工作空间。",
              payload: params,
            });
            execution.actions.push({ tool: "approval_required", approvalId: approval.id });
            return textResult(`创建工作空间需要批准，已提交审批：“${approval.title}”。`, { approval });
          }
          const workspace = createWorkspace(params);
          execution.actions.push({ tool: "create_workspace", workspace });
          return textResult(`已创建工作空间“${workspace.name}”。`, workspace);
        },
      },
      {
        name: "generate_character_sheet",
        label: "生成单张角色合集图",
        description: "仅生成一张包含多个不同角色的统一风格合集原画，不创建任何角色任务。用户要求一张合集图时必须使用此工具。",
        parameters: Type.Object({
          workspaceId: Type.String({ minLength: 1, maxLength: 80 }),
          title: Type.String({ minLength: 1, maxLength: 80 }),
          characterCount: Type.Integer({ minimum: 1, maximum: 12 }),
          styleDescription: Type.String({ minLength: 1, maxLength: 1000 }),
          characterDescriptions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 12 }),
          additionalPrompt: Type.String({ maxLength: 2000 }),
          negativePrompt: Type.String({ maxLength: 2000 }),
        }),
        executionMode: "sequential",
        execute: async (_id, params) => {
          if (params.characterDescriptions.length !== params.characterCount) throw new Error("角色描述数量必须与合集图角色数量一致");
          if (getPermissionMode() !== "auto") {
            const approval = requestApproval({
              scopeType: "coordinator",
              scopeId: "global",
              workspaceId: params.workspaceId || workspaceId,
              operation: "generate_character_sheet",
              title: `生成一张包含 ${params.characterCount} 个角色的合集图`,
              description: `只生成“${params.title}”合集原画，不创建角色任务。`,
              payload: { ...params, sessionId: execution.sessionId },
            });
            execution.actions.push({ tool: "approval_required", approvalId: approval.id });
            return textResult(`单张合集图生成需要批准，已提交审批：“${approval.title}”。不会创建角色任务。`, { approval });
          }
          const job = generateCharacterSheet({ ...params, sessionId: execution.sessionId });
          execution.actions.push({ tool: "generate_character_sheet", jobId: job.id });
          return textResult(`已启动单张合集图“${params.title}”的生成，不会创建角色任务。`, { job });
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
          if (intent.singleSheetOnly) throw new Error("用户要求的是单张角色合集图，禁止创建多个任务；请改用 generate_character_sheet");
          if (getPermissionMode() !== "auto") {
            const approval = requestApproval({
              scopeType: "coordinator",
              scopeId: "global",
              workspaceId: params.workspaceId || workspaceId,
              operation: "create_character_tasks",
              title: `创建并调度 ${params.tasks.length} 个角色任务`,
              description: params.delegateToAgents
                ? `将创建任务并委派各任务的专属 Asset Agent，目标为 ${params.target}。`
                : "将按分析结果创建角色任务。",
              payload: { ...params, image: attachment },
            });
            execution.actions.push({ tool: "approval_required", approvalId: approval.id });
            return textResult(`批量创建与调度需要批准，已提交审批：“${approval.title}”。`, { approval });
          }
          const tasks = await createCharacterTasks({ ...params, image: attachment });
          const delegated = [];
          if (params.delegateToAgents) {
            for (const task of tasks) {
              try {
                const result = await delegateTask(task.run.id, params.target);
                delegated.push({ runId: task.run.id, status: result?.status === "pending" ? "awaiting_approval" : result?.status || "submitted" });
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
    if (!workspaceId) throw new Error("请先选择工作空间");
    if (!getWorkspaces().some((item) => item.id === workspaceId)) throw new Error("工作空间不存在");
    const explicitAttachment = validateImage(image);
    const userText = typeof message === "string" && message.trim()
      ? message.trim().slice(0, 6000)
      : explicitAttachment ? "请分析这张角色合集原画，拆分每个独立角色，并在当前工作空间创建图生模型任务。" : "";
    if (!userText) throw new Error("消息不能为空");
    const sessionId = ensureSession(workspaceId);
    const preliminaryIntent = classifyCoordinatorIntent(userText, Boolean(explicitAttachment));
    const inherited = !explicitAttachment && preliminaryIntent.asksForSplit
      ? getLatestGeneratedImage?.(workspaceId, sessionId) || null
      : null;
    const attachment = explicitAttachment || validateImage(inherited);
    const imageContext = attachment ? {
      inherited: Boolean(inherited),
      name: attachment.name,
      title: inherited?.title || null,
    } : null;
    const history = getMessages(workspaceId, 24, sessionId);
    const intent = classifyCoordinatorIntent(userText, Boolean(attachment));
    const execution = { actions: [], toolCalls: 0, turns: 0, sessionId };
    const agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(workspaceId, history, imageContext),
        model: createModel(config),
        thinkingLevel: "off",
        tools: tools(workspaceId, attachment, execution, intent),
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
      return { ...getConversation(workspaceId), actions: execution.actions, workspaces: getWorkspaces() };
    } finally {
      activeAgent = null;
    }
  }

  function cancel() {
    if (!activeAgent) return false;
    activeAgent.abort();
    return true;
  }

  return { run, cancel, getMessages, getConversation, startSession, activateSession, status: () => ({ running: Boolean(activeAgent) }) };
}
