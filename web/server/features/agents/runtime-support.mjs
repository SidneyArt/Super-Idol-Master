import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

import { AGENT_CONTEXT_WINDOW } from "../../conversation-context.mjs";

export const STAGE_NAMES = ["角色描述", "概念图生成", "T-Pose 检查", "3D 模型生成", "自动拓扑", "自动绑骨", "资产导出"];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function textResult(message, details) {
  return {
    content: [{ type: "text", text: message }],
    details,
  };
}

export function messageText(message) {
  return (message?.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();
}

export function createModel(agentConfig) {
  return {
    id: agentConfig.model,
    name: "Stepfun Step Plan",
    api: "openai-completions",
    provider: "stepfun",
    baseUrl: agentConfig.baseUrl,
    reasoning: agentConfig.reasoningEffort !== "off",
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: AGENT_CONTEXT_WINDOW,
    maxTokens: 4096,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsStrictMode: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    },
  };
}

export function imageContent(filePath) {
  const size = statSync(filePath).size;
  if (size <= 0 || size > MAX_IMAGE_BYTES) throw new Error("专业 Agent 图片不能超过 4 MB");
  const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
  const mimeType = mimeTypes[extname(filePath).toLowerCase()];
  if (!mimeType) throw new Error("专业 Agent 只支持 PNG、JPEG 或 WebP");
  return { type: "image", data: readFileSync(filePath).toString("base64"), mimeType };
}

export function validateImage(image) {
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

export function compactRunContext(detail) {
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
      metrics: run.qaMetrics || {},
    },
    assets: run.assets,
  };
}

export function buildSystemPrompt(detail, history, permissionMode) {
  const transcript = history.length
    ? history.map((item) => `${item.role === "user" ? "用户" : "Asset Agent"}：${item.content}`).join("\n")
    : "无历史消息";
  return `你是 Super Idol Master 的 Asset Agent，负责把用户意图转换成受控的角色资产生产操作。

工作原则：
1. 你只能通过已注册工具改变项目状态，绝不能声称未执行的操作已经完成。
2. 用户提供角色描述或参考图片，并要求创建、完善或重生成时，主动整理正向和负向提示词，再调用 update_character_prompts。
3. 用户给出明确终点（例如“一路生成到模型”“自动做到绑骨完成”）时，优先调用 execute_pipeline_goal 一次登记持续执行目标。系统会在每个异步 Job 完成后自动恢复编排，不要把它拆成多轮人工确认。
4. 用户只要求推进一步时，调用 advance_workflow；如果进入的新阶段需要执行任务，再调用 run_stage_job。例外：当 T-Pose 质检已经失败，用户要求“重新生成/再试一次/修复 T-Pose”时，必须调用 execute_pipeline_goal，目标至少为 validated_tpose；禁止只调用 run_stage_job 生成一张未复检图片。若此前计划目标晚于 validated_tpose，应保留原计划终点。
5. 用户要求回退时调用 revert_workflow。修改已经产生下游资产的提示词前，先回退到“概念图生成”。
6. 一次对话最多直接启动一个 GPU Job。execute_pipeline_goal 的后续 Job 由完成事件依次触发，仍遵守单 GPU 串行规则。
7. 不要在没有明确终点时替用户确认生成结果；明确的流水线终点属于对中间合格产物的持续授权。SDPose、Visual QA 或 Character Consistency 未通过时绝对不能越过质量门禁，但应自动依据失败证据修复提示词、重新生成并复检，而不是立即暂停；连续三轮修复仍未通过时才结束自动计划并明确报告。3D 结构、绑骨或导出硬门禁失败时不得自动伪造修复结果。
8. 如果用户只是询问状态或建议，不要调用写工具。信息不足时先提出一个简短问题。
9. 图片是参考信息，不等于流水线已经生成的正式资产。分析图片时把可见的角色、服装、风格、配色和构图转成提示词。
10. 工具报错时解释真实原因，不要绕过阶段、审批或运行中任务限制。
11. 最终回复使用简洁中文，明确说明实际执行的操作、流水线目标和当前阶段。

当前权限模式：${permissionMode === "auto" ? "Auto（变更工具自动批准）" : "请求批准（变更工具只创建审批，批准前不得声称已执行）"}

当前任务状态：
${JSON.stringify(compactRunContext(detail), null, 2)}

最近会话：
${transcript.slice(-12000)}`;
}
