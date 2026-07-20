"use client";

import Image from "next/image";
import {
  Bot,
  Box,
  Check,
  Download,
  Expand,
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
  Paperclip,
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
  Undo2,
  User,
  X,
} from "lucide-react";
import { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import ModelViewer from "./components/ModelViewer";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8787";

const DEFAULT_POSITIVE_PROMPT =
  "美式3d卡通，1个3d女性角色，Ninjala风格，任天堂风格，潮流配色，(严格正视图:1.3)，完全正对镜头，(严格的T-Pose:1.3)，双臂水平伸展，全身出镜，纯白色背景，极简服装设计，纯净模型，1:1比例，高品质，杰作";
const DEFAULT_NEGATIVE_PROMPT =
  "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲";

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
type RunDetail = { run: Run; events: RunEvent[] };
type WorkflowCheck = { ready: boolean; missing: string[] };
type ProcessKind = "2d" | "qa" | "3d" | "rig";
type ProcessSettings = {
  label: string;
  url: string;
  workflow: Record<string, unknown>;
  defaultUrl: string;
  defaultWorkflow: Record<string, unknown>;
};
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
  processes: Record<ProcessKind, { url: string; workflowJson: string }>;
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
      url: settings.processes[kind].url,
      workflowJson: JSON.stringify(settings.processes[kind].workflow, null, 2),
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
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState<SettingsDraft | null>(null);
  const [settingsTab, setSettingsTab] = useState<ProcessKind | "agent">("2d");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const [agentWidth, setAgentWidth] = useState(360);
  const [theme, setTheme] = useState<Theme>("dark");
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentAttachment, setAgentAttachment] = useState<AgentAttachment | null>(null);
  const [form, setForm] = useState({ name: "" });
  const [promptDraft, setPromptDraft] = useState({
    positivePrompt: DEFAULT_POSITIVE_PROMPT,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
  });
  const agentDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const agentFileRef = useRef<HTMLInputElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

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
  }, [chatMessages, agentBusy]);

  useEffect(() => {
    if (!selectedId || detail?.run.jobStatus !== "running") return;
    const timer = window.setInterval(() => {
      void api<RunDetail>(`/api/runs/${selectedId}`)
        .then((data) => {
          setDetail(data);
          setViewStage(data.run.currentStage);
          return api<{ runs: Run[] }>("/api/runs");
        })
        .then((data) => setRuns(data.runs))
        .catch((reason) => setError(reason instanceof Error ? reason.message : "DGX 状态读取失败"));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [selectedId, detail?.run.jobStatus]);

  const run = detail?.run;
  const current = run?.currentStage ?? 0;
  const stage = stages[viewStage];
  const progress = useMemo(() => Math.round((current / (stages.length - 1)) * 100), [current]);
  const isCurrentView = viewStage === current;
  const visiblePreview = viewStage < 3
    ? viewStage === 2 && run?.qaOverlayPath ? run.qaOverlayPath : run?.previewPath
    : null;
  const useRiggedPreview = viewStage >= 4 && run?.assets.riggedReady === true;
  const modelPreviewUrl = viewStage >= 3 && run?.assets.modelReady
    ? downloadUrl(useRiggedPreview ? run.assets.riggedDownloadUrl : run.assets.modelDownloadUrl)
    : null;
  const hasPreview = Boolean(visiblePreview || modelPreviewUrl);
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

  async function revertToStage(stageIndex: number) {
    if (!run || busy || run.jobStatus === "running") return;
    const target = stages[stageIndex];
    if (!window.confirm(`回退到“${target.title}”会清除该阶段及后续阶段的产物引用，确定继续吗？`)) return;
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
    setError("");
    try {
      const data = await api<AppSettings>("/api/settings");
      setSettings(data);
      setSettingsForm(settingsDraft(data));
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
      url: settings.processes[kind].defaultUrl,
      workflowJson: JSON.stringify(settings.processes[kind].defaultWorkflow, null, 2),
    });
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!settingsForm || settingsSaving) return;
    const processes = {} as Record<ProcessKind, { url: string; workflow: Record<string, unknown> }>;
    try {
      for (const kind of PROCESS_KINDS) {
        const workflow = JSON.parse(settingsForm.processes[kind].workflowJson);
        processes[kind] = { url: settingsForm.processes[kind].url, workflow };
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

  function selectAgentImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("参考图片只支持 PNG、JPEG 或 WebP");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError("参考图片不能超过 4 MB");
      return;
    }
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

  async function cancelAgent() {
    if (!run || !agentBusy) return;
    try {
      await api(`/api/runs/${run.id}/agent/cancel`, { method: "POST" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "取消 Agent 失败");
    }
  }

  function handleChatKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function sendChatMessage(event: FormEvent) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!run || agentBusy || (!message && !agentAttachment)) return;
    const attachment = agentAttachment;
    const optimisticMessage: ChatMessage = {
      id: -Date.now(),
      role: "user",
      content: message || "请分析这张参考图片并完善角色设定。",
      attachmentName: attachment?.name || null,
      attachmentMime: attachment?.mimeType || null,
      createdAt: new Date().toISOString(),
    };
    setChatMessages((items) => [...items, optimisticMessage]);
    setChatInput("");
    setAgentAttachment(null);
    setAgentBusy(true);
    setError("");
    try {
      const data = await api<{ messages: ChatMessage[]; detail: RunDetail }>(`/api/runs/${run.id}/agent/messages`, {
        method: "POST",
        body: JSON.stringify({
          message,
          image: attachment ? { name: attachment.name, mimeType: attachment.mimeType, data: attachment.data } : undefined,
        }),
      });
      setChatMessages(data.messages);
      setDetail(data.detail);
      setViewStage(data.detail.run.currentStage);
      setPromptDraft({
        positivePrompt: data.detail.run.positivePrompt || DEFAULT_POSITIVE_PROMPT,
        negativePrompt: data.detail.run.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
      });
      await refreshRuns(run.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent 请求失败");
      void api<{ messages: ChatMessage[] }>(`/api/runs/${run.id}/agent/messages`)
        .then((data) => setChatMessages(data.messages))
        .catch(() => setChatMessages((items) => items.filter((item) => item.id !== optimisticMessage.id)));
    } finally {
      setAgentBusy(false);
    }
  }

  const previewType = modelPreviewUrl
    ? useRiggedPreview ? "绑骨 GLB" : "静态 GLB"
    : viewStage === 2 && run?.qaOverlayPath ? "SDPose 覆盖图"
    : run?.previewPath ? "2D 概念图" : "等待资产";

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
                <span className="run-avatar">{item.name.trim().slice(0, 1).toUpperCase() || "R"}</span>
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
                            onClick={() => setViewStage(index)}
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
                    <div className={`preview-frame ${modelPreviewUrl ? "model-preview" : ""} ${hasPreview ? "" : "placeholder"} ${run.jobStatus === "running" ? "generating" : ""}`}>
                      {modelPreviewUrl ? (
                        <ModelViewer src={modelPreviewUrl} label={`${run.name} · ${useRiggedPreview ? "绑骨 GLB" : "静态 GLB"}`} rigged={useRiggedPreview} />
                      ) : visiblePreview ? (
                        <Image src={visiblePreview} alt={`${run.name} 的角色预览`} width={1600} height={1600} priority unoptimized />
                      ) : (
                        <div className="preview-empty"><ImageIcon size={38} /><strong>{stage.title}</strong><span>等待本阶段真实产物</span></div>
                      )}
                      {run.jobStatus === "running" && (
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
                    <div className="asset-status-row">
                      <span className={run.assets.imageReady ? "ready" : "waiting"}><ImageIcon size={15} />PNG</span>
                      <span className={run.assets.modelReady ? "ready" : "waiting"}><Box size={15} />静态 GLB</span>
                      <span className={run.assets.riggedReady ? "ready" : "waiting"}><Expand size={15} />绑骨 GLB</span>
                      {viewStage >= 3 && run.assets.modelReady && (
                        <div className="asset-status-actions">
                          {isCurrentView && current === 3 && <button className="secondary-button" onClick={() => runAction("generate-3d", "重新生成失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新生成 3D</button>}
                          {isCurrentView && current === 3 && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy}><Check size={16} />确认 3D 完成，进入绑骨</button>}
                          <a className="download-button" href={downloadUrl(run.assets.modelDownloadUrl)}><Download size={16} />下载静态 GLB</a>
                        </div>
                      )}
                    </div>
                  </div>

                  {hasPreviewFooter && <section className="stage-workflow-panel">
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

                      {isCurrentView && current === 0 && (
                        <div className="stage-prompt-editor">
                          <label>
                            <span>正向提示词</span>
                            <textarea rows={5} maxLength={4000} value={promptDraft.positivePrompt} onChange={(event) => setPromptDraft({ ...promptDraft, positivePrompt: event.target.value })} />
                          </label>
                          <label>
                            <span>负向提示词</span>
                            <textarea rows={4} maxLength={2000} value={promptDraft.negativePrompt} onChange={(event) => setPromptDraft({ ...promptDraft, negativePrompt: event.target.value })} />
                          </label>
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

                      <div className="preview-actions">
                        {isCurrentView && current === 0 && <button className="primary-button" onClick={() => runAction("start", "进入 2D 阶段失败", promptDraft)} disabled={busy || !promptDraft.positivePrompt.trim()}><Play size={16} />确认设定</button>}
                        {isCurrentView && current === 1 && !run.assets.imageReady && <button className="primary-button" onClick={() => runAction("generate-2d", "2D 任务提交失败")} disabled={busy || run.jobStatus === "running"}><Sparkles size={16} />生成 2D 概念图</button>}
                        {isCurrentView && current === 1 && run.assets.imageReady && <button className="secondary-button" onClick={() => runAction("generate-2d", "重新生成失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新生成 2D</button>}
                        {isCurrentView && current === 1 && run.assets.imageReady && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy || run.jobStatus === "running"}><Check size={16} />确认 2D 完成，进入检查</button>}
                        {isCurrentView && current === 2 && run.qaStatus === "failed" && <button className="warning-button" onClick={() => runAction("generate-2d", "重新生成失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新生成 2D</button>}
                        {isCurrentView && current === 2 && run.qaStatus !== "passed" && run.jobStatus !== "running" && <button className="secondary-button" onClick={() => runAction("check-tpose", "姿态检查启动失败")} disabled={busy}><RefreshCw size={16} />{run.qaStatus === "failed" ? "重新检查姿态" : "运行姿态检查"}</button>}
                        {isCurrentView && current === 2 && run.qaStatus === "passed" && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy}><Check size={16} />确认检查通过，进入 3D</button>}
                        {isCurrentView && current === 3 && !run.assets.modelReady && <button className="primary-button" onClick={() => runAction("generate-3d", "3D 任务提交失败")} disabled={busy || run.jobStatus === "running"}><Box size={16} />生成静态 GLB</button>}
                        {isCurrentView && current === 4 && !run.assets.riggedReady && <button className="primary-button" onClick={() => runAction("rig", "绑骨任务提交失败")} disabled={busy || run.jobStatus === "running"}><Expand size={16} />运行自动绑骨</button>}
                        {isCurrentView && current === 4 && run.assets.riggedReady && <button className="secondary-button" onClick={() => runAction("rig", "重新绑骨失败")} disabled={busy || run.jobStatus === "running"}><RefreshCw size={16} />重新运行绑骨</button>}
                        {isCurrentView && current === 4 && run.assets.riggedReady && <button className="primary-button" onClick={() => runAction("advance", "阶段确认失败")} disabled={busy}><Check size={16} />确认绑骨完成，进入导出</button>}
                        {viewStage === 1 && run.assets.imageReady && <a className="download-button" href={downloadUrl(run.assets.imageDownloadUrl)}><Download size={16} />下载 PNG</a>}
                        {viewStage >= 4 && run.assets.riggedReady && <a className="download-button primary" href={downloadUrl(run.assets.riggedDownloadUrl)}><Download size={16} />下载最终 GLB</a>}
                      </div>
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

        <aside className={`agent-panel ${agentCollapsed ? "agent-collapsed" : ""}`}>
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
                <i />{agentBusy ? "处理中" : system?.agent.configured ? "待命" : "未配置"}
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
            {agentBusy && (
              <div className="chat-message assistant pending">
                <span className="chat-avatar"><Bot size={16} /></span>
                <div><strong>Asset Agent</strong><p><LoaderCircle size={15} />正在处理任务</p></div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-composer" onSubmit={sendChatMessage}>
            {agentAttachment && (
              <div className="attachment-chip">
                <ImageIcon size={14} /><span>{agentAttachment.name}</span>
                <button type="button" onClick={() => setAgentAttachment(null)} title="移除图片" aria-label="移除参考图片"><X size={14} /></button>
              </div>
            )}
            <textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={handleChatKeyDown} rows={3} placeholder="给 Agent 下达资产生成任务…" disabled={agentBusy} />
            <div className="composer-footer">
              <div className="composer-meta">
                <input ref={agentFileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={selectAgentImage} hidden />
                <button className="attach-button" type="button" onClick={() => agentFileRef.current?.click()} disabled={agentBusy || !run} aria-label="添加参考图片" title="添加参考图片"><Paperclip size={16} /></button>
                <span><MessageSquare size={15} />{system?.agent.model || "当前会话"}</span>
              </div>
              {agentBusy
                ? <button type="button" onClick={cancelAgent} aria-label="停止 Agent" title="停止 Agent"><X size={17} /></button>
                : <button type="submit" disabled={!run || (!chatInput.trim() && !agentAttachment) || system?.agent.configured === false} aria-label="发送消息" title="发送消息"><Send size={17} /></button>}
            </div>
          </form>
        </aside>
      </div>

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
                    <button key={kind} type="button" role="tab" aria-selected={settingsTab === kind} className={settingsTab === kind ? "active" : ""} onClick={() => setSettingsTab(kind)}>
                      {kind === "qa" ? "QA" : kind.toUpperCase()}
                    </button>
                  ))}
                  <button type="button" role="tab" aria-selected={settingsTab === "agent"} className={settingsTab === "agent" ? "active" : ""} onClick={() => setSettingsTab("agent")}>Agent</button>
                </div>

                <div className="settings-content">
                  {settingsTab !== "agent" ? (
                    <section className="process-settings" aria-label={`${settings.processes[settingsTab].label}配置`}>
                      <div className="settings-section-heading">
                        <div><span>ComfyUI</span><h3>{settings.processes[settingsTab].label}</h3></div>
                        <button className="text-icon-button" type="button" onClick={() => restoreProcessDefaults(settingsTab)}><RotateCcw size={15} />恢复默认</button>
                      </div>
                      <label className="settings-field">
                        <span>请求地址</span>
                        <input type="url" required value={settingsForm.processes[settingsTab].url} onChange={(event) => updateProcessSettings(settingsTab, { url: event.target.value })} />
                      </label>
                      <label className="settings-field workflow-field">
                        <span>工作流 JSON</span>
                        <textarea spellCheck={false} required value={settingsForm.processes[settingsTab].workflowJson} onChange={(event) => updateProcessSettings(settingsTab, { workflowJson: event.target.value })} />
                      </label>
                      <div className="workflow-json-status">
                        {(() => {
                          try {
                            const graph = JSON.parse(settingsForm.processes[settingsTab].workflowJson);
                            return <><i className="valid" /><span>{Object.keys(graph).length} 个节点</span></>;
                          } catch {
                            return <><i className="invalid" /><span>JSON 格式错误</span></>;
                          }
                        })()}
                      </div>
                    </section>
                  ) : (
                    <section className="agent-settings" aria-label="Agent API 配置">
                      <div className="settings-section-heading">
                        <div><span>Asset Agent</span><h3>模型 API</h3></div>
                        <span className={`config-state ${settings.agent.apiKeyConfigured ? "configured" : ""}`}><i />{settings.agent.apiKeyConfigured ? "已配置" : "未配置"}</span>
                      </div>
                      <label className="settings-field">
                        <span>Base URL</span>
                        <input type="url" required value={settingsForm.agent.baseUrl} onChange={(event) => setSettingsForm({ ...settingsForm, agent: { ...settingsForm.agent, baseUrl: event.target.value } })} />
                      </label>
                      <label className="settings-field">
                        <span>模型</span>
                        <input required maxLength={160} value={settingsForm.agent.model} onChange={(event) => setSettingsForm({ ...settingsForm, agent: { ...settingsForm.agent, model: event.target.value } })} />
                      </label>
                      <label className="settings-field">
                        <span>API Key</span>
                        <input type="password" autoComplete="off" maxLength={1000} value={settingsForm.agent.apiKey} disabled={settingsForm.agent.clearApiKey} placeholder={settings.agent.apiKeyConfigured ? "留空以保留当前密钥" : "输入 API Key"} onChange={(event) => setSettingsForm({ ...settingsForm, agent: { ...settingsForm.agent, apiKey: event.target.value } })} />
                      </label>
                      {settings.agent.apiKeyConfigured && (
                        <label className="clear-key-control">
                          <input type="checkbox" checked={settingsForm.agent.clearApiKey} onChange={(event) => setSettingsForm({ ...settingsForm, agent: { ...settingsForm.agent, clearApiKey: event.target.checked, apiKey: event.target.checked ? "" : settingsForm.agent.apiKey } })} />
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
