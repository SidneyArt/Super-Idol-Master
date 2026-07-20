import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const STAGE_NAMES = ["角色描述", "概念图生成", "T-Pose 检查", "3D 模型生成", "自动绑骨", "资产导出"];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_CALLS = 10;
const MAX_TURNS = 10;

function textResult(message, details) {
  return {
    content: [{ type: "text", text: message }],
    details,
  };
}

function messageText(message) {
  return (message?.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();
}

function validateImage(image) {
  if (!image) return null;
  const mimeType = typeof image.mimeType === "string" ? image.mimeType.toLowerCase() : "";
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    throw new Error("Agent 图片只支持 PNG、JPEG 或 WebP");
  }
  const rawData = typeof image.data === "string" ? image.data.replace(/^data:[^;]+;base64,/, "") : "";
  if (!rawData || !/^[a-zA-Z0-9+/=\r\n]+$/.test(rawData)) throw new Error("图片数据无效");
  const data = Buffer.from(rawData, "base64");
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error("Agent 图片不能超过 4 MB");

  const isPng = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const isWebp = data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  if ((mimeType === "image/png" && !isPng) || (mimeType === "image/jpeg" && !isJpeg) || (mimeType === "image/webp" && !isWebp)) {
    throw new Error("图片内容与文件类型不匹配");
  }
  return {
    name: typeof image.name === "string" ? image.name.slice(0, 160) : "reference-image",
    mimeType,
    data: data.toString("base64"),
  };
}

function compactRunContext(detail) {
  const run = detail.run;
  return {
    id: run.id,
    name: run.name,
    currentStage: run.currentStage,
    currentStageName: STAGE_NAMES[run.currentStage],
    positivePrompt: run.positivePrompt,
    negativePrompt: run.negativePrompt,
    job: {
      type: run.jobType,
      status: run.jobStatus,
      progress: run.jobProgress,
      message: run.jobMessage,
    },
    qa: {
      status: run.qaStatus,
      score: run.qaScore,
      summary: run.qaSummary,
    },
    assets: run.assets,
  };
}

function buildSystemPrompt(detail, history) {
  const transcript = history.length
    ? history.map((item) => `${item.role === "user" ? "用户" : "Asset Agent"}：${item.content}`).join("\n")
    : "无历史消息";
  return `你是 Super Idol Master 的 Asset Agent，负责把用户意图转换成受控的角色资产生产操作。

工作原则：
1. 你只能通过已注册工具改变项目状态，绝不能声称未执行的操作已经完成。
2. 用户提供角色描述或参考图片，并要求创建、完善或重生成时，主动整理正向和负向提示词，再调用 update_character_prompts。
3. 用户明确要求开始、继续、确认、推进时，调用 advance_workflow；如果进入的新阶段需要执行任务，再调用 run_stage_job。
4. 用户要求回退时调用 revert_workflow。修改已经产生下游资产的提示词前，先回退到“概念图生成”。
5. 一次对话最多启动一个 GPU Job。Job 创建后立即向用户说明已经提交，不等待生成完成。
6. 不要自动替用户确认生成结果。只有用户明确表达认可、确认或要求继续时，才能调用 advance_workflow 确认已有产物。
7. 如果用户只是询问状态或建议，不要调用写工具。信息不足时先提出一个简短问题。
8. 图片是参考信息，不等于流水线已经生成的正式资产。分析图片时把可见的角色、服装、风格、配色和构图转成提示词。
9. 工具报错时解释真实原因，不要绕过阶段、审批或运行中任务限制。
10. 最终回复使用简洁中文，明确说明实际执行的操作和当前阶段。

当前任务状态：
${JSON.stringify(compactRunContext(detail), null, 2)}

最近会话：
${transcript.slice(-12000)}`;
}

export function createAssetAgentRuntime({
  db,
  getRunDetail,
  updatePrompts,
  advanceWorkflow,
  revertWorkflow,
  runStageJob,
  getAgentConfig,
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      attachment_name TEXT,
      attachment_mime TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS agent_messages_run_id_idx ON agent_messages(run_id, id DESC)");

  const activeAgents = new Map();

  function getMessages(runId, limit = 100) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
    return db.prepare(`
      SELECT id, role, content, attachment_name AS attachmentName,
             attachment_mime AS attachmentMime, created_at AS createdAt
      FROM (
        SELECT * FROM agent_messages WHERE run_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(runId, safeLimit);
  }

  function addMessage(runId, role, content, image = null) {
    const createdAt = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO agent_messages (run_id, role, content, attachment_name, attachment_mime, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(runId, role, content, image?.name || null, image?.mimeType || null, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      role,
      content,
      attachmentName: image?.name || null,
      attachmentMime: image?.mimeType || null,
      createdAt,
    };
  }

  function createTools(runId, execution) {
    const currentContext = () => compactRunContext(getRunDetail(runId));
    return [
      {
        name: "get_run_context",
        label: "读取任务状态",
        description: "读取当前角色任务、阶段、提示词、QA、Job 和资产状态。",
        parameters: Type.Object({}),
        executionMode: "sequential",
        execute: async () => textResult(JSON.stringify(currentContext()), currentContext()),
      },
      {
        name: "update_character_prompts",
        label: "更新角色提示词",
        description: "更新角色的正向或负向生成提示词。已有下游资产时必须先回退到概念图生成阶段。",
        parameters: Type.Object({
          positivePrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
          negativePrompt: Type.Optional(Type.String({ maxLength: 2000 })),
          reason: Type.String({ minLength: 1, maxLength: 240 }),
        }),
        executionMode: "sequential",
        execute: async (_toolCallId, params) => {
          const detail = updatePrompts(runId, params);
          execution.actions.push({ tool: "update_character_prompts", message: "角色提示词已更新" });
          return textResult("角色提示词已保存。", compactRunContext(detail));
        },
      },
      {
        name: "advance_workflow",
        label: "推进工作流",
        description: "确认角色设定或当前阶段产物，并推进到下一阶段。只有用户明确要求开始、确认或继续时才能调用。",
        parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 240 }) }),
        executionMode: "sequential",
        execute: async (_toolCallId, params) => {
          const detail = advanceWorkflow(runId, params.reason);
          execution.actions.push({ tool: "advance_workflow", message: `流程已推进到${STAGE_NAMES[detail.run.currentStage]}` });
          return textResult(`流程已推进到“${STAGE_NAMES[detail.run.currentStage]}”。`, compactRunContext(detail));
        },
      },
      {
        name: "revert_workflow",
        label: "回退工作流",
        description: "回退到指定的更早阶段，并清除该阶段之后的产物引用。",
        parameters: Type.Object({
          targetStage: Type.Integer({ minimum: 0, maximum: 4 }),
          reason: Type.String({ minLength: 1, maxLength: 240 }),
        }),
        executionMode: "sequential",
        execute: async (_toolCallId, params) => {
          const detail = revertWorkflow(runId, params.targetStage, params.reason);
          execution.actions.push({ tool: "revert_workflow", message: `流程已回退到${STAGE_NAMES[params.targetStage]}` });
          return textResult(`流程已回退到“${STAGE_NAMES[params.targetStage]}”。`, compactRunContext(detail));
        },
      },
      {
        name: "run_stage_job",
        label: "执行阶段任务",
        description: "启动当前阶段允许的 2D 生成、T-Pose 检查、3D 生成或自动绑骨任务。",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("generate_2d"),
            Type.Literal("check_tpose"),
            Type.Literal("generate_3d"),
            Type.Literal("rig"),
          ]),
          reason: Type.String({ minLength: 1, maxLength: 240 }),
        }),
        executionMode: "sequential",
        execute: async (_toolCallId, params) => {
          if (execution.jobStarted) throw new Error("本次 Agent 对话已经启动过一个 GPU Job，请等待任务完成");
          const detail = runStageJob(runId, params.action, params.reason);
          execution.jobStarted = true;
          execution.actions.push({ tool: "run_stage_job", message: detail.run.jobMessage || "GPU Job 已提交" });
          return textResult(`已提交 ${detail.run.jobType} Job，当前状态为 ${detail.run.jobStatus}。`, compactRunContext(detail));
        },
      },
    ];
  }

  async function run({ runId, message, image }) {
    const agentConfig = getAgentConfig();
    if (!agentConfig.apiKey) throw new Error("Asset Agent 未配置 API Key，请在设置面板中完成配置");
    if (activeAgents.has(runId)) throw new Error("当前任务的 Agent 正在处理上一条消息");
    const detail = getRunDetail(runId);
    if (!detail?.run) throw new Error("任务不存在");

    const attachment = validateImage(image);
    const userText = typeof message === "string" && message.trim()
      ? message.trim().slice(0, 6000)
      : attachment
        ? "请分析这张参考图片，并根据当前任务状态完善角色提示词。"
        : "";
    if (!userText) throw new Error("消息不能为空");

    const history = getMessages(runId, 24);
    const execution = { actions: [], jobStarted: false, toolCalls: 0, turns: 0 };
    const model = {
      id: agentConfig.model,
      name: "Stepfun Step Plan",
      api: "openai-completions",
      provider: "stepfun",
      baseUrl: agentConfig.baseUrl,
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
    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(detail, history),
        model,
        thinkingLevel: "off",
        tools: createTools(runId, execution),
      },
      getApiKey: () => agentConfig.apiKey,
      toolExecution: "sequential",
      maxRetryDelayMs: 5000,
      beforeToolCall: async () => {
        execution.toolCalls += 1;
        if (execution.toolCalls > MAX_TOOL_CALLS) return { block: true, reason: "本次对话的工具调用次数已达到上限" };
        return undefined;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "turn_end") {
        execution.turns += 1;
        if (execution.turns >= MAX_TURNS) agent.abort();
      }
    });

    activeAgents.set(runId, agent);
    addMessage(runId, "user", userText, attachment);
    try {
      await agent.prompt(userText, attachment ? [{ type: "image", data: attachment.data, mimeType: attachment.mimeType }] : undefined);
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      const assistantText = [...agent.state.messages]
        .reverse()
        .filter((item) => item.role === "assistant")
        .map(messageText)
        .find(Boolean);
      if (!assistantText) throw new Error("模型没有返回可显示的回复");
      const assistantMessage = addMessage(runId, "assistant", assistantText);
      return {
        message: assistantMessage,
        messages: getMessages(runId),
        actions: execution.actions,
        detail: getRunDetail(runId),
      };
    } finally {
      activeAgents.delete(runId);
    }
  }

  function cancel(runId) {
    const agent = activeAgents.get(runId);
    if (!agent) return false;
    agent.abort();
    return true;
  }

  return {
    run,
    cancel,
    getMessages,
    status: () => {
      const config = getAgentConfig();
      return { configured: Boolean(config.apiKey), model: config.model };
    },
  };
}
