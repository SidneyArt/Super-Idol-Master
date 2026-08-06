"use client";

import { type FormEvent, type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useCoordinator } from "./coordinator";
import {
  GlobalSettingsDialog,
  SettingsDialog,
  PROCESS_KINDS,
  type AgentApiDraft,
  type ImageModelDraft,
  type SettingsDraft,
  type TopologyApiDraft,
  settingsDraft,
  useSettingsState,
} from "./settings";
import { useTaskAgent } from "./task-agent";
import { API_BASE, api } from "../shared/api-client";
import type {
  AgentAttachment,
  AgentModelOption,
  AppNotification,
  AppSettings,
  ApprovalMode,
  ApprovalRequest,
  GlobalPreferences,
  ProcessKind,
  ReasoningEffort,
  Run,
  RunDetail,
  SystemState,
  Theme,
  WorkflowMetadata,
  Workspace,
  WorkspaceAsset,
  WorkspaceAssetFilter,
} from "../shared/contracts";
import {
  formatFileSize,
  formatMemory,
  jobName,
} from "../shared/formatters";
import {
  buildDispatcherTimeline,
  preferredHomeWorkspaceId,
  workspaceAssetsFromRuns,
} from "../shared/selectors";
import {
  ClientTime,
  StyledSelect,
} from "../shared/ui";
import { usePollingQuery } from "../shared/use-polling-query";

const DEFAULT_POSITIVE_PROMPT =
  "美式3d卡通，1个3d女性角色，Ninjala风格，任天堂风格，潮流配色，(严格正视图:1.3)，完全正对镜头，(严格的T-Pose:1.3)，双臂水平伸展，全身出镜，纯白色背景，极简服装设计，纯净模型，1:1比例，高品质，杰作";
const DEFAULT_NEGATIVE_PROMPT =
  "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲";
const stages = [
  { short: "IDEA", title: "角色输入", subtitle: "上传或生成角色参考图", input: "人物设定与提示词", output: "角色规格", action: "确认角色身份、服装、视角和背景。" },
  { short: "2D", title: "姿态标准化", subtitle: "将角色调整为标准建模姿态", input: "角色规格", output: "PNG 概念图", action: "调用已配置的 StepFun 图片 API 或 DGX Qwen Image，并下载真实 PNG。" },
  { short: "QA", title: "姿态质量检查", subtitle: "检查对称性、肢体角度与遮挡", input: "2D 概念图", output: "关键点与评分", action: "SDPose 检查单人全身、双臂水平、肘部伸直和左右对称。" },
  { short: "3D", title: "三维重建", subtitle: "根据角色图生成静态三维模型", input: "合格 T-Pose PNG", output: "静态 GLB", action: "DGX 执行 Pixal3D 工作流并下载真实静态 GLB。" },
  { short: "TOPO", title: "网格优化", subtitle: "降低面数并优化模型拓扑", input: "静态 GLB", output: "四边面派生拓扑 GLB", action: "DGX 执行 AutoRemesher 重拓扑，并通过 Blender 回烘纹理；GLB 导出时按 glTF 规范三角化。" },
  { short: "RIG", title: "骨骼绑定", subtitle: "生成人体骨骼与蒙皮权重", input: "拓扑 GLB", output: "带骨骼 GLB", action: "DGX 使用拓扑模型执行 SkinTokens，生成 Mixamo 骨骼与蒙皮。" },
  { short: "OUT", title: "资产导出", subtitle: "校验并导出可用的 3D 文件", input: "已绑骨 GLB", output: "最终资产", action: "下载后端实际保存的 PNG、静态 GLB 或最终绑骨 GLB。" },
];

type UiConfirmation = {
  title: string;
  description: string;
  confirmLabel: string;
  tone: "warning" | "danger";
  action: () => Promise<void>;
};
const DEFAULT_GLOBAL_PREFERENCES: GlobalPreferences = {
  defaultTheme: "dark",
  backgroundAnimationEnabled: false,
  notificationsEnabled: true,
  defaultApprovalMode: "request",
};

type StudioProps = {
  initialRunId: string | null;
  initialWorkspaceId: string | null;
  initialNotificationId: number | null;
  initialRuns: Run[];
  initialWorkspaces: Workspace[];
};

export function useStudioState({ initialRunId, initialWorkspaceId: requestedWorkspaceId, initialNotificationId, initialRuns, initialWorkspaces }: StudioProps) {
  const router = useRouter();
  const screen: "home" | "task" = initialRunId ? "task" : "home";
  const initialRun = initialRuns.find((item) => item.id === initialRunId);
  const startingWorkspaceId = initialRun?.workspaceId
    || requestedWorkspaceId
    || preferredHomeWorkspaceId(initialWorkspaces);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(initialWorkspaces);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(startingWorkspaceId);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(() => new Set([startingWorkspaceId]));
  const [runs, setRuns] = useState<Run[]>(initialRuns);
  const [selectedId, setSelectedId] = useState<string | null>(initialRunId);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [viewStage, setViewStage] = useState(0);
  const [system, setSystem] = useState<SystemState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(initialRuns.length === 0);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [revertStage, setRevertStage] = useState<number | null>(null);
  const [uiConfirmation, setUiConfirmation] = useState<UiConfirmation | null>(null);
  const [uiConfirmationBusy, setUiConfirmationBusy] = useState(false);
  const [taskAgentMode, setTaskAgentMode] = useState<ApprovalMode>("request");
  const [coordinatorMode, setCoordinatorMode] = useState<ApprovalMode>("request");
  const notificationsEnabledRef = useRef(DEFAULT_GLOBAL_PREFERENCES.notificationsEnabled);
  const settingsController = useSettingsState(DEFAULT_GLOBAL_PREFERENCES, {
    setError,
    setSystem,
    notificationsEnabledRef,
    onNotificationsDisabled: () => { setShowNotifications(false); setToastQueue([]); },
    setCoordinatorMode,
    refreshActivity: (showToast) => refreshActivity(showToast),
    requestConfirmation: setUiConfirmation,
  });
  const {
    showSettings, setShowSettings, settings, setSettings, settingsForm, setSettingsForm,
    settingsTab, setSettingsTab, settingsLoading, setSettingsLoading, settingsSaving, setSettingsSaving,
    systemRefreshing, setSystemRefreshing, agentModelsLoading, setAgentModelsLoading,
    agentModels, setAgentModels, coordinatorModels, setCoordinatorModels,
    showGlobalSettings, setShowGlobalSettings, globalPreferences, setGlobalPreferences,
    globalPreferencesDraft, setGlobalPreferencesDraft, globalSettingsLoading, setGlobalSettingsLoading,
    globalSettingsSaving, setGlobalSettingsSaving, workflowPreviewOpen, setWorkflowPreviewOpen,
    workflowDragging, setWorkflowDragging, workflowFileRef, workflowDirectoryRef,
    refreshSystemStatus, openSettings, openGlobalSettings, saveGlobalSettings,
    updateProcessSettings, updateAgentApiSettings, updateTopologySettings,
    restoreTopologyDefaults, updateImageModelSettings, restoreProcessDefaults,
    selectWorkflow, handleWorkflowFiles, chooseWorkflowDirectory, removeWorkflow,
    fetchAgentModels, saveSettings,
  } = settingsController;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");
  const [themeReady, setThemeReady] = useState(false);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [qaBlend, setQaBlend] = useState(0.5);
  const [promptDraft, setPromptDraft] = useState({
    positivePrompt: DEFAULT_POSITIVE_PROMPT,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
  });
  const [showWorkspaceCreate, setShowWorkspaceCreate] = useState(false);
  const [assetLibraryWorkspaceId, setAssetLibraryWorkspaceId] = useState<string | null>(null);
  const [workspaceAssets, setWorkspaceAssets] = useState<WorkspaceAsset[]>([]);
  const [workspaceAssetFilter, setWorkspaceAssetFilter] = useState<WorkspaceAssetFilter>("all");
  const [selectedWorkspaceAssetId, setSelectedWorkspaceAssetId] = useState<string | null>(null);
  const [workspaceAssetsLoading, setWorkspaceAssetsLoading] = useState(false);
  const [workspaceForm, setWorkspaceForm] = useState({ name: "", description: "" });
  const [form, setForm] = useState({ name: "", workspaceId: "default", pipelineType: "text_to_model" as "text_to_model" | "image_to_model" });
  const [taskSourceImage, setTaskSourceImage] = useState<AgentAttachment | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [notificationAction, setNotificationAction] = useState<number | "read-all" | "clear" | null>(null);
  const [notificationFocusId, setNotificationFocusId] = useState<number | null>(initialNotificationId);
  const [toastQueue, setToastQueue] = useState<AppNotification[]>([]);
  const [showFullEvents, setShowFullEvents] = useState(false);
  const [approvalBusyId, setApprovalBusyId] = useState<number | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const selectedWorkspaceIdRef = useRef(selectedWorkspaceId);
  const notificationCenterRef = useRef<HTMLDivElement | null>(null);
  const taskSourceFileRef = useRef<HTMLInputElement | null>(null);
  const latestNotificationIdRef = useRef(0);
  const notificationsInitializedRef = useRef(false);
  const toastNotification = toastQueue[0] || null;

  const taskAgentRun = detail?.run.id === selectedId
    ? detail.run
    : runs.find((item) => item.id === selectedId) || null;
  const taskAgent = useTaskAgent({
    run: taskAgentRun,
    configured: system?.agent.configured,
    onDetail: (nextDetail) => {
      setDetail(nextDetail);
      setViewStage(nextDetail.run.currentStage);
      setPromptDraft({
        positivePrompt: nextDetail.run.positivePrompt || DEFAULT_POSITIVE_PROMPT,
        negativePrompt: nextDetail.run.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
      });
    },
    onRunsChanged: setRuns,
    onActivity: refreshActivity,
    onError: setError,
    requestConfirmation: setUiConfirmation,
  });
  const coordinator = useCoordinator({
    workspaceId: selectedWorkspaceId,
    configured: settings?.coordinator.agent.apiKeyConfigured,
    onWorkspacesChanged: setWorkspaces,
    onRunsChanged: setRuns,
    onActivity: refreshActivity,
    onError: setError,
    requestConfirmation: setUiConfirmation,
  });
  const { status: { activeRunId: activeAgentRunId }, panel: { collapsed: agentCollapsed, width: agentWidth } } = taskAgent;
  const {
    conversation: { messages: dispatcherMessages, sessionId: dispatcherSessionId },
    activity: { generations: dispatcherGenerations, taskBatches: dispatcherTaskBatches },
  } = coordinator;

  function openHome() {
    router.push("/");
  }

  useEffect(() => {
    if (!error) return;
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(""), 8000);
    return () => {
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current);
        errorTimerRef.current = null;
      }
    };
  }, [error]);

  function closeError() {
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setError("");
  }

  function openTask(runId: string) {
    router.push(`/?task=${encodeURIComponent(runId)}`);
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
    selectedIdRef.current = runId;
    setSelectedId(runId);
  }

  function selectWorkspace(workspaceId: string) {
    selectedWorkspaceIdRef.current = workspaceId;
    setSelectedWorkspaceId(workspaceId);
    setExpandedWorkspaceIds(new Set([workspaceId]));
  }

  function toggleWorkspace(workspaceId: string) {
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }

  useEffect(() => {
    // 优先使用用户已保存的主题；没有保存过则用全局默认主题（后端 defaultTheme）
    const saved = window.localStorage.getItem("sim-theme");
    const resolved = saved === "light" || saved === "dark"
      ? saved
      : globalPreferences.defaultTheme === "light" || globalPreferences.defaultTheme === "dark"
        ? globalPreferences.defaultTheme
        : "dark";
    document.documentElement.dataset.theme = resolved;
    setTheme(resolved);
    window.localStorage.setItem("sim-theme", resolved);
    setThemeReady(true);
  }, [globalPreferences.defaultTheme]);

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
      try {
        const data = await api<{ runs: Run[] }>(`/api/runs?workspaceId=${encodeURIComponent(workspaceId)}`);
        const fallbackAssets = workspaceAssetsFromRuns(data.runs, workspaceId);
        setWorkspaceAssets(fallbackAssets);
        setSelectedWorkspaceAssetId(fallbackAssets[0]?.id || null);
      } catch (fallbackReason) {
        setAssetLibraryWorkspaceId(null);
        setError(fallbackReason instanceof Error ? fallbackReason.message : reason instanceof Error ? reason.message : "资产库加载失败");
      }
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

  async function refreshActivity(showToast = false, signal?: AbortSignal) {
    const runId = selectedIdRef.current;
    const workspaceId = selectedWorkspaceIdRef.current || "default";
    const sessionId = dispatcherSessionId;
    const controlParams = new URLSearchParams({ workspaceId });
    if (runId) controlParams.set("runId", runId);
    if (sessionId) controlParams.set("sessionId", sessionId);
    const [controls, notificationData] = await Promise.all([
      api<{ coordinatorMode: ApprovalMode; taskMode: ApprovalMode | null; approvals: ApprovalRequest[] }>(`/api/agent-controls?${controlParams.toString()}`, { signal }),
      api<{ notifications: AppNotification[] }>("/api/notifications?limit=50", { signal }),
    ]);
    if (
      signal?.aborted
      || workspaceId !== selectedWorkspaceIdRef.current
      || runId !== selectedIdRef.current
      || !coordinator.isCurrent(workspaceId, sessionId)
    ) return;
    setCoordinatorMode(controls.coordinatorMode);
    if (controls.taskMode) setTaskAgentMode(controls.taskMode);
    setApprovals(controls.approvals);
    setNotifications(notificationData.notifications);
    const newest = notificationData.notifications[0];
    if (newest) {
      if (showToast && notificationsEnabledRef.current && notificationsInitializedRef.current && newest.id > latestNotificationIdRef.current) {
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
  }, [setShowSettings, showSettings]);

  useEffect(() => {
    if (!showGlobalSettings) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowGlobalSettings(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [setShowGlobalSettings, showGlobalSettings]);

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
    const workspaceSelectionAtStart = selectedWorkspaceIdRef.current;
    const runSelectionAtStart = selectedIdRef.current;
    async function initialize() {
      try {
        const [runData, workspaceData, settingsData, preferencesData] = await Promise.all([
          api<{ runs: Run[] }>("/api/runs"),
          api<{ workspaces: Workspace[] }>("/api/workspaces"),
          api<AppSettings>("/api/settings"),
          api<GlobalPreferences>("/api/ui-preferences"),
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
          || preferredHomeWorkspaceId(workspaceData.workspaces);
        const nextRunId = requestedRun?.id || runData.runs[0]?.id || null;
        if (selectedWorkspaceIdRef.current === workspaceSelectionAtStart) {
          selectedWorkspaceIdRef.current = nextWorkspaceId;
          setSelectedWorkspaceId(nextWorkspaceId);
        }
        if (selectedIdRef.current === runSelectionAtStart) {
          selectedIdRef.current = nextRunId;
          setSelectedId(nextRunId);
        }
        setSettings(settingsData);
        setGlobalPreferences(preferencesData);
        setGlobalPreferencesDraft(preferencesData);
        notificationsEnabledRef.current = preferencesData.notificationsEnabled;
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
    return () => {
      cancelled = true;
    };
  }, [
    initialRunId,
    requestedWorkspaceId,
    setGlobalPreferences,
    setGlobalPreferencesDraft,
    setSettings,
  ]);

  usePollingQuery({
    key: "system",
    foregroundMs: 15_000,
    backgroundMs: 60_000,
    query: (_key, signal) => api<SystemState>("/api/system", { signal }),
    onData: setSystem,
    onError: () => setSystem(null),
  });

  const activityPollKey = `${selectedWorkspaceId}:${selectedId || ""}:${dispatcherSessionId}`;
  usePollingQuery({
    key: activityPollKey,
    foregroundMs: 3_000,
    backgroundMs: 30_000,
    query: async (_key, signal) => {
      await refreshActivity(true, signal);
      return null;
    },
    onData: () => undefined,
  });

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

  const selectedDetail = detail?.run.id === selectedId ? detail : null;
  const hasRunningTask = runs.some((item) => item.jobStatus === "running");
  const selectedTaskIsRunning = runs.some((item) => item.id === selectedId && item.jobStatus === "running");
  const selectedRoleIsRunning = selectedDetail?.agentRoleRuns?.some((item) => item.status === "running") === true;
  const selectedPlanIsRunning = selectedDetail?.agentWorkflowPlan?.status === "running";

  usePollingQuery({
    key: "runs",
    foregroundMs: hasRunningTask ? 1_000 : 10_000,
    backgroundMs: hasRunningTask ? 15_000 : 30_000,
    query: (_key, signal) => api<{ runs: Run[] }>("/api/runs", { signal }),
    onData: (data) => setRuns(data.runs),
    onError: (reason) => {
      if (hasRunningTask) {
        setError(reason instanceof Error ? reason.message : "任务列表读取失败");
      }
    },
  });

  usePollingQuery({
    key: selectedId || "",
    enabled: Boolean(selectedId),
    foregroundMs: selectedTaskIsRunning || selectedRoleIsRunning || selectedPlanIsRunning
      ? 1_000
      : 10_000,
    backgroundMs: 30_000,
    query: (runId, signal) => api<RunDetail>(`/api/runs/${runId}`, { signal }),
    onData: (runDetail, runId) => {
      if (selectedIdRef.current !== runId) return;
      const changedRun = detail?.run.id !== runId;
      setDetail(runDetail);
      if (changedRun) {
        setViewStage(runDetail.run.currentStage);
        setQaBlend(0.5);
        setPromptDraft({
          positivePrompt: runDetail.run.positivePrompt || DEFAULT_POSITIVE_PROMPT,
          negativePrompt: runDetail.run.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
        });
      }
    },
    onError: (reason, runId) => {
      if (selectedIdRef.current === runId) {
        setError(reason instanceof Error ? reason.message : "任务读取失败");
      }
    },
  });

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
      if (!target) {
        coordinator.panel.scrollToEnd();
        setNotificationFocusId(null);
        window.history.replaceState(null, "", "/");
        return;
      }
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("notification-target-highlight");
      window.setTimeout(() => target?.classList.remove("notification-target-highlight"), 2200);
      setNotificationFocusId(null);
      window.history.replaceState(null, "", "/");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    coordinator.panel,
    dispatcherGenerations,
    notificationFocusId,
    notifications,
    screen,
    selectedWorkspaceId,
  ]);

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
      ? { ...item, title: "角色输入", subtitle: "上传角色原画", input: "单体角色原画", output: "角色规格", action: "确认单体原画、角色身份、服装和 T-Pose 转换提示词。" }
      : index === 1
        ? { ...item, title: "姿态标准化", subtitle: "将角色调整为标准建模姿态", input: "单体角色原画", output: "T-Pose PNG", action: "使用图生图模型保持角色身份并转换为标准 T-Pose。" }
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
      title: `删除"${runName}"？`,
      description: "任务、流程进度、Agent 对话和历史记录都会被永久删除。",
      confirmLabel: "确认删除",
      tone: "danger",
      action: async () => {
        setBusy(true);
        try {
          await api(`/api/runs/${runId}`, { method: "DELETE" });
          selectRun(null);
          setDetail(null);
          await refreshRuns();
          setError(`"${runName}" 已删除，即将返回首页…`);
          setTimeout(() => {
            if (selectedIdRef.current === null) openHome();
          }, 2000);
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

  function requestDeleteWorkspace(workspace: Workspace) {
    if (workspace.id === "default" || busy) return;
    setUiConfirmation({
      title: `删除“${workspace.name}”？`,
      description: `该工作空间中的 ${workspace.taskCount} 个任务、Agent 对话、审批记录和生成资产都会被永久删除。此操作无法撤销。`,
      confirmLabel: "删除工作空间",
      tone: "danger",
      action: async () => {
        setBusy(true);
        setError("");
        try {
          const data = await api<{ workspaces: Workspace[] }>(`/api/workspaces/${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
          const runData = await api<{ runs: Run[] }>("/api/runs");
          const fallbackId = data.workspaces.find((item) => item.id === "default")?.id || data.workspaces[0]?.id || "default";
          const nextWorkspaceId = selectedWorkspaceIdRef.current === workspace.id ? fallbackId : selectedWorkspaceIdRef.current;
          setWorkspaces(data.workspaces);
          setRuns(runData.runs);
          selectWorkspace(nextWorkspaceId);
          selectRun(null);
          setDetail(null);
          setForm((current) => ({ ...current, workspaceId: nextWorkspaceId }));
          setExpandedWorkspaceIds((current) => {
            const next = new Set(current);
            next.delete(workspace.id);
            return next;
          });
          if (assetLibraryWorkspaceId === workspace.id) setAssetLibraryWorkspaceId(null);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "工作空间删除失败");
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function downloadUrl(value: string | null) {
    return value ? `${API_BASE}${value}` : "#";
  }

  function workspaceAssetPreviewUrl(value: string) {
    return value.startsWith("/generated/") ? value : downloadUrl(value);
  }

  function toggleTheme() {
    setTheme((currentTheme) => {
      const nextTheme = currentTheme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = nextTheme;
      window.localStorage.setItem("sim-theme", nextTheme);
      return nextTheme;
    });
  }

  function togglePreviewFullscreen() {
    setPreviewFullscreen((value) => !value);
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

  const previewType = modelPreviewUrl
    ? useRiggedPreview ? "绑骨 GLB" : useTopologyPreview ? "拓扑 GLB" : "静态 GLB"
    : viewStage === 0 ? "角色规格"
    : hasQaComparison ? "SDPose 对比"
    : viewStage === 2 && run?.qaOverlayPath ? "SDPose 覆盖图"
    : run?.previewPath ? "2D 概念图" : "等待资产";
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

  return {
    // Props
    screen,
    // State
    workspaces, setWorkspaces,
    selectedWorkspaceId, setSelectedWorkspaceId,
    expandedWorkspaceIds, setExpandedWorkspaceIds,
    runs, setRuns,
    selectedId, setSelectedId,
    detail, setDetail,
    viewStage, setViewStage,
    system, setSystem,
    busy, setBusy,
    loading, setLoading,
    error, setError,
    showCreate, setShowCreate,
    revertStage, setRevertStage,
    uiConfirmation, setUiConfirmation,
    uiConfirmationBusy, setUiConfirmationBusy,
    taskAgentMode, setTaskAgentMode,
    coordinatorMode, setCoordinatorMode,
    // Settings controller values
    settingsController,
    showSettings, setShowSettings,
    settings, setSettings,
    settingsForm, setSettingsForm,
    settingsTab, setSettingsTab,
    settingsLoading, setSettingsLoading,
    settingsSaving, setSettingsSaving,
    systemRefreshing, setSystemRefreshing,
    agentModelsLoading, setAgentModelsLoading,
    agentModels, setAgentModels,
    coordinatorModels, setCoordinatorModels,
    showGlobalSettings, setShowGlobalSettings,
    globalPreferences, setGlobalPreferences,
    globalPreferencesDraft, setGlobalPreferencesDraft,
    globalSettingsLoading, setGlobalSettingsLoading,
    globalSettingsSaving, setGlobalSettingsSaving,
    workflowPreviewOpen, setWorkflowPreviewOpen,
    workflowDragging, setWorkflowDragging,
    workflowFileRef, workflowDirectoryRef,
    refreshSystemStatus,
    openSettings, openGlobalSettings, saveGlobalSettings,
    updateProcessSettings, updateAgentApiSettings, updateTopologySettings,
    restoreTopologyDefaults, updateImageModelSettings, restoreProcessDefaults,
    selectWorkflow, handleWorkflowFiles, chooseWorkflowDirectory, removeWorkflow,
    fetchAgentModels, saveSettings,
    // Other state
    sidebarCollapsed, setSidebarCollapsed,
    theme, setTheme,
    themeReady,
    previewFullscreen, setPreviewFullscreen,
    qaBlend, setQaBlend,
    promptDraft, setPromptDraft,
    showWorkspaceCreate, setShowWorkspaceCreate,
    assetLibraryWorkspaceId, setAssetLibraryWorkspaceId,
    workspaceAssets, setWorkspaceAssets,
    workspaceAssetFilter, setWorkspaceAssetFilter,
    selectedWorkspaceAssetId, setSelectedWorkspaceAssetId,
    workspaceAssetsLoading, setWorkspaceAssetsLoading,
    workspaceForm, setWorkspaceForm,
    form, setForm,
    taskSourceImage, setTaskSourceImage,
    approvals, setApprovals,
    notifications, setNotifications,
    showNotifications, setShowNotifications,
    notificationAction, setNotificationAction,
    notificationFocusId, setNotificationFocusId,
    toastQueue, setToastQueue,
    showFullEvents, setShowFullEvents,
    approvalBusyId, setApprovalBusyId,
    notificationCenterRef,
    taskSourceFileRef,
    toastNotification,
    // Refs
    selectedIdRef,
    selectedWorkspaceIdRef,
    // Derived hooks
    taskAgent,
    coordinator,
    activeAgentRunId,
    agentCollapsed,
    agentWidth,
    dispatcherMessages,
    dispatcherSessionId,
    dispatcherGenerations,
    dispatcherTaskBatches,
    // Derived state
    selectedDetail,
    hasRunningTask,
    selectedTaskIsRunning,
    selectedRoleIsRunning,
    selectedPlanIsRunning,
    run,
    coordinatorApprovals,
    taskApprovals,
    dispatcherTimeline,
    unreadNotificationCount,
    artDirectorRun,
    visualQaRun,
    characterConsistencyRun,
    assetInspectorRun,
    riggingQaRun,
    exportSpecialistRun,
    workflowDoctorRun,
    specialistRoleRuns,
    current,
    activeStages,
    stage,
    progress,
    isCurrentView,
    visiblePreview,
    hasQaComparison,
    useRiggedPreview,
    useTopologyPreview,
    modelPreviewUrl,
    hasPreview,
    currentStageReady,
    hasPreviewFooter,
    previewType,
    activeAgentRunName,
    selectedWorkspace,
    assetLibraryWorkspace,
    filteredWorkspaceAssets,
    selectedWorkspaceAsset,
    dgxDevice,
    dgxMemoryTotal,
    dgxMemoryFree,
    // Constants
    stages,
    // Callbacks
    openHome,
    closeError,
    openTask,
    selectTask,
    selectRun,
    selectWorkspace,
    toggleWorkspace,
    refreshRuns,
    refreshWorkspaces,
    openAssetLibrary,
    requestDeleteWorkspaceAsset,
    refreshActivity,
    runAction,
    resetRun,
    deleteRun,
    confirmUiAction,
    revertToStage,
    confirmRevert,
    createRun,
    createWorkspace,
    requestDeleteWorkspace,
    downloadUrl,
    workspaceAssetPreviewUrl,
    toggleTheme,
    togglePreviewFullscreen,
    readImage,
    changeAgentMode,
    resolveApproval,
    viewNotification,
    markAllNotificationsRead,
    clearAllNotifications,
    deleteNotification,
  };
}

// Re-export type for use in StudioApplication
export type { UiConfirmation, StudioProps };
