"use client";

/* eslint-disable react-hooks/refs -- Task Agent DOM refs remain private to its controller and are only bound/read by event callbacks. */
/* eslint-disable @next/next/no-img-element -- Markdown images have runtime URLs and dimensions. */

import { Bot, Check, ChevronDown, ImageIcon, LoaderCircle, PanelRightClose, PanelRightOpen, Plus, Send, ShieldCheck, Sparkles, User, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { AgentRoleRun, ApprovalMode, ApprovalRequest, Run, RunDetail } from "../../shared/contracts";
import { AgentPermissionMenu, ContextUsage, ConversationSessionManager } from "../../shared/ui";
import type { TaskAgentController } from "./useTaskAgent";

export type SpecialistRoleItem = {
  run: AgentRoleRun;
  name: string;
  running: string;
  fallback: string;
  icon: string;
};

export function TaskAgentConsole({
  controller,
  run,
  detail,
  stageTitle,
  progress,
  specialistRoleRuns,
  approvals,
  approvalBusyId,
  mode,
  configured,
  selectedRoleIsRunning,
  selectedPlanIsRunning,
  activeRunName,
  resolveApproval,
  changeMode,
}: {
  controller: TaskAgentController;
  run: Run | null;
  detail: RunDetail | null;
  stageTitle: string;
  progress: number;
  specialistRoleRuns: SpecialistRoleItem[];
  approvals: ApprovalRequest[];
  approvalBusyId: number | null;
  mode: ApprovalMode;
  configured: boolean | undefined;
  selectedRoleIsRunning: boolean;
  selectedPlanIsRunning: boolean;
  activeRunName: string | undefined;
  resolveApproval: (id: number, decision: "approve" | "reject") => Promise<void>;
  changeMode: (mode: ApprovalMode) => Promise<void>;
}) {
  const { conversation, queue, status, composer, sessions, panel } = controller;
  const operationalBusy = status.busy || selectedRoleIsRunning || selectedPlanIsRunning;
  const selectedRunBusy = status.busy && status.activeRunId === run?.id;

  return (
    <aside className={`agent-panel ${panel.collapsed ? "agent-collapsed" : ""} ${panel.imageDragging ? "image-dragging" : ""}`} onDragEnter={panel.onDragEnter} onDragOver={panel.onDragOver} onDragLeave={panel.onDragLeave} onDrop={panel.onDrop}>
      <div className="agent-resizer" onPointerDown={panel.onResizeStart} onPointerMove={panel.onResizeMove} onPointerUp={panel.onResizeEnd} onPointerCancel={panel.onResizeEnd} role="separator" aria-label="调整 Agent 面板宽度" aria-orientation="vertical" />
      <div className="agent-header">
        <div className="agent-title"><span><Bot size={19} /></span><div><strong>Asset Agent</strong><small>工作对话</small></div></div>
        <div className="agent-header-actions">
          <span className={`agent-state ${operationalBusy ? "busy" : configured ? "" : "unavailable"}`}><i />{status.busy ? queue.items.length ? `处理中 · ${queue.items.length} 排队` : "处理中" : selectedRoleIsRunning ? "子 Agent 质检中" : selectedPlanIsRunning ? "自动执行中" : configured ? "待命" : "未配置"}</span>
          <button className="icon-button" type="button" onClick={panel.toggleCollapsed} title={panel.collapsed ? "展开 Agent 面板" : "收起 Agent 面板"} aria-label={panel.collapsed ? "展开 Agent 面板" : "收起 Agent 面板"}>{panel.collapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}</button>
        </div>
      </div>
      <div className="agent-summary">
        <div className="agent-context"><span>任务上下文</span><strong>{run?.name || "未选择任务"}</strong><p>{run ? `${stageTitle} · ${progress}% 完成` : "选择或创建任务后开始"}</p></div>
        {detail?.agentWorkflowPlan && <section className={`agent-orchestration ${detail.agentWorkflowPlan.status}`}><div><Bot size={15} /><strong>Supervisor 自动编排</strong><span>{detail.agentWorkflowPlan.status === "running" ? "执行中" : detail.agentWorkflowPlan.status === "completed" ? "已完成" : detail.agentWorkflowPlan.status === "blocked" ? "已暂停" : "失败"}</span></div><p>目标阶段：{detail.agentWorkflowPlan.targetStage + 1}</p><small>{detail.agentWorkflowPlan.message}</small></section>}
        <SpecialistReports items={specialistRoleRuns} collapsed={panel.roleCollapsed} toggle={panel.toggleRoleCollapsed} />
      </div>
      <div className="chat-thread" key={run?.id || "no-run"} ref={panel.threadRef} onScroll={panel.onThreadScroll}>
        {conversation.messages.map((message) => <div className={`chat-message ${message.role}`} key={message.id}><span className="chat-avatar">{message.role === "assistant" ? <Bot size={16} /> : <User size={16} />}</span><div><strong className="chat-author">{message.role === "assistant" ? "Asset Agent" : "你"}</strong>{message.attachmentName && <span className="chat-attachment"><ImageIcon size={14} />{message.attachmentName}</span>}<div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ href, children, ...props }) => <a {...props} href={href} target={href?.startsWith("http://") || href?.startsWith("https://") ? "_blank" : undefined} rel="noreferrer noopener">{children}</a>, img: ({ alt, ...props }) => <img {...props} alt={alt || "Markdown 图片"} loading="lazy" /> }}>{message.content}</ReactMarkdown></div></div></div>)}
        {selectedRunBusy && <div className="chat-message assistant pending"><span className="chat-avatar"><Bot size={16} /></span><div><strong className="chat-author">Asset Agent</strong><p><LoaderCircle size={15} />正在处理任务</p></div></div>}
        {status.busy && !selectedRunBusy && activeRunName && <div className="agent-background-status"><LoaderCircle size={14} />正在处理“{activeRunName}”的消息</div>}
        {queue.items.length > 0 && <section className="agent-message-queue" aria-label="Agent 待发送队列"><div className="agent-queue-heading"><span>待发送队列</span><strong>{queue.items.length}</strong></div><div className="agent-queue-list">{queue.items.map((item, index) => <div className="agent-queue-item" key={item.id}><span className="agent-queue-position">{index + 1}</span><div className="agent-queue-copy"><strong>{item.runName}</strong><p>{item.message || "分析参考图片并完善角色设定"}</p>{item.attachment && <span><ImageIcon size={12} />{item.attachment.name}</span>}</div><button type="button" onClick={() => queue.remove(item.id)} title="从队列移除" aria-label={`从队列移除：${item.message || item.attachment?.name || "图片消息"}`}><X size={14} /></button></div>)}</div></section>}
        {approvals.map((approval) => <section className="approval-card compact-card" key={approval.id}><span><ShieldCheck size={17} /></span><div><small>Asset Agent 请求批准</small><strong>{approval.title}</strong><p>{approval.description}</p></div><div className="approval-actions"><button type="button" className="secondary-button" disabled={approvalBusyId !== null} onClick={() => void resolveApproval(approval.id, "reject")}>拒绝</button><button type="button" className="primary-button" disabled={approvalBusyId !== null} onClick={() => void resolveApproval(approval.id, "approve")}>{approvalBusyId === approval.id ? <LoaderCircle className="spinning" size={14} /> : <Check size={14} />}批准</button></div></section>)}
      </div>
      {panel.imageDragging && !panel.collapsed && <div className="agent-drop-overlay" aria-hidden="true"><ImageIcon size={26} /><strong>松开以添加图片</strong></div>}
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); composer.send(); }}>
        {composer.attachment && <div className="attachment-chip"><ImageIcon size={14} /><span>{composer.attachment.name}</span><button type="button" onClick={composer.removeAttachment} title="移除图片" aria-label="移除参考图片"><X size={14} /></button></div>}
        <textarea value={composer.input} onChange={(event) => composer.setInput(event.target.value)} onKeyDown={composer.onKeyDown} rows={3} placeholder={status.busy ? "继续输入，消息将进入待发送队列…" : "给 Agent 下达资产生成任务…"} />
        <div className="composer-footer"><div className="composer-meta"><ConversationSessionManager sessions={conversation.sessions} sessionId={conversation.sessionId} label="Asset Agent 会话" disabled={!run || status.busy || queue.items.length > 0 || status.sessionBusy} onActivate={(value) => void sessions.switch(value)} onCreate={() => void sessions.create()} onDelete={sessions.requestDelete} />{run && <AgentPermissionMenu mode={mode} onChange={(nextMode) => void changeMode(nextMode)} title="选择当前任务 Agent 的变更审批方式" />}<ContextUsage context={conversation.context} compact /></div><div className="composer-actions"><button type="button" className="plus" onPointerDown={(event) => { event.preventDefault(); composer.openFilePicker(); }} onClick={(event) => event.preventDefault()} title="添加参考图片" aria-label="添加参考图片"><Plus size={17} /></button><input id="agent-file-input" {...composer.fileInputProps} type="file" accept="image/png,image/jpeg,image/webp" tabIndex={-1} aria-hidden="true" style={{ position: "fixed", top: 0, left: 0, width: "1px", height: "1px", opacity: 0.001, zIndex: -1, pointerEvents: "auto" }} />{status.busy && <button className="cancel" type="button" onClick={() => void composer.cancel()} aria-label="停止当前 Agent 请求" title="停止当前 Agent 请求"><X size={17} /></button>}<button type="submit" disabled={!run || (!composer.input.trim() && !composer.attachment) || queue.items.length >= 20 || configured === false} aria-label={status.busy ? "加入发送队列" : "发送消息"} title={status.busy ? "加入发送队列" : "发送消息"}><Send size={17} /></button></div></div>
      </form>
    </aside>
  );
}

export function SpecialistReports({ items, collapsed, toggle }: { items: SpecialistRoleItem[]; collapsed: boolean; toggle: () => void }) {
  if (!items.length) return null;
  return <section className={`agent-role-activity ${collapsed ? "collapsed" : ""}`} aria-label="多 Agent 协作记录"><button type="button" className="agent-role-activity-toggle" onClick={toggle} title={collapsed ? "展开多 Agent 协作" : "收起多 Agent 协作"} aria-expanded={!collapsed}><span>多 Agent 协作</span><ChevronDown size={14} /></button><div className="agent-role-list">{items.map((item) => <div className={`agent-role-row ${item.run.status}`} key={item.run.id}>{item.icon === "art" ? <Sparkles size={14} /> : <Bot size={14} />}<div><strong>{item.name}</strong><small>{item.run.status === "running" ? item.running : item.run.status === "succeeded" ? item.run.report?.summary || item.fallback : item.run.errorMessage}</small></div><em>{item.run.status === "running" ? "运行中" : item.run.status === "succeeded" ? "已完成" : "失败"}</em></div>)}</div></section>;
}
