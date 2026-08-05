"use client";

import { Check, ChevronDown, MessageSquare, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { ApprovalMode, ConversationContext, ConversationSession } from "./contracts";
import { formatTime, formatTokenCount } from "./formatters";

export function AgentPermissionMenu({ mode, onChange, title }: { mode: ApprovalMode; onChange: (mode: ApprovalMode) => void; title: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className={`agent-permission-menu ${open ? "open" : ""}`} ref={rootRef}>
      <button type="button" className="agent-permission-trigger" onClick={() => setOpen((value) => !value)} title={title} aria-haspopup="listbox" aria-expanded={open}>
        {mode === "request"
          ? <span className="approval-shield-icon" aria-hidden="true" />
          : <Sparkles size={20} />}
        <span>{mode === "request" ? "请求批准" : "Auto"}</span><ChevronDown size={15} />
      </button>
      {open && (
        <div className="agent-permission-options" role="listbox" aria-label={title}>
          <button type="button" className={mode === "request" ? "selected" : ""} role="option" aria-selected={mode === "request"} onClick={() => { onChange("request"); setOpen(false); }}><span className="approval-shield-icon" aria-hidden="true" /><span><strong>请求批准</strong><small>执行变更前询问</small></span>{mode === "request" && <Check size={14} />}</button>
          <button type="button" className={mode === "auto" ? "selected" : ""} role="option" aria-selected={mode === "auto"} onClick={() => { onChange("auto"); setOpen(false); }}><Sparkles size={14} /><span><strong>Auto</strong><small>自动批准受控操作</small></span>{mode === "auto" && <Check size={14} />}</button>
        </div>
      )}
    </div>
  );
}

type StyledSelectOption = { value: string; label: string; disabled?: boolean };

export function StyledSelect({ value, options, onChange, ariaLabel, placement = "down", disabled = false }: {
  value: string;
  options: StyledSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placement?: "up" | "down";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) || options[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  return (
    <div className={`styled-select ${open ? "open" : ""} placement-${placement}`} ref={rootRef}>
      <button type="button" className="styled-select-trigger" disabled={disabled} onClick={() => setOpen((current) => !current)} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}>
        <span>{selected?.label || "请选择"}</span><ChevronDown size={15} />
      </button>
      {open && !disabled && (
        <div className="styled-select-options" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button key={option.value} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className={option.value === value ? "selected" : ""} onClick={() => { onChange(option.value); setOpen(false); }}>
              <span>{option.label}</span>{option.value === value && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

// `Intl.DateTimeFormat` 在 SSR 与客户端运行时可能因时区/区域差异产生不同文本，
// 直接渲染会触发 React hydration 不匹配。下面两个组件在客户端挂载后才计算时间字符串，
// SSR 阶段输出稳定占位符，确保两端渲染一致后再用客户端时间覆盖。
export function ClientTime({ value, fallback = "" }: { value: string; fallback?: string }) {
  const [text, setText] = useState(fallback);
  useEffect(() => {
    const timer = window.setTimeout(() => setText(formatTime(value)), 0);
    return () => window.clearTimeout(timer);
  }, [value]);
  return <time suppressHydrationWarning>{text}</time>;
}

function ClientSessionTime({ value, fallback = "" }: { value: string; fallback?: string }) {
  const [text, setText] = useState(fallback);
  useEffect(() => {
    const timer = window.setTimeout(() => setText(formatSessionTime(value)), 0);
    return () => window.clearTimeout(timer);
  }, [value]);
  return <small suppressHydrationWarning>{text}</small>;
}

export function ConversationSessionManager({
  sessions,
  sessionId,
  label,
  disabled,
  variant = "default",
  onActivate,
  onCreate,
  onDelete,
}: {
  sessions: ConversationSession[];
  sessionId: string;
  label: string;
  disabled: boolean;
  variant?: "default" | "home";
  onActivate: (sessionId: string) => void;
  onCreate: () => void;
  onDelete: (session: ConversationSession) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = sessions.find((session) => session.id === sessionId) || sessions[0] || null;
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  return (
    <div className={`conversation-manager ${variant === "home" ? "home-conversation-manager" : ""} ${open ? "open" : ""}`} ref={rootRef}>
      <button type="button" className="conversation-manager-trigger" disabled={disabled} onClick={() => setOpen((value) => !value)} aria-haspopup="dialog" aria-expanded={open} title={`${label}：${current?.title || "新会话"}`}>
        <MessageSquare size={14} />
        <span><strong>{variant === "home" ? "历史会话" : current?.title || "新会话"}</strong><small>{current ? `${current.messageCount} 条消息` : "正在创建"}</small></span>
        <ChevronDown size={13} />
      </button>
      <button type="button" className="conversation-create-button" disabled={disabled} onClick={() => { setOpen(false); onCreate(); }} title="新建会话" aria-label={`新建${label}`}><Plus size={15} />{variant === "home" && <span>新建会话</span>}</button>
      {open && !disabled && (
        <section className="conversation-menu" role="dialog" aria-label={`${label}列表`}>
          <header><div><strong>会话记录</strong><small>{sessions.length} 个会话</small></div><button type="button" onClick={() => { setOpen(false); onCreate(); }}><Plus size={14} />新对话</button></header>
          <div className="conversation-list">
            {sessions.map((session) => (
              <div className={`conversation-list-row ${session.id === sessionId ? "current" : ""}`} key={session.id}>
                <button type="button" className="conversation-list-main" onClick={() => { setOpen(false); onActivate(session.id); }}>
                  <span><MessageSquare size={14} /></span>
                  <div><strong>{session.title.replace(/\s+/g, " ")}</strong><small>{session.messageCount} 条消息 · </small><ClientSessionTime value={session.updatedAt} /></div>
                  {session.id === sessionId && <Check size={14} />}
                </button>
                <button type="button" className="conversation-delete-button" onClick={() => { setOpen(false); onDelete(session); }} title={`删除会话：${session.title}`} aria-label={`删除会话：${session.title}`}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function ContextUsage({ context, compact = false }: { context: ConversationContext | null; compact?: boolean }) {
  const used = context?.estimatedTokens || 0;
  const limit = context?.contextWindow || 131_072;
  const percent = Math.min(100, Math.max(0, context?.usagePercent || 0));
  const tooltipId = useId();
  const description = context
    ? `上下文已使用 ${percent}%，${used.toLocaleString()} / ${limit.toLocaleString()} tokens，剩余约 ${context.availableTokens.toLocaleString()} tokens`
    : "正在读取上下文用量";
  return (
    <span className={`context-usage ${compact ? "compact" : ""}`}>
      <button className="context-usage-trigger" type="button" aria-label={description} aria-describedby={tooltipId}>
        <span className="context-usage-pie" aria-hidden="true" style={{ background: `conic-gradient(var(--accent) ${percent * 3.6}deg, var(--border-strong) 0deg)` }} />
      </button>
      <span className="context-usage-tooltip" id={tooltipId} role="tooltip">
        <small>Context</small>
        <strong>{context ? `${percent}% · ${formatTokenCount(used)} / ${formatTokenCount(limit)}` : "正在读取…"}</strong>
        <span className="context-usage-divider" />
        <span className="context-usage-detail"><span>剩余可用</span><b>{context ? formatTokenCount(context.availableTokens) : "—"}</b></span>
        <span className="context-usage-detail"><span>消息</span><b>{context ? `${context.messageCount} 条` : "—"}</b></span>
      </span>
    </span>
  );
}
