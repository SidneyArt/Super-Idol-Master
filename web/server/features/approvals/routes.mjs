export function createApprovalRoutes({
  approvalRuntime,
  cleanText,
  getRunRow,
  json,
  readBody,
}) {
  return async function approvalRoutes({ req, res, url, parts }) {
    if (req.method === "GET" && url.pathname === "/api/ui-preferences") {
      json(res, 200, approvalRuntime.preferences());
      return true;
    }
    if (req.method === "PUT" && url.pathname === "/api/ui-preferences") {
      json(res, 200, approvalRuntime.updatePreferences(await readBody(req, 50_000)));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/agent-controls") {
      const runId = url.searchParams.get("runId");
      const workspaceId = url.searchParams.get("workspaceId");
      const sessionId = url.searchParams.get("sessionId");
      const approvals = approvalRuntime.listApprovals("pending").filter((item) => (
        item.scopeType === "coordinator"
          ? Boolean(workspaceId) && Boolean(sessionId)
            && item.workspaceId === workspaceId && item.sessionId === sessionId
          : Boolean(runId) && item.runId === runId
      ));
      json(res, 200, {
        coordinatorMode: approvalRuntime.permission("coordinator", "global"),
        taskMode: runId ? approvalRuntime.permission("task", runId) : null,
        approvals,
      });
      return true;
    }
    if (req.method === "PUT" && url.pathname === "/api/agent-controls") {
      const body = await readBody(req, 50_000);
      const scopeType = body.scopeType === "coordinator"
        ? "coordinator"
        : body.scopeType === "task" ? "task" : null;
      if (!scopeType) throw new Error("未知 Agent 权限范围");
      const scopeId = scopeType === "coordinator"
        ? "global"
        : cleanText(body.runId, 80, "任务 ID", true);
      if (scopeType === "task" && !getRunRow(scopeId)) throw new Error("任务不存在");
      json(res, 200, approvalRuntime.setPermission(scopeType, scopeId, body.mode));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/notifications") {
      json(res, 200, {
        notifications: approvalRuntime.listNotifications(url.searchParams.get("limit")),
      });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/notifications/read-all") {
      json(res, 200, approvalRuntime.markAllNotificationsRead());
      return true;
    }
    if (req.method === "DELETE" && url.pathname === "/api/notifications") {
      json(res, 200, approvalRuntime.clearNotifications());
      return true;
    }
    if (
      parts[0] === "api" && parts[1] === "notifications" && parts[2]
      && parts.length === 3 && req.method === "DELETE"
    ) {
      const notificationId = Number(parts[2]);
      if (!Number.isInteger(notificationId) || notificationId <= 0) {
        throw new Error("通知不存在");
      }
      json(res, 200, approvalRuntime.deleteNotification(notificationId));
      return true;
    }
    if (
      parts[0] === "api" && parts[1] === "notifications" && parts[2]
      && req.method === "POST" && parts[3] === "read"
    ) {
      json(res, 200, approvalRuntime.markNotificationRead(Number(parts[2])));
      return true;
    }
    if (
      parts[0] === "api" && parts[1] === "approvals" && parts[2]
      && req.method === "POST"
    ) {
      if (parts[3] === "approve") {
        const approval = await approvalRuntime.approve(Number(parts[2]));
        json(res, 200, { ...approval, payload: undefined });
        return true;
      }
      if (parts[3] === "reject") {
        const approval = approvalRuntime.reject(Number(parts[2]));
        json(res, 200, { ...approval, payload: undefined });
        return true;
      }
    }
    return false;
  };
}
