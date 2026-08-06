export function createRunRoutes({
  createRunBodyMaxBytes,
  json,
  readBody,
  runs,
  agents,
}) {
  return async function runRoutes({ req, res, url, parts }) {
    if (req.method === "GET" && url.pathname === "/api/runs") {
      const workspaceId = url.searchParams.get("workspaceId");
      json(res, 200, { runs: runs.list(workspaceId) });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/runs") {
      json(res, 201, runs.create(await readBody(req, createRunBodyMaxBytes)));
      return true;
    }
    if (
      parts[0] !== "api" || parts[1] !== "runs" || !parts[2]
      || parts[3] === "agent" || parts[3] === "preview" || parts[3] === "download"
    ) return false;

    const runId = parts[2];
    const existing = runs.getInternal(runId);
    if (!existing) {
      json(res, 404, { error: "任务不存在" });
      return true;
    }
    if (req.method === "GET" && parts.length === 3) {
      json(res, 200, {
        ...runs.get(runId),
        agentRoleRuns: agents.getRoleRuns(runId),
        agentWorkflowPlan: agents.getWorkflowPlan(runId),
      });
      return true;
    }
    if (req.method === "POST" && parts[3] === "reset") {
      json(res, 200, runs.reset(runId));
      return true;
    }
    if (req.method === "DELETE" && parts.length === 3) {
      json(res, 200, runs.remove(runId));
      return true;
    }
    return false;
  };
}
