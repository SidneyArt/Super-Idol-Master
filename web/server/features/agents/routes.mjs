export function createAgentRoutes({
  agents,
  json,
  readBody,
}) {
  return async function agentRoutes({ req, res, url, parts }) {
    if (req.method === "GET" && url.pathname === "/api/dispatcher/messages") {
      json(res, 200, agents.dispatcher.conversation(url.searchParams.get("workspaceId")));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/dispatcher/sessions") {
      const body = await readBody(req);
      json(res, 201, agents.dispatcher.startSession(body.workspaceId));
      return true;
    }
    if (req.method === "PUT" && url.pathname === "/api/dispatcher/sessions/current") {
      const body = await readBody(req);
      json(res, 200, agents.dispatcher.activateSession(body.workspaceId, body.sessionId));
      return true;
    }
    if (
      req.method === "DELETE" && parts[0] === "api"
      && parts[1] === "dispatcher" && parts[2] === "sessions" && parts[3]
    ) {
      json(res, 200, agents.dispatcher.deleteSession(url.searchParams.get("workspaceId"), decodeURIComponent(parts[3])));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/dispatcher/generations") {
      const workspaceId = url.searchParams.get("workspaceId") || "default";
      const sessionId = url.searchParams.get("sessionId") || "";
      json(res, 200, { generations: agents.dispatcher.generations(workspaceId, sessionId) });
      return true;
    }
    if (
      req.method === "POST" && parts[0] === "api"
      && parts[1] === "dispatcher" && parts[2] === "generations"
      && parts[3] && parts[4] === "regenerate"
    ) {
      const body = await readBody(req);
      json(res, 200, agents.dispatcher.regenerate({ ...body, generationId: decodeURIComponent(parts[3]) }));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/dispatcher/task-batches") {
      const workspaceId = url.searchParams.get("workspaceId") || "default";
      const sessionId = url.searchParams.get("sessionId") || "";
      json(res, 200, { batches: agents.dispatcher.taskBatches(workspaceId, sessionId) });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/dispatcher/messages") {
      const body = await readBody(req, 18_000_000);
      json(res, 200, await agents.dispatcher.run(body));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/dispatcher/cancel") {
      json(res, 200, { cancelled: agents.dispatcher.cancel() });
      return true;
    }
    if (
      parts[0] === "api" && parts[1] === "runs" && parts[2]
      && parts[3] === "agent"
    ) {
      const runId = parts[2];
      if (!agents.task.exists(runId)) {
        json(res, 404, { error: "任务不存在" });
        return true;
      }
      if (req.method === "GET" && parts[4] === "messages") {
        json(res, 200, agents.task.conversation(runId));
        return true;
      }
      if (req.method === "POST" && parts[4] === "messages") {
        const body = await readBody(req, 6_000_000);
        json(res, 200, await agents.task.run(runId, body));
        return true;
      }
      if (req.method === "POST" && parts[4] === "cancel") {
        json(res, 200, { cancelled: agents.task.cancel(runId) });
        return true;
      }
      if (req.method === "POST" && parts[4] === "sessions" && parts.length === 5) {
        json(res, 201, agents.task.startSession(runId));
        return true;
      }
      if (req.method === "PUT" && parts[4] === "sessions" && parts[5] === "current") {
        const body = await readBody(req);
        json(res, 200, agents.task.activateSession(runId, body.sessionId));
        return true;
      }
      if (req.method === "DELETE" && parts[4] === "sessions" && parts[5]) {
        json(res, 200, agents.task.deleteSession(runId, decodeURIComponent(parts[5])));
        return true;
      }
    }
    return false;
  };
}
