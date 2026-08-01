"use client";

import { useRef, useState } from "react";

import type { AgentModelOption, AppSettings, GlobalPreferences, ProcessKind, ReasoningEffort } from "../../shared/contracts";

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

export function useSettingsState(defaultPreferences: GlobalPreferences) {
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

  return {
    showSettings, setShowSettings, settings, setSettings, settingsForm, setSettingsForm,
    settingsTab, setSettingsTab, settingsLoading, setSettingsLoading, settingsSaving, setSettingsSaving,
    systemRefreshing, setSystemRefreshing, agentModelsLoading, setAgentModelsLoading,
    agentModels, setAgentModels, coordinatorModels, setCoordinatorModels,
    showGlobalSettings, setShowGlobalSettings, globalPreferences, setGlobalPreferences,
    globalPreferencesDraft, setGlobalPreferencesDraft, globalSettingsLoading, setGlobalSettingsLoading,
    globalSettingsSaving, setGlobalSettingsSaving, workflowPreviewOpen, setWorkflowPreviewOpen,
    workflowDragging, setWorkflowDragging, workflowFileRef, workflowDirectoryRef,
  };
}

