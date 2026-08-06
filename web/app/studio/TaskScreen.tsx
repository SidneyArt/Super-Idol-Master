"use client";

import Image from "next/image";
import { Bot, Box, Check, Download, Expand, Home, ImageIcon, Library, LoaderCircle, Maximize2, Minimize2, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Play, Plus, RefreshCw, RotateCcw, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { lazy, Suspense, type CSSProperties, type Dispatch, type SetStateAction } from "react";

import { TaskAgentConsole, type SpecialistRoleItem, type TaskAgentController } from "./features/task-agent";
import { API_BASE } from "./shared/api-client";
import type { AgentAttachment, AgentRoleRun, ApprovalMode, ApprovalRequest, Run, RunDetail, SystemState, Workspace } from "./shared/contracts";
import { jobName } from "./shared/formatters";
import { ClientTime } from "./shared/ui";

const ModelViewer = lazy(() => import("../components/ModelViewer"));

type Stage = { short: string; title: string; subtitle: string; input: string; output: string; action: string };
type PromptDraft = { positivePrompt: string; negativePrompt: string };
type TaskForm = { name: string; workspaceId: string; pipelineType: "text_to_model" | "image_to_model" };

export type TaskScreenModel = {
  taskAgent: TaskAgentController;
  run: Run | null;
  runs: Run[];
  workspaces: Workspace[];
  selectedId: string | null;
  selectedWorkspaceId: string;
  selectedDetail: RunDetail | null;
  loading: boolean;
  busy: boolean;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  setForm: Dispatch<SetStateAction<TaskForm>>;
  setTaskSourceImage: Dispatch<SetStateAction<AgentAttachment | null>>;
  setShowCreate: Dispatch<SetStateAction<boolean>>;
  openHome: () => void;
  selectTask: (run: Run) => void;
  openAssetLibrary: (workspaceId: string) => Promise<void>;
  resetRun: () => void;
  deleteRun: () => void;
  stages: Stage[];
  activeStages: Stage[];
  current: number;
  currentStageReady: boolean;
  viewStage: number;
  setViewStage: Dispatch<SetStateAction<number>>;
  qaBlend: number;
  setQaBlend: Dispatch<SetStateAction<number>>;
  revertToStage: (stage: number) => void;
  progress: number;
  previewFullscreen: boolean;
  togglePreviewFullscreen: () => void;
  previewType: string;
  modelPreviewUrl: string | null;
  hasPreview: boolean;
  hasQaComparison: boolean;
  visiblePreview: string | null;
  useRiggedPreview: boolean;
  useTopologyPreview: boolean;
  stage: Stage;
  promptDraft: PromptDraft;
  setPromptDraft: Dispatch<SetStateAction<PromptDraft>>;
  artDirectorRun: AgentRoleRun | undefined;
  visualQaRun: AgentRoleRun | undefined;
  downloadUrl: (value: string | null) => string;
  isCurrentView: boolean;
  runAction: (path: string, fallback: string, payload?: Record<string, unknown>) => Promise<void>;
  hasPreviewFooter: boolean;
  setShowFullEvents: Dispatch<SetStateAction<boolean>>;
  specialistRoleRuns: SpecialistRoleItem[];
  taskApprovals: ApprovalRequest[];
  approvalBusyId: number | null;
  taskAgentMode: ApprovalMode;
  system: SystemState | null;
  selectedRoleIsRunning: boolean;
  selectedPlanIsRunning: boolean;
  activeAgentRunName: string | undefined;
  resolveApproval: (id: number, decision: "approve" | "reject") => Promise<void>;
  changeTaskMode: (mode: ApprovalMode) => Promise<void>;
};

export function TaskScreen({ model }: { model: TaskScreenModel }) {
  const {
    taskAgent, run, runs, workspaces, selectedId, selectedWorkspaceId, selectedDetail, loading, busy,
    sidebarCollapsed, setSidebarCollapsed, setForm, setTaskSourceImage, setShowCreate, openHome, selectTask,
    openAssetLibrary, resetRun, deleteRun, stages, activeStages, current, currentStageReady, viewStage,
    setViewStage, qaBlend, setQaBlend, revertToStage, progress, previewFullscreen, togglePreviewFullscreen,
    previewType, modelPreviewUrl, hasPreview, hasQaComparison, visiblePreview, useRiggedPreview,
    useTopologyPreview, stage, promptDraft, setPromptDraft, artDirectorRun, visualQaRun, downloadUrl,
    isCurrentView, runAction, hasPreviewFooter, setShowFullEvents, specialistRoleRuns, taskApprovals,
    approvalBusyId, taskAgentMode, system, selectedRoleIsRunning, selectedPlanIsRunning, activeAgentRunName,
    resolveApproval, changeTaskMode,
  } = model;
  const agentCollapsed = taskAgent.panel.collapsed;
  const agentWidth = taskAgent.panel.width;

  return (
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
                  <span className="run-row"><strong>{item.name}</strong><ClientTime value={item.updatedAt} /></span>
                  <span className="run-meta">{item.jobStatus === "running" ? `${jobName(item.jobType)} 执行中` : stages[item.currentStage].title}</span>
                  <span className="run-progress"><i style={{ width: `${Math.round((item.currentStage / (stages.length - 1)) * 100)}%` }} /></span>
                </span>
              </button>
            ))}
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
                  <p><span className="pipeline-type-badge">{run.pipelineType === "image_to_model" ? "图生模型" : "文生模型"}</span>更新于 <ClientTime value={run.updatedAt} /> · {progress}% 完成</p>
                </div>
                <div className="workspace-actions">
                  <button className="secondary-button workspace-asset-library-button" type="button" onClick={() => void openAssetLibrary(run.workspaceId)}><Library size={16} />资产库</button>
                  <button className="icon-button" type="button" onClick={resetRun} disabled={busy || run.jobStatus === "running"} title="重置任务" aria-label="重置任务"><RotateCcw size={17} /></button>
                  <button className="icon-button danger" type="button" onClick={deleteRun} disabled={busy || run.jobStatus === "running"} title="删除任务" aria-label="删除任务"><Trash2 size={17} /></button>
                </div>
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
                          <ModelViewer src={modelPreviewUrl} label={`${run.name} · ${useRiggedPreview ? "绑骨 GLB" : useTopologyPreview ? "拓扑 GLB" : "静态 GLB"}`} rigged={useRiggedPreview} animationApiBase={API_BASE} />
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
                    <div className="section-heading"><div><span>活动</span><strong>任务记录</strong></div><button type="button" className="icon-button" onClick={() => setShowFullEvents(true)} title="查看全部历史任务记录" aria-label="查看全部历史任务记录"><MoreHorizontal size={18} /></button></div>
                    <div className="event-list">
                      {(selectedDetail?.events || []).slice(0, 8).map((item) => (
                        <div className="event-item" key={item.id}>
                          <span className="event-dot" />
                          <div><strong>{item.message}</strong><span>{activeStages[item.stage]?.title || "流程"} · <ClientTime value={item.createdAt} /></span></div>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            </>
          )}
        </section>

        <TaskAgentConsole
          controller={taskAgent}
          run={run}
          detail={selectedDetail}
          stageTitle={activeStages[current]?.title || "流程"}
          progress={progress}
          specialistRoleRuns={specialistRoleRuns}
          approvals={taskApprovals}
          approvalBusyId={approvalBusyId}
          mode={taskAgentMode}
          configured={system?.agent.configured}
          selectedRoleIsRunning={selectedRoleIsRunning}
          selectedPlanIsRunning={Boolean(selectedPlanIsRunning)}
          activeRunName={activeAgentRunName}
          resolveApproval={resolveApproval}
          changeMode={changeTaskMode}
        />
      </div>
  );
}

