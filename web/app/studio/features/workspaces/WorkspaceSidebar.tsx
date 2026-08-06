"use client";

import { ChevronRight, Library, LoaderCircle, Settings, Trash2 } from "lucide-react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";

import type { Run, Workspace } from "../../shared/contracts";

type TaskForm = { name: string; workspaceId: string; pipelineType: "text_to_model" | "image_to_model" };

export function WorkspaceSidebar({
  workspaces,
  runs,
  selectedWorkspaceId,
  expandedWorkspaceIds,
  busy,
  stageTitles,
  selectWorkspace,
  toggleWorkspace,
  openTask,
  openAssetLibrary,
  requestDeleteWorkspace,
  setForm,
  openGlobalSettings,
}: {
  workspaces: Workspace[];
  runs: Run[];
  selectedWorkspaceId: string;
  expandedWorkspaceIds: Set<string>;
  busy: boolean;
  stageTitles: string[];
  selectWorkspace: (workspaceId: string) => void;
  toggleWorkspace: (workspaceId: string) => void;
  openTask: (runId: string) => void;
  openAssetLibrary: (workspaceId: string) => Promise<void>;
  requestDeleteWorkspace: (workspace: Workspace) => void;
  setForm: Dispatch<SetStateAction<TaskForm>>;
  openGlobalSettings: () => Promise<void>;
}) {
  const orderedWorkspaces = [...workspaces].sort((first, second) => {
    if (first.id === "default") return -1;
    if (second.id === "default") return 1;
    return 0;
  });

  return (
    <nav className="workspace-sidebar" aria-label="工作空间列表">
      <div className="workspace-list">
        {orderedWorkspaces.map((workspace) => (
          <div className={`workspace-group ${workspace.id === selectedWorkspaceId ? "selected" : ""} ${expandedWorkspaceIds.has(workspace.id) ? "expanded" : ""}`} key={workspace.id}>
            <div className={`workspace-item ${workspace.id === "default" ? "workspace-item-default" : ""}`}>
              <button type="button" className="workspace-select-button" onClick={() => {
                selectWorkspace(workspace.id);
                setForm((current) => ({ ...current, workspaceId: workspace.id }));
              }} aria-pressed={workspace.id === selectedWorkspaceId}>
                <span className={`workspace-icon ${expandedWorkspaceIds.has(workspace.id) ? "is-open" : "is-closed"}`} aria-hidden="true">
                  <span className="workspace-folder-glyph" />
                </span>
                <span><strong>{workspace.name}</strong><small>{workspace.taskCount} 个任务 · {workspace.runningCount} 个运行中</small></span>
              </button>
              <button type="button" className="workspace-library-button" onClick={() => {
                selectWorkspace(workspace.id);
                void openAssetLibrary(workspace.id);
              }} title={`打开 ${workspace.name} 的资产库`} aria-label={`打开 ${workspace.name} 的资产库`}>
                <Library size={15} />
              </button>
              {workspace.id !== "default" && (
                <button type="button" className="workspace-delete-button" disabled={busy} onClick={() => requestDeleteWorkspace(workspace)} title={`删除工作空间：${workspace.name}`} aria-label={`删除工作空间：${workspace.name}`}>
                  <Trash2 size={15} />
                </button>
              )}
              <button type="button" className="workspace-toggle-button" onClick={() => toggleWorkspace(workspace.id)} aria-expanded={expandedWorkspaceIds.has(workspace.id)} aria-controls={`workspace-tasks-${workspace.id}`} aria-label={`${expandedWorkspaceIds.has(workspace.id) ? "折叠" : "展开"}工作空间：${workspace.name}`} title={expandedWorkspaceIds.has(workspace.id) ? "折叠工作空间" : "展开工作空间"}>
                <ChevronRight className="workspace-chevron" size={15} />
              </button>
            </div>
            <div className="workspace-task-region" id={`workspace-tasks-${workspace.id}`} aria-hidden={!expandedWorkspaceIds.has(workspace.id)}>
              <div className="workspace-task-list">
                {runs.filter((item) => item.workspaceId === workspace.id).map((item) => (
                  <button type="button" key={item.id} onClick={() => openTask(item.id)}>
                    <span>{item.name.slice(0, 1).toUpperCase()}</span>
                    <div><strong>{item.name}</strong><small>{item.pipelineType === "image_to_model" ? "图生模型" : "文生模型"} · {stageTitles[item.currentStage]}</small></div>
                    {item.jobStatus === "running" && <LoaderCircle className="spinning" size={14} />}
                    <i className="workspace-task-progress" style={{
                      "--workspace-task-progress": `${item.jobStatus === "running" ? item.jobProgress : Math.max(8, Math.round((item.currentStage / (stageTitles.length - 1)) * 100))}%`,
                    } as CSSProperties} />
                  </button>
                ))}
                {!runs.some((item) => item.workspaceId === workspace.id) && <p>该工作空间还没有任务。</p>}
              </div>
            </div>
          </div>
        ))}
      </div>
      <footer className="workspace-sidebar-footer">
        <button className="workspace-sidebar-settings" type="button" onClick={() => void openGlobalSettings()} title="全局设置" aria-label="打开全局设置面板">
          <Settings size={21} />
        </button>
        <span>{workspaces.length} 个工作空间</span>
      </footer>
    </nav>
  );
}
