export const AGENT_CONTEXT_WINDOW = 131_072;
export const AGENT_RESPONSE_RESERVE = 4_096;

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) return 0;
  const cjk = (text.match(/[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk * 1.15 + other / 4);
}

export function contextStats(systemPrompt, messages = []) {
  const attachmentTokens = messages.filter((item) => item.attachmentName).length * 1_024;
  const estimatedTokens = Math.min(
    AGENT_CONTEXT_WINDOW,
    estimateTokens(systemPrompt) + attachmentTokens,
  );
  const usableTokens = AGENT_CONTEXT_WINDOW - AGENT_RESPONSE_RESERVE;
  return {
    estimatedTokens,
    contextWindow: AGENT_CONTEXT_WINDOW,
    responseReserve: AGENT_RESPONSE_RESERVE,
    availableTokens: Math.max(0, usableTokens - estimatedTokens),
    usagePercent: Math.min(100, Math.round((estimatedTokens / usableTokens) * 100)),
    messageCount: messages.length,
    estimated: true,
  };
}
