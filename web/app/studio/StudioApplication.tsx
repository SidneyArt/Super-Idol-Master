"use client";

import Image from "next/image";
import {
  Bell,
  BrainCircuit,
  Check,
  Library,
  Moon,
  SlidersHorizontal,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { lazy, Suspense } from "react";
import LiquidWaveBackground from "../components/LiquidWaveBackground";
import { TaskAgentConsole, useTaskAgent } from "./features/task-agent";
const AssetLibrary = lazy(() => import("./features/assets").then((m) => ({ default: m.AssetLibrary })));
const GlobalSettingsDialog = lazy(() => import("./features/settings").then((m) => ({ default: m.GlobalSettingsDialog })));
const SettingsDialog = lazy(() => import("./features/settings").then((m) => ({ default: m.SettingsDialog })));
const HomeScreen = lazy(() => import("./HomeScreen").then((m) => ({ default: m.HomeScreen })));
const TaskScreen = lazy(() => import("./TaskScreen").then((m) => ({ default: m.TaskScreen })));
import { ConfirmationDialog, CreateTaskDialog, CreateWorkspaceDialog, EventHistoryDialog, RevertDialog } from "./StudioDialogs";
import {
  ClientTime,
} from "./shared/ui";
import { useStudioState, type StudioProps } from "./features/useStudioState";

const ModelViewer = lazy(() => import("../components/ModelViewer"));

export default function Studio(props: StudioProps) {
  const state = useStudioState(props);
  const {
    screen,
    workspaces, setWorkspaces,
    selectedWorkspaceId,
    expandedWorkspaceIds,
    runs,
    selectedId,
    selectedDetail,
    viewStage, setViewStage,
    system,
    busy, setBusy,
    loading,
    error,
    showCreate, setShowCreate,
    revertStage, setRevertStage,
    uiConfirmation, setUiConfirmation,
    uiConfirmationBusy,
    taskAgentMode,
    coordinatorMode,
    settings, settingsController,
    showSettings, setShowSettings,
    settingsTab, setSettingsTab,
    showGlobalSettings, setShowGlobalSettings,
    globalPreferences, globalPreferencesDraft, setGlobalPreferencesDraft,
    globalSettingsLoading, globalSettingsSaving,
    openSettings, openGlobalSettings,
    saveGlobalSettings,
    saveSettings,
    refreshSystemStatus,
    restoreTopologyDefaults,
    updateTopologySettings,
    restoreProcessDefaults,
    updateProcessSettings,
    selectWorkflow,
    removeWorkflow,
    handleWorkflowFiles,
    chooseWorkflowDirectory,
    updateAgentApiSettings,
    fetchAgentModels,
    updateImageModelSettings,
    dgxDevice,
    dgxMemoryTotal,
    dgxMemoryFree,
    sidebarCollapsed, setSidebarCollapsed,
    theme,
    themeReady,
    previewFullscreen, togglePreviewFullscreen,
    qaBlend, setQaBlend,
    promptDraft, setPromptDraft,
    showWorkspaceCreate, setShowWorkspaceCreate,
    assetLibraryWorkspaceId, setAssetLibraryWorkspaceId,
    workspaceAssets,
    workspaceAssetFilter, setWorkspaceAssetFilter,
    selectedWorkspaceAssetId, setSelectedWorkspaceAssetId,
    workspaceAssetsLoading,
    workspaceForm, setWorkspaceForm,
    form, setForm,
    taskSourceImage, setTaskSourceImage,
    approvals, setApprovals,
    notifications, setNotifications,
    showNotifications, setShowNotifications,
    notificationAction,
    toastQueue, setToastQueue,
    showFullEvents, setShowFullEvents,
    approvalBusyId,
    notificationCenterRef,
    taskSourceFileRef,
    toastNotification,
    taskAgent,
    coordinator,
    activeAgentRunName,
    dispatcherTimeline,
    coordinatorApprovals,
    taskApprovals,
    unreadNotificationCount,
    hasRunningTask,
    selectedTaskIsRunning,
    selectedRoleIsRunning,
    selectedPlanIsRunning,
    run,
    activeStages,
    current,
    currentStageReady,
    stage,
    progress,
    isCurrentView,
    visiblePreview,
    hasQaComparison,
    useRiggedPreview,
    useTopologyPreview,
    modelPreviewUrl,
    hasPreview,
    hasPreviewFooter,
    previewType,
    artDirectorRun,
    visualQaRun,
    specialistRoleRuns,
    selectedWorkspace,
    assetLibraryWorkspace,
    filteredWorkspaceAssets,
    selectedWorkspaceAsset,
    stages,
    openHome,
    closeError,
    openTask,
    selectTask,
    selectWorkspace,
    toggleWorkspace,
    openAssetLibrary,
    requestDeleteWorkspace,
    requestDeleteWorkspaceAsset,
    resetRun,
    deleteRun,
    confirmUiAction,
    confirmRevert,
    revertToStage,
    createRun,
    createWorkspace,
    downloadUrl,
    workspaceAssetPreviewUrl,
    toggleTheme,
    runAction,
    readImage,
    changeAgentMode,
    resolveApproval,
    viewNotification,
    markAllNotificationsRead,
    clearAllNotifications,
    deleteNotification,
    refreshActivity,
    refreshRuns,
    selectRun,
  } = state;

  return (
    <>
      {themeReady && <LiquidWaveBackground
        theme={theme}
        animated={showGlobalSettings
          ? globalPreferencesDraft.backgroundAnimationEnabled
          : globalPreferences.backgroundAnimationEnabled}
      />}
      <main
        className={`site-shell screen-${screen} ${screen === "task" && sidebarCollapsed ? "tasks-collapsed" : ""}`}
        data-screen={screen}
      >
      <header className="topbar">
        <div className="topbar-left">
          <button className="brand home-brand" type="button" onClick={openHome} title="返回首页">
            <Image
              className="brand-logo"
              src="/super-idol-master-logo.png"
              alt="Super Idol Master"
              width={1950}
              height={502}
              priority
              unoptimized
            />
          </button>
        </div>
        <nav className="topbar-center" aria-label="主要功能">
          <button
            className={assetLibraryWorkspaceId !== null || (!showCreate && !showSettings) ? "active" : ""}
            type="button"
            disabled={!selectedWorkspace && !run}
            onClick={() => {
              const workspaceId = screen === "task"
                ? run?.workspaceId
                : selectedWorkspace?.id;
              if (workspaceId) void openAssetLibrary(workspaceId);
            }}
          >
            <Library size={17} /><span>资产库</span>
          </button>
          <button
            className={showCreate ? "active" : ""}
            type="button"
            onClick={() => {
              setForm({
                name: "",
                workspaceId: screen === "task"
                  ? run?.workspaceId || selectedWorkspaceId
                  : selectedWorkspaceId,
                pipelineType: "text_to_model",
              });
              setTaskSourceImage(null);
              setShowCreate(true);
            }}
          >
            <SlidersHorizontal size={18} /><span>新建任务</span>
          </button>
          <button className={showSettings ? "active" : ""} type="button" onClick={() => { setSettingsTab("status"); void openSettings(); }}>
            <BrainCircuit size={18} /><span>模型配置</span>
          </button>
        </nav>
        <div className="topbar-right">
          {screen === "home" && (
            <button className="topbar-workspace-button" type="button" onClick={() => setShowWorkspaceCreate(true)}>
              <span>创建工作空间</span>
            </button>
          )}
          {screen === "task" && globalPreferences.notificationsEnabled && <div className="notification-center" ref={notificationCenterRef}>
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
                      <div><strong>{notification.title}</strong><p>{notification.message}</p><ClientTime value={notification.createdAt} /></div>
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
          </div>}
          <button className="icon-button" type="button" onClick={toggleTheme} title="切换主题" aria-label="切换浅色或深色主题">
            {theme === "dark" ? <Sun size={27} /> : <Moon size={27} />}
          </button>
        </div>
      </header>

      {globalPreferences.notificationsEnabled && toastNotification && (
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
          <button type="button" onClick={closeError} aria-label="关闭错误提示"><X size={17} /></button>
        </div>
      )}

      {screen === "home" ? (
        <Suspense fallback={null}><HomeScreen
          workspaces={workspaces}
          runs={runs}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedWorkspace={selectedWorkspace}
          expandedWorkspaceIds={expandedWorkspaceIds}
          busy={busy}
          stageTitles={stages.map((stage) => stage.title)}
          coordinator={coordinator}
          dispatcherTimeline={dispatcherTimeline}
          approvalBusyId={approvalBusyId}
          coordinatorMode={coordinatorMode}
          coordinatorConfigured={settings?.coordinator.agent.apiKeyConfigured}
          setForm={setForm}
          selectWorkspace={selectWorkspace}
          toggleWorkspace={toggleWorkspace}
          openTask={openTask}
          selectTask={selectTask}
          openAssetLibrary={openAssetLibrary}
          requestDeleteWorkspace={requestDeleteWorkspace}
          openGlobalSettings={openGlobalSettings}
          openSettings={async () => { setSettingsTab("status"); void openSettings(); }}
          createTask={(workspaceId) => { setForm({ name: "", workspaceId, pipelineType: "text_to_model" }); setShowCreate(true); }}
          resolveApproval={resolveApproval}
          changeCoordinatorMode={(mode) => changeAgentMode("coordinator", mode)}
        /></Suspense>
      ) : (
        <Suspense fallback={null}><TaskScreen model={{
          taskAgent, run, runs, workspaces, selectedId, selectedWorkspaceId, selectedDetail, loading, busy,
          sidebarCollapsed, setSidebarCollapsed, setForm, setTaskSourceImage, setShowCreate, openHome, selectTask,
          openAssetLibrary, resetRun, deleteRun, stages, activeStages, current, currentStageReady, viewStage,
          setViewStage, qaBlend, setQaBlend, revertToStage, progress, previewFullscreen, togglePreviewFullscreen,
          previewType, modelPreviewUrl, hasPreview, hasQaComparison, visiblePreview, useRiggedPreview,
          useTopologyPreview, stage, promptDraft, setPromptDraft, artDirectorRun, visualQaRun, downloadUrl,
          isCurrentView, runAction, hasPreviewFooter, setShowFullEvents, specialistRoleRuns, taskApprovals,
          approvalBusyId, taskAgentMode, system, selectedRoleIsRunning, selectedPlanIsRunning,
          activeAgentRunName, resolveApproval, changeTaskMode: (mode) => changeAgentMode("task", mode),
        }} /></Suspense>
      )}

      {revertStage !== null && <RevertDialog stageTitle={activeStages[revertStage].title} busy={busy} close={() => setRevertStage(null)} confirm={confirmRevert} />}

      {showGlobalSettings && <Suspense fallback={null}><GlobalSettingsDialog
        draft={globalPreferencesDraft}
        loading={globalSettingsLoading}
        saving={globalSettingsSaving}
        setDraft={setGlobalPreferencesDraft}
        close={() => setShowGlobalSettings(false)}
        save={saveGlobalSettings}
      /></Suspense>}

      {showSettings && <Suspense fallback={null}><SettingsDialog
        controller={settingsController}
        system={system}
        dgxDeviceName={dgxDevice?.name}
        dgxMemoryFree={dgxMemoryFree}
        dgxMemoryTotal={dgxMemoryTotal}
        saveSettings={saveSettings}
        refreshSystemStatus={() => refreshSystemStatus()}
        restoreTopologyDefaults={restoreTopologyDefaults}
        updateTopologySettings={updateTopologySettings}
        restoreProcessDefaults={restoreProcessDefaults}
        updateProcessSettings={updateProcessSettings}
        selectWorkflow={selectWorkflow}
        removeWorkflow={removeWorkflow}
        handleWorkflowFiles={handleWorkflowFiles}
        chooseWorkflowDirectory={chooseWorkflowDirectory}
        updateAgentApiSettings={updateAgentApiSettings}
        fetchAgentModels={fetchAgentModels}
        updateImageModelSettings={updateImageModelSettings}
      /></Suspense>}

      {assetLibraryWorkspaceId && <Suspense fallback={null}><AssetLibrary
        workspace={assetLibraryWorkspace}
        assets={workspaceAssets}
        filter={workspaceAssetFilter}
        selectedAsset={selectedWorkspaceAsset}
        loading={workspaceAssetsLoading}
        confirmationOpen={Boolean(uiConfirmation)}
        close={() => setAssetLibraryWorkspaceId(null)}
        setFilter={setWorkspaceAssetFilter}
        selectAsset={setSelectedWorkspaceAssetId}
        openTask={openTask}
        downloadUrl={downloadUrl}
        previewUrl={workspaceAssetPreviewUrl}
        requestDelete={requestDeleteWorkspaceAsset}
      /></Suspense>}

      {showCreate && <CreateTaskDialog form={form} setForm={setForm} workspaces={workspaces} sourceImage={taskSourceImage} setSourceImage={setTaskSourceImage} fileRef={taskSourceFileRef} busy={busy} close={() => setShowCreate(false)} submit={createRun} readImage={readImage} />}

      {showWorkspaceCreate && <CreateWorkspaceDialog form={workspaceForm} setForm={setWorkspaceForm} busy={busy} close={() => setShowWorkspaceCreate(false)} submit={createWorkspace} />}

      {showFullEvents && selectedDetail && <EventHistoryDialog detail={selectedDetail} stageTitles={activeStages.map((item) => item.title)} close={() => setShowFullEvents(false)} />}

      {uiConfirmation && <ConfirmationDialog confirmation={uiConfirmation} busy={uiConfirmationBusy} close={() => setUiConfirmation(null)} confirm={confirmUiAction} />}
    </main>
    </>
  );
}
