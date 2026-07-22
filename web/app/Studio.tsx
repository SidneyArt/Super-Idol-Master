"use client";

import Image from "next/image";
import {
  Bell,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Expand,
  FileJson,
  FolderOpen,
  Home,
  ImageIcon,
  Library,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  Undo2,
  User,
  X,
} from "lucide-react";
import { CSSProperties, DragEvent as ReactDragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, lazy, PointerEvent as ReactPointerEvent, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const ModelViewer = lazy(() => import("./components/ModelViewer"));

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8787";

const DEFAULT_POSITIVE_PROMPT =
  "美式3d卡通，1个3d女性角色，Ninjala风格，任天堂风格，潮流配色，(严格正视图:1.3)，完全正对镜头，(严格的T-Pose:1.3)，双臂水平伸展，全身出镜，纯白色背景，极简服装设计，纯净模型，1:1比例，高品质，杰作";
const DEFAULT_NEGATIVE_PROMPT =
  "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲";
const MAX_AGENT_QUEUE_ITEMS = 20;

const stages = [
  { short: "IDEA", title: "角色描述", subtitle: "定义人物与风格", input: "人物设定与提示词", output: "角色规格", action: "确认角色身份、服装、视角和背景。" },
  { short: "2D", title: "概念图生成", subtitle: "StepFun / Qwen", input: "角色规格", output: "PNG 概念图", action: "调用已配置的 StepFun 图片 API 或 DGX Qwen Image，并下载真实 PNG。" },
  { short: "QA", title: "T-Pose 检查", subtitle: "SDPose", input: "2D 概念图", output: "关键点与评分", action: "SDPose 检查单人全身、双臂水平、肘部伸直和左右对称。" },
  { short: "3D", title: "3D 模型生成", subtitle: "Pixal3D", input: "合格 T-Pose PNG", output: "静态 GLB", action: "DGX 执行 Pixal3D 工作流并下载真实静态 GLB。" },
  { short: "TOPO", title: "自动拓扑", subtitle: "AutoRemesher", input: "静态 GLB", output: "四边面派生拓扑 GLB", action: "DGX 执行 AutoRemesher 重拓扑，并通过 Blender 回烘纹理；GLB 导出时按 glTF 规范三角化。" },
  { short: "RIG", title: "自动绑骨", subtitle: "SkinTokens", input: "拓扑 GLB", output: "带骨骼 GLB", action: "DGX 使用拓扑模型执行 SkinTokens，生成 Mixamo 骨骼与蒙皮。" },
  { short: "OUT", title: "资产导出", subtitle: "文件交付", input: "已绑骨 GLB", output: "最终资产", action: "下载后端实际保存的 PNG、静态 GLB 或最终绑骨 GLB。" },
];

type JobType = "none" | "2d" | "qa" | "3d" | "topology" | "rig";
type JobStatus = "idle" | "running" | "succeeded" | "failed";
type Theme = "light" | "dark";
type ApprovalMode = "request" | "auto";
type ChatMessage = {
  id: number;
  role: "assistant" | "user";
  content: string;
  attachmentName: string | null;
  attachmentMime: string | null;
  createdAt: string;
};
type AgentAttachment = { name: string; mimeType: string; data: string; size: number };
type AgentQueueItem = {
  id: number;
  runId: string;
  runName: string;
  message: string;
  attachment: AgentAttachment | null;
};

type Assets = {
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

type RunEvent = { id: number; eventType: string; stage: number; message: string; createdAt: string };
type AgentRoleReport = {
  summary?: string;
  decision?: "approve" | "revise" | "manual_review" | "pass" | "repairable" | "reject";
  recommendation?: "retry_same" | "retry_with_changes" | "manual_intervention" | "abort";
  issues?: string[];
  warnings?: string[];
  positivePrompt?: string;
  negativePrompt?: string;
};
type AgentRoleRun = {
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
type UiConfirmation = {
  title: string;
  description: string;
  confirmLabel: string;
  tone: "warning" | "danger";
  action: () => Promise<void>;
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
type WorkspaceAssetKind = "image" | "model" | "topology" | "rigged";
type WorkspaceAssetFilter = "all" | "2d" | "3d" | WorkspaceAssetKind;
type WorkspaceAsset = {
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
  size: number;
  createdAt: string;
  rigged: boolean;
};
type ApprovalRequest = {
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
type AppNotification = {
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
type ConversationSession = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  isCurrent: boolean;
};
type ConversationContext = {
  estimatedTokens: number;
  contextWindow: number;
  responseReserve: number;
  availableTokens: number;
  usagePercent: number;
  messageCount: number;
  estimated: boolean;
};
type ConversationPayload = {
  sessionId: string;
  messages: ChatMessage[];
  sessions: ConversationSession[];
  context: ConversationContext;
};
type DispatcherGeneration = {
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
type DispatcherTaskBatch = {
  id: string;
  workspaceId: string;
  sessionId: string;
  target: "concept_image" | "validated_tpose" | "model" | "retopologized_model" | "rigged_model" | "export";
  tasks: Run[];
  createdAt: string;
};
type DispatcherTimelineItem =
  | { kind: "message"; createdAt: string; item: ChatMessage }
  | { kind: "generation"; createdAt: string; item: DispatcherGeneration }
  | { kind: "taskBatch"; createdAt: string; item: DispatcherTaskBatch }
  | { kind: "approval"; createdAt: string; item: ApprovalRequest };

function dispatcherTimelineTime(createdAt: string) {
  const timestamp = Date.parse(createdAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareDispatcherTimelineItems(left: DispatcherTimelineItem, right: DispatcherTimelineItem) {
  const timeDifference = dispatcherTimelineTime(left.createdAt) - dispatcherTimelineTime(right.createdAt);
  if (timeDifference) return timeDifference;

  const rank = (entry: DispatcherTimelineItem) => entry.kind === "message"
    ? entry.item.role === "user" ? 0 : 3
    : entry.kind === "generation" ? 1 : entry.kind === "taskBatch" ? 2 : 3;
  const rankDifference = rank(left) - rank(right);
  if (rankDifference) return rankDifference;

  return String(left.item.id).localeCompare(String(right.item.id), undefined, { numeric: true });
}

function buildDispatcherTimeline(
  messages: ChatMessage[],
  generations: DispatcherGeneration[],
  approvalRequests: ApprovalRequest[],
  taskBatches: DispatcherTaskBatch[],
) {
  const sortedMessages = [...messages].sort((left, right) => {
    const timeDifference = dispatcherTimelineTime(left.createdAt) - dispatcherTimelineTime(right.createdAt);
    if (timeDifference) return timeDifference;
    if (left.role !== right.role) return left.role === "user" ? -1 : 1;
    return left.id - right.id;
  });
  const approvalsByAssistant = new Map<number, ApprovalRequest[]>();
  const batchesByAssistant = new Map<number, DispatcherTaskBatch[]>();
  const unanchoredApprovals: ApprovalRequest[] = [];
  const unanchoredBatches: DispatcherTaskBatch[] = [];

  const followingAssistant = (createdAt: string) => {
    const itemTime = dispatcherTimelineTime(createdAt);
    return sortedMessages.find((message) => {
      if (message.role !== "assistant" || dispatcherTimelineTime(message.createdAt) < itemTime) return false;
      const assistantTime = dispatcherTimelineTime(message.createdAt);
      return !sortedMessages.some((candidate) => candidate.role === "user"
        && dispatcherTimelineTime(candidate.createdAt) > itemTime
        && dispatcherTimelineTime(candidate.createdAt) <= assistantTime);
    });
  };

  [...approvalRequests]
    .sort((left, right) => dispatcherTimelineTime(left.createdAt) - dispatcherTimelineTime(right.createdAt) || left.id - right.id)
    .forEach((approval) => {
      const assistant = followingAssistant(approval.createdAt);

      if (!assistant) {
        unanchoredApprovals.push(approval);
        return;
      }
      const anchored = approvalsByAssistant.get(assistant.id) || [];
      anchored.push(approval);
      approvalsByAssistant.set(assistant.id, anchored);
    });

  [...taskBatches]
    .sort((left, right) => dispatcherTimelineTime(left.createdAt) - dispatcherTimelineTime(right.createdAt))
    .forEach((batch) => {
      const assistant = followingAssistant(batch.createdAt);
      if (!assistant) {
        unanchoredBatches.push(batch);
        return;
      }
      const anchored = batchesByAssistant.get(assistant.id) || [];
      anchored.push(batch);
      batchesByAssistant.set(assistant.id, anchored);
    });

  const baseTimeline: DispatcherTimelineItem[] = [
    ...messages.map((item) => ({ kind: "message" as const, createdAt: item.createdAt, item })),
    ...generations.map((item) => ({ kind: "generation" as const, createdAt: item.createdAt, item })),
    ...unanchoredBatches.map((item) => ({ kind: "taskBatch" as const, createdAt: item.createdAt, item })),
    ...unanchoredApprovals.map((item) => ({ kind: "approval" as const, createdAt: item.createdAt, item })),
  ].sort(compareDispatcherTimelineItems);

  return baseTimeline.flatMap((entry) => {
    if (entry.kind !== "message" || entry.item.role !== "assistant") return [entry];
    const anchored = approvalsByAssistant.get(entry.item.id) || [];
    const anchoredBatches = batchesByAssistant.get(entry.item.id) || [];
    return [
      entry,
      ...anchored.map((item) => ({ kind: "approval" as const, createdAt: item.createdAt, item })),
      ...anchoredBatches.map((item) => ({ kind: "taskBatch" as const, createdAt: item.createdAt, item })),
    ];
  });
}
type AgentWorkflowPlan = {
  runId: string;
  target: "concept_image" | "validated_tpose" | "model" | "retopologized_model" | "rigged_model" | "export";
  targetStage: number;
  status: "running" | "completed" | "blocked" | "failed" | "cancelled";
  message: string;
  createdAt: string;
  updatedAt: string;
};
type RunDetail = {
  run: Run;
  events: RunEvent[];
  agentRoleRuns?: AgentRoleRun[];
  agentWorkflowPlan?: AgentWorkflowPlan | null;
};
type WorkflowCheck = { ready: boolean; missing: string[] };
type ProcessKind = "2d" | "qa" | "3d" | "rig";
type ProcessSettings = {
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
type WorkflowMetadata = { id: string; name: string; source: "default" | "uploaded"; createdAt: string | null; nodeCount: number };
type AgentModelOption = { id: string; name: string };
type ReasoningEffort = "off" | "low" | "high";
type AgentApiSettings = {
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  apiKeyConfigured: boolean;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
};
type TopologyApiSettings = {
  url: string;
  tokenConfigured: boolean;
  targetQuads: number;
  timeoutSeconds: number;
  defaultUrl: string;
  defaultTargetQuads: number;
  defaultTimeoutSeconds: number;
};
type AppSettings = {
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
type ImageModelSettings = {
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  defaultBaseUrl: string;
  defaultModel: string;
};
type ImageModelDraft = { baseUrl: string; model: string; apiKey: string; clearApiKey: boolean };
type AgentApiDraft = { baseUrl: string; model: string; reasoningEffort: ReasoningEffort; apiKey: string; clearApiKey: boolean };
type TopologyApiDraft = { url: string; token: string; clearToken: boolean; targetQuads: number; timeoutSeconds: number };
type SettingsDraft = {
  processes: Record<ProcessKind, {
    mode: "comfyui" | "api";
    url: string;
    activeWorkflowId: string;
    workflowJson: string;
    api?: { baseUrl: string; model: string; apiKey: string };
  }>;
  agent: AgentApiDraft;
  topology: TopologyApiDraft;
  imageModels: { textToImage: ImageModelDraft; imageToImage: ImageModelDraft };
  coordinator: {
    agent: AgentApiDraft;
    imageModels: { textToImage: ImageModelDraft; imageToImage: ImageModelDraft };
  };
};
type SystemState = {
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
    topology?: { configured: boolean; online: boolean; ready: boolean; url: string; latencyMs: number; architecture: string | null };
    workflows: Partial<Record<"2d" | "qa" | "3d" | "rig", WorkflowCheck>>;
  };
};

const PROCESS_KINDS: ProcessKind[] = ["2d", "qa", "3d", "rig"];

function settingsDraft(settings: AppSettings): SettingsDraft {
  return {
    processes: Object.fromEntries(PROCESS_KINDS.map((kind) => [kind, {
      mode: settings.processes[kind].mode,
      url: settings.processes[kind].url,
      activeWorkflowId: settings.processes[kind].activeWorkflowId,
      workflowJson: JSON.stringify(settings.processes[kind].workflow, null, 2),
      ...(settings.processes[kind].api ? {
        api: {
          baseUrl: settings.processes[kind].api.baseUrl,
          model: settings.processes[kind].api.model,
          apiKey: "",
        },
      } : {}),
    }])) as SettingsDraft["processes"],
    agent: {
      baseUrl: settings.agent.baseUrl,
      model: settings.agent.model,
      reasoningEffort: settings.agent.reasoningEffort,
      apiKey: "",
      clearApiKey: false,
    },
    topology: {
      url: settings.topology.url,
      token: "",
      clearToken: false,
      targetQuads: settings.topology.targetQuads,
      timeoutSeconds: settings.topology.timeoutSeconds,
    },
    imageModels: {
      textToImage: { baseUrl: settings.imageModels.textToImage.baseUrl, model: settings.imageModels.textToImage.model, apiKey: "", clearApiKey: false },
      imageToImage: { baseUrl: settings.imageModels.imageToImage.baseUrl, model: settings.imageModels.imageToImage.model, apiKey: "", clearApiKey: false },
    },
    coordinator: {
      agent: {
        baseUrl: settings.coordinator.agent.baseUrl,
        model: settings.coordinator.agent.model,
        reasoningEffort: settings.coordinator.agent.reasoningEffort,
        apiKey: "",
        clearApiKey: false,
      },
      imageModels: {
        textToImage: { baseUrl: settings.coordinator.imageModels.textToImage.baseUrl, model: settings.coordinator.imageModels.textToImage.model, apiKey: "", clearApiKey: false },
        imageToImage: { baseUrl: settings.coordinator.imageModels.imageToImage.baseUrl, model: settings.coordinator.imageModels.imageToImage.model, apiKey: "", clearApiKey: false },
      },
    },
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMemory(value: number | null | undefined) {
  if (!Number.isFinite(value) || Number(value) <= 0) return null;
  return `${(Number(value) / (1024 ** 3)).toFixed(1)} GB`;
}

function formatFileSize(value: number) {
  if (!Number.isFinite(value) || value < 1) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MB`;
  return `${(value / (1024 ** 3)).toFixed(1)} GB`;
}

function jobName(type: JobType) {
  return { none: "本地流程", "2d": "2D 图片", qa: "SDPose", "3d": "Pixal3D", topology: "AutoRemesher", rig: "SkinTokens" }[type];
}

function formatTokenCount(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
}

function AgentPermissionMenu({ mode, onChange, title }: { mode: ApprovalMode; onChange: (mode: ApprovalMode) => void; title: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className={`agent-permission-menu ${open ? "open" : ""}`} ref={rootRef}>
      <button type="button" className="agent-permission-trigger" onClick={() => setOpen((value) => !value)} title={title} aria-haspopup="listbox" aria-expanded={open}>
        <ShieldCheck size={14} /><span>{mode === "request" ? "请求批准" : "Auto"}</span><ChevronDown size={13} />
      </button>
      {open && (
        <div className="agent-permission-options" role="listbox" aria-label={title}>
          <button type="button" className={mode === "request" ? "selected" : ""} role="option" aria-selected={mode === "request"} onClick={() => { onChange("request"); setOpen(false); }}><ShieldCheck size={14} /><span><strong>请求批准</strong><small>执行变更前询问</small></span>{mode === "request" && <Check size={14} />}</button>
          <button type="button" className={mode === "auto" ? "selected" : ""} role="option" aria-selected={mode === "auto"} onClick={() => { onChange("auto"); setOpen(false); }}><Sparkles size={14} /><span><strong>Auto</strong><small>自动批准受控操作</small></span>{mode === "auto" && <Check size={14} />}</button>
        </div>
      )}
    </div>
  );
}

type StyledSelectOption = { value: string; label: string; disabled?: boolean };

function StyledSelect({ value, options, onChange, ariaLabel, placement = "down", disabled = false }: {
  value: string;
  options: StyledSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placement?: "up" | "down";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) || options[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  return (
    <div className={`styled-select ${open ? "open" : ""} placement-${placement}`} ref={rootRef}>
      <button type="button" className="styled-select-trigger" disabled={disabled} onClick={() => setOpen((current) => !current)} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}>
        <span>{selected?.label || "请选择"}</span><ChevronDown size={15} />
      </button>
      {open && !disabled && (
        <div className="styled-select-options" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button key={option.value} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className={option.value === value ? "selected" : ""} onClick={() => { onChange(option.value); setOpen(false); }}>
              <span>{option.label}</span>{option.value === value && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function ConversationSessionManager({
  sessions,
  sessionId,
  label,
  disabled,
  onActivate,
  onCreate,
  onDelete,
}: {
  sessions: ConversationSession[];
  sessionId: string;
  label: string;
  disabled: boolean;
  onActivate: (sessionId: string) => void;
  onCreate: () => void;
  onDelete: (session: ConversationSession) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = sessions.find((session) => session.id === sessionId) || sessions[0] || null;
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  return (
    <div className={`conversation-manager ${open ? "open" : ""}`} ref={rootRef}>
      <button type="button" className="conversation-manager-trigger" disabled={disabled} onClick={() => setOpen((value) => !value)} aria-haspopup="dialog" aria-expanded={open} title={`${label}：${current?.title || "新会话"}`}>
        <MessageSquare size={14} />
        <span><strong>{current?.title || "新会话"}</strong><small>{current ? `${current.messageCount} 条消息` : "正在创建"}</small></span>
        <ChevronDown size={13} />
      </button>
      <button type="button" className="conversation-create-button" disabled={disabled} onClick={() => { setOpen(false); onCreate(); }} title="新建会话" aria-label={`新建${label}`}><Plus size={15} /></button>
      {open && !disabled && (
        <section className="conversation-menu" role="dialog" aria-label={`${label}列表`}>
          <header><div><strong>会话记录</strong><small>{sessions.length} 个会话</small></div><button type="button" onClick={() => { setOpen(false); onCreate(); }}><Plus size={14} />新对话</button></header>
          <div className="conversation-list">
            {sessions.map((session) => (
              <div className={`conversation-list-row ${session.id === sessionId ? "current" : ""}`} key={session.id}>
                <button type="button" className="conversation-list-main" onClick={() => { setOpen(false); onActivate(session.id); }}>
                  <span><MessageSquare size={14} /></span>
                  <div><strong>{session.title.replace(/\s+/g, " ")}</strong><small>{session.messageCount} 条消息 · {formatSessionTime(session.updatedAt)}</small></div>
                  {session.id === sessionId && <Check size={14} />}
                </button>
                <button type="button" className="conversation-delete-button" onClick={() => { setOpen(false); onDelete(session); }} title={`删除会话：${session.title}`} aria-label={`删除会话：${session.title}`}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ContextUsage({ context, compact = false }: { context: ConversationContext | null; compact?: boolean }) {
  const used = context?.estimatedTokens || 0;
  const limit = context?.contextWindow || 131_072;
  const percent = Math.min(100, Math.max(0, context?.usagePercent || 0));
  const tooltipId = useId();
  const description = context
    ? `上下文已使用 ${percent}%，${used.toLocaleString()} / ${limit.toLocaleString()} tokens，剩余约 ${context.availableTokens.toLocaleString()} tokens`
    : "正在读取上下文用量";
  return (
    <span className={`context-usage ${compact ? "compact" : ""}`}>
      <button className="context-usage-trigger" type="button" aria-label={description} aria-describedby={tooltipId}>
        <span className="context-usage-pie" aria-hidden="true" style={{ background: `conic-gradient(var(--accent) ${percent * 3.6}deg, var(--border-strong) 0deg)` }} />
      </button>
      <span className="context-usage-tooltip" id={tooltipId} role="tooltip">
        <small>Context</small>
        <strong>{context ? `${percent}% · ${formatTokenCount(used)} / ${formatTokenCount(limit)}` : "正在读取…"}</strong>
        <span className="context-usage-divider" />
        <span className="context-usage-detail"><span>剩余可用</span><b>{context ? formatTokenCount(context.availableTokens) : "—"}</b></span>
        <span className="context-usage-detail"><span>消息</span><b>{context ? `${context.messageCount} 条` : "—"}</b></span>
      </span>
    </span>
  );
}

type StudioProps = {
  initialRunId: string | null;
  initialWorkspaceId: string | null;
  initialNotificationId: number | null;
  initialRuns: Run[];
  initialWorkspaces: Workspace[];
};

export default function Studio({ initialRunId, initialWorkspaceId: requestedWorkspaceId, initialNotificationId, initialRuns, initialWorkspaces }: StudioProps) {
  const screen: "home" | "task" = initialRunId ? "task" : "home";
  const initialRun = initialRuns.find((item) => item.id === initialRunId);
  const startingWorkspaceId = initialRun?.workspaceId
    || requestedWorkspaceId
    || initialWorkspaces.find((item) => item.id === "default")?.id
    || initialWorkspaces[0]?.id
    || "default";
  const [workspaces, setWorkspaces] = useState<Workspace[]>(initialWorkspaces);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(startingWorkspaceId);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(() => new Set(["default"]));
  const [runs, setRuns] = useState<Run[]>(initialRuns);
  const [selectedId, setSelectedId] = useState<string | null>(initialRunId);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [viewStage, setViewStage] = useState(0);
  const [system, setSystem] = useState<SystemState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(initialRuns.length === 0);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [revertStage, setRevertStage] = useState<number | null>(null);
  const [uiConfirmation, setUiConfirmation] = useState<UiConfirmation | null>(null);
  const [uiConfirmationBusy, setUiConfirmationBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState<SettingsDraft | null>(null);
  const [settingsTab, setSettingsTab] = useState<ProcessKind | "topology" | "agent" | "coordinator">("2d");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [agentModelsLoading, setAgentModelsLoading] = useState(false);
  const [agentModels, setAgentModels] = useState<AgentModelOption[]>([]);
  const [coordinatorModels, setCoordinatorModels] = useState<AgentModelOption[]>([]);
  const [workflowPreviewOpen, setWorkflowPreviewOpen] = useState(false);
  const [workflowDragging, setWorkflowDragging] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const [agentWidth, setAgentWidth] = useState(360);
  const [theme, setTheme] = useState<Theme>("dark");
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [qaBlend, setQaBlend] = useState(0.5);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSessionId, setChatSessionId] = useState("");
  const [chatSessions, setChatSessions] = useState<ConversationSession[]>([]);
  const [chatContext, setChatContext] = useState<ConversationContext | null>(null);
  const [chatSessionBusy, setChatSessionBusy] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [activeAgentRunId, setActiveAgentRunId] = useState<string | null>(null);
  const [agentQueue, setAgentQueue] = useState<AgentQueueItem[]>([]);
  const [agentAttachment, setAgentAttachment] = useState<AgentAttachment | null>(null);
  const [agentImageDragging, setAgentImageDragging] = useState(false);
  const [dispatcherMessages, setDispatcherMessages] = useState<ChatMessage[]>([]);
  const [dispatcherSessionId, setDispatcherSessionId] = useState("");
  const [dispatcherSessions, setDispatcherSessions] = useState<ConversationSession[]>([]);
  const [dispatcherContext, setDispatcherContext] = useState<ConversationContext | null>(null);
  const [dispatcherSessionBusy, setDispatcherSessionBusy] = useState(false);
  const [dispatcherInput, setDispatcherInput] = useState("");
  const [dispatcherBusy, setDispatcherBusy] = useState(false);
  const [dispatcherAttachment, setDispatcherAttachment] = useState<AgentAttachment | null>(null);
  const [dispatcherDragging, setDispatcherDragging] = useState(false);
  const [dispatcherGenerations, setDispatcherGenerations] = useState<DispatcherGeneration[]>([]);
  const [dispatcherTaskBatches, setDispatcherTaskBatches] = useState<DispatcherTaskBatch[]>([]);
  const dispatcherGenerationScrollKey = dispatcherGenerations.map((item) => `${item.id}:${item.updatedAt}`).join("|");
  const [showWorkspaceCreate, setShowWorkspaceCreate] = useState(false);
  const [assetLibraryWorkspaceId, setAssetLibraryWorkspaceId] = useState<string | null>(null);
  const [workspaceAssets, setWorkspaceAssets] = useState<WorkspaceAsset[]>([]);
  const [workspaceAssetFilter, setWorkspaceAssetFilter] = useState<WorkspaceAssetFilter>("all");
  const [selectedWorkspaceAssetId, setSelectedWorkspaceAssetId] = useState<string | null>(null);
  const [workspaceAssetsLoading, setWorkspaceAssetsLoading] = useState(false);
  const [workspaceForm, setWorkspaceForm] = useState({ name: "", description: "" });
  const [form, setForm] = useState({ name: "", workspaceId: "default", pipelineType: "text_to_model" as "text_to_model" | "image_to_model" });
  const [taskSourceImage, setTaskSourceImage] = useState<AgentAttachment | null>(null);
  const [coordinatorMode, setCoordinatorMode] = useState<ApprovalMode>("request");
  const [taskAgentMode, setTaskAgentMode] = useState<ApprovalMode>("request");
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const approvalScrollKey = approvals.map((item) => item.id).join("|");
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [notificationAction, setNotificationAction] = useState<number | "read-all" | "clear" | null>(null);
  const [notificationFocusId, setNotificationFocusId] = useState<number | null>(initialNotificationId);
  const [toastQueue, setToastQueue] = useState<AppNotification[]>([]);
  const [approvalBusyId, setApprovalBusyId] = useState<number | null>(null);
  const [promptDraft, setPromptDraft] = useState({
    positivePrompt: DEFAULT_POSITIVE_PROMPT,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
  });
  const agentDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const dispatcherSessionIdRef = useRef("");
  const agentQueueRef = useRef<AgentQueueItem[]>([]);
  const agentProcessingRef = useRef(false);
  const agentQueueIdRef = useRef(0);
  const selectedIdRef = useRef<string | null>(selectedId);
  const selectedWorkspaceIdRef = useRef(selectedWorkspaceId);
  const agentDropDepthRef = useRef(0);
  const dispatcherDropDepthRef = useRef(0);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const dispatcherEndRef = useRef<HTMLDivElement | null>(null);
  const notificationCenterRef = useRef<HTMLDivElement | null>(null);
  const dispatcherFileRef = useRef<HTMLInputElement | null>(null);
  const taskSourceFileRef = useRef<HTMLInputElement | null>(null);
  const workflowFileRef = useRef<HTMLInputElement | null>(null);
  const workflowDirectoryRef = useRef<HTMLInputElement | null>(null);
  const latestNotificationIdRef = useRef(0);
  const notificationsInitializedRef = useRef(false);
  const toastNotification = toastQueue[0] || null;

  function openHome() {
    window.location.assign("/");
  }

  function openTask(runId: string) {
    window.location.assign(`/?task=${encodeURIComponent(runId)}`);
  }

  function selectTask(run: Run) {
    window.history.replaceState(null, "", `/?task=${encodeURIComponent(run.id)}`);
    selectWorkspace(run.workspaceId);
    selectRun(run.id);
  }

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  function selectRun(runId: string | null) {
    if (selectedIdRef.current !== runId) clearTaskConversation();
    selectedIdRef.current = runId;
    setSelectedId(runId);
  }

  function selectWorkspace(workspaceId: string) {
    if (selectedWorkspaceIdRef.current !== workspaceId) clearDispatcherConversation();
    selectedWorkspaceIdRef.current = workspaceId;
    setSelectedWorkspaceId(workspaceId);
  }

  function toggleWorkspace(workspaceId: string) {
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }

  function applyDispatcherConversation(data: ConversationPayload) {
    setDispatcherMessages(data.messages);
    dispatcherSessionIdRef.current = data.sessionId;
    setDispatcherSessionId(data.sessionId);
    setDispatcherSessions(data.sessions);
    setDispatcherContext(data.context);
  }

  function applyTaskConversation(data: ConversationPayload) {
    setChatMessages(data.messages);
    setChatSessionId(data.sessionId);
    setChatSessions(data.sessions);
    setChatContext(data.context);
  }

  function clearTaskConversation() {
    setChatMessages([]);
    setChatSessionId("");
    setChatSessions([]);
    setChatContext(null);
  }

  function clearDispatcherConversation() {
    setDispatcherMessages([]);
    dispatcherSessionIdRef.current = "";
    setDispatcherSessionId("");
    setDispatcherSessions([]);
    setDispatcherContext(null);
    setDispatcherGenerations([]);
    setDispatcherTaskBatches([]);
  }

  useEffect(() => {
    const saved = window.localStorage.getItem("sim-theme");
    if (saved !== "light" && saved !== "dark") return;
    document.documentElement.dataset.theme = saved;
    const timer = window.setTimeout(() => setTheme(saved), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function refreshRuns(preferredId?: string) {
    const data = await api<{ runs: Run[] }>("/api/runs");
    setRuns(data.runs);
    const nextId = preferredId || selectedId || data.runs[0]?.id || null;
    selectRun(nextId);
    if (!nextId) setDetail(null);
  }

  async function refreshWorkspaces(preferredId?: string) {
    const data = await api<{ workspaces: Workspace[] }>("/api/workspaces");
    setWorkspaces(data.workspaces);
    const nextId = preferredId || selectedWorkspaceId || data.workspaces[0]?.id || "default";
    selectWorkspace(nextId);
    return data.workspaces;
  }

  async function openAssetLibrary(workspaceId: string) {
    setAssetLibraryWorkspaceId(workspaceId);
    setWorkspaceAssetFilter("all");
    setSelectedWorkspaceAssetId(null);
    setWorkspaceAssets([]);
    setWorkspaceAssetsLoading(true);
    setError("");
    try {
      const data = await api<{ assets: WorkspaceAsset[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/assets`);
      setWorkspaceAssets(data.assets);
      setSelectedWorkspaceAssetId(data.assets[0]?.id || null);
    } catch (reason) {
      setAssetLibraryWorkspaceId(null);
      setError(reason instanceof Error ? reason.message : "资产库加载失败");
    } finally {
      setWorkspaceAssetsLoading(false);
    }
  }

  function requestDeleteWorkspaceAsset(asset: WorkspaceAsset) {
    const dependencyText = {
      image: "删除概念图也会删除由它生成的静态模型、拓扑模型和绑定模型。",
      model: "删除静态模型也会删除由它生成的拓扑模型和绑定模型。",
      topology: "删除拓扑模型也会删除由它生成的绑定模型。",
      rigged: "只会删除这个绑定模型。",
    }[asset.kind];
    setUiConfirmation({
      title: `删除“${asset.runName}”的${asset.label}？`,
      description: `${dependencyText} 文件和对应流程状态会同步更新，此操作无法撤销。`,
      confirmLabel: "删除资产",
      tone: "danger",
      action: async () => {
        try {
          const data = await api<{ assets: WorkspaceAsset[] }>(`/api/workspaces/${encodeURIComponent(asset.workspaceId)}/assets/${encodeURIComponent(asset.runId)}/${asset.kind}`, { method: "DELETE" });
          setWorkspaceAssets(data.assets);
          setSelectedWorkspaceAssetId((current) => current === asset.id ? data.assets[0]?.id || null : current);
          const [runData] = await Promise.all([
            api<{ runs: Run[] }>("/api/runs"),
            refreshWorkspaces(asset.workspaceId),
          ]);
          setRuns(runData.runs);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "资产删除失败");
        }
      },
    });
  }

  async function refreshActivity(showToast = false) {
    const runId = selectedIdRef.current;
    const workspaceId = selectedWorkspaceIdRef.current || "default";
    const sessionId = dispatcherSessionIdRef.current;
    const controlParams = new URLSearchParams({ workspaceId });
    if (runId) controlParams.set("runId", runId);
    if (sessionId) controlParams.set("sessionId", sessionId);
    const [controls, notificationData, generationData, batchData] = await Promise.all([
      api<{ coordinatorMode: ApprovalMode; taskMode: ApprovalMode | null; approvals: ApprovalRequest[] }>(`/api/agent-controls?${controlParams.toString()}`),
      api<{ notifications: AppNotification[] }>("/api/notifications?limit=50"),
      api<{ generations: DispatcherGeneration[] }>(`/api/dispatcher/generations?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`),
      api<{ batches: DispatcherTaskBatch[] }>(`/api/dispatcher/task-batches?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`),
    ]);
    setCoordinatorMode(controls.coordinatorMode);
    if (controls.taskMode) setTaskAgentMode(controls.taskMode);
    setApprovals(controls.approvals);
    setNotifications(notificationData.notifications);
    if (workspaceId === selectedWorkspaceIdRef.current && sessionId === dispatcherSessionIdRef.current) {
      setDispatcherGenerations(generationData.generations);
      setDispatcherTaskBatches(batchData.batches);
    }
    const newest = notificationData.notifications[0];
    if (newest) {
      if (showToast && notificationsInitializedRef.current && newest.id > latestNotificationIdRef.current) {
        const incoming = notificationData.notifications.filter((item) => item.id > latestNotificationIdRef.current).sort((a, b) => a.id - b.id);
        setToastQueue((items) => [...items, ...incoming.filter((item) => !items.some((queued) => queued.id === item.id))]);
      }
      latestNotificationIdRef.current = Math.max(latestNotificationIdRef.current, newest.id);
    }
    notificationsInitializedRef.current = true;
  }

  useEffect(() => {
    if (!previewFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewFullscreen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [previewFullscreen]);

  useEffect(() => {
    if (!showSettings) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowSettings(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showSettings]);

  useEffect(() => {
    if (revertStage === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRevertStage(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [revertStage]);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        const [runData, workspaceData, settingsData] = await Promise.all([
          api<{ runs: Run[] }>("/api/runs"),
          api<{ workspaces: Workspace[] }>("/api/workspaces"),
          api<AppSettings>("/api/settings"),
        ]);
        if (cancelled) return;
        setRuns(runData.runs);
        setWorkspaces(workspaceData.workspaces);
        const requestedRun = initialRunId ? runData.runs.find((item) => item.id === initialRunId) : null;
        const requestedWorkspace = requestedWorkspaceId
          ? workspaceData.workspaces.find((item) => item.id === requestedWorkspaceId)
          : null;
        const nextWorkspaceId = requestedRun?.workspaceId
          || requestedWorkspace?.id
          || workspaceData.workspaces.find((item) => item.id === "default")?.id
          || workspaceData.workspaces[0]?.id
          || "default";
        const nextRunId = requestedRun?.id || runData.runs[0]?.id || null;
        selectedWorkspaceIdRef.current = nextWorkspaceId;
        selectedIdRef.current = nextRunId;
        setSelectedWorkspaceId(nextWorkspaceId);
        setSelectedId(nextRunId);
        setSettings(settingsData);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法连接本地后端");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialize();
    void api<SystemState>("/api/system?force=1")
      .then((data) => { if (!cancelled) setSystem(data); })
      .catch(() => { if (!cancelled) setSystem(null); });
    const timer = window.setInterval(() => {
      void api<SystemState>("/api/system").then(setSystem).catch(() => setSystem(null));
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [initialRunId, requestedWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    void api<ConversationPayload>(`/api/dispatcher/messages?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`)
      .then((data) => { if (!cancelled) applyDispatcherConversation(data); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "总调度对话读取失败"); });
    return () => { cancelled = true; };
  }, [selectedWorkspaceId]);

  useEffect(() => {
    void refreshActivity(false).catch(() => undefined);
  }, [selectedId, selectedWorkspaceId, dispatcherSessionId]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshActivity(true).catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toastNotification) return;
    const timer = window.setTimeout(() => setToastQueue((items) => items.slice(1)), 8000);
    return () => window.clearTimeout(timer);
  }, [toastNotification]);

  useEffect(() => {
    if (!showNotifications) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !notificationCenterRef.current?.contains(target)) setShowNotifications(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [showNotifications]);

  useEffect(() => {
    dispatcherEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [dispatcherMessages, dispatcherBusy, approvalScrollKey, dispatcherGenerationScrollKey]);

  useEffect(() => {
    if (!selectedId) return;
    const requestedRunId = selectedId;
    let cancelled = false;
    void Promise.all([
      api<RunDetail>(`/api/runs/${selectedId}`),
      api<ConversationPayload>(`/api/runs/${selectedId}/agent/messages`),
    ])
      .then(([data, agentData]) => {
        if (cancelled || selectedIdRef.current !== requestedRunId) return;
        setDetail(data);
        applyTaskConversation(agentData);
        setAgentAttachment(null);
        setViewStage(data.run.currentStage);
        setQaBlend(0.5);
        setPromptDraft({
          positivePrompt: data.run.positivePrompt || DEFAULT_POSITIVE_PROMPT,
          negativePrompt: data.run.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
        });
      })
      .catch((reason) => {
        if (!cancelled && selectedIdRef.current === requestedRunId) setError(reason instanceof Error ? reason.message : "任务读取失败");
      });
    return () => { cancelled = true; };
  }, [selectedId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages, agentBusy, agentQueue.length, approvalScrollKey]);

  const selectedDetail = detail?.run.id === selectedId ? detail : null;
  const hasRunningTask = runs.some((item) => item.jobStatus === "running");
  const selectedTaskIsRunning = runs.some((item) => item.id === selectedId && item.jobStatus === "running");
  const selectedRoleIsRunning = selectedDetail?.agentRoleRuns?.some((item) => item.status === "running") === true;
  const selectedPlanIsRunning = selectedDetail?.agentWorkflowPlan?.status === "running";
  const agentOperationalBusy = agentBusy || selectedRoleIsRunning || selectedPlanIsRunning;

  useEffect(() => {
    if (!hasRunningTask && !selectedRoleIsRunning && !selectedPlanIsRunning) return;
    const timer = window.setInterval(() => {
      const requestedRunId = selectedId;
      const shouldRefreshSelected = selectedId && (selectedTaskIsRunning || selectedRoleIsRunning || selectedPlanIsRunning);
      const detailRequest = shouldRefreshSelected
        ? api<RunDetail>(`/api/runs/${selectedId}`)
        : Promise.resolve(null);
      const messagesRequest = shouldRefreshSelected
        ? api<ConversationPayload>(`/api/runs/${selectedId}/agent/messages`)
        : Promise.resolve(null);
      void Promise.all([api<{ runs: Run[] }>("/api/runs"), detailRequest, messagesRequest])
        .then(([runData, detailData, messagesData]) => {
          setRuns(runData.runs);
          if (requestedRunId !== selectedIdRef.current) return;
          if (messagesData) applyTaskConversation(messagesData);
          if (!detailData) return;
          setDetail(detailData);
          setViewStage(detailData.run.currentStage);
        })
        .catch((reason) => setError(reason instanceof Error ? reason.message : "DGX 状态读取失败"));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningTask, selectedId, selectedPlanIsRunning, selectedRoleIsRunning, selectedTaskIsRunning]);

  const run = selectedDetail?.run || runs.find((item) => item.id === selectedId) || null;
  const coordinatorApprovals = approvals.filter((item) => (
    item.scopeType === "coordinator"
    && item.workspaceId === selectedWorkspaceId
    && item.sessionId === dispatcherSessionId
  ));
  const taskApprovals = approvals.filter((item) => item.scopeType === "task" && item.runId === run?.id);
  const dispatcherTimeline = buildDispatcherTimeline(dispatcherMessages, dispatcherGenerations, coordinatorApprovals, dispatcherTaskBatches);
  const unreadNotificationCount = notifications.filter((item) => !item.readAt).length;

  useEffect(() => {
    if (screen !== "home" || notificationFocusId === null) return;
    const notification = notifications.find((item) => item.id === notificationFocusId);
    if (!notification) return;
    if (notification.workspaceId && notification.workspaceId !== selectedWorkspaceId) {
      const workspaceId = notification.workspaceId;
      const workspaceFrame = window.requestAnimationFrame(() => {
        selectedWorkspaceIdRef.current = workspaceId;
        setSelectedWorkspaceId(workspaceId);
        clearDispatcherConversation();
      });
      return () => window.cancelAnimationFrame(workspaceFrame);
    }
    const frame = window.requestAnimationFrame(() => {
      let target: HTMLElement | null = notification.approvalId
        ? document.getElementById(`dispatcher-approval-${notification.approvalId}`)
        : null;
      if (!target && (notification.kind === "generation_completed" || notification.kind === "generation_failed" || notification.kind === "approval_executed")) {
        const notificationTime = Date.parse(notification.createdAt);
        const matchingGeneration = dispatcherGenerations
          .filter((generation) => notification.message.includes(generation.title) || Math.abs(Date.parse(generation.createdAt) - notificationTime) < 120_000)
          .sort((left, right) => Math.abs(Date.parse(left.createdAt) - notificationTime) - Math.abs(Date.parse(right.createdAt) - notificationTime))[0];
        if (matchingGeneration) target = document.getElementById(`dispatcher-generation-${matchingGeneration.id}`);
      }
      target ||= dispatcherEndRef.current;
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("notification-target-highlight");
      window.setTimeout(() => target?.classList.remove("notification-target-highlight"), 2200);
      setNotificationFocusId(null);
      window.history.replaceState(null, "", "/");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dispatcherGenerations, notificationFocusId, notifications, screen, selectedWorkspaceId]);

  const visibleChatMessages = run?.id === selectedId ? chatMessages : [];
  const artDirectorRun = selectedDetail?.agentRoleRuns?.find((item) =>
    (item.reportType === "prompt_plan" || item.agentRole === "art_director")
      && (item.status !== "succeeded" || (
        item.report?.positivePrompt === run?.positivePrompt
        && item.report?.negativePrompt === run?.negativePrompt
      )),
  );
  const visualQaRun = selectedDetail?.agentRoleRuns?.find((item) =>
    (item.reportType === "image_quality_report" || item.agentRole === "visual_qa")
      && item.sourceKey === `qa:${run?.jobPromptId}`,
  );
  const characterConsistencyRun = selectedDetail?.agentRoleRuns?.find((item) =>
    (item.reportType === "character_consistency_report" || item.agentRole === "character_consistency")
      && item.sourceKey === `qa:${run?.jobPromptId}`,
  );
  const assetInspectorRun = selectedDetail?.agentRoleRuns?.find((item) => item.agentRole === "asset_inspector");
  const riggingQaRun = selectedDetail?.agentRoleRuns?.find((item) => item.agentRole === "rigging_qa");
  const exportSpecialistRun = selectedDetail?.agentRoleRuns?.find((item) => item.agentRole === "export_specialist");
  const workflowDoctorRun = selectedDetail?.agentRoleRuns?.find((item) => item.agentRole === "workflow_doctor");
  const specialistRoleRuns = [
    { run: artDirectorRun, name: "Art Director", running: "正在检查提示词", fallback: "提示词检查完成", icon: "art" },
    { run: visualQaRun, name: "Visual QA", running: "正在复核姿态、遮挡和背景", fallback: "视觉质检完成", icon: "qa" },
    { run: characterConsistencyRun, name: "Character Consistency", running: "正在检查角色身份连续性", fallback: "角色一致性检查完成", icon: "qa" },
    { run: assetInspectorRun, name: "Asset Inspector", running: "正在检查静态 GLB", fallback: "3D 资产检查完成", icon: "qa" },
    { run: riggingQaRun, name: "Rigging QA", running: "正在检查 skin、joints 与层级", fallback: "绑骨检查完成", icon: "qa" },
    { run: exportSpecialistRun, name: "Export Specialist", running: "正在检查导出就绪度", fallback: "导出检查完成", icon: "qa" },
    { run: workflowDoctorRun, name: "Workflow Doctor", running: "正在诊断工作流失败", fallback: "失败诊断完成", icon: "qa" },
  ].filter((item): item is typeof item & { run: AgentRoleRun } => Boolean(item.run));
  const current = run?.currentStage ?? 0;
  const activeStages = run?.pipelineType === "image_to_model"
    ? stages.map((item, index) => index === 0
      ? { ...item, title: "角色原画", subtitle: "单体输入", input: "拆分后的单体原画", output: "角色规格", action: "确认单体原画、角色身份、服装和 T-Pose 转换提示词。" }
      : index === 1
        ? { ...item, title: "T-Pose 图生成", subtitle: "Stepfun 图生图", input: "单体角色原画", output: "T-Pose PNG", action: "使用图生图模型保持角色身份并转换为标准 T-Pose。" }
        : item)
    : stages;
  const stage = activeStages[viewStage];
  const progress = useMemo(() => Math.round((current / (stages.length - 1)) * 100), [current]);
  const isCurrentView = viewStage === current;
  const visiblePreview = viewStage > 0 && viewStage < 3
    ? viewStage === 2 && run?.qaOverlayPath ? run.qaOverlayPath : run?.previewPath
    : null;
  const hasQaComparison = Boolean(viewStage === 2 && run?.previewPath && run.qaOverlayPath);
  const useRiggedPreview = viewStage >= 5 && run?.assets.riggedReady === true;
  const useTopologyPreview = !useRiggedPreview && viewStage >= 4 && run?.assets.topologyReady === true;
  const modelPreviewUrl = viewStage >= 3 && run?.assets.modelReady
    ? downloadUrl(useRiggedPreview
      ? run.assets.riggedDownloadUrl
      : useTopologyPreview ? run.assets.topologyDownloadUrl : run.assets.modelDownloadUrl)
    : null;
  const hasPreview = Boolean(viewStage === 0 || visiblePreview || modelPreviewUrl);
  const currentStageReady = Boolean(
    (current === 1 && run?.assets.imageReady)
      || (current === 2 && run?.qaStatus === "passed")
      || (current === 3 && run?.assets.modelReady)
      || (current === 4 && run?.assets.topologyReady)
      || (current === 5 && run?.assets.riggedReady)
      || (current === 6 && run?.status === "completed"),
  );
  const hasPreviewFooter = Boolean(
    isCurrentView
      || (viewStage === 1 && run?.assets.imageReady)
      || (viewStage === 2 && run?.qaScore !== null)
      || (viewStage >= 3 && run?.assets.modelReady),
  );

  async function runAction(path: string, fallback: string, payload?: Record<string, unknown>) {
    if (!run || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await api<RunDetail>(`/api/runs/${run.id}/${path}`, {
        method: "POST",
        body: payload ? JSON.stringify(payload) : undefined,
      });
      setDetail(data);
      setViewStage(data.run.currentStage);
      setPromptDraft({
        positivePrompt: data.run.positivePrompt || DEFAULT_POSITIVE_PROMPT,
        negativePrompt: data.run.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
      });
      await refreshRuns(run.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  function resetRun() {
    if (!run || busy) return;
    setUiConfirmation({
      title: `重置“${run.name}”？`,
      description: "这会清除当前任务的产物引用和流程进度，任务本身及聊天记录会保留。",
      confirmLabel: "确认重置",
      tone: "warning",
      action: () => runAction("reset", "重置失败"),
    });
  }

  function deleteRun() {
    if (!run || busy) return;
    const runId = run.id;
    const runName = run.name;
    setUiConfirmation({
      title: `删除“${runName}”？`,
      description: "任务、流程进度、Agent 对话和历史记录都会被永久删除。",
      confirmLabel: "确认删除",
      tone: "danger",
      action: async () => {
        setBusy(true);
        try {
          await api(`/api/runs/${runId}`, { method: "DELETE" });
          selectRun(null);
          setDetail(null);
          clearTaskConversation();
          await refreshRuns();
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "删除失败");
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function confirmUiAction() {
    if (!uiConfirmation || uiConfirmationBusy) return;
    const action = uiConfirmation.action;
    setUiConfirmationBusy(true);
    try {
      await action();
      setUiConfirmation(null);
    } finally {
      setUiConfirmationBusy(false);
    }
  }

  function revertToStage(stageIndex: number) {
    if (!run || busy || run.jobStatus === "running") return;
    setRevertStage(stageIndex);
  }

  async function confirmRevert() {
    if (!run || busy || run.jobStatus === "running" || revertStage === null) return;
    const stageIndex = revertStage;
    setRevertStage(null);
    setBusy(true);
    setError("");
    try {
      const data = await api<RunDetail>(`/api/runs/${run.id}/revert`, {
        method: "POST",
        body: JSON.stringify({ stage: stageIndex }),
      });
      setDetail(data);
      setViewStage(stageIndex);
      setPromptDraft({
        positivePrompt: data.run.positivePrompt || DEFAULT_POSITIVE_PROMPT,
        negativePrompt: data.run.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
      });
      await refreshRuns(run.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "流程回退失败");
    } finally {
      setBusy(false);
    }
  }

  async function createRun(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<RunDetail>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          workspaceId: form.workspaceId,
          pipelineType: form.pipelineType,
          sourceImage: taskSourceImage ? {
            name: taskSourceImage.name,
            mimeType: taskSourceImage.mimeType,
            data: taskSourceImage.data,
          } : undefined,
          requireSourceImage: form.pipelineType === "image_to_model",
        }),
      });
      setShowCreate(false);
      setForm({ name: "", workspaceId: form.workspaceId, pipelineType: "text_to_model" });
      setTaskSourceImage(null);
      setPromptDraft({
        positivePrompt: data.run.positivePrompt || DEFAULT_POSITIVE_PROMPT,
        negativePrompt: data.run.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
      });
      setDetail(data);
      setViewStage(0);
      openTask(data.run.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const workspace = await api<Workspace>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(workspaceForm),
      });
      setWorkspaceForm({ name: "", description: "" });
      setShowWorkspaceCreate(false);
      selectWorkspace(workspace.id);
      setForm((current) => ({ ...current, workspaceId: workspace.id }));
      await refreshWorkspaces(workspace.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "工作空间创建失败");
    } finally {
      setBusy(false);
    }
  }

  function workflowReady(kind: "2d" | "qa" | "3d" | "rig") {
    return system?.comfyui.workflows?.[kind]?.ready === true;
  }

  function downloadUrl(value: string | null) {
    return value ? `${API_BASE}${value}` : "#";
  }

  function toggleTheme() {
    setTheme((currentTheme) => {
      const nextTheme = currentTheme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = nextTheme;
      window.localStorage.setItem("sim-theme", nextTheme);
      return nextTheme;
    });
  }

  async function openSettings() {
    setShowSettings(true);
    setSettingsLoading(true);
    setWorkflowPreviewOpen(false);
    setError("");
    try {
      const data = await api<AppSettings>("/api/settings");
      setSettings(data);
      setSettingsForm(settingsDraft(data));
      setAgentModels([{ id: data.agent.model, name: data.agent.model }]);
      setCoordinatorModels([{ id: data.coordinator.agent.model, name: data.coordinator.agent.model }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "配置读取失败");
      setShowSettings(false);
    } finally {
      setSettingsLoading(false);
    }
  }

  function updateProcessSettings(kind: ProcessKind, patch: Partial<SettingsDraft["processes"][ProcessKind]>) {
    setSettingsForm((current) => current ? {
      ...current,
      processes: {
        ...current.processes,
        [kind]: { ...current.processes[kind], ...patch },
      },
    } : current);
  }

  function updateAgentApiSettings(scope: "agent" | "coordinator", patch: Partial<AgentApiDraft>) {
    setSettingsForm((current) => {
      if (!current) return current;
      if (scope === "coordinator") return {
        ...current,
        coordinator: { ...current.coordinator, agent: { ...current.coordinator.agent, ...patch } },
      };
      return { ...current, agent: { ...current.agent, ...patch } };
    });
  }

  function updateTopologySettings(patch: Partial<TopologyApiDraft>) {
    setSettingsForm((current) => current ? { ...current, topology: { ...current.topology, ...patch } } : current);
  }

  function restoreTopologyDefaults() {
    if (!settings) return;
    updateTopologySettings({
      url: settings.topology.defaultUrl,
      token: "",
      clearToken: false,
      targetQuads: settings.topology.defaultTargetQuads,
      timeoutSeconds: settings.topology.defaultTimeoutSeconds,
    });
  }

  function updateImageModelSettings(scope: "agent" | "coordinator", key: "textToImage" | "imageToImage", patch: Partial<ImageModelDraft>) {
    setSettingsForm((current) => {
      if (!current) return current;
      if (scope === "coordinator") return {
        ...current,
        coordinator: {
          ...current.coordinator,
          imageModels: { ...current.coordinator.imageModels, [key]: { ...current.coordinator.imageModels[key], ...patch } },
        },
      };
      return { ...current, imageModels: { ...current.imageModels, [key]: { ...current.imageModels[key], ...patch } } };
    });
  }

  function restoreProcessDefaults(kind: ProcessKind) {
    if (!settings) return;
    updateProcessSettings(kind, {
      mode: settings.processes[kind].defaultMode || "comfyui",
      url: settings.processes[kind].defaultUrl,
      activeWorkflowId: settings.processes[kind].defaultWorkflowId,
      workflowJson: JSON.stringify(settings.processes[kind].defaultWorkflow, null, 2),
      ...(settings.processes[kind].api ? {
        api: {
          baseUrl: settings.processes[kind].api.defaultBaseUrl,
          model: settings.processes[kind].api.defaultModel,
          apiKey: "",
        },
      } : {}),
    });
    setWorkflowPreviewOpen(false);
  }

  async function selectWorkflow(kind: ProcessKind, workflowId: string) {
    if (!settingsForm || settingsSaving) return;
    setError("");
    try {
      const workflow = await api<{ workflow: Record<string, unknown> }>(`/api/settings/workflows/${kind}/${encodeURIComponent(workflowId)}`);
      updateProcessSettings(kind, {
        activeWorkflowId: workflowId,
        workflowJson: JSON.stringify(workflow.workflow, null, 2),
      });
      setWorkflowPreviewOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "工作流读取失败");
    }
  }

  function validateWorkflowFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".json")) throw new Error(`${file.name} 不是 JSON 文件`);
    if (file.size > 500_000) throw new Error(`${file.name} 不能超过 500 KB`);
  }

  async function uploadWorkflowFiles(kind: ProcessKind, files: File[]) {
    if (!files.length || !settingsForm || settingsSaving) return;
    setError("");
    try {
      let latestSettings: AppSettings | null = null;
      let latestId = "";
      let latestGraph: Record<string, unknown> | null = null;
      for (const file of files) {
        validateWorkflowFile(file);
        const graph = JSON.parse(await file.text()) as Record<string, unknown>;
        if (!graph || Array.isArray(graph) || typeof graph !== "object") throw new Error(`${file.name} 必须是 JSON 对象`);
        const result = await api<{ settings: AppSettings; uploaded: WorkflowMetadata }>(`/api/settings/workflows/${kind}`, {
          method: "POST",
          body: JSON.stringify({ name: file.name, workflow: graph }),
        });
        latestSettings = result.settings;
        latestId = result.uploaded.id;
        latestGraph = graph;
      }
      if (!latestSettings || !latestGraph) return;
      setSettings(latestSettings);
      updateProcessSettings(kind, {
        activeWorkflowId: latestId,
        workflowJson: JSON.stringify(latestGraph, null, 2),
      });
      setWorkflowPreviewOpen(false);
      setSystem(await api<SystemState>("/api/system?force=1"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "工作流上传失败");
    }
  }

  function handleWorkflowFiles(kind: ProcessKind, fileList: FileList | File[]) {
    const files = Array.from(fileList);
    const jsonFiles = files.filter((file) => file.name.toLowerCase().endsWith(".json"));
    if (!jsonFiles.length) {
      setError("所选位置没有 JSON 工作流文件");
      return;
    }
    void uploadWorkflowFiles(kind, jsonFiles);
  }

  function chooseWorkflowDirectory() {
    const input = workflowDirectoryRef.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.click();
  }

  function removeWorkflow(kind: ProcessKind, workflowId: string) {
    if (!settings || workflowId === settings.processes[kind].defaultWorkflowId || settingsSaving) return;
    const workflow = settings.processes[kind].workflows.find((item) => item.id === workflowId);
    if (!workflow) return;
    setUiConfirmation({
      title: `删除“${workflow.name}”？`,
      description: "这个自定义工作流版本会被永久移除；内置默认工作流不会受到影响。",
      confirmLabel: "删除工作流",
      tone: "danger",
      action: async () => {
        try {
          const data = await api<AppSettings>(`/api/settings/workflows/${kind}/${encodeURIComponent(workflowId)}`, { method: "DELETE" });
          setSettings(data);
          const active = data.processes[kind];
          updateProcessSettings(kind, {
            activeWorkflowId: active.activeWorkflowId,
            workflowJson: JSON.stringify(active.workflow, null, 2),
          });
          setWorkflowPreviewOpen(false);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "工作流删除失败");
        }
      },
    });
  }

  async function fetchAgentModels(scope: "agent" | "coordinator" = "agent") {
    if (!settingsForm || agentModelsLoading) return;
    setAgentModelsLoading(true);
    setError("");
    try {
      const draft = scope === "coordinator" ? settingsForm.coordinator.agent : settingsForm.agent;
      const result = await api<{ baseUrl: string; models: AgentModelOption[] }>("/api/settings/agent/models", {
        method: "POST",
        body: JSON.stringify({
          scope,
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey,
          clearApiKey: draft.clearApiKey,
        }),
      });
      const currentModel = draft.model;
      const models = result.models.some((item) => item.id === currentModel)
        ? result.models
        : [{ id: currentModel, name: `${currentModel}（当前配置）` }, ...result.models];
      if (scope === "coordinator") setCoordinatorModels(models);
      else setAgentModels(models);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型列表获取失败");
    } finally {
      setAgentModelsLoading(false);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!settingsForm || settingsSaving) return;
    const processes = {} as Record<ProcessKind, {
      mode: "comfyui" | "api";
      url: string;
      activeWorkflowId: string;
      api?: { baseUrl: string; model: string; apiKey: string };
    }>;
    try {
      for (const kind of PROCESS_KINDS) {
        JSON.parse(settingsForm.processes[kind].workflowJson);
        processes[kind] = {
          mode: settingsForm.processes[kind].mode,
          url: settingsForm.processes[kind].url,
          activeWorkflowId: settingsForm.processes[kind].activeWorkflowId,
          ...(settingsForm.processes[kind].api ? { api: settingsForm.processes[kind].api } : {}),
        };
      }
    } catch (reason) {
      setError(reason instanceof Error ? `工作流 JSON 无效：${reason.message}` : "工作流 JSON 无效");
      return;
    }
    setSettingsSaving(true);
    setError("");
    try {
      const data = await api<AppSettings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ processes, topology: settingsForm.topology, agent: settingsForm.agent, imageModels: settingsForm.imageModels, coordinator: settingsForm.coordinator }),
      });
      setSettings(data);
      setSettingsForm(settingsDraft(data));
      setSystem(await api<SystemState>("/api/system?force=1"));
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "配置保存失败");
    } finally {
      setSettingsSaving(false);
    }
  }

  function togglePreviewFullscreen() {
    setPreviewFullscreen((value) => !value);
  }

  function startAgentResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (agentCollapsed) return;
    agentDragRef.current = { startX: event.clientX, startWidth: agentWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function moveAgentResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = agentDragRef.current;
    if (!drag) return;
    const nextWidth = Math.min(560, Math.max(300, drag.startWidth + drag.startX - event.clientX));
    setAgentWidth(nextWidth);
  }

  function endAgentResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!agentDragRef.current) return;
    agentDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  function readImage(file: File, maxBytes: number, label: string, onReady: (image: AgentAttachment) => void) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError(`${label}只支持 PNG、JPEG 或 WebP`);
      return;
    }
    if (file.size > maxBytes) {
      setError(`${label}不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
      return;
    }
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const data = value.split(",", 2)[1];
      if (!data) {
        setError(`${label}读取失败`);
        return;
      }
      onReady({ name: file.name, mimeType: file.type, data, size: file.size });
    };
    reader.onerror = () => setError(`${label}读取失败`);
    reader.readAsDataURL(file);
  }

  function attachAgentImage(file: File) {
    readImage(file, 4 * 1024 * 1024, "参考图片", setAgentAttachment);
  }

  function attachDispatcherImage(file: File) {
    readImage(file, 12 * 1024 * 1024, "合集原画", setDispatcherAttachment);
  }

  function handleAgentDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    agentDropDepthRef.current += 1;
    setAgentImageDragging(true);
  }

  function handleAgentDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleAgentDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    agentDropDepthRef.current = Math.max(0, agentDropDepthRef.current - 1);
    if (agentDropDepthRef.current === 0) setAgentImageDragging(false);
  }

  function handleAgentDrop(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    agentDropDepthRef.current = 0;
    setAgentImageDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (!run) {
      setError("请先选择任务，再向 Agent 消息中拖入图片");
      return;
    }
    if (files.length !== 1) {
      setError("每条 Agent 消息只能添加一张参考图片");
      return;
    }
    attachAgentImage(files[0]);
  }

  function handleDispatcherDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dispatcherDropDepthRef.current += 1;
    setDispatcherDragging(true);
  }

  function handleDispatcherDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    dispatcherDropDepthRef.current = Math.max(0, dispatcherDropDepthRef.current - 1);
    if (dispatcherDropDepthRef.current === 0) setDispatcherDragging(false);
  }

  function handleDispatcherDrop(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dispatcherDropDepthRef.current = 0;
    setDispatcherDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      setError("每次只能上传一张合集原画");
      return;
    }
    attachDispatcherImage(files[0]);
  }

  async function sendDispatcherMessage(event: FormEvent) {
    event.preventDefault();
    const message = dispatcherInput.trim();
    if ((!message && !dispatcherAttachment) || dispatcherBusy || settings?.coordinator.agent.apiKeyConfigured === false) return;
    setDispatcherBusy(true);
    setError("");
    const optimistic: ChatMessage = {
      id: -Date.now(), role: "user", content: message || "请分析这张角色合集原画并拆分任务。",
      attachmentName: dispatcherAttachment?.name || null,
      attachmentMime: dispatcherAttachment?.mimeType || null,
      createdAt: new Date().toISOString(),
    };
    setDispatcherMessages((items) => [...items, optimistic]);
    const attachment = dispatcherAttachment;
    setDispatcherInput("");
    setDispatcherAttachment(null);
    try {
      const data = await api<ConversationPayload & { workspaces: Workspace[] }>("/api/dispatcher/messages", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: selectedWorkspaceId,
          message,
          image: attachment ? { name: attachment.name, mimeType: attachment.mimeType, data: attachment.data } : undefined,
        }),
      });
      applyDispatcherConversation(data);
      setWorkspaces(data.workspaces);
      const runData = await api<{ runs: Run[] }>("/api/runs");
      setRuns(runData.runs);
      await refreshActivity(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "总调度 Agent 请求失败");
      try {
        const history = await api<ConversationPayload>(`/api/dispatcher/messages?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`);
        applyDispatcherConversation(history);
      } catch {
        setDispatcherMessages((items) => items.filter((item) => item.id !== optimistic.id));
      }
    } finally {
      setDispatcherBusy(false);
    }
  }

  async function cancelDispatcher() {
    if (!dispatcherBusy) return;
    try {
      await api("/api/dispatcher/cancel", { method: "POST" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "取消总调度 Agent 失败");
    }
  }

  async function startDispatcherSession() {
    if (dispatcherBusy || dispatcherSessionBusy || !selectedWorkspaceId) return;
    setDispatcherSessionBusy(true);
    setError("");
    setDispatcherMessages([]);
    setDispatcherGenerations([]);
    setDispatcherTaskBatches([]);
    setDispatcherContext(null);
    dispatcherSessionIdRef.current = "";
    setDispatcherSessionId("");
    try {
      const data = await api<ConversationPayload>("/api/dispatcher/sessions", {
        method: "POST",
        body: JSON.stringify({ workspaceId: selectedWorkspaceId }),
      });
      applyDispatcherConversation(data);
      setDispatcherInput("");
      setDispatcherAttachment(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新建总调度会话失败");
      try {
        const history = await api<ConversationPayload>(`/api/dispatcher/messages?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`);
        applyDispatcherConversation(history);
      } catch {
        // Keep the cleared state when the current conversation cannot be restored.
      }
    } finally {
      setDispatcherSessionBusy(false);
    }
  }

  async function activateDispatcherSession(sessionId: string) {
    if (sessionId === dispatcherSessionId || dispatcherBusy || dispatcherSessionBusy) return;
    setDispatcherSessionBusy(true);
    setError("");
    setDispatcherMessages([]);
    setDispatcherGenerations([]);
    setDispatcherTaskBatches([]);
    setDispatcherContext(null);
    dispatcherSessionIdRef.current = "";
    setDispatcherSessionId("");
    try {
      const data = await api<ConversationPayload>("/api/dispatcher/sessions/current", {
        method: "PUT",
        body: JSON.stringify({ workspaceId: selectedWorkspaceId, sessionId }),
      });
      applyDispatcherConversation(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "切换总调度会话失败");
      try {
        const history = await api<ConversationPayload>(`/api/dispatcher/messages?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`);
        applyDispatcherConversation(history);
      } catch {
        // Keep the cleared state when the current conversation cannot be restored.
      }
    } finally {
      setDispatcherSessionBusy(false);
    }
  }

  function requestDeleteDispatcherSession(session: ConversationSession) {
    if (dispatcherBusy || dispatcherSessionBusy || !selectedWorkspaceId) return;
    const workspaceId = selectedWorkspaceId;
    const deletingCurrent = session.id === dispatcherSessionId;
    setUiConfirmation({
      title: `删除“${session.title}”？`,
      description: "该会话的消息和总调度时间线会被永久删除；工作空间、已经创建的角色任务和模型资产不会被删除。",
      confirmLabel: "删除会话",
      tone: "danger",
      action: async () => {
        setDispatcherSessionBusy(true);
        setError("");
        try {
          const data = await api<ConversationPayload>(`/api/dispatcher/sessions/${encodeURIComponent(session.id)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
          if (selectedWorkspaceIdRef.current !== workspaceId) return;
          applyDispatcherConversation(data);
          if (deletingCurrent) {
            setDispatcherInput("");
            setDispatcherAttachment(null);
          }
          await refreshActivity(false);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "删除总调度会话失败");
        } finally {
          setDispatcherSessionBusy(false);
        }
      },
    });
  }

  async function changeAgentMode(scopeType: "coordinator" | "task", mode: ApprovalMode) {
    if (scopeType === "task" && !selectedIdRef.current) return;
    setError("");
    try {
      await api("/api/agent-controls", {
        method: "PUT",
        body: JSON.stringify({ scopeType, runId: scopeType === "task" ? selectedIdRef.current : undefined, mode }),
      });
      if (scopeType === "coordinator") setCoordinatorMode(mode);
      else setTaskAgentMode(mode);
      await refreshActivity(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent 权限模式更新失败");
    }
  }

  async function resolveApproval(id: number, decision: "approve" | "reject") {
    if (approvalBusyId !== null) return;
    setApprovalBusyId(id);
    setError("");
    try {
      await api(`/api/approvals/${id}/${decision}`, { method: "POST" });
      const [runData, workspaceData] = await Promise.all([
        api<{ runs: Run[] }>("/api/runs"),
        api<{ workspaces: Workspace[] }>("/api/workspaces"),
      ]);
      setRuns(runData.runs);
      setWorkspaces(workspaceData.workspaces);
      const currentRunId = selectedIdRef.current;
      if (currentRunId && runData.runs.some((item) => item.id === currentRunId)) {
        const detailData = await api<RunDetail>(`/api/runs/${currentRunId}`);
        if (selectedIdRef.current === currentRunId) setDetail(detailData);
      }
      await refreshActivity(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : decision === "approve" ? "审批执行失败" : "拒绝审批失败");
      await refreshActivity(false).catch(() => undefined);
    } finally {
      setApprovalBusyId(null);
    }
  }

  async function viewNotification(notification: AppNotification) {
    setShowNotifications(false);
    setToastQueue((items) => items.filter((item) => item.id !== notification.id));
    if (!notification.readAt) {
      try {
        await api(`/api/notifications/${notification.id}/read`, { method: "POST" });
        setNotifications((items) => items.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item));
      } catch {
        // Navigation should not be blocked when the read marker fails.
      }
    }
    if (notification.runId) {
      openTask(notification.runId);
      return;
    }
    if (notification.workspaceId) {
      const params = new URLSearchParams({ workspace: notification.workspaceId, notification: String(notification.id) });
      window.location.assign(`/?${params.toString()}`);
      return;
    }
    openHome();
  }

  async function markAllNotificationsRead() {
    if (notificationAction !== null || !notifications.some((item) => !item.readAt)) return;
    setNotificationAction("read-all");
    try {
      const result = await api<{ readAt: string }>("/api/notifications/read-all", { method: "POST" });
      setNotifications((items) => items.map((item) => item.readAt ? item : { ...item, readAt: result.readAt }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "通知全部已读失败");
    } finally {
      setNotificationAction(null);
    }
  }

  async function clearAllNotifications() {
    if (notificationAction !== null || notifications.length === 0) return;
    setNotificationAction("clear");
    try {
      await api("/api/notifications", { method: "DELETE" });
      setNotifications([]);
      setToastQueue([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "清空通知失败");
    } finally {
      setNotificationAction(null);
    }
  }

  async function deleteNotification(notificationId: number) {
    if (notificationAction !== null) return;
    setNotificationAction(notificationId);
    try {
      await api(`/api/notifications/${notificationId}`, { method: "DELETE" });
      setNotifications((items) => items.filter((item) => item.id !== notificationId));
      setToastQueue((items) => items.filter((item) => item.id !== notificationId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除通知失败");
    } finally {
      setNotificationAction(null);
    }
  }

  function replaceAgentQueue(items: AgentQueueItem[]) {
    agentQueueRef.current = items;
    setAgentQueue(items);
  }

  function removeQueuedAgentMessage(id: number) {
    replaceAgentQueue(agentQueueRef.current.filter((item) => item.id !== id));
  }

  async function processNextAgentMessage() {
    if (agentProcessingRef.current) return;
    const item = agentQueueRef.current[0];
    if (!item) return;

    replaceAgentQueue(agentQueueRef.current.slice(1));
    agentProcessingRef.current = true;
    setAgentBusy(true);
    setActiveAgentRunId(item.runId);
    setError("");

    const optimisticMessage: ChatMessage = {
      id: -item.id,
      role: "user",
      content: item.message || "请分析这张参考图片并完善角色设定。",
      attachmentName: item.attachment?.name || null,
      attachmentMime: item.attachment?.mimeType || null,
      createdAt: new Date().toISOString(),
    };
    if (selectedIdRef.current === item.runId) {
      setChatMessages((messages) => [...messages, optimisticMessage]);
    }

    try {
      const data = await api<ConversationPayload & { detail: RunDetail }>(`/api/runs/${item.runId}/agent/messages`, {
        method: "POST",
        body: JSON.stringify({
          message: item.message,
          image: item.attachment ? { name: item.attachment.name, mimeType: item.attachment.mimeType, data: item.attachment.data } : undefined,
        }),
      });
      if (selectedIdRef.current === item.runId) {
        applyTaskConversation(data);
        setDetail(data.detail);
        setViewStage(data.detail.run.currentStage);
        setPromptDraft({
          positivePrompt: data.detail.run.positivePrompt || DEFAULT_POSITIVE_PROMPT,
          negativePrompt: data.detail.run.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
        });
      }
      void api<{ runs: Run[] }>("/api/runs").then((runData) => setRuns(runData.runs)).catch(() => undefined);
      await refreshActivity(true);
    } catch (reason) {
      setError(`${item.runName}：${reason instanceof Error ? reason.message : "Agent 请求失败"}`);
      if (selectedIdRef.current === item.runId) {
        try {
          const history = await api<ConversationPayload>(`/api/runs/${item.runId}/agent/messages`);
          if (selectedIdRef.current === item.runId) applyTaskConversation(history);
        } catch {
          setChatMessages((messages) => messages.filter((message) => message.id !== optimisticMessage.id));
        }
      }
    } finally {
      agentProcessingRef.current = false;
      if (agentQueueRef.current.length > 0) {
        void processNextAgentMessage();
      } else {
        setAgentBusy(false);
        setActiveAgentRunId(null);
      }
    }
  }

  async function cancelAgent() {
    if (!activeAgentRunId || !agentBusy) return;
    try {
      await api(`/api/runs/${activeAgentRunId}/agent/cancel`, { method: "POST" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "取消 Agent 失败");
    }
  }

  async function startTaskSession() {
    const runId = selectedIdRef.current;
    if (!runId || agentBusy || agentQueue.length || chatSessionBusy) return;
    setChatSessionBusy(true);
    setError("");
    try {
      const data = await api<ConversationPayload>(`/api/runs/${runId}/agent/sessions`, { method: "POST" });
      if (selectedIdRef.current === runId) {
        applyTaskConversation(data);
        setChatInput("");
        setAgentAttachment(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新建任务 Agent 会话失败");
    } finally {
      setChatSessionBusy(false);
    }
  }

  async function activateTaskSession(sessionId: string) {
    const runId = selectedIdRef.current;
    if (!runId || sessionId === chatSessionId || agentBusy || agentQueue.length || chatSessionBusy) return;
    setChatSessionBusy(true);
    setError("");
    try {
      const data = await api<ConversationPayload>(`/api/runs/${runId}/agent/sessions/current`, {
        method: "PUT",
        body: JSON.stringify({ sessionId }),
      });
      if (selectedIdRef.current === runId) applyTaskConversation(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "切换任务 Agent 会话失败");
    } finally {
      setChatSessionBusy(false);
    }
  }

  function requestDeleteTaskSession(session: ConversationSession) {
    const runId = selectedIdRef.current;
    if (!runId || agentBusy || agentQueue.length || chatSessionBusy) return;
    const deletingCurrent = session.id === chatSessionId;
    setUiConfirmation({
      title: `删除“${session.title}”？`,
      description: "该会话中的用户消息和 Agent 回复会被永久删除；角色任务、流程进度、质检记录和模型资产不会被删除。",
      confirmLabel: "删除会话",
      tone: "danger",
      action: async () => {
        setChatSessionBusy(true);
        setError("");
        try {
          const data = await api<ConversationPayload>(`/api/runs/${runId}/agent/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
          if (selectedIdRef.current !== runId) return;
          applyTaskConversation(data);
          if (deletingCurrent) {
            setChatInput("");
            setAgentAttachment(null);
          }
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "删除任务 Agent 会话失败");
        } finally {
          setChatSessionBusy(false);
        }
      },
    });
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function sendChatMessage(event: FormEvent) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!run || (!message && !agentAttachment) || system?.agent.configured === false) return;
    if (agentQueueRef.current.length >= MAX_AGENT_QUEUE_ITEMS) {
      setError(`Agent 待发送队列最多保留 ${MAX_AGENT_QUEUE_ITEMS} 条消息`);
      return;
    }
    const queueItem: AgentQueueItem = {
      id: ++agentQueueIdRef.current,
      runId: run.id,
      runName: run.name,
      message,
      attachment: agentAttachment,
    };
    replaceAgentQueue([...agentQueueRef.current, queueItem]);
    setChatInput("");
    setAgentAttachment(null);
    void processNextAgentMessage();
  }

  const previewType = modelPreviewUrl
    ? useRiggedPreview ? "绑骨 GLB" : useTopologyPreview ? "拓扑 GLB" : "静态 GLB"
    : viewStage === 0 ? "角色规格"
    : hasQaComparison ? "SDPose 对比"
    : viewStage === 2 && run?.qaOverlayPath ? "SDPose 覆盖图"
    : run?.previewPath ? "2D 概念图" : "等待资产";
  const selectedRunAgentBusy = agentBusy && activeAgentRunId === run?.id;
  const activeAgentRunName = runs.find((item) => item.id === activeAgentRunId)?.name;
  const selectedWorkspace = workspaces.find((item) => item.id === selectedWorkspaceId) || workspaces[0] || null;
  const assetLibraryWorkspace = workspaces.find((item) => item.id === assetLibraryWorkspaceId) || null;
  const filteredWorkspaceAssets = workspaceAssets.filter((asset) => {
    if (workspaceAssetFilter === "all") return true;
    if (workspaceAssetFilter === "2d" || workspaceAssetFilter === "3d") return asset.group === workspaceAssetFilter;
    return asset.kind === workspaceAssetFilter;
  });
  const selectedWorkspaceAsset = filteredWorkspaceAssets.find((asset) => asset.id === selectedWorkspaceAssetId)
    || filteredWorkspaceAssets[0]
    || null;
  const dgxDevice = system?.comfyui.devices?.[0] || null;
  const dgxMemoryTotal = formatMemory(dgxDevice?.vramTotal ?? dgxDevice?.torchVramTotal);
  const dgxMemoryFree = formatMemory(dgxDevice?.vramFree ?? dgxDevice?.torchVramFree);
  const dgxDeviceSummary = dgxDevice
    ? `${dgxDevice.name}${dgxMemoryTotal ? ` · GPU／统一内存 ${dgxMemoryFree || "-"} / ${dgxMemoryTotal} 可用` : ""}`
    : "尚未读取到 DGX 设备信息";

  return (
    <main
      className={`site-shell screen-${screen} ${screen === "task" && sidebarCollapsed ? "tasks-collapsed" : ""}`}
      data-screen={screen}
    >
      <header className="topbar">
        <div className="topbar-left">
          <button className="brand home-brand" type="button" onClick={openHome} title="返回首页">
            <span className="brand-mark"><Sparkles size={18} /></span>
            <span className="brand-copy"><strong>Super Idol Master</strong><small>AI Asset Studio</small></span>
          </button>
        </div>
        <div className="topbar-right">
          <div className="system-status">
            <span className="status-pill healthy"><i />API</span>
            <span className={`status-pill ${system?.comfyui.pipelineReady ? "healthy" : "unhealthy"}`} title={dgxDeviceSummary}>
              <i />DGX {system?.comfyui.online ? `${system.comfyui.latencyMs} ms` : "离线"}
            </span>
          </div>
          <div className="notification-center" ref={notificationCenterRef}>
            <button className="icon-button notification-button" type="button" onClick={() => setShowNotifications((value) => !value)} title="通知" aria-label={`通知，${unreadNotificationCount} 条未读`}>
              <Bell size={18} />{unreadNotificationCount > 0 && <span>{Math.min(99, unreadNotificationCount)}</span>}
            </button>
            {showNotifications && (
              <div className="notification-menu">
                <div className="notification-menu-header">
                  <strong>通知</strong>
                  <div className="notification-menu-actions">
                    <span>{unreadNotificationCount} 条未读</span>
                    <button type="button" disabled={notificationAction !== null || unreadNotificationCount === 0} onClick={() => void markAllNotificationsRead()}><Check size={13} />全部已读</button>
                    <button className="clear" type="button" disabled={notificationAction !== null || notifications.length === 0} onClick={() => void clearAllNotifications()}><Trash2 size={13} />清空</button>
                  </div>
                </div>
                <div className="notification-list">
                  {notifications.map((notification) => (
                    <article className={notification.readAt ? "read" : "unread"} key={notification.id}>
                      <span><Bell size={15} /></span>
                      <div><strong>{notification.title}</strong><p>{notification.message}</p><small>{formatTime(notification.createdAt)}</small></div>
                      <div className="notification-item-actions">
                        <button type="button" onClick={() => void viewNotification(notification)}>查看</button>
                        <button className="delete" type="button" disabled={notificationAction !== null} onClick={() => void deleteNotification(notification.id)} title="删除通知" aria-label={`删除通知：${notification.title}`}><Trash2 size={14} /></button>
                      </div>
                    </article>
                  ))}
                  {!notifications.length && <p className="notification-empty">暂时没有通知。</p>}
                </div>
              </div>
            )}
          </div>
          <button className="icon-button" type="button" onClick={toggleTheme} title="切换主题" aria-label="切换浅色或深色主题">
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="icon-button" type="button" onClick={() => void openSettings()} title="请求设置" aria-label="打开请求设置面板">
            <Settings size={18} />
          </button>
        </div>
      </header>

      {toastNotification && (
        <aside className={`notification-toast ${toastNotification.kind}`} role="status">
          <span><Bell size={18} /></span>
          <div><strong>{toastNotification.title}</strong><p>{toastNotification.message}</p></div>
          <button type="button" onClick={() => void viewNotification(toastNotification)}>View</button>
          <button type="button" className="toast-close" onClick={() => setToastQueue((items) => items.slice(1))} aria-label="关闭提醒"><X size={14} /></button>
        </aside>
      )}

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="关闭错误提示"><X size={17} /></button>
        </div>
      )}

      {screen === "home" ? (
        <section className="home-frame">
          <nav className="workspace-sidebar" aria-label="工作空间列表">
            <div className="workspace-sidebar-header">
              <div><span>工作空间</span><strong>{workspaces.length} 个空间</strong></div>
              <button className="icon-button accent" type="button" onClick={() => setShowWorkspaceCreate(true)} title="新建工作空间" aria-label="新建工作空间"><Plus size={18} /></button>
            </div>
            <div className="workspace-list">
              {workspaces.map((workspace) => (
                <div className={`workspace-group ${workspace.id === selectedWorkspaceId ? "selected" : ""} ${expandedWorkspaceIds.has(workspace.id) ? "expanded" : ""}`} key={workspace.id}>
                  <div className="workspace-item">
                    <button type="button" className="workspace-select-button" onClick={() => {
                      selectWorkspace(workspace.id);
                      setForm((current) => ({ ...current, workspaceId: workspace.id }));
                    }} aria-pressed={workspace.id === selectedWorkspaceId}>
                      <span className="workspace-icon"><FolderOpen size={17} /></span>
                      <span><strong>{workspace.name}</strong><small>{workspace.taskCount} 个任务 · {workspace.runningCount} 个运行中</small></span>
                    </button>
                    <button
                      type="button"
                      className="workspace-library-button"
                      onClick={() => {
                        selectWorkspace(workspace.id);
                        void openAssetLibrary(workspace.id);
                      }}
                      title={`打开 ${workspace.name} 的资产库`}
                      aria-label={`打开 ${workspace.name} 的资产库`}
                    >
                      <Library size={15} />
                    </button>
                    <button
                      type="button"
                      className="workspace-toggle-button"
                      onClick={() => toggleWorkspace(workspace.id)}
                      aria-expanded={expandedWorkspaceIds.has(workspace.id)}
                      aria-controls={`workspace-tasks-${workspace.id}`}
                      aria-label={`${expandedWorkspaceIds.has(workspace.id) ? "折叠" : "展开"}工作空间：${workspace.name}`}
                      title={expandedWorkspaceIds.has(workspace.id) ? "折叠工作空间" : "展开工作空间"}
                    >
                      <ChevronRight className="workspace-chevron" size={15} />
                    </button>
                  </div>
                  <div className="workspace-task-region" id={`workspace-tasks-${workspace.id}`} aria-hidden={!expandedWorkspaceIds.has(workspace.id)}>
                    <div className="workspace-task-list">
                      {runs.filter((item) => item.workspaceId === workspace.id).map((item) => (
                        <button type="button" key={item.id} onClick={() => openTask(item.id)}>
                          <span>{item.name.slice(0, 1).toUpperCase()}</span>
                          <div><strong>{item.name}</strong><small>{item.pipelineType === "image_to_model" ? "图生模型" : "文生模型"} · {stages[item.currentStage].title}</small></div>
                          {item.jobStatus === "running" && <LoaderCircle className="spinning" size={14} />}
                        </button>
                      ))}
                      {!runs.some((item) => item.workspaceId === workspace.id) && <p>该工作空间还没有任务。</p>}
                      <button type="button" className="workspace-new-task" onClick={() => {
                        setForm({ name: "", workspaceId: workspace.id, pipelineType: "text_to_model" });
                        setShowCreate(true);
                      }}><Plus size={14} />新建任务</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </nav>

          <section
            className={`dispatcher-panel ${dispatcherDragging ? "dragging" : ""}`}
            onDragEnter={handleDispatcherDragEnter}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
            onDragLeave={handleDispatcherDragLeave}
            onDrop={handleDispatcherDrop}
          >
            <header className="dispatcher-header">
              <div className="dispatcher-title"><span><Bot size={22} /></span><div><small>总调度中心</small><h1>{selectedWorkspace?.name || "创建工作空间后开始调度"}</h1></div></div>
              <div className="dispatcher-actions">
                <button className="secondary-button" type="button" disabled={!selectedWorkspace} onClick={() => { if (selectedWorkspace) void openAssetLibrary(selectedWorkspace.id); }}><Library size={16} />资产库</button>
                <button className="secondary-button" type="button" onClick={() => { setForm({ name: "", workspaceId: selectedWorkspaceId, pipelineType: "text_to_model" }); setShowCreate(true); }}><Plus size={16} />新建任务</button>
                <button className="secondary-button" type="button" onClick={() => { setSettingsTab("coordinator"); void openSettings(); }}><Settings size={16} />模型配置</button>
              </div>
            </header>

            <div className="dispatcher-models">
              <button type="button" className={settings?.coordinator.imageModels.textToImage.apiKeyConfigured ? "configured" : "missing"} onClick={() => { setSettingsTab("coordinator"); void openSettings(); }}><Sparkles size={16} /><span><small>文生图 API</small><strong>{settings?.coordinator.imageModels.textToImage.model || "未读取"}</strong></span><em>{settings?.coordinator.imageModels.textToImage.apiKeyConfigured ? "已配置" : "待配置"}</em></button>
              <button type="button" className={settings?.coordinator.imageModels.imageToImage.apiKeyConfigured ? "configured" : "missing"} onClick={() => { setSettingsTab("coordinator"); void openSettings(); }}><ImageIcon size={16} /><span><small>图生图 API</small><strong>{settings?.coordinator.imageModels.imageToImage.model || "未读取"}</strong></span><em>{settings?.coordinator.imageModels.imageToImage.apiKeyConfigured ? "已配置" : "待配置"}</em></button>
              <button type="button" className={settings?.coordinator.agent.apiKeyConfigured ? "configured" : "missing"} onClick={() => { setSettingsTab("coordinator"); void openSettings(); }}><Bot size={16} /><span><small>调度模型</small><strong>{settings?.coordinator.agent.model || "未读取"}</strong></span><em>{settings?.coordinator.agent.apiKeyConfigured ? "已配置" : "待配置"}</em></button>
            </div>

            <div className="dispatcher-thread">
              <div className="dispatcher-thread-content">
                {!dispatcherTimeline.length && (
                  <div className="dispatcher-welcome"><span><ImageIcon size={28} /></span><h2>从一个目标开始整个角色项目</h2><p>可以先生成一张包含多个角色的合集原画，也可以创建多个独立任务，或上传已有合集原画再拆分。总调度 Agent 会根据你的目标选择单图生成或任务编排。</p><div><button type="button" onClick={() => setDispatcherInput("创建一张角色原画合集图，里面有 3 个同样风格但身份、服装和配色不同的角色")}>生成合集图</button><button type="button" onClick={() => setDispatcherInput("在当前工作空间创建 3 个不同风格的角色任务，并分别生成到 3D 模型")}>批量创建角色</button><button type="button" onClick={() => dispatcherFileRef.current?.click()}>上传并拆分</button></div></div>
                )}
                {dispatcherTimeline.map((entry) => {
                  if (entry.kind === "generation") {
                    const generation = entry.item;
                    return (
                      <div className="dispatcher-timeline-card-row" key={`generation-${generation.id}`}>
                        <section className={`dispatcher-generation ${generation.status}`} id={`dispatcher-generation-${generation.id}`}>
                          <header><span><ImageIcon size={16} /></span><div><strong>{generation.title}</strong><small>单张合集图 · {generation.characterCount} 个角色</small></div><em>{generation.status === "running" ? <><LoaderCircle className="spinning" size={13} />生成中</> : generation.status === "succeeded" ? "已完成" : "失败"}</em></header>
                          {generation.previewPath && <Image src={generation.previewPath} alt={generation.title} width={1024} height={1024} unoptimized />}
                          <p>{generation.message}</p>
                          <details><summary>查看生成要求</summary><p>{generation.prompt}</p></details>
                        </section>
                      </div>
                    );
                  }
                  if (entry.kind === "approval") {
                    const approval = entry.item;
                    return (
                      <div className="dispatcher-timeline-card-row" key={`approval-${approval.id}`}>
                        <section className="approval-card" id={`dispatcher-approval-${approval.id}`}>
                          <span><ShieldCheck size={18} /></span>
                          <div><small>总调度 Agent 请求批准</small><strong>{approval.title}</strong><p>{approval.description}</p></div>
                          <div className="approval-actions"><button type="button" className="secondary-button" disabled={approvalBusyId !== null} onClick={() => void resolveApproval(approval.id, "reject")}>拒绝</button><button type="button" className="primary-button" disabled={approvalBusyId !== null} onClick={() => void resolveApproval(approval.id, "approve")}>{approvalBusyId === approval.id ? <LoaderCircle className="spinning" size={15} /> : <Check size={15} />}批准</button></div>
                        </section>
                      </div>
                    );
                  }
                  if (entry.kind === "taskBatch") {
                    const batch = entry.item;
                    const targetLabel = batch.target === "concept_image" ? "概念图" : batch.target === "validated_tpose" ? "T-Pose 检查" : batch.target === "model" ? "静态 3D 模型" : batch.target === "retopologized_model" ? "自动拓扑" : batch.target === "rigged_model" ? "自动绑骨" : "资产导出";
                    return (
                      <div className="dispatcher-timeline-card-row" key={`task-batch-${batch.id}`}>
                        <section className="dispatcher-task-batch">
                          <header><span><Box size={16} /></span><div><strong>角色拆分结果</strong><small>{batch.tasks.length} 个独立任务 · 目标：{targetLabel}</small></div></header>
                          <div className="dispatcher-task-grid">
                            {batch.tasks.map((task) => {
                              const preview = task.sourcePreviewPath || task.previewPath;
                              const status = task.jobStatus === "running" ? `${task.jobProgress}%` : task.status === "completed" ? "已完成" : stages[Math.min(task.currentStage, stages.length - 1)].title;
                              return <button type="button" key={task.id} onClick={() => selectTask(task)}>
                                {preview ? <Image src={preview} alt={task.name} width={240} height={240} unoptimized /> : <span className="dispatcher-task-placeholder"><Box size={22} /></span>}
                                <span><strong>{task.name}</strong><small>{task.pipelineType === "image_to_model" ? "图生模型" : "文生模型"} · {status}</small></span>
                                {task.jobStatus === "running" && <i style={{ "--task-progress": `${task.jobProgress}%` } as CSSProperties} />}
                              </button>;
                            })}
                          </div>
                        </section>
                      </div>
                    );
                  }
                  const message = entry.item;
                  return (
                    <div className={`dispatcher-message ${message.role}`} key={`message-${message.id}`}>
                      <span>{message.role === "assistant" ? <Bot size={17} /> : <User size={17} />}</span>
                      <div><strong>{message.role === "assistant" ? "总调度 Agent" : "你"}</strong>{message.attachmentName && <small><ImageIcon size={13} />{message.attachmentName}</small>}<div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{message.content}</ReactMarkdown></div></div>
                    </div>
                  );
                })}
                {dispatcherBusy && <div className="dispatcher-message assistant pending"><span><Bot size={17} /></span><div><strong>总调度 Agent</strong><p><LoaderCircle size={15} />正在分析并调度任务</p></div></div>}
                <div ref={dispatcherEndRef} />
              </div>
            </div>

            <form className="dispatcher-composer" onSubmit={sendDispatcherMessage}>
              {dispatcherAttachment && <div className="dispatcher-attachment"><ImageIcon size={15} /><span>{dispatcherAttachment.name}</span><button type="button" onClick={() => setDispatcherAttachment(null)}><X size={14} /></button></div>}
              <textarea rows={4} value={dispatcherInput} onChange={(event) => setDispatcherInput(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder="要求生成一张合集图，或创建多个任务，也可以拖入已有合集原画进行拆分…" />
              <div className="dispatcher-composer-footer">
                <ConversationSessionManager sessions={dispatcherSessions} sessionId={dispatcherSessionId} label="总调度 Agent 会话" disabled={dispatcherBusy || dispatcherSessionBusy || !selectedWorkspaceId} onActivate={(value) => void activateDispatcherSession(value)} onCreate={() => void startDispatcherSession()} onDelete={requestDeleteDispatcherSession} />
                <AgentPermissionMenu mode={coordinatorMode} onChange={(mode) => void changeAgentMode("coordinator", mode)} title="选择总调度 Agent 的变更审批方式" />
                <input ref={dispatcherFileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) attachDispatcherImage(file); event.currentTarget.value = ""; }} />
                <ContextUsage context={dispatcherContext} />
                <span className="dispatcher-composer-actions">{dispatcherBusy && <button className="icon-button" type="button" onClick={() => void cancelDispatcher()} title="停止调度" aria-label="停止调度"><X size={16} /></button>}<button className="primary-button dispatcher-send-button" type="submit" disabled={dispatcherBusy || (!dispatcherInput.trim() && !dispatcherAttachment) || settings?.coordinator.agent.apiKeyConfigured === false} title="发送调度" aria-label="发送调度"><Send size={16} /></button></span>
              </div>
            </form>
            {dispatcherDragging && <div className="dispatcher-drop"><ImageIcon size={34} /><strong>松开以分析合集原画</strong><span>支持最多 12 MB 的 PNG、JPEG 或 WebP</span></div>}
          </section>
        </section>
      ) : (
      <div className="app-frame" style={{ "--agent-width": `${agentCollapsed ? 60 : agentWidth}px` } as CSSProperties}>
        <aside className="task-sidebar">
          <button className="sidebar-home-button" type="button" onClick={openHome} title="返回工作空间首页">
            <Home size={17} /><span>返回首页</span>
          </button>
          <div className="sidebar-header">
            <div className="sidebar-copy"><span>{workspaces.find((item) => item.id === run?.workspaceId)?.name || "工作空间"}</span><strong>{runs.filter((item) => item.workspaceId === run?.workspaceId).length} 个角色任务</strong></div>
            <div className="sidebar-actions">
              <button className="icon-button accent new-task-button" type="button" onClick={() => { setForm({ name: "", workspaceId: run?.workspaceId || selectedWorkspaceId, pipelineType: "text_to_model" }); setTaskSourceImage(null); setShowCreate(true); }} title="新建任务" aria-label="新建角色任务">
                <Plus size={18} />
              </button>
              <button
                className="icon-button sidebar-toggle"
                type="button"
                onClick={() => setSidebarCollapsed((value) => !value)}
                title={sidebarCollapsed ? "展开任务栏" : "收起任务栏"}
                aria-label={sidebarCollapsed ? "展开任务栏" : "收起任务栏"}
              >
                {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              </button>
            </div>
          </div>
          <div className="run-list">
            {loading && runs.length === 0 && <p className="empty-note">正在读取任务…</p>}
            {!loading && runs.filter((item) => item.workspaceId === run?.workspaceId).length === 0 && <p className="empty-note">还没有角色任务。</p>}
            {runs.filter((item) => item.workspaceId === run?.workspaceId).map((item) => (
              <button
                key={item.id}
                className={`run-item ${item.id === selectedId ? "selected" : ""}`}
                onClick={() => selectTask(item)}
                title={sidebarCollapsed ? item.name : undefined}
              >
                <span className={`run-avatar ${item.jobStatus === "running" ? "running" : ""}`}>
                  {item.jobStatus === "running"
                    ? <LoaderCircle size={18} aria-hidden="true" />
                    : item.name.trim().slice(0, 1).toUpperCase() || "R"}
                </span>
                <span className="run-copy">
                  <span className="run-row"><strong>{item.name}</strong><time>{formatTime(item.updatedAt)}</time></span>
                  <span className="run-meta">{item.jobStatus === "running" ? `${jobName(item.jobType)} 执行中` : stages[item.currentStage].title}</span>
                  <span className="run-progress"><i style={{ width: `${Math.round((item.currentStage / (stages.length - 1)) * 100)}%` }} /></span>
                </span>
              </button>
            ))}
          </div>
          <div className="sidebar-footer">
            <span className="database-dot" />
            <span className="sidebar-copy"><strong>SQLite</strong><small>本地持久化</small></span>
          </div>
        </aside>

        <section className="workspace">
          {!run ? (
            <div className="empty-workspace">
              <span><Box size={30} /></span>
              <h1>创建角色资产任务</h1>
              <p>任务、生成进度和产物引用将保存在本地数据库中。</p>
              <button className="primary-button" type="button" onClick={() => setShowCreate(true)}><Plus size={17} />新建任务</button>
            </div>
          ) : (
            <>
              <div className="workspace-header">
                <div className="workspace-heading">
                  <span className="workspace-kicker">当前任务</span>
                  <h1>{run.name}</h1>
                  <p><span className="pipeline-type-badge">{run.pipelineType === "image_to_model" ? "图生模型" : "文生模型"}</span>更新于 {formatTime(run.updatedAt)} · {progress}% 完成</p>
                </div>
                <div className="workspace-actions">
                  <button className="icon-button" type="button" onClick={resetRun} disabled={busy || run.jobStatus === "running"} title="重置任务" aria-label="重置任务"><RotateCcw size={17} /></button>
                  <button className="icon-button danger" type="button" onClick={deleteRun} disabled={busy || run.jobStatus === "running"} title="删除任务" aria-label="删除任务"><Trash2 size={17} /></button>
                </div>
              </div>

              <div className="pipeline-bar">
                <div className="pipeline-health">
                  {(["2d", "qa", "3d", "rig"] as const).map((kind) => (
                    <span key={kind} className={workflowReady(kind) ? "ready" : "missing"}><i />{jobName(kind)}</span>
                  ))}
                  <span className={system?.comfyui.topology?.ready ? "ready" : "missing"}><i />AutoRemesher</span>
                </div>
                <span className="queue-status" title={dgxDeviceSummary}>
                  {dgxMemoryTotal ? `${dgxMemoryFree || "-"} / ${dgxMemoryTotal} 可用 · ` : ""}队列 {system?.comfyui.queue?.running || 0} 运行 / {system?.comfyui.queue?.pending || 0} 等待
                </span>
              </div>

              <div className="production-board">
                <nav className="stage-rail" aria-label="资产生成阶段">
                  <div className="stage-rail-header"><span>流程</span><strong>{current + 1} / {stages.length}</strong></div>
                  <div className="stage-list">
                    {activeStages.map((item, index) => {
                      const state = index < current || (index === current && run.status === "completed") ? "done" : index === current ? "active" : "pending";
                      let stateLabel = state === "done" ? "已完成" : state === "active" ? "当前" : "待处理";
                      if (index === current && currentStageReady && current < stages.length - 1) stateLabel = "待确认";
                      if (index === current && run.jobStatus === "running") stateLabel = `${run.jobProgress}%`;
                      if (index === 2 && index === current && run.qaStatus === "failed") stateLabel = "未通过";
                      if (index === 2 && index < current) stateLabel = `${run.qaScore ?? "-"} 分`;
                      return (
                        <div key={item.short} className={`stage-step ${state} ${viewStage === index ? "viewed" : ""}`}>
                          <button
                            type="button"
                            className="stage-main"
                            onClick={() => {
                              setViewStage(index);
                              if (index === 2) setQaBlend(0.5);
                            }}
                            disabled={state === "pending"}
                            aria-current={index === current ? "step" : undefined}
                          >
                            <span className="stage-node">{state === "done" ? <Check size={13} /> : String(index + 1)}</span>
                            <span className="stage-copy"><strong>{item.title}</strong><small>{item.subtitle}</small></span>
                            <span className="stage-state">{stateLabel}</span>
                          </button>
                          {state === "done" && index < current && (
                            <button className="stage-revert" type="button" onClick={() => revertToStage(index)} disabled={busy || run.jobStatus === "running"} title={`回退到${item.title}`} aria-label={`回退到${item.title}`}>
                              <Undo2 size={14} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </nav>

                <div className="asset-column">
                  <div className={`preview-panel ${previewFullscreen ? "is-maximized" : ""}`}>
                    <div className="preview-header">
                      <div><span>资产预览</span><strong>{previewType}</strong></div>
                      <button className="icon-button" type="button" onClick={togglePreviewFullscreen} title={previewFullscreen ? "退出全屏" : "全屏预览"} aria-label={previewFullscreen ? "退出全屏预览" : "进入全屏预览"}>
                        {previewFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                      </button>
                    </div>
                    <div className={`preview-frame ${viewStage === 0 ? "brief-preview" : ""} ${modelPreviewUrl ? "model-preview" : ""} ${hasPreview ? "" : "placeholder"} ${viewStage !== 0 && run.jobStatus === "running" ? "generating" : ""}`}>
                      {viewStage === 0 ? (
                        <div className="character-brief-view">
                          <div className="character-brief-content">
                            <div className="current-stage-summary">
                              <div className="current-stage-heading">
                                <span>{current === 0 ? "当前阶段 01" : "阶段 01 · 已完成"}</span>
                                <strong>{activeStages[0].title}</strong>
                                <p>{activeStages[0].action}</p>
                              </div>
                              <div className="current-stage-io">
                                <span>输入 <b>{activeStages[0].input}</b></span>
                                <span>输出 <b>{activeStages[0].output}</b></span>
                              </div>
                            </div>
                            {run.pipelineType === "image_to_model" && run.assets.sourceImageReady && (
                              <div className="source-art-card">
                                <Image src={run.sourcePreviewPath || downloadUrl(run.assets.sourceImageDownloadUrl)!} alt={`${run.name} 的单体角色原画`} width={720} height={720} unoptimized />
                                <div><span>图生图输入</span><strong>单体角色原画已就绪</strong><small>下一阶段将保持角色身份并转换为标准 T-Pose。</small></div>
                              </div>
                            )}
                            <div className={`stage-prompt-editor ${current > 0 ? "read-only" : ""}`}>
                              <label>
                                <span>正向提示词</span>
                                <textarea rows={8} maxLength={4000} value={promptDraft.positivePrompt} readOnly={current > 0} onChange={(event) => setPromptDraft({ ...promptDraft, positivePrompt: event.target.value })} />
                              </label>
                              <label>
                                <span>负向提示词</span>
                                <textarea rows={7} maxLength={2000} value={promptDraft.negativePrompt} readOnly={current > 0} onChange={(event) => setPromptDraft({ ...promptDraft, negativePrompt: event.target.value })} />
                              </label>
                            </div>
                            {artDirectorRun?.status === "running" && <div className="action-note running"><RefreshCw size={17} /><div><strong>Art Director 正在检查提示词</strong><p>检查角色身份、姿态约束和正负提示词冲突。</p></div></div>}
                            {artDirectorRun?.status === "succeeded" && <div className={`action-note ${artDirectorRun.report?.decision === "manual_review" ? "warning" : "passed"}`}><Sparkles size={17} /><div><strong>Art Director · {artDirectorRun.report?.decision === "approve" ? "已确认" : artDirectorRun.report?.decision === "revise" ? "已修订" : "建议人工确认"}</strong><p>{artDirectorRun.report?.summary}</p></div></div>}
                            {artDirectorRun?.status === "failed" && <div className="action-note failed"><X size={17} /><div><strong>Art Director 检查失败</strong><p>{artDirectorRun.errorMessage}</p></div></div>}
                          </div>
                        </div>
                      ) : modelPreviewUrl ? (
                        <Suspense fallback={<div className="stage-empty"><LoaderCircle className="spin" size={24} /><span>正在加载 3D 查看器</span></div>}>
                          <ModelViewer src={modelPreviewUrl} label={`${run.name} · ${useRiggedPreview ? "绑骨 GLB" : useTopologyPreview ? "拓扑 GLB" : "静态 GLB"}`} rigged={useRiggedPreview} />
                        </Suspense>
                      ) : hasQaComparison ? (
                        <div className="qa-blend-preview">
                          <Image
                            className="qa-blend-image"
                            src={run.previewPath!}
                            alt={`${run.name} 的原画`}
                            width={1600}
                            height={1600}
                            style={{ opacity: 1 - qaBlend }}
                            priority
                            unoptimized
                          />
                          <Image
                            className="qa-blend-image"
                            src={run.qaOverlayPath!}
                            alt={`${run.name} 的 SDPose 骨骼覆盖图`}
                            width={1600}
                            height={1600}
                            style={{ opacity: qaBlend }}
                            priority
                            unoptimized
                          />
                          <div className="qa-blend-control">
                            <span>原画</span>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.01}
                              value={qaBlend}
                              onChange={(event) => setQaBlend(Number(event.target.value))}
                              aria-label="原画与骨骼覆盖图混合比例"
                            />
                            <span>骨骼</span>
                            <output>{Math.round(qaBlend * 100)}%</output>
                          </div>
                        </div>
                      ) : visiblePreview ? (
                        <Image className="asset-preview-image" src={visiblePreview} alt={`${run.name} 的角色预览`} width={1600} height={1600} priority unoptimized />
                      ) : (
                        <div className="preview-empty"><ImageIcon size={38} /><strong>{stage.title}</strong><span>等待本阶段真实产物</span></div>
                      )}
                      {viewStage !== 0 && run.jobStatus === "running" && (
                        <div className="generation-overlay">
                          <div
                            className="generation-progress"
                            role="progressbar"
                            aria-label={`${jobName(run.jobType)} 生成进度`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={run.jobProgress}
                          >
                            <div className="generation-progress-heading">
                              <strong>{jobName(run.jobType)} 正在执行</strong>
                              <b>{run.jobProgress}%</b>
                            </div>
                            <span>{run.jobMessage || "等待 ComfyUI 实时事件"}</span>
                            <span className="generation-progress-track"><i style={{ width: `${run.jobProgress}%` }} /></span>
                            <small>Prompt {run.jobPromptId ? run.jobPromptId.slice(0, 16) : "等待提交"} · Node {run.jobCurrentNode || "等待执行"}</small>
                          </div>
                        </div>
                      )}
                    </div>
                    {(isCurrentView || (viewStage === 1 && run.assets.imageReady) || (viewStage >= 3 && run.assets.modelReady)) && (
                      <div className="asset-status-row">
                        <div className="asset-status-actions">
                          {isCurrentView && current === 0 && <button className="primary-button" onClick={() => runAction("start", "进入 2D 阶段失败", promptDraft)} disabled={busy || !promptDraft.positivePrompt.trim()}><Play size={16} />确认设定</button>}
                          {isCurrentView && current === 1 && !run.assets.imageReady && <button className="primary-button" onClick={() => runAction("generate-2d", "2D 任务提交失败")} disabled={busy || run.jobStatus === "running"}><Sparkles size={16} />{run.pipelineType === "image_to_model" ? "生成 T-Pose 图" : "生成 2D 概念图"}</button>}
                          {isCurrentView && current === 1 && run.assets.imageReady && <button className="secondary-button" onClick={() => runAction("generate-2d", "重新生成失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />{run.pipelineType === "image_to_model" ? "重新转换 T-Pose" : "重新生成 2D"}</button>}
                          {isCurrentView && current === 1 && run.assets.imageReady && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy || run.jobStatus === "running"}><Check size={16} />确认 {run.pipelineType === "image_to_model" ? "T-Pose" : "2D"} 完成，进入检查</button>}
                          {isCurrentView && current === 2 && run.qaStatus === "failed" && <button className="warning-button" onClick={() => runAction("generate-2d", "重新生成失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新生成 2D</button>}
                          {isCurrentView && current === 2 && run.qaStatus !== "passed" && run.jobStatus !== "running" && <button className="secondary-button" onClick={() => runAction("check-tpose", "姿态检查启动失败")} disabled={busy}><RefreshCw size={16} />{run.qaStatus === "failed" ? "重新检查姿态" : "运行姿态检查"}</button>}
                          {isCurrentView && current === 2 && run.qaStatus === "passed" && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy}><Check size={16} />确认检查通过，进入 3D</button>}
                          {isCurrentView && current === 3 && !run.assets.modelReady && <button className="primary-button" onClick={() => runAction("generate-3d", "3D 任务提交失败")} disabled={busy || run.jobStatus === "running"}><Box size={16} />生成静态 GLB</button>}
                          {isCurrentView && current === 3 && run.assets.modelReady && <button className="secondary-button" onClick={() => runAction("generate-3d", "重新生成失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新生成 3D</button>}
                          {isCurrentView && current === 3 && run.assets.modelReady && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy}><Check size={16} />确认 3D 完成，进入拓扑</button>}
                          {isCurrentView && current === 4 && !run.assets.topologyReady && <button className="primary-button" onClick={() => runAction("retopologize", "拓扑任务提交失败")} disabled={busy || run.jobStatus === "running"}><Expand size={16} />运行自动拓扑</button>}
                          {isCurrentView && current === 4 && run.assets.topologyReady && <button className="secondary-button" onClick={() => runAction("retopologize", "重新拓扑失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新运行拓扑</button>}
                          {isCurrentView && current === 4 && run.assets.topologyReady && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy}><Check size={16} />确认拓扑完成，进入绑骨</button>}
                          {isCurrentView && current === 5 && !run.assets.riggedReady && <button className="primary-button" onClick={() => runAction("rig", "绑骨任务提交失败")} disabled={busy || run.jobStatus === "running"}><Expand size={16} />运行自动绑骨</button>}
                          {isCurrentView && current === 5 && run.assets.riggedReady && <button className="secondary-button" onClick={() => runAction("rig", "重新绑骨失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新运行绑骨</button>}
                          {isCurrentView && current === 5 && run.assets.riggedReady && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy}><Check size={16} />确认绑骨完成，进入导出</button>}
                          {viewStage === 1 && run.assets.imageReady && <a className="download-button" href={downloadUrl(run.assets.imageDownloadUrl)}><Download size={16} />下载 PNG</a>}
                          {viewStage >= 3 && run.assets.modelReady && <a className="download-button" href={downloadUrl(run.assets.modelDownloadUrl)}><Download size={16} />下载静态 GLB</a>}
                          {viewStage >= 4 && run.assets.topologyReady && <a className="download-button" href={downloadUrl(run.assets.topologyDownloadUrl)}><Download size={16} />下载拓扑 GLB</a>}
                          {viewStage >= 5 && run.assets.riggedReady && <a className="download-button primary" href={downloadUrl(run.assets.riggedDownloadUrl)}><Download size={16} />下载最终 GLB</a>}
                        </div>
                      </div>
                    )}
                  </div>

                  {hasPreviewFooter && viewStage !== 0 && <section className="stage-workflow-panel">
                    <div className="stage-workflow-content">
                      {isCurrentView && (
                        <div className="current-stage-summary">
                          <div className="current-stage-heading">
                            <span>当前阶段 {String(current + 1).padStart(2, "0")}</span>
                            <strong>{activeStages[current].title}</strong>
                            <p>{activeStages[current].action}</p>
                          </div>
                          <div className="current-stage-io">
                            <span>输入 <b>{activeStages[current].input}</b></span>
                            <span>输出 <b>{activeStages[current].output}</b></span>
                          </div>
                        </div>
                      )}

                      {isCurrentView && run.jobStatus === "running" && <div className="action-note running"><RefreshCw size={17} /><div><strong>{jobName(run.jobType)} 正在执行</strong><p>{run.jobMessage}</p></div></div>}
                      {isCurrentView && run.jobStatus === "failed" && <div className="action-note failed"><X size={17} /><div><strong>{jobName(run.jobType)} 执行失败</strong><p>{run.jobMessage}</p></div></div>}

                      {viewStage === 2 && run.qaScore !== null && (
                        <div className={`qa-summary ${run.qaStatus}`}>
                          <strong>{run.qaScore}</strong><span>/ 100</span><p>{run.qaSummary}</p>
                        </div>
                      )}
                      {viewStage === 2 && Object.keys(run.qaMetrics || {}).length > 0 && (
                        <div className="metric-grid">
                          <div><span>最小置信度</span><strong>{Math.round((run.qaMetrics.minConfidence || 0) * 100)}%</strong></div>
                          <div><span>水平误差</span><strong>{Math.round((run.qaMetrics.armHorizontalError || 0) * 100)}%</strong></div>
                          <div><span>左肘角度</span><strong>{run.qaMetrics.leftElbowAngle || 0}°</strong></div>
                          <div><span>右肘角度</span><strong>{run.qaMetrics.rightElbowAngle || 0}°</strong></div>
                        </div>
                      )}
                      {viewStage === 2 && visualQaRun?.status === "running" && <div className="action-note running"><RefreshCw size={17} /><div><strong>Visual QA 正在语义复核</strong><p>SDPose 硬门禁已经完成，正在补充检查朝向、遮挡和背景。</p></div></div>}
                      {viewStage === 2 && visualQaRun?.status === "succeeded" && <div className={`action-note ${visualQaRun.report?.decision === "pass" ? "passed" : "warning"}`}><Bot size={17} /><div><strong>Visual QA · {visualQaRun.report?.decision === "pass" ? "通过" : visualQaRun.report?.decision === "repairable" ? "可修复" : visualQaRun.report?.decision === "reject" ? "不建议使用" : "建议人工复核"}</strong><p>{visualQaRun.report?.summary}</p></div></div>}
                      {viewStage === 2 && visualQaRun?.status === "failed" && <div className="action-note failed"><X size={17} /><div><strong>Visual QA 复核失败</strong><p>{visualQaRun.errorMessage}。SDPose 结果不受影响。</p></div></div>}

                    </div>
                  </section>}

                  <section className="event-panel event-panel-full">
                    <div className="section-heading"><div><span>活动</span><strong>任务记录</strong></div><MoreHorizontal size={18} /></div>
                    <div className="event-list">
                      {(selectedDetail?.events || []).slice(0, 8).map((item) => (
                        <div className="event-item" key={item.id}>
                          <span className="event-dot" />
                          <div><strong>{item.message}</strong><span>{activeStages[item.stage]?.title || "流程"} · {formatTime(item.createdAt)}</span></div>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            </>
          )}
        </section>

        <aside
          className={`agent-panel ${agentCollapsed ? "agent-collapsed" : ""} ${agentImageDragging ? "image-dragging" : ""}`}
          onDragEnter={handleAgentDragEnter}
          onDragOver={handleAgentDragOver}
          onDragLeave={handleAgentDragLeave}
          onDrop={handleAgentDrop}
        >
          <div
            className="agent-resizer"
            onPointerDown={startAgentResize}
            onPointerMove={moveAgentResize}
            onPointerUp={endAgentResize}
            onPointerCancel={endAgentResize}
            role="separator"
            aria-label="调整 Agent 面板宽度"
            aria-orientation="vertical"
          />
          <div className="agent-header">
            <div className="agent-title"><span><Bot size={19} /></span><div><strong>Asset Agent</strong><small>工作对话</small></div></div>
            <div className="agent-header-actions">
              <span className={`agent-state ${agentOperationalBusy ? "busy" : system?.agent.configured ? "" : "unavailable"}`}>
                <i />{agentBusy ? agentQueue.length ? `处理中 · ${agentQueue.length} 排队` : "处理中" : selectedRoleIsRunning ? "子 Agent 质检中" : selectedPlanIsRunning ? "自动执行中" : system?.agent.configured ? "待命" : "未配置"}
              </span>
              <button className="icon-button" type="button" onClick={() => setAgentCollapsed((value) => !value)} title={agentCollapsed ? "展开 Agent 面板" : "收起 Agent 面板"} aria-label={agentCollapsed ? "展开 Agent 面板" : "收起 Agent 面板"}>
                {agentCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
              </button>
            </div>
          </div>
          <div className="agent-summary">
            <div className="agent-context">
              <span>任务上下文</span>
              <strong>{run?.name || "未选择任务"}</strong>
              <p>{run ? `${activeStages[current].title} · ${progress}% 完成` : "选择或创建任务后开始"}</p>
            </div>
            {selectedDetail?.agentWorkflowPlan && (
              <section className={`agent-orchestration ${selectedDetail.agentWorkflowPlan.status}`}>
                <div><Bot size={15} /><strong>Supervisor 自动编排</strong><span>{selectedDetail.agentWorkflowPlan.status === "running" ? "执行中" : selectedDetail.agentWorkflowPlan.status === "completed" ? "已完成" : selectedDetail.agentWorkflowPlan.status === "blocked" ? "已暂停" : "失败"}</span></div>
                <p>目标：{activeStages[selectedDetail.agentWorkflowPlan.targetStage].title}</p>
                <small>{selectedDetail.agentWorkflowPlan.message}</small>
              </section>
            )}
            {specialistRoleRuns.length > 0 && (
              <section className="agent-role-activity" aria-label="多 Agent 协作记录">
                <span>多 Agent 协作</span>
                {specialistRoleRuns.map((item) => <div className={`agent-role-row ${item.run.status}`} key={item.run.id}>
                  {item.icon === "art" ? <Sparkles size={14} /> : <Bot size={14} />}
                  <div><strong>{item.name}</strong><small>{item.run.status === "running" ? item.running : item.run.status === "succeeded" ? item.run.report?.summary || item.fallback : item.run.errorMessage}</small></div>
                  <em>{item.run.status === "running" ? "运行中" : item.run.status === "succeeded" ? "已完成" : "失败"}</em>
                </div>)}
              </section>
            )}
          </div>
          <div className="chat-thread" key={selectedId || "no-run"}>
            {visibleChatMessages.map((message) => (
              <div className={`chat-message ${message.role}`} key={message.id}>
                <span className="chat-avatar">{message.role === "assistant" ? <Bot size={16} /> : <User size={16} />}</span>
                <div>
                  <strong className="chat-author">{message.role === "assistant" ? "Asset Agent" : "你"}</strong>
                  {message.attachmentName && <span className="chat-attachment"><ImageIcon size={14} />{message.attachmentName}</span>}
                  <div className="markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      skipHtml
                      components={{
                        a: ({ href, children, ...props }) => (
                          <a
                            {...props}
                            href={href}
                            target={href?.startsWith("http://") || href?.startsWith("https://") ? "_blank" : undefined}
                            rel="noreferrer noopener"
                          >
                            {children}
                          </a>
                        ),
                        img: ({ alt, ...props }) => (
                          // Markdown 图片的来源和尺寸在运行时才能确定，不能使用 Next.js 静态图片优化。
                          // eslint-disable-next-line @next/next/no-img-element
                          <img {...props} alt={alt || "Markdown 图片"} loading="lazy" />
                        ),
                      }}
                    >
                      {message.content}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            ))}
            {selectedRunAgentBusy && (
              <div className="chat-message assistant pending">
                <span className="chat-avatar"><Bot size={16} /></span>
                <div><strong className="chat-author">Asset Agent</strong><p><LoaderCircle size={15} />正在处理任务</p></div>
              </div>
            )}
            {agentBusy && !selectedRunAgentBusy && activeAgentRunName && (
              <div className="agent-background-status"><LoaderCircle size={14} />正在处理“{activeAgentRunName}”的消息</div>
            )}
            {agentQueue.length > 0 && (
              <section className="agent-message-queue" aria-label="Agent 待发送队列">
                <div className="agent-queue-heading"><span>待发送队列</span><strong>{agentQueue.length}</strong></div>
                <div className="agent-queue-list">
                  {agentQueue.map((item, index) => (
                    <div className="agent-queue-item" key={item.id}>
                      <span className="agent-queue-position">{index + 1}</span>
                      <div className="agent-queue-copy">
                        <strong>{item.runName}</strong>
                        <p>{item.message || "分析参考图片并完善角色设定"}</p>
                        {item.attachment && <span><ImageIcon size={12} />{item.attachment.name}</span>}
                      </div>
                      <button type="button" onClick={() => removeQueuedAgentMessage(item.id)} title="从队列移除" aria-label={`从队列移除：${item.message || item.attachment?.name || "图片消息"}`}><X size={14} /></button>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {taskApprovals.map((approval) => (
              <section className="approval-card compact-card" key={approval.id}>
                <span><ShieldCheck size={17} /></span>
                <div><small>Asset Agent 请求批准</small><strong>{approval.title}</strong><p>{approval.description}</p></div>
                <div className="approval-actions"><button type="button" className="secondary-button" disabled={approvalBusyId !== null} onClick={() => void resolveApproval(approval.id, "reject")}>拒绝</button><button type="button" className="primary-button" disabled={approvalBusyId !== null} onClick={() => void resolveApproval(approval.id, "approve")}>{approvalBusyId === approval.id ? <LoaderCircle className="spinning" size={14} /> : <Check size={14} />}批准</button></div>
              </section>
            ))}
            <div ref={chatEndRef} />
          </div>
          {agentImageDragging && !agentCollapsed && (
            <div className="agent-drop-overlay" aria-hidden="true"><ImageIcon size={26} /><strong>松开以添加图片</strong></div>
          )}
          <form className="chat-composer" onSubmit={sendChatMessage}>
            {agentAttachment && (
              <div className="attachment-chip">
                <ImageIcon size={14} /><span>{agentAttachment.name}</span>
                <button type="button" onClick={() => setAgentAttachment(null)} title="移除图片" aria-label="移除参考图片"><X size={14} /></button>
              </div>
            )}
            <textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={handleComposerKeyDown} rows={3} placeholder={agentBusy ? "继续输入，消息将进入待发送队列…" : "给 Agent 下达资产生成任务…"} />
            <div className="composer-footer">
              <div className="composer-meta">
                <ConversationSessionManager sessions={chatSessions} sessionId={chatSessionId} label="Asset Agent 会话" disabled={!run || agentBusy || agentQueue.length > 0 || chatSessionBusy} onActivate={(value) => void activateTaskSession(value)} onCreate={() => void startTaskSession()} onDelete={requestDeleteTaskSession} />
                {run && <AgentPermissionMenu mode={taskAgentMode} onChange={(mode) => void changeAgentMode("task", mode)} title="选择当前任务 Agent 的变更审批方式" />}
                <ContextUsage context={chatContext} compact />
              </div>
              <div className="composer-actions">
                {agentBusy && <button className="cancel" type="button" onClick={cancelAgent} aria-label="停止当前 Agent 请求" title="停止当前 Agent 请求"><X size={17} /></button>}
                <button type="submit" disabled={!run || (!chatInput.trim() && !agentAttachment) || agentQueue.length >= MAX_AGENT_QUEUE_ITEMS || system?.agent.configured === false} aria-label={agentBusy ? "加入发送队列" : "发送消息"} title={agentBusy ? "加入发送队列" : "发送消息"}><Send size={17} /></button>
              </div>
            </div>
          </form>
        </aside>
      </div>
      )}

      {revertStage !== null && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setRevertStage(null); }}>
          <div className="revert-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="revert-confirm-title">
            <div className="revert-confirm-icon"><RotateCcw size={21} /></div>
            <div className="revert-confirm-copy">
              <span>流程回滚</span>
              <h2 id="revert-confirm-title">回退到“{activeStages[revertStage].title}”？</h2>
              <p>该阶段及后续阶段的产物引用和流程进度将被清除。</p>
            </div>
            <div className="revert-confirm-actions">
              <button autoFocus type="button" className="secondary-button" onClick={() => setRevertStage(null)} disabled={busy}>取消</button>
              <button type="button" className="warning-button" onClick={() => void confirmRevert()} disabled={busy}><RotateCcw size={16} />{busy ? "回滚中…" : "确认回滚"}</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
          <form className="settings-panel" onSubmit={saveSettings} aria-label="请求设置">
            <div className="settings-header">
              <div><span>运行配置</span><h2>请求设置</h2></div>
              <button className="icon-button" type="button" onClick={() => setShowSettings(false)} aria-label="关闭设置面板"><X size={19} /></button>
            </div>

            {settingsLoading || !settingsForm || !settings ? (
              <div className="settings-loading"><LoaderCircle size={20} /><span>正在读取配置</span></div>
            ) : (
              <>
                <div className="settings-tabs" role="tablist" aria-label="配置分类">
                  {PROCESS_KINDS.map((kind) => (
                    <button key={kind} type="button" role="tab" aria-selected={settingsTab === kind} className={settingsTab === kind ? "active" : ""} onClick={() => { setSettingsTab(kind); setWorkflowPreviewOpen(false); }}>
                      {kind === "qa" ? "QA" : kind.toUpperCase()}
                    </button>
                  ))}
                  <button type="button" role="tab" aria-selected={settingsTab === "topology"} className={settingsTab === "topology" ? "active" : ""} onClick={() => { setSettingsTab("topology"); setWorkflowPreviewOpen(false); }}>拓扑 API</button>
                  <button type="button" role="tab" aria-selected={settingsTab === "agent"} className={settingsTab === "agent" ? "active" : ""} onClick={() => { setSettingsTab("agent"); setWorkflowPreviewOpen(false); }}>任务 Agent</button>
                  <button type="button" role="tab" aria-selected={settingsTab === "coordinator"} className={settingsTab === "coordinator" ? "active" : ""} onClick={() => { setSettingsTab("coordinator"); setWorkflowPreviewOpen(false); }}>总调度 Agent</button>
                </div>

                <div className="settings-content">
                  {settingsTab === "topology" ? (
                    <section className="process-settings" aria-label="自动拓扑 API 配置">
                      <div className="settings-section-heading">
                        <div><span>External Service</span><h3>自动拓扑 API</h3></div>
                        <button className="text-icon-button" type="button" onClick={restoreTopologyDefaults}><RotateCcw size={15} />恢复默认</button>
                      </div>
                      <div className="agent-scope-note"><ShieldCheck size={15} /><span>配置保存在本机后端。可以连接 DGX AutoRemesher，也可以替换为兼容相同请求协议的其他服务。</span></div>
                      <div className="api-mode-status">
                        <span className={`config-state ${settings.topology.url ? "configured" : ""}`}><i />{settings.topology.url ? "服务地址已配置" : "服务地址未配置"}</span>
                      </div>
                      <label className="settings-field">
                        <span>服务地址</span>
                        <input type="url" value={settingsForm.topology.url} placeholder="http://100.120.236.113:8190" onChange={(event) => updateTopologySettings({ url: event.target.value })} />
                        <small className="settings-field-note">可填写 API Base URL，也可填写以 /v1/remesh 结尾的完整地址。</small>
                      </label>
                      <label className="settings-field">
                        <span>目标四边面数</span>
                        <input type="number" required min={1000} max={1000000} step={1000} value={settingsForm.topology.targetQuads} onChange={(event) => updateTopologySettings({ targetQuads: Number(event.target.value) })} />
                        <small className="settings-field-note">允许范围为 1,000 到 1,000,000；默认 50,000。</small>
                      </label>
                      <label className="settings-field">
                        <span>请求超时（秒）</span>
                        <input type="number" required min={30} max={86400} step={30} value={settingsForm.topology.timeoutSeconds} onChange={(event) => updateTopologySettings({ timeoutSeconds: Number(event.target.value) })} />
                        <small className="settings-field-note">允许范围为 30 到 86,400 秒；复杂模型建议至少 3,600 秒。</small>
                      </label>
                    </section>
                  ) : settingsTab !== "agent" && settingsTab !== "coordinator" ? (
                    <section className="process-settings" aria-label={`${settings.processes[settingsTab].label}配置`}>
                      <div className="settings-section-heading">
                        <div><span>{settingsTab === "2d" && settingsForm.processes["2d"].mode === "api" ? "API" : "ComfyUI"}</span><h3>{settings.processes[settingsTab].label}</h3></div>
                        <button className="text-icon-button" type="button" onClick={() => restoreProcessDefaults(settingsTab)}><RotateCcw size={15} />恢复默认</button>
                      </div>
                      {settingsTab === "2d" && <div className="process-mode-control" role="group" aria-label="2D 概念图接入方式">
                        <button type="button" className={settingsForm.processes["2d"].mode === "comfyui" ? "active" : ""} onClick={() => updateProcessSettings("2d", { mode: "comfyui" })}>ComfyUI</button>
                        <button type="button" className={settingsForm.processes["2d"].mode === "api" ? "active" : ""} onClick={() => updateProcessSettings("2d", { mode: "api" })}>API</button>
                      </div>}
                      {settingsTab !== "2d" || settingsForm.processes["2d"].mode === "comfyui" ? <>
                        <label className="settings-field">
                          <span>请求地址</span>
                          <input type="url" required value={settingsForm.processes[settingsTab].url} onChange={(event) => updateProcessSettings(settingsTab, { url: event.target.value })} />
                        </label>
                        {(() => {
                          const kind = settingsTab;
                          const process = settings.processes[kind];
                          const selectedId = settingsForm.processes[kind].activeWorkflowId;
                          const selected = process.workflows.find((item) => item.id === selectedId);
                          return <>
                          <div className="settings-field">
                            <span>工作流版本</span>
                            <div className="workflow-select-row">
                              <StyledSelect value={selectedId} options={process.workflows.map((workflow) => ({ value: workflow.id, label: workflow.name }))} onChange={(value) => void selectWorkflow(kind, value)} ariaLabel={`${process.label}工作流版本`} />
                              <button className="icon-button" type="button" disabled={!selected || selected.source === "default"} onClick={() => void removeWorkflow(kind, selectedId)} title="删除当前工作流" aria-label="删除当前工作流"><Trash2 size={17} /></button>
                            </div>
                          </div>

                          <div
                            className={`workflow-dropzone ${workflowDragging ? "dragging" : ""}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => workflowFileRef.current?.click()}
                            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") workflowFileRef.current?.click(); }}
                            onDragEnter={(event) => { event.preventDefault(); setWorkflowDragging(true); }}
                            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setWorkflowDragging(true); }}
                            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setWorkflowDragging(false); }}
                            onDrop={(event) => {
                              event.preventDefault();
                              setWorkflowDragging(false);
                              handleWorkflowFiles(kind, event.dataTransfer.files);
                            }}
                          >
                            <input ref={workflowFileRef} type="file" accept="application/json,.json" multiple hidden onChange={(event) => {
                              if (event.target.files) handleWorkflowFiles(kind, event.target.files);
                              event.target.value = "";
                            }} />
                            <input ref={workflowDirectoryRef} type="file" multiple hidden onChange={(event) => {
                              if (event.target.files) handleWorkflowFiles(kind, event.target.files);
                              event.target.value = "";
                            }} />
                            <span className="workflow-upload-icon"><Upload size={19} /></span>
                            <div className="workflow-upload-copy"><strong>上传工作流 JSON</strong><span>拖拽文件或点击选择</span></div>
                            <div className="workflow-upload-actions">
                              <button className="icon-button" type="button" onClick={(event) => { event.stopPropagation(); workflowFileRef.current?.click(); }} title="选择 JSON 文件" aria-label="选择 JSON 文件"><Upload size={16} /></button>
                              <button className="icon-button" type="button" onClick={(event) => { event.stopPropagation(); chooseWorkflowDirectory(); }} title="选择目录" aria-label="选择目录"><FolderOpen size={16} /></button>
                            </div>
                          </div>

                          <div className="workflow-summary">
                            <div>
                              <FileJson size={17} />
                              <span><strong>{selected?.name || "工作流"}</strong><small>{selected?.nodeCount ?? 0} 个节点 · {selected?.source === "default" ? "内置" : "已上传"}</small></span>
                            </div>
                            <button className="text-icon-button" type="button" onClick={() => setWorkflowPreviewOpen((value) => !value)} aria-expanded={workflowPreviewOpen}>
                              {workflowPreviewOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}{workflowPreviewOpen ? "收起 JSON" : "预览 JSON"}
                            </button>
                          </div>
                          {workflowPreviewOpen && <pre className="workflow-json-preview">{settingsForm.processes[kind].workflowJson}</pre>}
                          </>;
                        })()}
                      </> : settingsForm.processes["2d"].api && <>
                        <div className="api-mode-status">
                          <span className={`config-state ${settings.processes["2d"].api?.apiKeyConfigured || settings.agent.apiKeyConfigured ? "configured" : ""}`}><i />{settings.processes["2d"].api?.apiKeyConfigured || settings.agent.apiKeyConfigured ? "API Key 已配置" : "API Key 未配置"}</span>
                        </div>
                        <label className="settings-field">
                          <span>Base URL</span>
                          <input type="url" required value={settingsForm.processes["2d"].api.baseUrl} onChange={(event) => updateProcessSettings("2d", { api: { ...settingsForm.processes["2d"].api!, baseUrl: event.target.value } })} />
                        </label>
                        <label className="settings-field">
                          <span>模型</span>
                          <input type="text" required maxLength={160} value={settingsForm.processes["2d"].api.model} onChange={(event) => updateProcessSettings("2d", { api: { ...settingsForm.processes["2d"].api!, model: event.target.value } })} />
                        </label>
                        <label className="settings-field">
                          <span>API Key</span>
                          <input type="password" autoComplete="off" maxLength={1000} value={settingsForm.processes["2d"].api.apiKey} placeholder={settings.processes["2d"].api?.apiKeyConfigured ? "留空以保留当前密钥" : settings.agent.apiKeyConfigured ? "留空以复用 Agent API Key" : "输入 API Key"} onChange={(event) => updateProcessSettings("2d", { api: { ...settingsForm.processes["2d"].api!, apiKey: event.target.value } })} />
                        </label>
                      </>}
                    </section>
                  ) : (() => {
                    const scope = settingsTab === "coordinator" ? "coordinator" : "agent";
                    const isCoordinator = scope === "coordinator";
                    const currentAgent = isCoordinator ? settings.coordinator.agent : settings.agent;
                    const draftAgent = isCoordinator ? settingsForm.coordinator.agent : settingsForm.agent;
                    const currentImages = isCoordinator ? settings.coordinator.imageModels : settings.imageModels;
                    const draftImages = isCoordinator ? settingsForm.coordinator.imageModels : settingsForm.imageModels;
                    const models = isCoordinator ? coordinatorModels : agentModels;
                    const resetModels = () => {
                      const current = [{ id: draftAgent.model, name: draftAgent.model }];
                      if (isCoordinator) setCoordinatorModels(current);
                      else setAgentModels(current);
                    };
                    return <section className="agent-settings" aria-label={`${isCoordinator ? "总调度" : "任务"} Agent API 配置`}>
                      <div className="agent-scope-note"><ShieldCheck size={15} /><span>此处配置仅供{isCoordinator ? "总调度 Agent" : "任务 Asset Agent"}使用，与另一套 Agent 配置完全独立。</span></div>
                      <div className="settings-section-heading">
                        <div><span>{isCoordinator ? "Workspace Coordinator" : "Asset Agent"}</span><h3>{isCoordinator ? "调度模型 API" : "任务模型 API"}</h3></div>
                        <span className={`config-state ${currentAgent.apiKeyConfigured ? "configured" : ""}`}><i />{currentAgent.apiKeyConfigured ? "已配置" : "未配置"}</span>
                      </div>
                      <label className="settings-field"><span>Base URL</span><input type="url" required value={draftAgent.baseUrl} onChange={(event) => { updateAgentApiSettings(scope, { baseUrl: event.target.value }); resetModels(); }} /></label>
                      <div className="settings-field">
                        <span>模型</span>
                        <div className="agent-model-row">
                          <StyledSelect value={draftAgent.model} options={models.map((model) => ({ value: model.id, label: model.name === model.id ? model.id : `${model.name} · ${model.id}` }))} onChange={(value) => updateAgentApiSettings(scope, { model: value })} ariaLabel={`${isCoordinator ? "总调度" : "任务"} Agent 模型`} />
                          <button className="text-icon-button" type="button" onClick={() => void fetchAgentModels(scope)} disabled={agentModelsLoading || draftAgent.clearApiKey}>
                            <RefreshCw className={agentModelsLoading ? "spinning" : ""} size={15} />{agentModelsLoading ? "获取中" : "获取模型"}
                          </button>
                        </div>
                      </div>
                      <div className="settings-field">
                        <span>推理强度</span>
                        <StyledSelect
                          value={draftAgent.reasoningEffort}
                          options={[
                            { value: "high", label: "High（默认，深度推理）" },
                            { value: "low", label: "Low（更快、更省 Token）" },
                            { value: "off", label: "关闭（不发送推理强度）" },
                          ]}
                          onChange={(value) => updateAgentApiSettings(scope, { reasoningEffort: value as ReasoningEffort })}
                          ariaLabel={`${isCoordinator ? "总调度" : "任务"} Agent 推理强度`}
                        />
                        <small className="settings-field-note">仅在所选模型支持 reasoning_effort 时生效。</small>
                      </div>
                      <label className="settings-field"><span>API Key</span><input type="password" autoComplete="off" maxLength={1000} value={draftAgent.apiKey} disabled={draftAgent.clearApiKey} placeholder={currentAgent.apiKeyConfigured ? "留空以保留当前密钥" : "输入 API Key"} onChange={(event) => { updateAgentApiSettings(scope, { apiKey: event.target.value }); resetModels(); }} /></label>
                      {currentAgent.apiKeyConfigured && <label className="clear-key-control"><input type="checkbox" checked={draftAgent.clearApiKey} onChange={(event) => { updateAgentApiSettings(scope, { clearApiKey: event.target.checked, apiKey: event.target.checked ? "" : draftAgent.apiKey }); resetModels(); }} /><span>清除已保存的 API Key</span></label>}
                      <div className="settings-section-heading image-model-heading">
                        <div><span>{isCoordinator ? "总调度 Agent" : "任务生成流程"}</span><h3>图片模型 API</h3></div>
                        <span className={`config-state ${currentImages.textToImage.apiKeyConfigured && currentImages.imageToImage.apiKeyConfigured ? "configured" : ""}`}><i />{currentImages.textToImage.apiKeyConfigured && currentImages.imageToImage.apiKeyConfigured ? "两项均已配置" : "需要分别配置"}</span>
                      </div>
                      {(["textToImage", "imageToImage"] as const).map((key) => {
                        const label = key === "textToImage" ? "文生图" : "图生图";
                        const current = currentImages[key];
                        const draft = draftImages[key];
                        return <fieldset className="image-model-config" key={key}>
                          <legend>{label}模型</legend>
                          <label className="settings-field"><span>Base URL</span><input type="url" required value={draft.baseUrl} onChange={(event) => updateImageModelSettings(scope, key, { baseUrl: event.target.value })} /></label>
                          <label className="settings-field"><span>模型</span><input type="text" required maxLength={160} value={draft.model} onChange={(event) => updateImageModelSettings(scope, key, { model: event.target.value })} /></label>
                          <label className="settings-field"><span>API Key</span><input type="password" autoComplete="off" maxLength={1000} disabled={draft.clearApiKey} value={draft.apiKey} placeholder={current.apiKeyConfigured ? "留空以保留当前密钥" : "输入 API Key"} onChange={(event) => updateImageModelSettings(scope, key, { apiKey: event.target.value })} /></label>
                          {current.apiKeyConfigured && <label className="clear-key-control"><input type="checkbox" checked={draft.clearApiKey} onChange={(event) => updateImageModelSettings(scope, key, { clearApiKey: event.target.checked, apiKey: event.target.checked ? "" : draft.apiKey })} /><span>清除已保存的 {label} API Key</span></label>}
                        </fieldset>;
                      })}
                    </section>;
                  })()}
                </div>

                <div className="settings-actions">
                  <button type="button" className="secondary-button" onClick={() => setShowSettings(false)}>取消</button>
                  <button type="submit" className="primary-button" disabled={settingsSaving}><Save size={16} />{settingsSaving ? "保存中…" : "保存配置"}</button>
                </div>
              </>
            )}
          </form>
        </div>
      )}

      {assetLibraryWorkspaceId && (
        <div className="modal-backdrop asset-library-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !uiConfirmation) setAssetLibraryWorkspaceId(null); }}>
          <section className="asset-library-modal" role="dialog" aria-modal="true" aria-labelledby="asset-library-title">
            <header className="asset-library-header">
              <div><span>WORKSPACE ASSETS</span><h2 id="asset-library-title">{assetLibraryWorkspace?.name || "工作空间"} · 资产库</h2><p>集中预览和管理当前工作空间内各任务生成的 2D 与 3D 资产。</p></div>
              <button className="icon-button" type="button" onClick={() => setAssetLibraryWorkspaceId(null)} aria-label="关闭资产库"><X size={19} /></button>
            </header>
            <div className="asset-library-body">
              <aside className="asset-library-browser">
                <nav className="asset-library-filters" aria-label="资产类型筛选">
                  {([
                    ["all", "全部"],
                    ["2d", "2D 图片"],
                    ["3d", "全部 3D"],
                    ["model", "静态模型"],
                    ["topology", "拓扑模型"],
                    ["rigged", "绑定模型"],
                  ] as Array<[WorkspaceAssetFilter, string]>).map(([value, label]) => {
                    const count = value === "all"
                      ? workspaceAssets.length
                      : workspaceAssets.filter((asset) => value === "2d" || value === "3d" ? asset.group === value : asset.kind === value).length;
                    return <button type="button" key={value} className={workspaceAssetFilter === value ? "active" : ""} onClick={() => { setWorkspaceAssetFilter(value); setSelectedWorkspaceAssetId(null); }}><span>{label}</span><em>{count}</em></button>;
                  })}
                </nav>
                <div className="asset-library-list" aria-label="资产列表">
                  {workspaceAssetsLoading && <div className="asset-library-empty"><LoaderCircle className="spinning" size={22} /><span>正在读取资产…</span></div>}
                  {!workspaceAssetsLoading && filteredWorkspaceAssets.map((asset) => (
                    <button type="button" className={`asset-library-card ${selectedWorkspaceAsset?.id === asset.id ? "selected" : ""}`} key={asset.id} onClick={() => setSelectedWorkspaceAssetId(asset.id)}>
                      <span className={`asset-library-thumb ${asset.group}`}>
                        {asset.group === "2d"
                          ? <Image src={downloadUrl(asset.previewUrl)} alt={asset.runName} width={160} height={100} unoptimized />
                          : <Box size={24} />}
                        <small>{asset.kind === "image" ? "PNG" : "GLB"}</small>
                      </span>
                      <span className="asset-library-card-copy"><strong>{asset.runName}</strong><small>{asset.label} · {formatFileSize(asset.size)}</small><time>{formatTime(asset.createdAt)}</time></span>
                    </button>
                  ))}
                  {!workspaceAssetsLoading && !filteredWorkspaceAssets.length && <div className="asset-library-empty"><Library size={24} /><strong>暂无此类资产</strong><span>完成对应生成阶段后，资产会自动出现在这里。</span></div>}
                </div>
              </aside>
              <div className="asset-library-detail">
                {selectedWorkspaceAsset ? (
                  <>
                    <header className="asset-library-detail-header">
                      <div><span>{selectedWorkspaceAsset.label}</span><h3>{selectedWorkspaceAsset.runName}</h3><p>{selectedWorkspaceAsset.filename} · {formatFileSize(selectedWorkspaceAsset.size)}</p></div>
                      <div>
                        <button className="secondary-button" type="button" onClick={() => openTask(selectedWorkspaceAsset.runId)}>打开任务</button>
                        <a className="secondary-button" href={downloadUrl(selectedWorkspaceAsset.downloadUrl)} download><Download size={15} />下载</a>
                        <button className="danger-button" type="button" onClick={() => requestDeleteWorkspaceAsset(selectedWorkspaceAsset)}><Trash2 size={15} />删除</button>
                      </div>
                    </header>
                    <div className={`asset-library-preview-frame preview-frame ${selectedWorkspaceAsset.group === "3d" ? "model-preview" : ""}`}>
                      {selectedWorkspaceAsset.group === "2d" ? (
                        <Image className="asset-preview-image" src={downloadUrl(selectedWorkspaceAsset.previewUrl)} alt={`${selectedWorkspaceAsset.runName} ${selectedWorkspaceAsset.label}`} width={1600} height={1600} unoptimized />
                      ) : (
                        <Suspense fallback={<div className="model-loading"><LoaderCircle className="spinning" size={24} /><span>正在加载 3D 资产…</span></div>}>
                          <ModelViewer src={downloadUrl(selectedWorkspaceAsset.previewUrl)} label={`${selectedWorkspaceAsset.runName} ${selectedWorkspaceAsset.label}`} rigged={selectedWorkspaceAsset.rigged} />
                        </Suspense>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="asset-library-detail-empty"><Library size={32} /><h3>选择一个资产进行预览</h3><p>2D 图片和 3D 模型会使用任务生成页相同的预览方式。</p></div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {showCreate && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCreate(false); }}>
          <form className="create-modal" onSubmit={createRun}>
            <div className="modal-header"><div><span>新资产</span><h2>创建角色资产</h2></div><button className="icon-button" type="button" onClick={() => setShowCreate(false)} aria-label="关闭"><X size={19} /></button></div>
            <label>资产名称<input autoFocus required maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：未来城市女飞行员" /></label>
            <div className="create-form-grid">
              <div className="create-select-field"><span>工作空间</span><StyledSelect value={form.workspaceId} options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))} onChange={(value) => setForm({ ...form, workspaceId: value })} ariaLabel="任务所属工作空间" placement="up" /></div>
              <div className="create-select-field"><span>工作流</span><StyledSelect value={form.pipelineType} options={[{ value: "text_to_model", label: "文生图 → T-Pose → 模型 → 绑定" }, { value: "image_to_model", label: "原画 → T-Pose 图 → 模型 → 绑定" }]} onChange={(value) => { const pipelineType = value as "text_to_model" | "image_to_model"; setForm({ ...form, pipelineType }); if (pipelineType === "text_to_model") setTaskSourceImage(null); }} ariaLabel="任务工作流" placement="up" /></div>
            </div>
            {form.pipelineType === "image_to_model" && (
              <div className="task-source-upload" role="button" tabIndex={0} onClick={() => taskSourceFileRef.current?.click()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") taskSourceFileRef.current?.click(); }}>
                <input ref={taskSourceFileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) readImage(file, 12 * 1024 * 1024, "角色原画", setTaskSourceImage); event.currentTarget.value = ""; }} />
                <ImageIcon size={22} /><div><strong>{taskSourceImage?.name || "上传单体角色原画"}</strong><span>{taskSourceImage ? "原画已就绪，创建后将使用图生图模型转换 T-Pose" : "PNG、JPEG 或 WebP，最大 12 MB"}</span></div><Upload size={17} />
              </div>
            )}
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowCreate(false)}>取消</button><button className="primary-button" disabled={busy || (form.pipelineType === "image_to_model" && !taskSourceImage)}>{busy ? "创建中…" : "创建资产"}</button></div>
          </form>
        </div>
      )}

      {showWorkspaceCreate && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowWorkspaceCreate(false); }}>
          <form className="create-modal workspace-create-modal" onSubmit={createWorkspace}>
            <div className="modal-header"><div><span>新空间</span><h2>创建工作空间</h2></div><button className="icon-button" type="button" onClick={() => setShowWorkspaceCreate(false)} aria-label="关闭"><X size={19} /></button></div>
            <label>工作空间名称<input autoFocus required maxLength={80} value={workspaceForm.name} onChange={(event) => setWorkspaceForm({ ...workspaceForm, name: event.target.value })} placeholder="例如：忍者角色系列" /></label>
            <label>说明<textarea rows={4} maxLength={500} value={workspaceForm.description} onChange={(event) => setWorkspaceForm({ ...workspaceForm, description: event.target.value })} placeholder="描述该工作空间要管理的角色、风格或交付目标" /></label>
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowWorkspaceCreate(false)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "创建中…" : "创建工作空间"}</button></div>
          </form>
        </div>
      )}

      {uiConfirmation && (
        <div className="modal-backdrop ui-confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !uiConfirmationBusy) setUiConfirmation(null); }}>
          <div className={`revert-confirm-modal ui-confirmation-modal ${uiConfirmation.tone}`} role="dialog" aria-modal="true" aria-labelledby="ui-confirmation-title">
            <div className="revert-confirm-icon">{uiConfirmation.tone === "danger" ? <Trash2 size={21} /> : <RotateCcw size={21} />}</div>
            <div className="revert-confirm-copy">
              <span>{uiConfirmation.tone === "danger" ? "删除确认" : "操作确认"}</span>
              <h2 id="ui-confirmation-title">{uiConfirmation.title}</h2>
              <p>{uiConfirmation.description}</p>
            </div>
            <div className="revert-confirm-actions">
              <button autoFocus type="button" className="secondary-button" onClick={() => setUiConfirmation(null)} disabled={uiConfirmationBusy}>取消</button>
              <button type="button" className={uiConfirmation.tone === "danger" ? "danger-button" : "warning-button"} onClick={() => void confirmUiAction()} disabled={uiConfirmationBusy}>{uiConfirmationBusy ? <LoaderCircle className="spinning" size={16} /> : uiConfirmation.tone === "danger" ? <Trash2 size={16} /> : <RotateCcw size={16} />}{uiConfirmationBusy ? "处理中…" : uiConfirmation.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
