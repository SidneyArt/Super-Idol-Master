export const CHAT_NEAR_BOTTOM_THRESHOLD = 96;

export type ComparableChatMessage = {
  id: number;
  role: "assistant" | "user";
  content: string;
  attachmentName: string | null;
  attachmentMime: string | null;
  createdAt: string;
};

type ScrollContainerMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function chatMessagesEqual(current: ComparableChatMessage[], incoming: ComparableChatMessage[]) {
  if (current.length !== incoming.length) return false;
  return current.every((message, index) => {
    const next = incoming[index];
    return message.id === next.id
      && message.role === next.role
      && message.content === next.content
      && message.attachmentName === next.attachmentName
      && message.attachmentMime === next.attachmentMime
      && message.createdAt === next.createdAt;
  });
}

export function isChatNearBottom(container: ScrollContainerMetrics) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= CHAT_NEAR_BOTTOM_THRESHOLD;
}
