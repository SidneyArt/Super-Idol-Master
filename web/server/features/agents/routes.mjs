export function createAgentRoutes({
  assetAgent,
  cleanText,
  coordinatorAgent,
  getRunRow,
  getWorkspace,
  json,
  listDispatcherGenerations,
  listDispatcherTaskBatches,
  readBody,
}) {
  return async function agentRoutes({ req, res, url, parts }) {
    if (req.method === "GET" && url.pathname === "/api/dispatcher/messages") {
      json(res, 200, coordinatorAgent.getConversation(url.searchParams.get("workspaceId")));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/dispatcher/sessions") {
      const body = await readBody(req);
      json(res, 201, coordinatorAgent.startSession(
        cleanText(body.workspaceId, 80, "工作空间 ID", true),
      ));
      return true;
    }
    if (req.method === "PUT" && url.pathname === "/api/dispatcher/sessions/current") {
      const body = await readBody(req);
      json(res, 200, coordinatorAgent.activateSession(
        cleanText(body.workspaceId, 80, "工作空间 ID", true),
        cleanText(body.sessionId, 80, "会话 ID", true),
      ));
      return true;
    }
    if (
      req.method === "DELETE" && parts[0] === "api"
      && parts[1] === "dispatcher" && parts[2] === "sessions" && parts[3]
    ) {
      json(res, 200, coordinatorAgent.deleteSession(
        cleanText(url.searchParams.get("workspaceId"), 80, "工作空间 ID", true),
        cleanText(decodeURIComponent(parts[3]), 80, "会话 ID", true),
      ));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/dispatcher/generations") {
      const workspaceId = url.searchParams.get("workspaceId") || "default";
      const sessionId = url.searchParams.get("sessionId") || "";
      if (!getWorkspace(workspaceId)) throw new Error("工作空间不存在");
      json(res, 200, { generations: listDispatcherGenerations(workspaceId, sessionId) });
      return true;
    }
    if (
      req.method === "POST" && parts[0] === "api"
      && parts[1] === "dispatcher" && parts[2] === "generations"
      && parts[3] && parts[4] === "regenerate"
    ) {
      const body = await readBody(req);
      json(res, 200, coordinatorAgent.regenerateCharacterSheet({
        workspaceId: cleanText(body.workspaceId, 80, "工作空间 ID", true),
        sessionId: cleanText(body.sessionId, 80, "会话 ID", true),
        generationId: cleanText(decodeURIComponent(parts[3]), 80, "生成任务 ID", true),
      }));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/dispatcher/task-batches") {
      const workspaceId = url.searchParams.get("workspaceId") || "default";
      const sessionId = url.searchParams.get("sessionId") || "";
      if (!getWorkspace(workspaceId)) throw new Error("工作空间不存在");
      json(res, 200, { batches: listDispatcherTaskBatches(workspaceId, sessionId) });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/dispatcher/messages") {
      const body = await readBody(req, 18_000_000);
      json(res, 200, await coordinatorAgent.run({
        workspaceId: typeof body.workspaceId === "string" && body.workspaceId
          ? body.workspaceId
          : null,
        message: body.message,
        image: body.image,
      }));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/dispatcher/cancel") {
      json(res, 200, { cancelled: coordinatorAgent.cancel() });
      return true;
    }
    if (
      parts[0] === "api" && parts[1] === "runs" && parts[2]
      && parts[3] === "agent"
    ) {
      const runId = parts[2];
      if (!getRunRow(runId)) {
        json(res, 404, { error: "任务不存在" });
        return true;
      }
      if (req.method === "GET" && parts[4] === "messages") {
        json(res, 200, assetAgent.getConversation(runId));
        return true;
      }
      if (req.method === "POST" && parts[4] === "messages") {
        const body = await readBody(req, 6_000_000);
        json(res, 200, await assetAgent.run({
          runId,
          message: body.message,
          image: body.image,
        }));
        return true;
      }
      if (req.method === "POST" && parts[4] === "cancel") {
        json(res, 200, { cancelled: assetAgent.cancel(runId) });
        return true;
      }
      if (req.method === "POST" && parts[4] === "sessions" && parts.length === 5) {
        json(res, 201, assetAgent.startSession(runId));
        return true;
      }
      if (req.method === "PUT" && parts[4] === "sessions" && parts[5] === "current") {
        const body = await readBody(req);
        json(res, 200, assetAgent.activateSession(
          runId,
          cleanText(body.sessionId, 80, "会话 ID", true),
        ));
        return true;
      }
      if (req.method === "DELETE" && parts[4] === "sessions" && parts[5]) {
        json(res, 200, assetAgent.deleteSession(
          runId,
          cleanText(decodeURIComponent(parts[5]), 80, "会话 ID", true),
        ));
        return true;
      }
    }
    return false;
  };
}
