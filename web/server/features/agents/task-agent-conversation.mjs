import { randomUUID } from "node:crypto";
import { contextStats } from "../../conversation-context.mjs";
import { buildSystemPrompt } from "./runtime-support.mjs";

export function createTaskAgentConversation({ db, getPermissionMode, getRunDetail, isBusy }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      attachment_name TEXT,
      attachment_mime TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    )
  `);
  const agentMessageColumns = db.prepare("PRAGMA table_info(agent_messages)").all();
  if (!agentMessageColumns.some((column) => column.name === "session_id")) {
    db.exec("ALTER TABLE agent_messages ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
  }
  db.exec("CREATE INDEX IF NOT EXISTS agent_messages_run_id_idx ON agent_messages(run_id, id DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS agent_messages_session_idx ON agent_messages(run_id, session_id, id DESC)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '新会话',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS agent_conversations_run_idx ON agent_conversations(run_id, updated_at DESC)");
  db.exec(`
    INSERT OR IGNORE INTO agent_conversations (id, run_id, title, created_at, updated_at)
    SELECT messages.session_id, messages.run_id,
           COALESCE((SELECT substr(first.content, 1, 48) FROM agent_messages first
                     WHERE first.run_id = messages.run_id AND first.session_id = messages.session_id AND first.role = 'user'
                     ORDER BY first.id ASC LIMIT 1), '新会话'),
           MIN(messages.created_at), MAX(messages.created_at)
    FROM agent_messages messages
    WHERE messages.session_id <> ''
    GROUP BY messages.run_id, messages.session_id
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_conversation_state (
      run_id TEXT PRIMARY KEY,
      current_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    )
  `);
  
  function ensureSession(runId) {
    const state = db.prepare("SELECT current_session_id AS sessionId FROM agent_conversation_state WHERE run_id = ?").get(runId);
    if (state?.sessionId) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO agent_conversations (id, run_id, title, created_at, updated_at)
        VALUES (?, ?, '新会话', ?, ?)
      `).run(state.sessionId, runId, now, now);
      return state.sessionId;
    }
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE agent_messages SET session_id = ? WHERE run_id = ? AND session_id = ''").run(sessionId, runId);
      const firstMessage = db.prepare(`
        SELECT substr(content, 1, 48) AS title, MIN(created_at) AS createdAt, MAX(created_at) AS updatedAt
        FROM agent_messages WHERE run_id = ? AND session_id = ? AND role = 'user'
      `).get(runId, sessionId);
      db.prepare(`
        INSERT INTO agent_conversations (id, run_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(sessionId, runId, firstMessage?.title || "新会话", firstMessage?.createdAt || now, firstMessage?.updatedAt || now);
      db.prepare(`
        INSERT INTO agent_conversation_state (run_id, current_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET current_session_id = excluded.current_session_id, updated_at = excluded.updated_at
      `).run(runId, sessionId, now, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return sessionId;
  }
  
  function listSessions(runId) {
    const currentSessionId = ensureSession(runId);
    const rows = db.prepare(`
      SELECT conversations.id, conversations.title, conversations.created_at AS createdAt,
             conversations.updated_at AS updatedAt, COUNT(messages.id) AS messageCount
      FROM agent_conversations conversations
      LEFT JOIN agent_messages messages
        ON messages.run_id = conversations.run_id AND messages.session_id = conversations.id
      WHERE conversations.run_id = ?
      GROUP BY conversations.id
      ORDER BY conversations.id = ? DESC, conversations.updated_at DESC
    `).all(runId, currentSessionId);
    return rows.map((item) => ({ ...item, isCurrent: item.id === currentSessionId }));
  }
  
  function getMessages(runId, limit = 100, requestedSessionId = null) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
    const sessionId = requestedSessionId || ensureSession(runId);
    return db.prepare(`
      SELECT id, role, content, attachment_name AS attachmentName,
             attachment_mime AS attachmentMime, created_at AS createdAt
      FROM (
        SELECT * FROM agent_messages WHERE run_id = ? AND session_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(runId, sessionId, safeLimit);
  }
  
  function addMessage(runId, role, content, image = null) {
    const sessionId = ensureSession(runId);
    const createdAt = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO agent_messages (run_id, session_id, role, content, attachment_name, attachment_mime, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runId, sessionId, role, content, image?.name || null, image?.mimeType || null, createdAt);
    db.prepare(`
      UPDATE agent_conversations
      SET title = CASE WHEN title = '新会话' AND ? = 'user' THEN substr(?, 1, 48) ELSE title END,
          updated_at = ?
      WHERE id = ? AND run_id = ?
    `).run(role, content, createdAt, sessionId, runId);
    return {
      id: Number(result.lastInsertRowid),
      role,
      content,
      attachmentName: image?.name || null,
      attachmentMime: image?.mimeType || null,
      createdAt,
    };
  }
  
  function getConversation(runId) {
    const sessionId = ensureSession(runId);
    const messages = getMessages(runId, 100, sessionId);
    const contextMessages = messages.slice(-24);
    const detail = getRunDetail(runId);
    const prompt = detail?.run ? buildSystemPrompt(detail, contextMessages, getPermissionMode(runId)) : "";
    return {
      sessionId,
      messages,
      sessions: listSessions(runId),
      context: contextStats(prompt, contextMessages),
    };
  }
  
  function startSession(runId) {
    if (isBusy(runId)) throw new Error("Agent 正在处理消息，暂时不能新建会话");
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO agent_conversations (id, run_id, title, created_at, updated_at) VALUES (?, ?, '新会话', ?, ?)").run(sessionId, runId, now, now);
      db.prepare(`
        INSERT INTO agent_conversation_state (run_id, current_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET current_session_id = excluded.current_session_id, updated_at = excluded.updated_at
      `).run(runId, sessionId, now, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return getConversation(runId);
  }
  
  function activateSession(runId, sessionId) {
    if (isBusy(runId)) throw new Error("Agent 正在处理消息，暂时不能切换会话");
    const current = ensureSession(runId);
    const exists = sessionId === current || db.prepare("SELECT 1 FROM agent_conversations WHERE run_id = ? AND id = ? LIMIT 1").get(runId, sessionId);
    if (!exists) throw new Error("会话不存在");
    db.prepare("UPDATE agent_conversation_state SET current_session_id = ?, updated_at = ? WHERE run_id = ?").run(sessionId, new Date().toISOString(), runId);
    return getConversation(runId);
  }
  
  function deleteSession(runId, sessionId) {
    if (isBusy(runId)) throw new Error("Agent 正在处理消息，暂时不能删除会话");
    const currentSessionId = ensureSession(runId);
    const exists = db.prepare("SELECT 1 FROM agent_conversations WHERE run_id = ? AND id = ? LIMIT 1").get(runId, sessionId);
    if (!exists) throw new Error("会话不存在");
    const fallback = sessionId === currentSessionId
      ? db.prepare("SELECT id FROM agent_conversations WHERE run_id = ? AND id <> ? ORDER BY updated_at DESC LIMIT 1").get(runId, sessionId)
      : { id: currentSessionId };
    const nextSessionId = fallback?.id || randomUUID();
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!fallback?.id) {
        db.prepare("INSERT INTO agent_conversations (id, run_id, title, created_at, updated_at) VALUES (?, ?, '新会话', ?, ?)").run(nextSessionId, runId, now, now);
      }
      db.prepare("DELETE FROM agent_messages WHERE run_id = ? AND session_id = ?").run(runId, sessionId);
      db.prepare("DELETE FROM agent_conversations WHERE run_id = ? AND id = ?").run(runId, sessionId);
      db.prepare("UPDATE agent_conversation_state SET current_session_id = ?, updated_at = ? WHERE run_id = ?").run(nextSessionId, now, runId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return getConversation(runId);
  }

  return { activateSession, addMessage, deleteSession, getConversation, getMessages, listSessions, startSession };
}
