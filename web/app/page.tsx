"use client";

import Image from "next/image";
import {
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Expand,
  FileJson,
  FolderOpen,
  ImageIcon,
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
  Sparkles,
  Sun,
  Trash2,
  Upload,
  Undo2,
  User,
  X,
} from "lucide-react";
import { CSSProperties, DragEvent as ReactDragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import ModelViewer from "./components/ModelViewer";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8787";

const DEFAULT_POSITIVE_PROMPT =
  "美式3d卡通，1个3d女性角色，Ninjala风格，任天堂风格，潮流配色，(严格正视图:1.3)，完全正对镜头，(严格的T-Pose:1.3)，双臂水平伸展，全身出镜，纯白色背景，极简服装设计，纯净模型，1:1比例，高品质，杰作";
const DEFAULT_NEGATIVE_PROMPT =
  "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲";
const MAX_AGENT_QUEUE_ITEMS = 20;

const stages = [
  { short: "IDEA", title: "角色描述", subtitle: "定义人物与风格", input: "人物设定与提示词", output: "角色规格", action: "确认角色身份、服装、视角和背景。" },
  { short: "2D", title: "概念图生成", subtitle: "Qwen Image", input: "角色规格", output: "PNG 概念图", action: "DGX 执行 Qwen Image 工作流并下载真实 PNG。" },
  { short: "QA", title: "T-Pose 检查", subtitle: "SDPose", input: "2D 概念图", output: "关键点与评分", action: "SDPose 检查单人全身、双臂水平、肘部伸直和左右对称。" },
  { short: "3D", title: "3D 模型生成", subtitle: "Pixal3D", input: "合格 T-Pose PNG", output: "静态 GLB", action: "DGX 执行 Pixal3D 工作流并下载真实静态 GLB。" },
  { short: "RIG", title: "自动绑骨", subtitle: "SkinTokens", input: "静态 GLB", output: "带骨骼 GLB", action: "DGX 执行 SkinTokens，生成 Mixamo 骨骼与蒙皮。" },
  { short: "OUT", title: "资产导出", subtitle: "文件交付", input: "已绑骨 GLB", output: "最终资产", action: "下载后端实际保存的 PNG、静态 GLB 或最终绑骨 GLB。" },
];

type JobType = "none" | "2d" | "qa" | "3d" | "rig";
type JobStatus = "idle" | "running" | "succeeded" | "failed";
type Theme = "light" | "dark";
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
  imageReady: boolean;
  modelReady: boolean;
  riggedReady: boolean;
  imageDownloadUrl: string | null;
  modelDownloadUrl: string | null;
  riggedDownloadUrl: string | null;
};

type Run = {
  id: string;
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
  assets: Assets;
  createdAt: string;
  updatedAt: string;
};

type RunEvent = { id: number; eventType: string; stage: number; message: string; createdAt: string };
type AgentRoleReport = {
  summary?: string;
  decision?: "approve" | "revise" | "manual_review" | "pass" | "repairable" | "reject";
  issues?: string[];
  positivePrompt?: string;
  negativePrompt?: string;
};
type AgentRoleRun = {
  id: string;
  agentRole: "art_director" | "visual_qa";
  triggerType: string;
  sourceKey: string;
  status: "running" | "succeeded" | "failed";
  errorMessage: string;
  reportType: "prompt_plan" | "image_quality_report" | null;
  report: AgentRoleReport | null;
  createdAt: string;
  completedAt: string | null;
};
type RunDetail = { run: Run; events: RunEvent[]; agentRoleRuns?: AgentRoleRun[] };
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
type AppSettings = {
  processes: Record<ProcessKind, ProcessSettings>;
  agent: {
    baseUrl: string;
    model: string;
    apiKeyConfigured: boolean;
    defaultBaseUrl: string;
    defaultModel: string;
  };
};
type SettingsDraft = {
  processes: Record<ProcessKind, {
    mode: "comfyui" | "api";
    url: string;
    activeWorkflowId: string;
    workflowJson: string;
    api?: { baseUrl: string; model: string; apiKey: string };
  }>;
  agent: { baseUrl: string; model: string; apiKey: string; clearApiKey: boolean };
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
      apiKey: "",
      clearApiKey: false,
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

function jobName(type: JobType) {
  return { none: "本地流程", "2d": "Qwen Image", qa: "SDPose", "3d": "Pixal3D", rig: "SkinTokens" }[type];
}

export default function Home() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [viewStage, setViewStage] = useState(0);
  const [system, setSystem] = useState<SystemState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [revertStage, setRevertStage] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState<SettingsDraft | null>(null);
  const [settingsTab, setSettingsTab] = useState<ProcessKind | "agent">("2d");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [agentModelsLoading, setAgentModelsLoading] = useState(false);
  const [agentModels, setAgentModels] = useState<AgentModelOption[]>([]);
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
  const [agentBusy, setAgentBusy] = useState(false);
  const [activeAgentRunId, setActiveAgentRunId] = useState<string | null>(null);
  const [agentQueue, setAgentQueue] = useState<AgentQueueItem[]>([]);
  const [agentAttachment, setAgentAttachment] = useState<AgentAttachment | null>(null);
  const [agentImageDragging, setAgentImageDragging] = useState(false);
  const [form, setForm] = useState({ name: "" });
  const [promptDraft, setPromptDraft] = useState({
    positivePrompt: DEFAULT_POSITIVE_PROMPT,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
  });
  const agentDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const agentQueueRef = useRef<AgentQueueItem[]>([]);
  const agentProcessingRef = useRef(false);
  const agentQueueIdRef = useRef(0);
  const selectedIdRef = useRef<string | null>(selectedId);
  const agentDropDepthRef = useRef(0);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const workflowFileRef = useRef<HTMLInputElement | null>(null);
  const workflowDirectoryRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

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
    setSelectedId(nextId);
    if (!nextId) setDetail(null);
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
        const [runData, systemData] = await Promise.all([
          api<{ runs: Run[] }>("/api/runs"),
          api<SystemState>("/api/system?force=1"),
        ]);
        if (cancelled) return;
        setRuns(runData.runs);
        setSelectedId(runData.runs[0]?.id || null);
        setSystem(systemData);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法连接本地后端");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialize();
    const timer = window.setInterval(() => {
      void api<SystemState>("/api/system").then(setSystem).catch(() => setSystem(null));
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void Promise.all([
      api<RunDetail>(`/api/runs/${selectedId}`),
      api<{ messages: ChatMessage[] }>(`/api/runs/${selectedId}/agent/messages`),
    ])
      .then(([data, agentData]) => {
        if (cancelled) return;
        setDetail(data);
        setChatMessages(agentData.messages);
        setAgentAttachment(null);
        setViewStage(data.run.currentStage);
        setQaBlend(0.5);
        setPromptDraft({
          positivePrompt: data.run.positivePrompt || DEFAULT_POSITIVE_PROMPT,
          negativePrompt: data.run.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
        });
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "任务读取失败");
      });
    return () => { cancelled = true; };
  }, [selectedId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages, agentBusy, agentQueue.length]);

  const hasRunningTask = runs.some((item) => item.jobStatus === "running");
  const selectedTaskIsRunning = runs.some((item) => item.id === selectedId && item.jobStatus === "running");
  const selectedRoleIsRunning = detail?.agentRoleRuns?.some((item) => item.status === "running") === true;

  useEffect(() => {
    if (!hasRunningTask && !selectedRoleIsRunning) return;
    const timer = window.setInterval(() => {
      const detailRequest = selectedId && (selectedTaskIsRunning || selectedRoleIsRunning)
        ? api<RunDetail>(`/api/runs/${selectedId}`)
        : Promise.resolve(null);
      void Promise.all([api<{ runs: Run[] }>("/api/runs"), detailRequest])
        .then(([runData, detailData]) => {
          setRuns(runData.runs);
          if (!detailData) return;
          setDetail(detailData);
          setViewStage(detailData.run.currentStage);
        })
        .catch((reason) => setError(reason instanceof Error ? reason.message : "DGX 状态读取失败"));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningTask, selectedId, selectedRoleIsRunning, selectedTaskIsRunning]);

  const run = detail?.run;
  const artDirectorRun = detail?.agentRoleRuns?.find((item) =>
    (item.reportType === "prompt_plan" || item.agentRole === "art_director")
      && (item.status !== "succeeded" || (
        item.report?.positivePrompt === run?.positivePrompt
        && item.report?.negativePrompt === run?.negativePrompt
      )),
  );
  const visualQaRun = detail?.agentRoleRuns?.find((item) =>
    (item.reportType === "image_quality_report" || item.agentRole === "visual_qa")
      && item.sourceKey === `qa:${run?.jobPromptId}`,
  );
  const current = run?.currentStage ?? 0;
  const stage = stages[viewStage];
  const progress = useMemo(() => Math.round((current / (stages.length - 1)) * 100), [current]);
  const isCurrentView = viewStage === current;
  const visiblePreview = viewStage > 0 && viewStage < 3
    ? viewStage === 2 && run?.qaOverlayPath ? run.qaOverlayPath : run?.previewPath
    : null;
  const hasQaComparison = Boolean(viewStage === 2 && run?.previewPath && run.qaOverlayPath);
  const useRiggedPreview = viewStage >= 4 && run?.assets.riggedReady === true;
  const modelPreviewUrl = viewStage >= 3 && run?.assets.modelReady
    ? downloadUrl(useRiggedPreview ? run.assets.riggedDownloadUrl : run.assets.modelDownloadUrl)
    : null;
  const hasPreview = Boolean(viewStage === 0 || visiblePreview || modelPreviewUrl);
  const currentStageReady = Boolean(
    (current === 1 && run?.assets.imageReady)
      || (current === 2 && run?.qaStatus === "passed")
      || (current === 3 && run?.assets.modelReady)
      || (current === 4 && run?.assets.riggedReady)
      || (current === 5 && run?.status === "completed"),
  );
  const hasPreviewFooter = Boolean(
    isCurrentView
      || (viewStage === 1 && run?.assets.imageReady)
      || (viewStage === 2 && run?.qaScore !== null)
      || (viewStage >= 4 && run?.assets.riggedReady),
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

  async function resetRun() {
    if (!run || busy || !window.confirm("重置会清除当前任务的产物引用和进度，确定继续吗？")) return;
    await runAction("reset", "重置失败");
  }

  async function deleteRun() {
    if (!run || !window.confirm(`确定删除“${run.name}”及其历史记录吗？`)) return;
    setBusy(true);
    try {
      await api(`/api/runs/${run.id}`, { method: "DELETE" });
      setSelectedId(null);
      setDetail(null);
      setChatMessages([]);
      await refreshRuns();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusy(false);
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
      setChatMessages([]);
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
        body: JSON.stringify({ name: form.name }),
      });
      setShowCreate(false);
      setForm({ name: "" });
      setPromptDraft({
        positivePrompt: data.run.positivePrompt || DEFAULT_POSITIVE_PROMPT,
        negativePrompt: data.run.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
      });
      setDetail(data);
      setViewStage(0);
      await refreshRuns(data.run.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
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

  async function removeWorkflow(kind: ProcessKind, workflowId: string) {
    if (!settings || workflowId === settings.processes[kind].defaultWorkflowId || settingsSaving) return;
    const workflow = settings.processes[kind].workflows.find((item) => item.id === workflowId);
    if (!workflow || !window.confirm(`删除“${workflow.name}”？`)) return;
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
  }

  async function fetchAgentModels() {
    if (!settingsForm || agentModelsLoading) return;
    setAgentModelsLoading(true);
    setError("");
    try {
      const result = await api<{ baseUrl: string; models: AgentModelOption[] }>("/api/settings/agent/models", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: settingsForm.agent.baseUrl,
          apiKey: settingsForm.agent.apiKey,
          clearApiKey: settingsForm.agent.clearApiKey,
        }),
      });
      const currentModel = settingsForm.agent.model;
      const models = result.models.some((item) => item.id === currentModel)
        ? result.models
        : [{ id: currentModel, name: `${currentModel}（当前配置）` }, ...result.models];
      setAgentModels(models);
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
        body: JSON.stringify({ processes, agent: settingsForm.agent }),
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

  function attachAgentImage(file: File) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("参考图片只支持 PNG、JPEG 或 WebP");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError("参考图片不能超过 4 MB");
      return;
    }
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const data = value.split(",", 2)[1];
      if (!data) {
        setError("参考图片读取失败");
        return;
      }
      setAgentAttachment({ name: file.name, mimeType: file.type, data, size: file.size });
    };
    reader.onerror = () => setError("参考图片读取失败");
    reader.readAsDataURL(file);
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
      const data = await api<{ messages: ChatMessage[]; detail: RunDetail }>(`/api/runs/${item.runId}/agent/messages`, {
        method: "POST",
        body: JSON.stringify({
          message: item.message,
          image: item.attachment ? { name: item.attachment.name, mimeType: item.attachment.mimeType, data: item.attachment.data } : undefined,
        }),
      });
      if (selectedIdRef.current === item.runId) {
        setChatMessages(data.messages);
        setDetail(data.detail);
        setViewStage(data.detail.run.currentStage);
        setPromptDraft({
          positivePrompt: data.detail.run.positivePrompt || DEFAULT_POSITIVE_PROMPT,
          negativePrompt: data.detail.run.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
        });
      }
      void api<{ runs: Run[] }>("/api/runs").then((runData) => setRuns(runData.runs)).catch(() => undefined);
    } catch (reason) {
      setError(`${item.runName}：${reason instanceof Error ? reason.message : "Agent 请求失败"}`);
      if (selectedIdRef.current === item.runId) {
        try {
          const history = await api<{ messages: ChatMessage[] }>(`/api/runs/${item.runId}/agent/messages`);
          if (selectedIdRef.current === item.runId) setChatMessages(history.messages);
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

  function handleChatKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
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
    ? useRiggedPreview ? "绑骨 GLB" : "静态 GLB"
    : viewStage === 0 ? "角色规格"
    : hasQaComparison ? "SDPose 对比"
    : viewStage === 2 && run?.qaOverlayPath ? "SDPose 覆盖图"
    : run?.previewPath ? "2D 概念图" : "等待资产";
  const selectedRunAgentBusy = agentBusy && activeAgentRunId === run?.id;
  const activeAgentRunName = runs.find((item) => item.id === activeAgentRunId)?.name;

  return (
    <main className={`site-shell ${sidebarCollapsed ? "tasks-collapsed" : ""}`}>
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <span className="brand-mark"><Sparkles size={18} /></span>
            <span className="brand-copy"><strong>Super Idol Master</strong><small>AI Asset Studio</small></span>
          </div>
        </div>
        <div className="topbar-right">
          <div className="system-status">
            <span className="status-pill healthy"><i />API</span>
            <span className={`status-pill ${system?.comfyui.pipelineReady ? "healthy" : "unhealthy"}`}>
              <i />DGX {system?.comfyui.online ? `${system.comfyui.latencyMs} ms` : "离线"}
            </span>
          </div>
          <button className="icon-button" type="button" onClick={toggleTheme} title="切换主题" aria-label="切换浅色或深色主题">
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="icon-button" type="button" onClick={() => void openSettings()} title="请求设置" aria-label="打开请求设置面板">
            <Settings size={18} />
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="关闭错误提示"><X size={17} /></button>
        </div>
      )}

      <div className="app-frame" style={{ "--agent-width": `${agentCollapsed ? 60 : agentWidth}px` } as CSSProperties}>
        <aside className="task-sidebar">
          <div className="sidebar-header">
            <div className="sidebar-copy"><span>任务</span><strong>{runs.length} 个角色资产</strong></div>
            <div className="sidebar-actions">
              <button className="icon-button accent new-task-button" type="button" onClick={() => setShowCreate(true)} title="新建任务" aria-label="新建角色任务">
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
            {loading && <p className="empty-note">正在读取任务…</p>}
            {!loading && runs.length === 0 && <p className="empty-note">还没有角色任务。</p>}
            {runs.map((item) => (
              <button
                key={item.id}
                className={`run-item ${item.id === selectedId ? "selected" : ""}`}
                onClick={() => setSelectedId(item.id)}
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
                  <span className="run-progress"><i style={{ width: `${Math.round((item.currentStage / 5) * 100)}%` }} /></span>
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
                  <p>更新于 {formatTime(run.updatedAt)} · {progress}% 完成</p>
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
                </div>
                <span className="queue-status">队列 {system?.comfyui.queue?.running || 0} 运行 / {system?.comfyui.queue?.pending || 0} 等待</span>
              </div>

              <div className="production-board">
                <nav className="stage-rail" aria-label="资产生成阶段">
                  <div className="stage-rail-header"><span>流程</span><strong>{current + 1} / {stages.length}</strong></div>
                  <div className="stage-list">
                    {stages.map((item, index) => {
                      const state = index < current || (index === current && run.status === "completed") ? "done" : index === current ? "active" : "pending";
                      let stateLabel = state === "done" ? "已完成" : state === "active" ? "当前" : "待处理";
                      if (index === current && currentStageReady && current < 5) stateLabel = "待确认";
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
                                <strong>{stages[0].title}</strong>
                                <p>{stages[0].action}</p>
                              </div>
                              <div className="current-stage-io">
                                <span>输入 <b>{stages[0].input}</b></span>
                                <span>输出 <b>{stages[0].output}</b></span>
                              </div>
                            </div>
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
                        <ModelViewer src={modelPreviewUrl} label={`${run.name} · ${useRiggedPreview ? "绑骨 GLB" : "静态 GLB"}`} rigged={useRiggedPreview} />
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
                    {(isCurrentView || (viewStage === 1 && run.assets.imageReady) || (viewStage >= 3 && run.assets.modelReady) || (viewStage >= 4 && run.assets.riggedReady)) && (
                      <div className="asset-status-row">
                        <div className="asset-status-actions">
                          {isCurrentView && current === 0 && <button className="primary-button" onClick={() => runAction("start", "进入 2D 阶段失败", promptDraft)} disabled={busy || !promptDraft.positivePrompt.trim()}><Play size={16} />确认设定</button>}
                          {isCurrentView && current === 1 && !run.assets.imageReady && <button className="primary-button" onClick={() => runAction("generate-2d", "2D 任务提交失败")} disabled={busy || run.jobStatus === "running"}><Sparkles size={16} />生成 2D 概念图</button>}
                          {isCurrentView && current === 1 && run.assets.imageReady && <button className="secondary-button" onClick={() => runAction("generate-2d", "重新生成失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新生成 2D</button>}
                          {isCurrentView && current === 1 && run.assets.imageReady && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy || run.jobStatus === "running"}><Check size={16} />确认 2D 完成，进入检查</button>}
                          {isCurrentView && current === 2 && run.qaStatus === "failed" && <button className="warning-button" onClick={() => runAction("generate-2d", "重新生成失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新生成 2D</button>}
                          {isCurrentView && current === 2 && run.qaStatus !== "passed" && run.jobStatus !== "running" && <button className="secondary-button" onClick={() => runAction("check-tpose", "姿态检查启动失败")} disabled={busy}><RefreshCw size={16} />{run.qaStatus === "failed" ? "重新检查姿态" : "运行姿态检查"}</button>}
                          {isCurrentView && current === 2 && run.qaStatus === "passed" && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy}><Check size={16} />确认检查通过，进入 3D</button>}
                          {isCurrentView && current === 3 && !run.assets.modelReady && <button className="primary-button" onClick={() => runAction("generate-3d", "3D 任务提交失败")} disabled={busy || run.jobStatus === "running"}><Box size={16} />生成静态 GLB</button>}
                          {isCurrentView && current === 3 && run.assets.modelReady && <button className="secondary-button" onClick={() => runAction("generate-3d", "重新生成失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新生成 3D</button>}
                          {isCurrentView && current === 3 && run.assets.modelReady && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy}><Check size={16} />确认 3D 完成，进入绑骨</button>}
                          {isCurrentView && current === 4 && !run.assets.riggedReady && <button className="primary-button" onClick={() => runAction("rig", "绑骨任务提交失败")} disabled={busy || run.jobStatus === "running"}><Expand size={16} />运行自动绑骨</button>}
                          {isCurrentView && current === 4 && run.assets.riggedReady && <button className="secondary-button" onClick={() => runAction("rig", "重新绑骨失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新运行绑骨</button>}
                          {isCurrentView && current === 4 && run.assets.riggedReady && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy}><Check size={16} />确认绑骨完成，进入导出</button>}
                          {viewStage === 1 && run.assets.imageReady && <a className="download-button" href={downloadUrl(run.assets.imageDownloadUrl)}><Download size={16} />下载 PNG</a>}
                          {viewStage >= 3 && run.assets.modelReady && <a className="download-button" href={downloadUrl(run.assets.modelDownloadUrl)}><Download size={16} />下载静态 GLB</a>}
                          {viewStage >= 4 && run.assets.riggedReady && <a className="download-button primary" href={downloadUrl(run.assets.riggedDownloadUrl)}><Download size={16} />下载最终 GLB</a>}
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
                            <strong>{stages[current].title}</strong>
                            <p>{stages[current].action}</p>
                          </div>
                          <div className="current-stage-io">
                            <span>输入 <b>{stages[current].input}</b></span>
                            <span>输出 <b>{stages[current].output}</b></span>
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
                      {detail.events.slice(0, 8).map((item) => (
                        <div className="event-item" key={item.id}>
                          <span className="event-dot" />
                          <div><strong>{item.message}</strong><span>{stages[item.stage]?.title || "流程"} · {formatTime(item.createdAt)}</span></div>
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
              <span className={`agent-state ${agentBusy ? "busy" : system?.agent.configured ? "" : "unavailable"}`}>
                <i />{agentBusy ? agentQueue.length ? `处理中 · ${agentQueue.length} 排队` : "处理中" : system?.agent.configured ? "待命" : "未配置"}
              </span>
              <button className="icon-button" type="button" onClick={() => setAgentCollapsed((value) => !value)} title={agentCollapsed ? "展开 Agent 面板" : "收起 Agent 面板"} aria-label={agentCollapsed ? "展开 Agent 面板" : "收起 Agent 面板"}>
                {agentCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
              </button>
            </div>
          </div>
          <div className="agent-context">
            <span>任务上下文</span>
            <strong>{run?.name || "未选择任务"}</strong>
            <p>{run ? `${stages[current].title} · ${progress}% 完成` : "选择或创建任务后开始"}</p>
          </div>
          <div className="chat-thread">
            {chatMessages.map((message) => (
              <div className={`chat-message ${message.role}`} key={message.id}>
                <span className="chat-avatar">{message.role === "assistant" ? <Bot size={16} /> : <User size={16} />}</span>
                <div>
                  <strong>{message.role === "assistant" ? "Asset Agent" : "你"}</strong>
                  {message.attachmentName && <span className="chat-attachment"><ImageIcon size={14} />{message.attachmentName}</span>}
                  <p>{message.content}</p>
                </div>
              </div>
            ))}
            {selectedRunAgentBusy && (
              <div className="chat-message assistant pending">
                <span className="chat-avatar"><Bot size={16} /></span>
                <div><strong>Asset Agent</strong><p><LoaderCircle size={15} />正在处理任务</p></div>
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
            <textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={handleChatKeyDown} rows={3} placeholder={agentBusy ? "继续输入，消息将进入待发送队列…" : "给 Agent 下达资产生成任务…"} />
            <div className="composer-footer">
              <div className="composer-meta">
                <span><MessageSquare size={15} />{system?.agent.model || "当前会话"}</span>
              </div>
              <div className="composer-actions">
                {agentBusy && <button className="cancel" type="button" onClick={cancelAgent} aria-label="停止当前 Agent 请求" title="停止当前 Agent 请求"><X size={17} /></button>}
                <button type="submit" disabled={!run || (!chatInput.trim() && !agentAttachment) || agentQueue.length >= MAX_AGENT_QUEUE_ITEMS || system?.agent.configured === false} aria-label={agentBusy ? "加入发送队列" : "发送消息"} title={agentBusy ? "加入发送队列" : "发送消息"}><Send size={17} /></button>
              </div>
            </div>
          </form>
        </aside>
      </div>

      {revertStage !== null && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setRevertStage(null); }}>
          <div className="revert-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="revert-confirm-title">
            <div className="revert-confirm-icon"><RotateCcw size={21} /></div>
            <div className="revert-confirm-copy">
              <span>流程回滚</span>
              <h2 id="revert-confirm-title">回退到“{stages[revertStage].title}”？</h2>
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
                  <button type="button" role="tab" aria-selected={settingsTab === "agent"} className={settingsTab === "agent" ? "active" : ""} onClick={() => { setSettingsTab("agent"); setWorkflowPreviewOpen(false); }}>Agent</button>
                </div>

                <div className="settings-content">
                  {settingsTab !== "agent" ? (
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
                          <label className="settings-field">
                            <span>工作流版本</span>
                            <div className="workflow-select-row">
                              <select value={selectedId} onChange={(event) => void selectWorkflow(kind, event.target.value)}>
                                {process.workflows.map((workflow) => (
                                  <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                                ))}
                              </select>
                              <button className="icon-button" type="button" disabled={!selected || selected.source === "default"} onClick={() => void removeWorkflow(kind, selectedId)} title="删除当前工作流" aria-label="删除当前工作流"><Trash2 size={17} /></button>
                            </div>
                          </label>

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
                  ) : (
                    <section className="agent-settings" aria-label="Agent API 配置">
                      <div className="settings-section-heading">
                        <div><span>Asset Agent</span><h3>模型 API</h3></div>
                        <span className={`config-state ${settings.agent.apiKeyConfigured ? "configured" : ""}`}><i />{settings.agent.apiKeyConfigured ? "已配置" : "未配置"}</span>
                      </div>
                      <label className="settings-field">
                        <span>Base URL</span>
                        <input type="url" required value={settingsForm.agent.baseUrl} onChange={(event) => {
                          setSettingsForm({ ...settingsForm, agent: { ...settingsForm.agent, baseUrl: event.target.value } });
                          setAgentModels([{ id: settingsForm.agent.model, name: settingsForm.agent.model }]);
                        }} />
                      </label>
                      <label className="settings-field">
                        <span>模型</span>
                        <div className="agent-model-row">
                          <select required value={settingsForm.agent.model} onChange={(event) => setSettingsForm({ ...settingsForm, agent: { ...settingsForm.agent, model: event.target.value } })}>
                            {agentModels.map((model) => <option key={model.id} value={model.id}>{model.name === model.id ? model.id : `${model.name} · ${model.id}`}</option>)}
                          </select>
                          <button className="text-icon-button" type="button" onClick={() => void fetchAgentModels()} disabled={agentModelsLoading || settingsForm.agent.clearApiKey}>
                            <RefreshCw className={agentModelsLoading ? "spinning" : ""} size={15} />{agentModelsLoading ? "获取中" : "获取模型"}
                          </button>
                        </div>
                      </label>
                      <label className="settings-field">
                        <span>API Key</span>
                        <input type="password" autoComplete="off" maxLength={1000} value={settingsForm.agent.apiKey} disabled={settingsForm.agent.clearApiKey} placeholder={settings.agent.apiKeyConfigured ? "留空以保留当前密钥" : "输入 API Key"} onChange={(event) => {
                          setSettingsForm({ ...settingsForm, agent: { ...settingsForm.agent, apiKey: event.target.value } });
                          setAgentModels([{ id: settingsForm.agent.model, name: settingsForm.agent.model }]);
                        }} />
                      </label>
                      {settings.agent.apiKeyConfigured && (
                        <label className="clear-key-control">
                          <input type="checkbox" checked={settingsForm.agent.clearApiKey} onChange={(event) => {
                            setSettingsForm({ ...settingsForm, agent: { ...settingsForm.agent, clearApiKey: event.target.checked, apiKey: event.target.checked ? "" : settingsForm.agent.apiKey } });
                            setAgentModels([{ id: settingsForm.agent.model, name: settingsForm.agent.model }]);
                          }} />
                          <span>清除已保存的 API Key</span>
                        </label>
                      )}
                    </section>
                  )}
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

      {showCreate && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCreate(false); }}>
          <form className="create-modal" onSubmit={createRun}>
            <div className="modal-header"><div><span>新资产</span><h2>创建角色资产</h2></div><button className="icon-button" type="button" onClick={() => setShowCreate(false)} aria-label="关闭"><X size={19} /></button></div>
            <label>资产名称<input autoFocus required maxLength={80} value={form.name} onChange={(event) => setForm({ name: event.target.value })} placeholder="例如：未来城市女飞行员" /></label>
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowCreate(false)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "创建中…" : "创建资产"}</button></div>
          </form>
        </div>
      )}
    </main>
  );
}
