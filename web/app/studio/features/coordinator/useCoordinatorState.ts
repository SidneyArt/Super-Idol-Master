"use client";

import { useRef, useState } from "react";

import type {
  AgentAttachment,
  ApprovalMode,
  ChatMessage,
  ConversationContext,
  ConversationSession,
  DispatcherGeneration,
  DispatcherTaskBatch,
} from "../../shared/contracts";

export function useCoordinatorState() {
  const [dispatcherMessages, setDispatcherMessages] = useState<ChatMessage[]>([]);
  const [dispatcherSessionId, setDispatcherSessionId] = useState("");
  const [dispatcherSessions, setDispatcherSessions] = useState<ConversationSession[]>([]);
  const [dispatcherContext, setDispatcherContext] = useState<ConversationContext | null>(null);
  const [dispatcherSessionBusy, setDispatcherSessionBusy] = useState(false);
  const [dispatcherScrollRequest, setDispatcherScrollRequest] = useState(0);
  const [dispatcherInput, setDispatcherInput] = useState("");
  const [dispatcherBusy, setDispatcherBusy] = useState(false);
  const [dispatcherRegeneratingId, setDispatcherRegeneratingId] = useState<string | null>(null);
  const [dispatcherAttachment, setDispatcherAttachment] = useState<AgentAttachment | null>(null);
  const [dispatcherDragging, setDispatcherDragging] = useState(false);
  const [dispatcherGenerations, setDispatcherGenerations] = useState<DispatcherGeneration[]>([]);
  const [dispatcherTaskBatches, setDispatcherTaskBatches] = useState<DispatcherTaskBatch[]>([]);
  const [coordinatorMode, setCoordinatorMode] = useState<ApprovalMode>("request");

  const dispatcherSessionIdRef = useRef("");
  const dispatcherOptimisticIdRef = useRef(0);
  const dispatcherDropDepthRef = useRef(0);
  const dispatcherEndRef = useRef<HTMLDivElement | null>(null);
  const dispatcherThreadRef = useRef<HTMLDivElement | null>(null);
  const dispatcherNearBottomRef = useRef(true);
  const dispatcherForceScrollRef = useRef(false);
  const dispatcherFileRef = useRef<HTMLInputElement | null>(null);

  return {
    dispatcherMessages, setDispatcherMessages, dispatcherSessionId, setDispatcherSessionId,
    dispatcherSessions, setDispatcherSessions, dispatcherContext, setDispatcherContext,
    dispatcherSessionBusy, setDispatcherSessionBusy, dispatcherScrollRequest, setDispatcherScrollRequest,
    dispatcherInput, setDispatcherInput, dispatcherBusy, setDispatcherBusy,
    dispatcherRegeneratingId, setDispatcherRegeneratingId, dispatcherAttachment, setDispatcherAttachment,
    dispatcherDragging, setDispatcherDragging, dispatcherGenerations, setDispatcherGenerations,
    dispatcherTaskBatches, setDispatcherTaskBatches, coordinatorMode, setCoordinatorMode,
    dispatcherSessionIdRef, dispatcherOptimisticIdRef, dispatcherDropDepthRef, dispatcherEndRef,
    dispatcherThreadRef, dispatcherNearBottomRef, dispatcherForceScrollRef, dispatcherFileRef,
  };
}
