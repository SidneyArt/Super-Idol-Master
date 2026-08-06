"use client";

import type { Dispatch, SetStateAction } from "react";

import { CoordinatorConsole } from "./features/coordinator";
import { WorkspaceSidebar } from "./features/workspaces";
import type { CoordinatorController } from "./features/coordinator";
import type { ApprovalMode, Run, Workspace } from "./shared/contracts";
import type { DispatcherTimelineItem } from "./shared/selectors";

type TaskForm = { name: string; workspaceId: string; pipelineType: "text_to_model" | "image_to_model" };

export type HomeScreenProps = {
  workspaces: Workspace[];
  runs: Run[];
  selectedWorkspaceId: string;
  selectedWorkspace: Workspace | null;
  expandedWorkspaceIds: Set<string>;
  busy: boolean;
  stageTitles: string[];
  coordinator: CoordinatorController;
  dispatcherTimeline: DispatcherTimelineItem[];
  approvalBusyId: number | null;
  coordinatorMode: ApprovalMode;
  coordinatorConfigured: boolean | undefined;
  setForm: Dispatch<SetStateAction<TaskForm>>;
  selectWorkspace: (workspaceId: string) => void;
  toggleWorkspace: (workspaceId: string) => void;
  openTask: (runId: string) => void;
  selectTask: (run: Run) => void;
  openAssetLibrary: (workspaceId: string) => Promise<void>;
  requestDeleteWorkspace: (workspace: Workspace) => void;
  openGlobalSettings: () => Promise<void>;
  openSettings: () => Promise<void>;
  createTask: (workspaceId: string) => void;
  resolveApproval: (id: number, decision: "approve" | "reject") => Promise<void>;
  changeCoordinatorMode: (mode: ApprovalMode) => Promise<void>;
};

export function HomeScreen(props: HomeScreenProps) {
  return (
    <section className="home-frame">
      <WorkspaceSidebar
        workspaces={props.workspaces}
        runs={props.runs}
        selectedWorkspaceId={props.selectedWorkspaceId}
        expandedWorkspaceIds={props.expandedWorkspaceIds}
        busy={props.busy}
        stageTitles={props.stageTitles}
        selectWorkspace={props.selectWorkspace}
        toggleWorkspace={props.toggleWorkspace}
        openTask={props.openTask}
        openAssetLibrary={props.openAssetLibrary}
        requestDeleteWorkspace={props.requestDeleteWorkspace}
        setForm={props.setForm}
        openGlobalSettings={props.openGlobalSettings}
      />
      <CoordinatorConsole
        controller={props.coordinator}
        timeline={props.dispatcherTimeline}
        selectedWorkspace={props.selectedWorkspace}
        selectedWorkspaceId={props.selectedWorkspaceId}
        stageTitles={props.stageTitles}
        approvalBusyId={props.approvalBusyId}
        mode={props.coordinatorMode}
        configured={props.coordinatorConfigured}
        createTask={props.createTask}
        openAssetLibrary={props.openAssetLibrary}
        openSettings={props.openSettings}
        selectTask={props.selectTask}
        resolveApproval={props.resolveApproval}
        changeMode={props.changeCoordinatorMode}
      />
    </section>
  );
}
