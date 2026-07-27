import assert from "node:assert/strict";
import test from "node:test";

import { chatMessagesEqual, isChatNearBottom } from "../app/chat-scroll.ts";

const message = {
  id: 1,
  role: "assistant",
  content: "完成",
  attachmentName: null,
  attachmentMime: null,
  createdAt: "2026-07-28T00:00:00.000Z",
};

test("identical polling messages are treated as unchanged", () => {
  assert.equal(chatMessagesEqual([message], [{ ...message }]), true);
});

test("message content and list changes are detected", () => {
  assert.equal(chatMessagesEqual([message], [{ ...message, content: "更新后的内容" }]), false);
  assert.equal(chatMessagesEqual([message], []), false);
});

test("a chat is near the bottom only within the configured threshold", () => {
  assert.equal(isChatNearBottom({ scrollHeight: 1000, scrollTop: 504, clientHeight: 400 }), true);
  assert.equal(isChatNearBottom({ scrollHeight: 1000, scrollTop: 503, clientHeight: 400 }), false);
});
