"use client";

import {
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
  ConversationPayload,
  ConversationSession,
  DispatcherGeneration,
  DispatcherTaskBatch,
  Run,
  Workspace,
} from "../../shared/contracts";
import { usePollingQuery } from "../../shared/use-polling-query";

type Confirmation = {
  title: string;
  description: string;
  confirmLabel: string;
  tone: "danger";
  action: () => Promise<void>;
};

type UseCoordinatorOptions = {
  workspaceId: string;
  configured: boolean | undefined;
  onWorkspacesChanged: (workspaces: Workspace[]) => void;
  onRunsChanged: (runs: Run[]) => void;
  onActivity: (showToast: boolean) => Promise<void>;
  onError: (message: string) => void;
  requestConfirmation: (confirmation: Confirmation) => void;
};

export function useCoordinator({
  workspaceId,
  configured,
  onWorkspacesChanged,
  onRunsChanged,
  onActivity,
  onError,
  requestConfirmation,
}: UseCoordinatorOptions) {
  const [messages, setMessages] = useState<ConversationPayload["messages"]>([]);
  const [conversationWorkspaceId, setConversationWorkspaceId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [context, setContext] = useState<ConversationPayload["context"] | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<AgentAttachment | null>(null);
  const [dragging, setDragging] = useState(false);
  const [generations, setGenerations] = useState<DispatcherGeneration[]>([]);
  const [taskBatches, setTaskBatches] = useState<DispatcherTaskBatch[]>([]);
  const [activityWorkspaceId, setActivityWorkspaceId] = useState("");
  const [scrollRequest, setScrollRequest] = useState(0);

  const workspaceRef = useRef(workspaceId);
  const sessionIdRef = useRef("");
  const callbacksRef = useRef({ onWorkspacesChanged, onRunsChanged, onActivity, onError, requestConfirmation });
  const optimisticIdRef = useRef(0);
  const dropDepthRef = useRef(0);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    workspaceRef.current = workspaceId;
    callbacksRef.current = { onWorkspacesChanged, onRunsChanged, onActivity, onError, requestConfirmation };
  });

  const requestScroll = useCallback((force = false) => {
    if (force) forceScrollRef.current = true;
    setScrollRequest((request) => request + 1);
  }, []);

  const applyConversation = useCallback((data: ConversationPayload, forceScroll = false) => {
    setConversationWorkspaceId(workspaceRef.current);
    setMessages((current) => chatMessagesEqual(current, data.messages) ? current : data.messages);
    sessionIdRef.current = data.sessionId;
    setSessionId(data.sessionId);
    setSessions(data.sessions);
    setContext(data.context);
    if (forceScroll) requestScroll(true);
  }, [requestScroll]);

  const clearConversation = useCallback(() => {
    setMessages([]);
    sessionIdRef.current = "";
    setSessionId("");
    setSessions([]);
    setContext(null);
    setGenerations([]);
    setTaskBatches([]);
    setAttachment(null);
    setDragging(false);
  }, []);

  usePollingQuery({
    key: workspaceId,
    enabled: Boolean(workspaceId) && !busy,
    foregroundMs: 3_000,
    backgroundMs: 30_000,
    query: (key, signal) => api<ConversationPayload>(`/api/dispatcher/messages?workspaceId=${encodeURIComponent(key)}`, { signal }),
    onData: (data, key) => {
      if (workspaceRef.current !== key) return;
      if (sessionIdRef.current && data.sessionId !== sessionIdRef.current) return;
      applyConversation(data, messages.length === 0);
    },
    onError: (reason, key) => {
      if (workspaceRef.current === key && messages.length === 0) {
        callbacksRef.current.onError(reason instanceof Error ? reason.message : "总调度对话读取失败");
      }
    },
  });

  const activityKey = `${workspaceId}:${sessionId}`;
  usePollingQuery({
    key: activityKey,
    enabled: Boolean(workspaceId),
    foregroundMs: 3_000,
    backgroundMs: 30_000,
    query: async (_key, signal) => {
      const activeWorkspaceId = workspaceRef.current;
      const activeSessionId = sessionIdRef.current;
      const [generationData, batchData] = await Promise.all([
        api<{ generations: DispatcherGeneration[] }>(`/api/dispatcher/generations?workspaceId=${encodeURIComponent(activeWorkspaceId)}&sessionId=${encodeURIComponent(activeSessionId)}`, { signal }),
        api<{ batches: DispatcherTaskBatch[] }>(`/api/dispatcher/task-batches?workspaceId=${encodeURIComponent(activeWorkspaceId)}&sessionId=${encodeURIComponent(activeSessionId)}`, { signal }),
      ]);
      return { workspaceId: activeWorkspaceId, sessionId: activeSessionId, generationData, batchData };
    },
    onData: (data) => {
      if (workspaceRef.current !== data.workspaceId || sessionIdRef.current !== data.sessionId) return;
      setActivityWorkspaceId(data.workspaceId);
      setGenerations(data.generationData.generations);
      setTaskBatches(data.batchData.batches);
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
  }, [busy, generations, messages, scrollRequest, taskBatches]);

  function readAttachment(file: File) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return onError("合集原画只支持 PNG、JPEG 或 WebP");
    if (file.size > 12 * 1024 * 1024) return onError("合集原画不能超过 12 MB");
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result.split(",", 2)[1] : "";
      if (!data) return onError("合集原画读取失败");
      setAttachment({ name: file.name, mimeType: file.type, data, size: file.size });
    };
    reader.onerror = () => onError("合集原画读取失败");
    reader.readAsDataURL(file);
  }

  async function send() {
    const message = input.trim();
    const activeWorkspaceId = workspaceRef.current;
    if ((!message && !attachment) || busy || configured === false || !activeWorkspaceId) return;
    const optimisticId = --optimisticIdRef.current;
    const image = attachment;
    setBusy(true);
    setMessages((current) => [...current, {
      id: optimisticId,
      role: "user",
      content: message || "请分析这张角色合集原画并拆分任务。",
      attachmentName: image?.name || null,
      attachmentMime: image?.mimeType || null,
      createdAt: new Date().toISOString(),
    }]);
    requestScroll(true);
    setInput("");
    setAttachment(null);
    try {
      const data = await api<ConversationPayload & { workspaces: Workspace[] }>("/api/dispatcher/messages", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: activeWorkspaceId,
          message,
          image: image ? { name: image.name, mimeType: image.mimeType, data: image.data } : undefined,
        }),
      });
      if (workspaceRef.current === activeWorkspaceId) applyConversation(data);
      callbacksRef.current.onWorkspacesChanged(data.workspaces);
      const { runs } = await api<{ runs: Run[] }>("/api/runs");
      callbacksRef.current.onRunsChanged(runs);
      await callbacksRef.current.onActivity(true);
    } catch (reason) {
      callbacksRef.current.onError(reason instanceof Error ? reason.message : "总调度 Agent 请求失败");
      try {
        const history = await api<ConversationPayload>(`/api/dispatcher/messages?workspaceId=${encodeURIComponent(activeWorkspaceId)}`);
        if (workspaceRef.current === activeWorkspaceId) applyConversation(history);
      } catch {
        if (workspaceRef.current === activeWorkspaceId) setMessages((current) => current.filter((item) => item.id !== optimisticId));
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!busy) return;
    try {
      await api("/api/dispatcher/cancel", { method: "POST" });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "取消总调度 Agent 失败");
    }
  }

  async function regenerate(generation: DispatcherGeneration) {
    const activeWorkspaceId = workspaceRef.current;
    const activeSessionId = sessionIdRef.current;
    if (busy || regeneratingId || !activeWorkspaceId || !activeSessionId) return;
    setRegeneratingId(generation.id);
    try {
      const data = await api<ConversationPayload & { workspaces: Workspace[] }>(`/api/dispatcher/generations/${encodeURIComponent(generation.id)}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ workspaceId: activeWorkspaceId, sessionId: activeSessionId }),
      });
      if (workspaceRef.current === activeWorkspaceId && sessionIdRef.current === activeSessionId) applyConversation(data);
      callbacksRef.current.onWorkspacesChanged(data.workspaces);
      await callbacksRef.current.onActivity(true);
    } catch (reason) {
      callbacksRef.current.onError(reason instanceof Error ? reason.message : "合集图重新生成失败");
      await callbacksRef.current.onActivity(false).catch(() => undefined);
    } finally {
      setRegeneratingId(null);
    }
  }

  async function createSession() {
    const activeWorkspaceId = workspaceRef.current;
    if (busy || sessionBusy || !activeWorkspaceId) return;
    setSessionBusy(true);
    clearConversation();
    try {
      const data = await api<ConversationPayload>("/api/dispatcher/sessions", {
        method: "POST",
        body: JSON.stringify({ workspaceId: activeWorkspaceId }),
      });
      if (workspaceRef.current === activeWorkspaceId) applyConversation(data, true);
      setInput("");
    } catch (reason) {
      callbacksRef.current.onError(reason instanceof Error ? reason.message : "新建总调度会话失败");
    } finally {
      setSessionBusy(false);
    }
  }

  async function switchSession(nextSessionId: string) {
    const activeWorkspaceId = workspaceRef.current;
    if (nextSessionId === sessionId || busy || sessionBusy || !activeWorkspaceId) return;
    setSessionBusy(true);
    clearConversation();
    try {
      const data = await api<ConversationPayload>("/api/dispatcher/sessions/current", {
        method: "PUT",
        body: JSON.stringify({ workspaceId: activeWorkspaceId, sessionId: nextSessionId }),
      });
      if (workspaceRef.current === activeWorkspaceId) applyConversation(data, true);
    } catch (reason) {
      callbacksRef.current.onError(reason instanceof Error ? reason.message : "切换总调度会话失败");
    } finally {
      setSessionBusy(false);
    }
  }

  function requestDeleteSession(session: ConversationSession) {
    const activeWorkspaceId = workspaceRef.current;
    if (busy || sessionBusy || !activeWorkspaceId) return;
    const deletingCurrent = session.id === sessionId;
    requestConfirmation({
      title: `删除“${session.title}”？`,
      description: "该会话的消息和总调度时间线会被永久删除；工作空间、已经创建的角色任务和模型资产不会被删除。",
      confirmLabel: "删除会话",
      tone: "danger",
      action: async () => {
        setSessionBusy(true);
        try {
          const data = await api<ConversationPayload>(`/api/dispatcher/sessions/${encodeURIComponent(session.id)}?workspaceId=${encodeURIComponent(activeWorkspaceId)}`, { method: "DELETE" });
          if (workspaceRef.current !== activeWorkspaceId) return;
          applyConversation(data, deletingCurrent);
          if (deletingCurrent) setInput("");
          await callbacksRef.current.onActivity(false);
        } catch (reason) {
          onError(reason instanceof Error ? reason.message : "删除总调度会话失败");
        } finally {
          setSessionBusy(false);
        }
      },
    });
  }

  function handleDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dropDepthRef.current += 1;
    setDragging(true);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
    if (dropDepthRef.current === 0) setDragging(false);
  }

  function handleDrop(event: ReactDragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dropDepthRef.current = 0;
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) return onError("每次只能上传一张合集原画");
    readAttachment(files[0]);
  }

  return {
    conversation: conversationWorkspaceId === workspaceId
      ? { messages, sessionId, sessions, context }
      : { messages: [], sessionId: "", sessions: [], context: null },
    activity: {
      generations: activityWorkspaceId === workspaceId ? generations : [],
      taskBatches: activityWorkspaceId === workspaceId ? taskBatches : [],
      regeneratingId,
    },
    status: { busy, sessionBusy },
    composer: {
      input,
      setInput,
      attachment,
      removeAttachment: () => setAttachment(null),
      send,
      cancel,
      fileInputProps: {
        ref: (node: HTMLInputElement | null) => { fileRef.current = node; },
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          const file = event.currentTarget.files?.[0];
          if (file) readAttachment(file);
          event.currentTarget.value = "";
        },
      },
      openFilePicker: () => fileRef.current?.click(),
      onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        void send();
      },
    },
    sessions: { create: createSession, switch: switchSession, requestDelete: requestDeleteSession },
    regenerate,
    isCurrent: (expectedWorkspaceId: string, expectedSessionId: string) => (
      workspaceRef.current === expectedWorkspaceId && sessionIdRef.current === expectedSessionId
    ),
    panel: {
      dragging,
      threadRef: (node: HTMLDivElement | null) => { threadRef.current = node; },
      endRef: (node: HTMLDivElement | null) => { endRef.current = node; },
      onThreadScroll: (event: ReactUIEvent<HTMLDivElement>) => {
        nearBottomRef.current = isChatNearBottom(event.currentTarget);
      },
      onDragEnter: handleDragEnter,
      onDragOver: (event: ReactDragEvent<HTMLElement>) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      },
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      scrollToEnd: () => endRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
    },
  };
}

export type CoordinatorController = ReturnType<typeof useCoordinator>;
