"use client";

import { useRef, useState } from "react";

import type {
  AgentAttachment,
  AgentQueueItem,
  ApprovalMode,
  ChatMessage,
  ConversationContext,
  ConversationSession,
} from "../../shared/contracts";

export function useTaskAgentState(defaultPrompt: {
  positivePrompt: string;
  negativePrompt: string;
}) {
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const [agentRoleCollapsed, setAgentRoleCollapsed] = useState(false);
  const [agentWidth, setAgentWidth] = useState(360);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSessionId, setChatSessionId] = useState("");
  const [chatSessions, setChatSessions] = useState<ConversationSession[]>([]);
  const [chatContext, setChatContext] = useState<ConversationContext | null>(null);
  const [chatSessionBusy, setChatSessionBusy] = useState(false);
  const [chatScrollRequest, setChatScrollRequest] = useState(0);
  const [agentBusy, setAgentBusy] = useState(false);
  const [activeAgentRunId, setActiveAgentRunId] = useState<string | null>(null);
  const [agentQueue, setAgentQueue] = useState<AgentQueueItem[]>([]);
  const [agentAttachment, setAgentAttachment] = useState<AgentAttachment | null>(null);
  const [agentImageDragging, setAgentImageDragging] = useState(false);
  const [taskAgentMode, setTaskAgentMode] = useState<ApprovalMode>("request");
  const [promptDraft, setPromptDraft] = useState(defaultPrompt);

  const agentDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const agentQueueRef = useRef<AgentQueueItem[]>([]);
  const agentProcessingRef = useRef(false);
  const agentQueueIdRef = useRef(0);
  const agentDropDepthRef = useRef(0);
  const chatThreadRef = useRef<HTMLDivElement | null>(null);
  const chatNearBottomRef = useRef(true);
  const chatForceScrollRef = useRef(false);
  const agentFileRef = useRef<HTMLInputElement | null>(null);

  function openAgentFilePicker() {
    const input = agentFileRef.current;
    if (!input) return false;
    input.value = "";
    input.click();
    return true;
  }

  return {
    agentCollapsed, setAgentCollapsed, agentRoleCollapsed, setAgentRoleCollapsed,
    agentWidth, setAgentWidth, chatInput, setChatInput, chatMessages, setChatMessages,
    chatSessionId, setChatSessionId, chatSessions, setChatSessions, chatContext, setChatContext,
    chatSessionBusy, setChatSessionBusy, chatScrollRequest, setChatScrollRequest,
    agentBusy, setAgentBusy, activeAgentRunId, setActiveAgentRunId, agentQueue, setAgentQueue,
    agentAttachment, setAgentAttachment, agentImageDragging, setAgentImageDragging,
    taskAgentMode, setTaskAgentMode, promptDraft, setPromptDraft, agentDragRef,
    agentQueueRef, agentProcessingRef, agentQueueIdRef, agentDropDepthRef, chatThreadRef,
    chatNearBottomRef, chatForceScrollRef, agentFileRef, openAgentFilePicker,
  };
}
