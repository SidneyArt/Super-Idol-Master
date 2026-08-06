"use client";

/* eslint-disable react-hooks/refs -- The lazy queue initializer stores callbacks; it does not execute or expose the captured refs during render. */

import {
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { chatMessagesEqual, isChatNearBottom } from "../../../chat-scroll";
import { api } from "../../shared/api-client";
import type {
  AgentAttachment,
  AgentQueueItem,
  ConversationPayload,
  ConversationSession,
  Run,
  RunDetail,
} from "../../shared/contracts";
import { usePollingQuery } from "../../shared/use-polling-query";
import { createAgentMessageQueue } from "./agent-message-queue";

const MAX_QUEUE_ITEMS = 20;

export type TaskAgentConfirmation = {
  title: string;
  description: string;
  confirmLabel: string;
  tone: "danger";
  action: () => Promise<void>;
};

type UseTaskAgentOptions = {
  run: Run | null;
  configured: boolean | undefined;
  onDetail: (detail: RunDetail) => void;
  onRunsChanged: (runs: Run[]) => void;
  onActivity: (showToast: boolean) => Promise<void>;
  onError: (message: string) => void;
  requestConfirmation: (confirmation: TaskAgentConfirmation) => void;
};

export function useTaskAgent({
  run,
  configured,
  onDetail,
  onRunsChanged,
  onActivity,
  onError,
  requestConfirmation,
}: UseTaskAgentOptions) {
  const [messages, setMessages] = useState<ConversationPayload["messages"]>([]);
  const [conversationRunId, setConversationRunId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [context, setContext] = useState<ConversationPayload["context"] | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [input, setInput] = useState("");
  const [attachment, setAttachment] = useState<AgentAttachment | null>(null);
  const [imageDragging, setImageDragging] = useState(false);
  const [queueState, setQueueState] = useState<{ active: AgentQueueItem | null; queued: AgentQueueItem[] }>({ active: null, queued: [] });
  const [collapsed, setCollapsed] = useState(false);
  const [roleCollapsed, setRoleCollapsed] = useState(false);
  const [width, setWidth] = useState(360);
  const [scrollRequest, setScrollRequest] = useState(0);

  const runRef = useRef(run);
  const callbacksRef = useRef({ onDetail, onRunsChanged, onActivity, onError, requestConfirmation });
  const optimisticIdRef = useRef(0);
  const queueIdRef = useRef(0);
  const dropDepthRef = useRef(0);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    runRef.current = run;
    callbacksRef.current = { onDetail, onRunsChanged, onActivity, onError, requestConfirmation };
  });

  const requestScroll = useCallback((force = false) => {
    if (force) forceScrollRef.current = true;
    setScrollRequest((request) => request + 1);
  }, []);

  const applyConversation = useCallback((data: ConversationPayload, forceScroll = false) => {
    setConversationRunId(runRef.current?.id || "");
    setMessages((current) => chatMessagesEqual(current, data.messages) ? current : data.messages);
    setSessionId(data.sessionId);
    setSessions(data.sessions);
    setContext(data.context);
    if (forceScroll) requestScroll(true);
  }, [requestScroll]);

  const [queue] = useState(() => createAgentMessageQueue({
      onChange: setQueueState,
      execute: async (item) => {
        const optimisticId = --optimisticIdRef.current;
        if (runRef.current?.id === item.runId) {
          setMessages((current) => [...current, {
            id: optimisticId,
            role: "user",
            content: item.message || "请分析这张参考图片并完善角色设定。",
            attachmentName: item.attachment?.name || null,
            attachmentMime: item.attachment?.mimeType || null,
            createdAt: new Date().toISOString(),
          }]);
        }
        try {
          const data = await api<ConversationPayload & { detail: RunDetail }>(`/api/runs/${item.runId}/agent/messages`, {
            method: "POST",
            body: JSON.stringify({
              message: item.message,
              image: item.attachment ? {
                name: item.attachment.name,
                mimeType: item.attachment.mimeType,
                data: item.attachment.data,
              } : undefined,
            }),
          });
          if (runRef.current?.id === item.runId) {
            applyConversation(data);
            callbacksRef.current.onDetail(data.detail);
          }
          void api<{ runs: Run[] }>("/api/runs")
            .then(({ runs }) => callbacksRef.current.onRunsChanged(runs))
            .catch(() => undefined);
          await callbacksRef.current.onActivity(true);
        } catch (reason) {
          callbacksRef.current.onError(`${item.runName}：${reason instanceof Error ? reason.message : "Agent 请求失败"}`);
          if (runRef.current?.id === item.runId) {
            try {
              const history = await api<ConversationPayload>(`/api/runs/${item.runId}/agent/messages`);
              if (runRef.current?.id === item.runId) applyConversation(history);
            } catch {
              setMessages((current) => current.filter((message) => message.id !== optimisticId));
            }
          }
          throw reason;
        }
      },
    }));

  const runId = run?.id || "";
  const conversationIsCurrent = conversationRunId === runId;

  usePollingQuery({
    key: runId,
    enabled: Boolean(runId) && queueState.active?.runId !== runId,
    foregroundMs: 3_000,
    backgroundMs: 30_000,
    query: (key, signal) => api<ConversationPayload>(`/api/runs/${key}/agent/messages`, { signal }),
    onData: (data, key) => {
      if (runRef.current?.id === key) applyConversation(data, messages.length === 0);
    },
    onError: (reason, key) => {
      if (runRef.current?.id === key && messages.length === 0) {
        callbacksRef.current.onError(reason instanceof Error ? reason.message : "任务 Agent 对话读取失败");
      }
    },
  });

  useEffect(() => {
    const container = threadRef.current;
    if (!container) return;
    const force = forceScrollRef.current;
    forceScrollRef.current = false;
    if (!force && !nearBottomRef.current) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    nearBottomRef.current = true;
  }, [messages, queueState.active, queueState.queued.length, scrollRequest]);

  function readAttachment(file: File) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      onError("参考图片只支持 PNG、JPEG 或 WebP");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      onError("参考图片不能超过 4 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result.split(",", 2)[1] : "";
      if (!data) return onError("参考图片读取失败");
      setAttachment({ name: file.name, mimeType: file.type, data, size: file.size });
    };
    reader.onerror = () => onError("参考图片读取失败");
    reader.readAsDataURL(file);
  }

  function send() {
    const selectedRun = runRef.current;
    const message = input.trim();
    if (!selectedRun || (!message && !attachment) || configured === false) return false;
    if (queue.state().queued.length >= MAX_QUEUE_ITEMS) {
      onError(`Agent 待发送队列最多保留 ${MAX_QUEUE_ITEMS} 条消息`);
      return false;
    }
    const item: AgentQueueItem = {
      id: ++queueIdRef.current,
      runId: selectedRun.id,
      runName: selectedRun.name,
      message,
      attachment,
    };
    setInput("");
    setAttachment(null);
    requestScroll(true);
    void queue.send(item).catch(() => undefined);
    return true;
  }

  async function cancel() {
    const active = queue.state().active;
    if (!active) return;
    try {
      await api(`/api/runs/${active.runId}/agent/cancel`, { method: "POST" });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "取消 Agent 失败");
    }
  }

  async function createSession() {
    const selectedRunId = runRef.current?.id;
    if (!selectedRunId || queueState.active || queueState.queued.length || sessionBusy) return;
    setSessionBusy(true);
    try {
      const data = await api<ConversationPayload>(`/api/runs/${selectedRunId}/agent/sessions`, { method: "POST" });
      if (runRef.current?.id === selectedRunId) {
        applyConversation(data, true);
        setInput("");
        setAttachment(null);
      }
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "新建任务 Agent 会话失败");
    } finally {
      setSessionBusy(false);
    }
  }

  async function switchSession(nextSessionId: string) {
    const selectedRunId = runRef.current?.id;
    if (!selectedRunId || nextSessionId === sessionId || queueState.active || queueState.queued.length || sessionBusy) return;
    setSessionBusy(true);
    try {
      const data = await api<ConversationPayload>(`/api/runs/${selectedRunId}/agent/sessions/current`, {
        method: "PUT",
        body: JSON.stringify({ sessionId: nextSessionId }),
      });
      if (runRef.current?.id === selectedRunId) applyConversation(data, true);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "切换任务 Agent 会话失败");
    } finally {
      setSessionBusy(false);
    }
  }

  function requestDeleteSession(session: ConversationSession) {
    const selectedRunId = runRef.current?.id;
    if (!selectedRunId || queueState.active || queueState.queued.length || sessionBusy) return;
    const deletingCurrent = session.id === sessionId;
    requestConfirmation({
      title: `删除“${session.title}”？`,
      description: "该会话中的用户消息和 Agent 回复会被永久删除；角色任务、流程进度、质检记录和模型资产不会被删除。",
      confirmLabel: "删除会话",
      tone: "danger",
      action: async () => {
        setSessionBusy(true);
        try {
          const data = await api<ConversationPayload>(`/api/runs/${selectedRunId}/agent/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
          if (runRef.current?.id !== selectedRunId) return;
          applyConversation(data, deletingCurrent);
          if (deletingCurrent) {
            setInput("");
            setAttachment(null);
          }
        } catch (reason) {
          onError(reason instanceof Error ? reason.message : "删除任务 Agent 会话失败");
        } finally {
          setSessionBusy(false);
        }
      },
    });
  }

  function openFilePicker() {
    if (!runRef.current) return onError("请先选择任务，再向 Agent 消息中添加参考图片");
    const fileInput = fileRef.current;
    if (!fileInput) return onError("无法打开文件选择器，请刷新页面后重试");
    fileInput.value = "";
    fileInput.click();
  }

  function handleDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dropDepthRef.current += 1;
    setImageDragging(true);
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
    if (dropDepthRef.current === 0) setImageDragging(false);
  }

  function handleDrop(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dropDepthRef.current = 0;
    setImageDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (!runRef.current) return onError("请先选择任务，再向 Agent 消息中拖入图片");
    if (files.length !== 1) return onError("每条 Agent 消息只能添加一张参考图片");
    readAttachment(files[0]);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (collapsed) return;
    dragRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    setWidth(Math.min(560, Math.max(300, dragRef.current.startWidth + dragRef.current.startX - event.clientX)));
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  return {
    conversation: {
      messages: conversationIsCurrent ? messages : [],
      sessionId: conversationIsCurrent ? sessionId : "",
      sessions: conversationIsCurrent ? sessions : [],
      context: conversationIsCurrent ? context : null,
    },
    queue: { items: queueState.queued, remove: queue.remove },
    status: { busy: Boolean(queueState.active), activeRunId: queueState.active?.runId || null, sessionBusy },
    composer: {
      input,
      setInput,
      attachment,
      removeAttachment: () => setAttachment(null),
      send,
      cancel,
      openFilePicker,
      fileInputProps: {
        ref: (node: HTMLInputElement | null) => { fileRef.current = node; },
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          const file = event.currentTarget.files?.[0];
          if (file) readAttachment(file);
          event.currentTarget.value = "";
        },
      },
      onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        send();
      },
    },
    sessions: { create: createSession, switch: switchSession, requestDelete: requestDeleteSession },
    panel: {
      collapsed,
      toggleCollapsed: () => setCollapsed((value) => !value),
      roleCollapsed,
      toggleRoleCollapsed: () => setRoleCollapsed((value) => !value),
      width,
      imageDragging,
      threadRef: (node: HTMLDivElement | null) => { threadRef.current = node; },
      onThreadScroll: (event: ReactUIEvent<HTMLDivElement>) => {
        nearBottomRef.current = isChatNearBottom(event.currentTarget);
      },
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      onResizeStart: startResize,
      onResizeMove: moveResize,
      onResizeEnd: endResize,
    },
  };
}

export type TaskAgentController = ReturnType<typeof useTaskAgent>;
