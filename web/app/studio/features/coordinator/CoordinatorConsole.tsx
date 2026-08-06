"use client";

/* eslint-disable react-hooks/refs -- Coordinator DOM refs remain private to its controller and are only bound/read by event callbacks. */

import Image from "next/image";
import { Bot, Box, Check, ImageIcon, Library, LoaderCircle, Plus, RefreshCw, Settings, ShieldCheck, User, X } from "lucide-react";
import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ApprovalMode, DispatcherGeneration, Run, Workspace } from "../../shared/contracts";
import type { DispatcherTimelineItem } from "../../shared/selectors";
import { AgentPermissionMenu, ContextUsage, ConversationSessionManager } from "../../shared/ui";
import type { CoordinatorController } from "./useCoordinator";

export function CoordinatorConsole({
  controller,
  timeline,
  selectedWorkspace,
  selectedWorkspaceId,
  stageTitles,
  approvalBusyId,
  mode,
  configured,
  createTask,
  openAssetLibrary,
  openSettings,
  selectTask,
  resolveApproval,
  changeMode,
}: {
  controller: CoordinatorController;
  timeline: DispatcherTimelineItem[];
  selectedWorkspace: Workspace | null;
  selectedWorkspaceId: string;
  stageTitles: string[];
  approvalBusyId: number | null;
  mode: ApprovalMode;
  configured: boolean | undefined;
  createTask: (workspaceId: string) => void;
  openAssetLibrary: (workspaceId: string) => Promise<void>;
  openSettings: () => Promise<void>;
  selectTask: (run: Run) => void;
  resolveApproval: (id: number, decision: "approve" | "reject") => Promise<void>;
  changeMode: (mode: ApprovalMode) => Promise<void>;
}) {
  const { conversation, activity, status, composer, sessions, panel } = controller;

  return (
    <section className={`dispatcher-panel ${panel.dragging ? "dragging" : ""}`} onDragEnter={panel.onDragEnter} onDragOver={panel.onDragOver} onDragLeave={panel.onDragLeave} onDrop={panel.onDrop}>
      <header className="dispatcher-header">
        <div className="dispatcher-title"><span><Bot size={22} /></span><div><small>总调度中心</small><h1>{selectedWorkspace?.name || "创建工作空间后开始调度"}</h1></div></div>
        <div className="dispatcher-actions">
          <button className="secondary-button" type="button" disabled={!selectedWorkspace} onClick={() => { if (selectedWorkspace) void openAssetLibrary(selectedWorkspace.id); }}><Library size={16} />资产库</button>
          <button className="secondary-button" type="button" onClick={() => createTask(selectedWorkspaceId)}><Plus size={16} />新建任务</button>
          <button className="secondary-button" type="button" onClick={() => void openSettings()}><Settings size={16} />模型配置</button>
        </div>
      </header>

      <div className="dispatcher-thread" ref={panel.threadRef} onScroll={panel.onThreadScroll}>
        <div className="dispatcher-thread-content">
          {!timeline.length && (
            <div className="dispatcher-welcome"><h2>从一个目标开始</h2><p>可以先生成一张包含多个角色的合集原画，也可以创建多个独立任务，或上传已有合集原画再拆分</p><div><button type="button" onClick={() => composer.setInput("创建一张角色原画合集图，里面有 3 个同样风格但身份、服装和配色不同的角色")}>生成合集图</button><button type="button" onClick={() => composer.setInput("在当前工作空间创建 3 个不同风格的角色任务，并分别生成到 3D 模型")}>批量创建角色</button><button type="button" onClick={composer.openFilePicker}>上传并拆分</button></div></div>
          )}
          {timeline.map((entry) => {
            if (entry.kind === "generation") return <GenerationCard key={`generation-${entry.item.id}`} generation={entry.item} busy={status.busy} regeneratingId={activity.regeneratingId} regenerate={controller.regenerate} />;
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
                    <header><span><Box size={16} /></span><div><strong>{batch.tasks.length === 1 ? "单角色任务" : "角色拆分结果"}</strong><small>{batch.tasks.length} 个独立任务 · 目标：{targetLabel}</small></div></header>
                    <div className="dispatcher-task-grid">
                      {batch.tasks.map((task) => {
                        const preview = task.sourcePreviewPath || task.previewPath;
                        const taskStatus = task.jobStatus === "running" ? `${task.jobProgress}%` : task.status === "completed" ? "已完成" : stageTitles[Math.min(task.currentStage, stageTitles.length - 1)];
                        return <button type="button" key={task.id} onClick={() => selectTask(task)}>
                          {preview ? <Image src={preview} alt={task.name} width={240} height={240} unoptimized /> : <span className="dispatcher-task-placeholder"><Box size={22} /></span>}
                          <span><strong>{task.name}</strong><small>{task.pipelineType === "image_to_model" ? "图生模型" : "文生模型"} · {taskStatus}</small></span>
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
          {status.busy && <div className="dispatcher-message assistant pending"><span><Bot size={17} /></span><div><strong>总调度 Agent</strong><p><LoaderCircle size={15} />正在分析并调度任务</p></div></div>}
          <div ref={panel.endRef} />
        </div>
      </div>

      <div className="dispatcher-session-bar">
        <ConversationSessionManager sessions={conversation.sessions} sessionId={conversation.sessionId} label="总调度 Agent 会话" disabled={status.busy || status.sessionBusy || !selectedWorkspaceId} variant="home" onActivate={(value) => void sessions.switch(value)} onCreate={() => void sessions.create()} onDelete={sessions.requestDelete} />
      </div>

      <form className="dispatcher-composer" onSubmit={(event) => { event.preventDefault(); void composer.send(); }}>
        {composer.attachment && <div className="dispatcher-attachment"><ImageIcon size={15} /><span>{composer.attachment.name}</span><button type="button" onClick={composer.removeAttachment}><X size={14} /></button></div>}
        <textarea rows={4} value={composer.input} onChange={(event) => composer.setInput(event.target.value)} onKeyDown={composer.onKeyDown} placeholder="要求生成一张合集图，或创建多个任务，也可以拖入已有合集原画进行拆分…" />
        <div className="dispatcher-composer-footer">
          <AgentPermissionMenu mode={mode} onChange={(nextMode) => void changeMode(nextMode)} title="选择总调度 Agent 的变更审批方式" />
          <input {...composer.fileInputProps} hidden type="file" accept="image/png,image/jpeg,image/webp" />
          <ContextUsage context={conversation.context} />
          <span className="dispatcher-composer-actions">{status.busy && <button className="icon-button" type="button" onClick={() => void composer.cancel()} title="停止调度" aria-label="停止调度"><X size={16} /></button>}<button className="primary-button dispatcher-send-button" type="submit" disabled={status.busy || (!composer.input.trim() && !composer.attachment) || configured === false} title="发送调度" aria-label="发送调度"><span className="dispatcher-send-glyph" aria-hidden="true" /></button></span>
        </div>
      </form>
      {panel.dragging && <div className="dispatcher-drop"><ImageIcon size={34} /><strong>松开以分析合集原画</strong><span>支持最多 12 MB 的 PNG、JPEG 或 WebP</span></div>}
    </section>
  );
}

function GenerationCard({ generation, busy, regeneratingId, regenerate }: {
  generation: DispatcherGeneration;
  busy: boolean;
  regeneratingId: string | null;
  regenerate: (generation: DispatcherGeneration) => Promise<void>;
}) {
  return (
    <div className="dispatcher-timeline-card-row">
      <section className={`dispatcher-generation ${generation.status}`} id={`dispatcher-generation-${generation.id}`}>
        <header><span><ImageIcon size={16} /></span><div><strong>{generation.title}</strong><small>单张合集图 · {generation.characterCount} 个角色</small></div><em>{generation.status === "running" ? <><LoaderCircle className="spinning" size={13} />生成中</> : generation.status === "succeeded" ? "已完成" : "失败"}</em></header>
        {generation.previewPath && <div className="dispatcher-generation-preview"><Image src={generation.previewPath} alt={generation.title} width={1024} height={1024} unoptimized />{generation.status === "succeeded" && <button type="button" className="dispatcher-generation-regenerate" disabled={busy || regeneratingId !== null} onClick={() => void regenerate(generation)} title="重新生成这张合集图" aria-label={`重新生成：${generation.title}`}>{regeneratingId === generation.id ? <LoaderCircle className="spinning" size={17} /> : <RefreshCw size={17} />}</button>}</div>}
        <p>{generation.message}</p>
        <details><summary>查看生成要求</summary><p>{generation.prompt}</p></details>
      </section>
    </div>
  );
}
