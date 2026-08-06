"use client";

import { type Dispatch, type FormEvent, type MutableRefObject, type SetStateAction, useRef, useState } from "react";

import { api } from "../../shared/api-client";
import type { AgentModelOption, AppSettings, ApprovalMode, GlobalPreferences, ProcessKind, ReasoningEffort, SystemState, WorkflowMetadata } from "../../shared/contracts";

export type ImageModelDraft = { baseUrl: string; model: string; apiKey: string; clearApiKey: boolean };
export type AgentApiDraft = { baseUrl: string; model: string; reasoningEffort: ReasoningEffort; apiKey: string; clearApiKey: boolean };
export type TopologyApiDraft = { url: string; token: string; clearToken: boolean; targetQuads: number; timeoutSeconds: number };
export type SettingsDraft = {
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
export const PROCESS_KINDS: ProcessKind[] = ["2d", "qa", "3d", "rig"];

export function settingsDraft(settings: AppSettings): SettingsDraft {
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

export type SettingsController = ReturnType<typeof useSettingsState>;

type SettingsConfirmation = { title: string; description: string; confirmLabel: string; tone: "danger"; action: () => Promise<void> };

export function useSettingsState(defaultPreferences: GlobalPreferences, dependencies: {
  setError: Dispatch<SetStateAction<string>>;
  setSystem: Dispatch<SetStateAction<SystemState | null>>;
  notificationsEnabledRef: MutableRefObject<boolean>;
  onNotificationsDisabled: () => void;
  setCoordinatorMode: Dispatch<SetStateAction<ApprovalMode>>;
  refreshActivity: (showToast: boolean) => Promise<void>;
  requestConfirmation: (confirmation: SettingsConfirmation) => void;
}) {
  const { setError, setSystem, notificationsEnabledRef, onNotificationsDisabled, setCoordinatorMode, refreshActivity, requestConfirmation } = dependencies;
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState<SettingsDraft | null>(null);
  const [settingsTab, setSettingsTab] = useState<ProcessKind | "status" | "topology" | "agent" | "coordinator">("status");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [systemRefreshing, setSystemRefreshing] = useState(false);
  const [agentModelsLoading, setAgentModelsLoading] = useState(false);
  const [agentModels, setAgentModels] = useState<AgentModelOption[]>([]);
  const [coordinatorModels, setCoordinatorModels] = useState<AgentModelOption[]>([]);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [globalPreferences, setGlobalPreferences] = useState(defaultPreferences);
  const [globalPreferencesDraft, setGlobalPreferencesDraft] = useState(defaultPreferences);
  const [globalSettingsLoading, setGlobalSettingsLoading] = useState(false);
  const [globalSettingsSaving, setGlobalSettingsSaving] = useState(false);
  const [workflowPreviewOpen, setWorkflowPreviewOpen] = useState(false);
  const [workflowDragging, setWorkflowDragging] = useState(false);
  const workflowFileRef = useRef<HTMLInputElement | null>(null);
  const workflowDirectoryRef = useRef<HTMLInputElement | null>(null);

  async function refreshSystemStatus(reportError = true) {
    if (systemRefreshing) return;
    setSystemRefreshing(true);
    if (reportError) setError("");
    try {
      setSystem(await api<SystemState>("/api/system?force=1"));
    } catch (reason) {
      setSystem(null);
      if (reportError) setError(reason instanceof Error ? reason.message : "服务联通检测失败");
    } finally {
      setSystemRefreshing(false);
    }
  }

  async function openSettings() {
    setShowGlobalSettings(false);
    setShowSettings(true);
    setSettingsLoading(true);
    setWorkflowPreviewOpen(false);
    setError("");
    void refreshSystemStatus(false);
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

  async function openGlobalSettings() {
    setShowSettings(false);
    setShowGlobalSettings(true);
    setGlobalSettingsLoading(true);
    setError("");
    try {
      const data = await api<GlobalPreferences>("/api/ui-preferences");
      setGlobalPreferences(data);
      setGlobalPreferencesDraft(data);
      notificationsEnabledRef.current = data.notificationsEnabled;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "全局设置读取失败");
      setShowGlobalSettings(false);
    } finally {
      setGlobalSettingsLoading(false);
    }
  }

  async function saveGlobalSettings(event: FormEvent) {
    event.preventDefault();
    if (globalSettingsSaving) return;
    setGlobalSettingsSaving(true);
    setError("");
    try {
      const data = await api<GlobalPreferences>("/api/ui-preferences", {
        method: "PUT",
        body: JSON.stringify(globalPreferencesDraft),
      });
      setGlobalPreferences(data);
      setGlobalPreferencesDraft(data);
      notificationsEnabledRef.current = data.notificationsEnabled;
      if (!data.notificationsEnabled) {
        onNotificationsDisabled();
      }
      setCoordinatorMode(data.defaultApprovalMode);
      setShowGlobalSettings(false);
      void refreshActivity(false).catch(() => undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "全局设置保存失败");
    } finally {
      setGlobalSettingsSaving(false);
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
    requestConfirmation({
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


  return {
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
  };
}
