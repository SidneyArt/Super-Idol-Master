import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";

if (existsSync(".env.local")) loadEnvFile(".env.local");

const apiKey = process.env.STEPFUN_API_KEY;
if (!apiKey) throw new Error("缺少 STEPFUN_API_KEY 环境变量");

const model = {
  id: process.env.STEPFUN_MODEL || "step-3.7-flash",
  name: "Stepfun Step Plan",
  api: "openai-completions",
  provider: "stepfun",
  baseUrl: process.env.STEPFUN_BASE_URL || "https://api.stepfun.com/step_plan/v1",
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

function createAgent(tools = []) {
  let responseStatus = null;
  const agent = new Agent({
    initialState: {
      systemPrompt: "你是兼容性测试助手。严格执行用户要求，回答保持简短。",
      model,
      thinkingLevel: "off",
      tools,
    },
    getApiKey: () => apiKey,
    toolExecution: "sequential",
    maxRetryDelayMs: 3000,
    onResponse: (response) => {
      responseStatus = response.status;
    },
  });
  let text = "";
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { agent, result: () => text.trim(), responseStatus: () => responseStatus };
}

async function verifyText() {
  const probe = createAgent();
  await probe.agent.prompt("只回答：文本兼容成功");
  if (!probe.result()) throw new Error("文本响应为空");
  console.log(`[text] ${probe.result()}`);
}

async function verifyTool() {
  let called = false;
  const tool = {
    name: "compatibility_echo",
    label: "兼容性回显",
    description: "必须调用此工具回显指定文本。",
    parameters: Type.Object({ text: Type.String() }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      called = true;
      return {
        content: [{ type: "text", text: `工具收到：${params.text}` }],
        details: { text: params.text },
      };
    },
  };
  const probe = createAgent([tool]);
  await probe.agent.prompt("调用 compatibility_echo，参数 text 必须是 tool-ok，然后说明结果。");
  if (!called) throw new Error("模型没有执行 Tool Call");
  console.log(`[tool] ${probe.result() || "工具已调用"}`);
}

async function verifyImage() {
  const probe = createAgent();
  const image = readFileSync(new URL("../public/character-preview.png", import.meta.url)).toString("base64");
  await probe.agent.prompt("确认你收到了图片，只回答：图片兼容成功", [
    { type: "image", data: image, mimeType: "image/png" },
  ]);
  if (!probe.result()) {
    throw new Error(`图片响应为空（HTTP ${probe.responseStatus() || "unknown"}）：${probe.agent.state.errorMessage || "模型未返回错误说明"}`);
  }
  console.log(`[image] ${probe.result()}`);
}

await verifyText();
await verifyTool();
await verifyImage();
console.log("Pi / Stepfun compatibility spike passed.");
