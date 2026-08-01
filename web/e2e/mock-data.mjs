export const workspaces = [
  {
    id: "default",
    name: "默认工作空间",
    description: "",
    taskCount: 0,
    completedCount: 0,
    runningCount: 0,
    createdAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:00:00.000Z",
  },
  {
    id: "workspace-a",
    name: "角色实验室",
    description: "E2E workspace",
    taskCount: 1,
    completedCount: 0,
    runningCount: 0,
    createdAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:00:00.000Z",
  },
  {
    id: "workspace-b",
    name: "宣传片资产",
    description: "Second workspace",
    taskCount: 0,
    completedCount: 0,
    runningCount: 0,
    createdAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:00:00.000Z",
  },
];

export const emptyAssets = {
  sourceImageReady: false,
  imageReady: true,
  modelReady: false,
  topologyReady: false,
  riggedReady: false,
  sourceImageDownloadUrl: null,
  imageDownloadUrl: "/generated/nova.png",
  modelDownloadUrl: null,
  topologyDownloadUrl: null,
  riggedDownloadUrl: null,
};

export const run = {
  id: "run-1",
  workspaceId: "workspace-a",
  pipelineType: "text_to_model",
  name: "Nova",
  positivePrompt: "未来城市女飞行员",
  negativePrompt: "低画质",
  currentStage: 2,
  status: "active",
  qaStatus: "passed",
  qaScore: 92,
  qaSummary: "姿态合格",
  qaMetrics: { symmetry: 0.92 },
  qaOverlayPath: "/generated/nova-qa.png",
  jobType: "none",
  jobStatus: "idle",
  jobMessage: "",
  jobProgress: 0,
  jobPromptId: null,
  jobCurrentNode: null,
  previewPath: "/generated/nova.png",
  sourcePreviewPath: null,
  assets: emptyAssets,
  createdAt: "2026-07-30T08:00:00.000Z",
  updatedAt: "2026-07-30T09:00:00.000Z",
};

export const sessions = [
  {
    id: "session-a",
    title: "角色方案 A",
    messageCount: 1,
    createdAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:05:00.000Z",
    isCurrent: true,
  },
  {
    id: "session-b",
    title: "角色方案 B",
    messageCount: 2,
    createdAt: "2026-07-30T08:10:00.000Z",
    updatedAt: "2026-07-30T08:15:00.000Z",
    isCurrent: false,
  },
];

export const context = {
  estimatedTokens: 1200,
  contextWindow: 131072,
  responseReserve: 4096,
  availableTokens: 125776,
  usagePercent: 1,
  messageCount: 1,
  estimated: true,
};

export function conversation(sessionId = "session-a") {
  return {
    sessionId,
    messages: [{
      id: 1,
      role: "assistant",
      content: "准备就绪",
      attachmentName: null,
      attachmentMime: null,
      createdAt: "2026-07-30T08:00:00.000Z",
    }],
    sessions: sessions.map((session) => ({
      ...session,
      isCurrent: session.id === sessionId,
    })),
    context,
  };
}

const workflow = (label) => ({
  label,
  mode: "comfyui",
  url: "http://127.0.0.1:8188",
  workflow: {},
  activeWorkflowId: "default",
  defaultWorkflowId: "default",
  workflows: [{
    id: "default",
    name: "默认工作流",
    source: "default",
    createdAt: null,
    nodeCount: 0,
  }],
  defaultUrl: "http://127.0.0.1:8188",
  defaultWorkflow: {},
});

const agent = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5",
  reasoningEffort: "low",
  apiKeyConfigured: true,
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-5",
  defaultReasoningEffort: "low",
};

const imageModel = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-image-1",
  apiKeyConfigured: true,
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-image-1",
};

export const settings = {
  processes: {
    "2d": {
      ...workflow("2D 概念图"),
      mode: "api",
      api: {
        baseUrl: imageModel.baseUrl,
        model: imageModel.model,
        apiKeyConfigured: true,
        defaultBaseUrl: imageModel.defaultBaseUrl,
        defaultModel: imageModel.defaultModel,
      },
    },
    qa: workflow("姿态质检"),
    "3d": workflow("三维重建"),
    rig: workflow("骨骼绑定"),
  },
  agent,
  topology: {
    url: "http://127.0.0.1:8190",
    tokenConfigured: true,
    targetQuads: 50000,
    timeoutSeconds: 3600,
    defaultUrl: "http://127.0.0.1:8190",
    defaultTargetQuads: 50000,
    defaultTimeoutSeconds: 3600,
  },
  imageModels: {
    textToImage: imageModel,
    imageToImage: imageModel,
  },
  coordinator: {
    agent,
    imageModels: {
      textToImage: imageModel,
      imageToImage: imageModel,
    },
  },
};

export const system = {
  api: true,
  database: true,
  agent: { configured: true, model: "gpt-5" },
  comfyui: {
    online: true,
    pipelineReady: true,
    latencyMs: 12,
    url: "http://127.0.0.1:8188",
    queue: { running: 0, pending: 0 },
    devices: [],
    topology: {
      configured: true,
      online: true,
      ready: true,
      url: "http://127.0.0.1:8190",
      latencyMs: 10,
      architecture: "mock",
    },
    workflows: {
      "2d": { ready: true, online: true, missing: [] },
      qa: { ready: true, online: true, missing: [] },
      "3d": { ready: true, online: true, missing: [] },
      rig: { ready: true, online: true, missing: [] },
    },
  },
};

export const approval = {
  id: 7,
  scopeType: "coordinator",
  scopeId: "workspace-a",
  workspaceId: "workspace-a",
  runId: null,
  operation: "create_tasks",
  title: "创建角色任务",
  description: "将合集拆成角色任务",
  status: "pending",
  errorMessage: "",
  createdAt: "2026-07-30T08:00:01.000Z",
  resolvedAt: null,
  sessionId: "session-a",
};

export const notification = {
  id: 9,
  kind: "task_completed",
  title: "任务完成",
  message: "Nova 已完成",
  workspaceId: "workspace-a",
  runId: "run-1",
  approvalId: null,
  readAt: null,
  createdAt: "2026-07-30T09:00:00.000Z",
};
