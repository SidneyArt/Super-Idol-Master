export function createRunRoutes({
  activeJobs,
  assetAgent,
  createRunBodyMaxBytes,
  createRunRecord,
  db,
  getRunRow,
  json,
  readBody,
  runDetail,
  runSelect,
  serializeRun,
  addEvent,
}) {
  return async function runRoutes({ req, res, url, parts }) {
    if (req.method === "GET" && url.pathname === "/api/runs") {
      const workspaceId = url.searchParams.get("workspaceId");
      const rows = workspaceId
        ? db.prepare(`${runSelect} WHERE workspace_id = ? ORDER BY updated_at DESC`).all(workspaceId)
        : db.prepare(`${runSelect} ORDER BY updated_at DESC`).all();
      json(res, 200, { runs: rows.map(serializeRun) });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/runs") {
      json(res, 201, createRunRecord(await readBody(req, createRunBodyMaxBytes)));
      return true;
    }
    if (
      parts[0] !== "api" || parts[1] !== "runs" || !parts[2]
      || parts[3] === "agent" || parts[3] === "preview" || parts[3] === "download"
    ) return false;

    const runId = parts[2];
    const existing = getRunRow(runId);
    if (!existing) {
      json(res, 404, { error: "任务不存在" });
      return true;
    }
    if (req.method === "GET" && parts.length === 3) {
      json(res, 200, {
        ...runDetail(runId),
        agentRoleRuns: assetAgent.getRoleRuns(runId),
        agentWorkflowPlan: assetAgent.getWorkflowPlan(runId),
      });
      return true;
    }
    if (req.method === "POST" && parts[3] === "reset") {
      if (activeJobs.has(runId) || existing.jobStatus === "running") {
        throw new Error("DGX 任务正在执行，暂时不能重置");
      }
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE runs SET current_stage = 0, status = 'active', qa_status = 'pending',
          job_type = 'none', generation_status = 'idle', generation_message = '', generation_progress = 0,
          generation_prompt_id = NULL, generation_current_node = NULL, preview_path = NULL,
          image_path = NULL, model_path = NULL, topology_path = NULL, rigged_model_path = NULL,
          qa_score = NULL, qa_summary = '', qa_metrics = '{}', qa_overlay_path = NULL, updated_at = ? WHERE id = ?
      `).run(now, runId);
      addEvent(runId, "reset", 0, "流程和产物引用已重置", now);
      json(res, 200, runDetail(runId));
      return true;
    }
    if (req.method === "DELETE" && parts.length === 3) {
      if (activeJobs.has(runId) || existing.jobStatus === "running") {
        throw new Error("DGX 任务正在执行，暂时不能删除");
      }
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  };
}
