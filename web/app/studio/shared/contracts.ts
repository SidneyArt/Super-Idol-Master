export type JobType = "none" | "2d" | "qa" | "3d" | "topology" | "rig";
export type JobStatus = "idle" | "running" | "succeeded" | "failed";
export type Theme = "light" | "dark";
export type ApprovalMode = "request" | "auto";
export type ProcessKind = "2d" | "qa" | "3d" | "rig";
export type ReasoningEffort = "off" | "low" | "high";
export type AgentModelOption = { id: string; name: string };

export type GlobalPreferences = {
  backgroundAnimationEnabled: boolean;
  notificationsEnabled: boolean;
  defaultApprovalMode: ApprovalMode;
};

export type ChatMessage = {
  id: number;
  role: "assistant" | "user";
  content: string;
  attachmentName: string | null;
  attachmentMime: string | null;
  createdAt: string;
};

export type AgentAttachment = {
  name: string;
  mimeType: string;
  data: string;
  size: number;
};

export type AgentQueueItem = {
  id: number;
  runId: string;
  runName: string;
  message: string;
  attachment: AgentAttachment | null;
};

export type Assets = {
  sourceImageReady: boolean;
  imageReady: boolean;
  modelReady: boolean;
  topologyReady: boolean;
  riggedReady: boolean;
  sourceImageDownloadUrl: string | null;
  imageDownloadUrl: string | null;
  modelDownloadUrl: string | null;
  topologyDownloadUrl: string | null;
  riggedDownloadUrl: string | null;
};

export type Run = {
  id: string;
  workspaceId: string;
  pipelineType: "text_to_model" | "image_to_model";
  name: string;
  positivePrompt: string;
  negativePrompt: string;
  currentStage: number;
  status: "active" | "completed" | "failed";
  qaStatus: "pending" | "passed" | "failed";
  qaScore: number | null;
  qaSummary: string;
  qaMetrics: Record<string, number>;
  qaOverlayPath: string | null;
  jobType: JobType;
  jobStatus: JobStatus;
  jobMessage: string;
  jobProgress: number;
  jobPromptId: string | null;
  jobCurrentNode: string | null;
  previewPath: string | null;
  sourcePreviewPath: string | null;
  assets: Assets;
  createdAt: string;
  updatedAt: string;
};

export type RunEvent = {
  id: number;
  eventType: string;
  stage: number;
  message: string;
  createdAt: string;
};

export type AgentRoleReport = {
  summary?: string;
  decision?: "approve" | "revise" | "manual_review" | "pass" | "repairable" | "reject";
  recommendation?: "retry_same" | "retry_with_changes" | "manual_intervention" | "abort";
  issues?: string[];
  warnings?: string[];
  positivePrompt?: string;
  negativePrompt?: string;
};

export type AgentRoleRun = {
  id: string;
  agentRole: "art_director" | "visual_qa" | "character_consistency" | "asset_inspector" | "rigging_qa" | "export_specialist" | "workflow_doctor";
  triggerType: string;
  sourceKey: string;
  status: "running" | "succeeded" | "failed";
  errorMessage: string;
  reportType: "prompt_plan" | "image_quality_report" | "character_consistency_report" | "asset_quality_report" | "rigging_quality_report" | "export_readiness_report" | "workflow_diagnosis_report" | null;
  report: AgentRoleReport | null;
  createdAt: string;
  completedAt: string | null;
};

export type Workspace = {
  id: string;
  name: string;
  description: string;
  taskCount: number;
  completedCount: number;
  runningCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceAssetKind = "image" | "model" | "topology" | "rigged";
export type WorkspaceAssetFilter = "all" | "2d" | "3d" | WorkspaceAssetKind;

export type WorkspaceAsset = {
  id: string;
  workspaceId: string;
  runId: string;
  runName: string;
  kind: WorkspaceAssetKind;
  group: "2d" | "3d";
  label: string;
  downloadUrl: string;
  previewUrl: string;
  filename: string;
  size: number | null;
  createdAt: string;
  rigged: boolean;
};

export type ApprovalRequest = {
  id: number;
  scopeType: "coordinator" | "task";
  scopeId: string;
  workspaceId: string | null;
  runId: string | null;
  operation: string;
  title: string;
  description: string;
  status: "pending" | "executing" | "approved" | "rejected" | "failed";
  errorMessage: string;
  createdAt: string;
  resolvedAt: string | null;
  sessionId: string;
};

export type AppNotification = {
  id: number;
  kind: string;
  title: string;
  message: string;
  workspaceId: string | null;
  runId: string | null;
  approvalId: number | null;
  readAt: string | null;
  createdAt: string;
};

export type ConversationSession = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  isCurrent: boolean;
};

export type ConversationContext = {
  estimatedTokens: number;
  contextWindow: number;
  responseReserve: number;
  availableTokens: number;
  usagePercent: number;
  messageCount: number;
  estimated: boolean;
};

export type ConversationPayload = {
  sessionId: string;
  messages: ChatMessage[];
  sessions: ConversationSession[];
  context: ConversationContext;
};

export type DispatcherGeneration = {
  id: string;
  workspaceId: string;
  sessionId: string;
  title: string;
  characterCount: number;
  prompt: string;
  status: "running" | "succeeded" | "failed";
  message: string;
  previewPath: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DispatcherTaskBatch = {
  id: string;
  workspaceId: string;
  sessionId: string;
  target: "concept_image" | "validated_tpose" | "model" | "retopologized_model" | "rigged_model" | "export";
  tasks: Run[];
  createdAt: string;
};

export type AgentWorkflowPlan = {
  runId: string;
  target: "concept_image" | "validated_tpose" | "model" | "retopologized_model" | "rigged_model" | "export";
  targetStage: number;
  status: "running" | "completed" | "blocked" | "failed" | "cancelled";
  message: string;
  createdAt: string;
  updatedAt: string;
};

export type RunDetail = {
  run: Run;
  events: RunEvent[];
  agentRoleRuns?: AgentRoleRun[];
  agentWorkflowPlan?: AgentWorkflowPlan | null;
};

export type WorkflowMetadata = {
  id: string;
  name: string;
  source: "default" | "uploaded";
  createdAt: string | null;
  nodeCount: number;
};

export type WorkflowCheck = {
  ready: boolean;
  online?: boolean;
  missing: string[];
  url?: string;
  latencyMs?: number;
};

export type ImageModelSettings = {
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  defaultBaseUrl: string;
  defaultModel: string;
};

export type AgentApiSettings = {
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  apiKeyConfigured: boolean;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
};

export type TopologyApiSettings = {
  url: string;
  tokenConfigured: boolean;
  targetQuads: number;
  timeoutSeconds: number;
  defaultUrl: string;
  defaultTargetQuads: number;
  defaultTimeoutSeconds: number;
};

export type ProcessSettings = {
  label: string;
  mode: "comfyui" | "api";
  url: string;
  workflow: Record<string, unknown>;
  activeWorkflowId: string;
  defaultWorkflowId: string;
  workflows: WorkflowMetadata[];
  defaultUrl: string;
  defaultWorkflow: Record<string, unknown>;
  defaultMode?: "comfyui";
  api?: {
    baseUrl: string;
    model: string;
    apiKeyConfigured: boolean;
    defaultBaseUrl: string;
    defaultModel: string;
  };
};

export type AppSettings = {
  processes: Record<ProcessKind, ProcessSettings>;
  agent: AgentApiSettings;
  topology: TopologyApiSettings;
  imageModels: {
    textToImage: ImageModelSettings;
    imageToImage: ImageModelSettings;
  };
  coordinator: {
    agent: AgentApiSettings;
    imageModels: {
      textToImage: ImageModelSettings;
      imageToImage: ImageModelSettings;
    };
  };
};

export type SystemState = {
  api: boolean;
  database: boolean;
  agent: { configured: boolean; model: string };
  comfyui: {
    online: boolean;
    pipelineReady: boolean;
    latencyMs: number;
    url: string;
    version?: string;
    queue: { running: number; pending: number };
    devices?: Array<{
      name: string;
      type: string;
      index: number | null;
      vramTotal: number | null;
      vramFree: number | null;
      torchVramTotal: number | null;
      torchVramFree: number | null;
    }>;
    topology?: {
      configured: boolean;
      online: boolean;
      ready: boolean;
      url: string;
      latencyMs: number;
      architecture: string | null;
    };
    workflows: Partial<Record<ProcessKind, WorkflowCheck>>;
  };
};
