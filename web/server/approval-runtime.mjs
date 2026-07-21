function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeMode(mode) {
  if (mode !== "request" && mode !== "auto") throw new Error("未知 Agent 权限模式");
  return mode;
}

export function createApprovalRuntime({ db }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_permission_modes (
      scope_type TEXT NOT NULL CHECK(scope_type IN ('coordinator', 'task')),
      scope_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('request', 'auto')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope_type, scope_id)
    );
    CREATE TABLE IF NOT EXISTS approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('coordinator', 'task')),
      scope_id TEXT NOT NULL,
      workspace_id TEXT,
      run_id TEXT,
      operation TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'executing', 'approved', 'rejected', 'failed')),
      result TEXT,
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests(status, id DESC);
    CREATE INDEX IF NOT EXISTS approval_requests_run_idx ON approval_requests(run_id, id DESC);
    CREATE TABLE IF NOT EXISTS app_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      workspace_id TEXT,
      run_id TEXT,
      approval_id INTEGER,
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_notifications_created_idx ON app_notifications(id DESC);
  `);
  db.prepare("UPDATE approval_requests SET status = 'failed', error_message = '本地服务重启，审批执行已中断', resolved_at = ? WHERE status = 'executing'").run(new Date().toISOString());

  let executor = null;

  function permission(scopeType, scopeId) {
    const row = db.prepare("SELECT mode FROM agent_permission_modes WHERE scope_type = ? AND scope_id = ?").get(scopeType, scopeId);
    return row?.mode === "auto" ? "auto" : "request";
  }

  function setPermission(scopeType, scopeId, mode) {
    if (!["coordinator", "task"].includes(scopeType)) throw new Error("未知 Agent 权限范围");
    const safeScopeId = String(scopeId || "").trim();
    if (!safeScopeId) throw new Error("Agent 权限范围不能为空");
    const safeMode = normalizeMode(mode);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO agent_permission_modes (scope_type, scope_id, mode, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
    `).run(scopeType, safeScopeId, safeMode, now);
    return { scopeType, scopeId: safeScopeId, mode: safeMode, updatedAt: now };
  }

  function addNotification({ kind, title, message, workspaceId = null, runId = null, approvalId = null }) {
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO app_notifications (kind, title, message, workspace_id, run_id, approval_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(kind, title, message, workspaceId, runId, approvalId, now);
    return getNotification(Number(result.lastInsertRowid));
  }

  function getNotification(id) {
    return db.prepare(`
      SELECT id, kind, title, message, workspace_id AS workspaceId, run_id AS runId,
             approval_id AS approvalId, read_at AS readAt, created_at AS createdAt
      FROM app_notifications WHERE id = ?
    `).get(id) || null;
  }

  function serializeApproval(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      workspaceId: row.workspaceId,
      runId: row.runId,
      operation: row.operation,
      title: row.title,
      description: row.description,
      payload: parseJson(row.payload, {}),
      status: row.status,
      result: parseJson(row.result, null),
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    };
  }

  function getApproval(id) {
    return serializeApproval(db.prepare(`
      SELECT id, scope_type AS scopeType, scope_id AS scopeId, workspace_id AS workspaceId,
             run_id AS runId, operation, title, description, payload, status, result,
             error_message AS errorMessage, created_at AS createdAt, resolved_at AS resolvedAt
      FROM approval_requests WHERE id = ?
    `).get(id));
  }

  function listApprovals(status = "pending") {
    const safeStatus = ["pending", "executing", "approved", "rejected", "failed"].includes(status) ? status : "pending";
    return db.prepare(`
      SELECT id, scope_type AS scopeType, scope_id AS scopeId, workspace_id AS workspaceId,
             run_id AS runId, operation, title, description, payload, status, result,
             error_message AS errorMessage, created_at AS createdAt, resolved_at AS resolvedAt
      FROM approval_requests WHERE status = ? ORDER BY id DESC LIMIT 100
    `).all(safeStatus).map((row) => {
      const approval = serializeApproval(row);
      delete approval.payload;
      return approval;
    });
  }

  function requestApproval({ scopeType, scopeId, workspaceId = null, runId = null, operation, title, description, payload = {} }) {
    const payloadJson = JSON.stringify(payload);
    const existing = db.prepare(`
      SELECT id FROM approval_requests
      WHERE scope_type = ? AND scope_id = ? AND operation = ? AND payload = ? AND status = 'pending'
      ORDER BY id DESC LIMIT 1
    `).get(scopeType, scopeId, operation, payloadJson);
    if (existing) return getApproval(existing.id);
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO approval_requests (
        scope_type, scope_id, workspace_id, run_id, operation, title, description, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeType, scopeId, workspaceId, runId, operation, title, description, payloadJson, now);
    const approval = getApproval(Number(result.lastInsertRowid));
    addNotification({
      kind: "approval_required",
      title: "需要审批",
      message: title,
      workspaceId,
      runId,
      approvalId: approval.id,
    });
    return approval;
  }

  async function approve(id) {
    const approval = getApproval(id);
    if (!approval) throw new Error("审批请求不存在");
    if (approval.status !== "pending") throw new Error("审批请求已经处理");
    if (!executor) throw new Error("审批执行器尚未就绪");
    const claim = db.prepare("UPDATE approval_requests SET status = 'executing', error_message = '' WHERE id = ? AND status = 'pending'").run(id);
    if (Number(claim.changes) !== 1) throw new Error("审批请求已经由其他操作处理");
    try {
      const result = await executor(approval);
      const now = new Date().toISOString();
      db.prepare("UPDATE approval_requests SET status = 'approved', result = ?, resolved_at = ? WHERE id = ?").run(JSON.stringify(result ?? null), now, id);
      addNotification({
        kind: "approval_executed",
        title: "审批已执行",
        message: approval.title,
        workspaceId: approval.workspaceId,
        runId: approval.runId,
        approvalId: approval.id,
      });
      return getApproval(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "审批执行失败";
      const now = new Date().toISOString();
      db.prepare("UPDATE approval_requests SET status = 'failed', error_message = ?, resolved_at = ? WHERE id = ?").run(message.slice(0, 1200), now, id);
      addNotification({
        kind: "approval_failed",
        title: "审批执行失败",
        message,
        workspaceId: approval.workspaceId,
        runId: approval.runId,
        approvalId: approval.id,
      });
      throw error;
    }
  }

  function reject(id) {
    const approval = getApproval(id);
    if (!approval) throw new Error("审批请求不存在");
    if (approval.status !== "pending") throw new Error("审批请求已经处理");
    const now = new Date().toISOString();
    const result = db.prepare("UPDATE approval_requests SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now, id);
    if (Number(result.changes) !== 1) throw new Error("审批请求已经由其他操作处理");
    return getApproval(id);
  }

  function listNotifications(limit = 50) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    return db.prepare(`
      SELECT id, kind, title, message, workspace_id AS workspaceId, run_id AS runId,
             approval_id AS approvalId, read_at AS readAt, created_at AS createdAt
      FROM app_notifications ORDER BY id DESC LIMIT ?
    `).all(safeLimit);
  }

  function markNotificationRead(id) {
    db.prepare("UPDATE app_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?").run(new Date().toISOString(), id);
    return getNotification(id);
  }

  return {
    permission,
    setPermission,
    requestApproval,
    listApprovals,
    getApproval,
    approve,
    reject,
    addNotification,
    listNotifications,
    markNotificationRead,
    setExecutor(value) { executor = value; },
  };
}
