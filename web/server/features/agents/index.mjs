export function createAgentsFeature({ db, runs, workspaces, taskRuntime, coordinatorRuntime, cleanText }) {
  function requireWorkspace(workspaceId) {
    if (!workspaces.get(workspaceId)) throw new Error("工作空间不存在");
    return workspaceId;
  }

  function listGenerations(workspaceId, sessionId = "") {
    requireWorkspace(workspaceId);
    return db.prepare(`
      SELECT id, workspace_id AS workspaceId, session_id AS sessionId, title, character_count AS characterCount,
             prompt, status, message, preview_path AS previewPath, created_at AS createdAt, updated_at AS updatedAt
      FROM dispatcher_generations WHERE workspace_id = ? AND session_id = ?
      ORDER BY created_at DESC LIMIT 30
    `).all(workspaceId, sessionId);
  }

  function listTaskBatches(workspaceId, sessionId = "") {
    requireWorkspace(workspaceId);
    return db.prepare(`
      SELECT id, workspace_id AS workspaceId, session_id AS sessionId, target,
             run_ids AS runIds, created_at AS createdAt
      FROM dispatcher_task_batches WHERE workspace_id = ? AND session_id = ?
      ORDER BY created_at DESC LIMIT 30
    `).all(workspaceId, sessionId).map((batch) => {
      let runIds = [];
      try {
        const parsed = JSON.parse(batch.runIds || "[]");
        if (Array.isArray(parsed)) runIds = parsed.filter((item) => typeof item === "string");
      } catch {
        runIds = [];
      }
      return {
        id: batch.id,
        workspaceId: batch.workspaceId,
        sessionId: batch.sessionId,
        target: batch.target,
        createdAt: batch.createdAt,
        tasks: runIds.map((runId) => runs.serialize(runs.getInternal(runId))).filter(Boolean),
      };
    });
  }

  const dispatcher = {
    conversation: (workspaceId) => coordinatorRuntime.getConversation(workspaceId),
    startSession: (workspaceId) => coordinatorRuntime.startSession(cleanText(workspaceId, 80, "工作空间 ID", true)),
    activateSession: (workspaceId, sessionId) => coordinatorRuntime.activateSession(
      cleanText(workspaceId, 80, "工作空间 ID", true),
      cleanText(sessionId, 80, "会话 ID", true),
    ),
    deleteSession: (workspaceId, sessionId) => coordinatorRuntime.deleteSession(
      cleanText(workspaceId, 80, "工作空间 ID", true),
      cleanText(sessionId, 80, "会话 ID", true),
    ),
    generations: listGenerations,
    taskBatches: listTaskBatches,
    regenerate: (input) => coordinatorRuntime.regenerateCharacterSheet({
      workspaceId: cleanText(input.workspaceId, 80, "工作空间 ID", true),
      sessionId: cleanText(input.sessionId, 80, "会话 ID", true),
      generationId: cleanText(input.generationId, 80, "生成任务 ID", true),
    }),
    run: (input) => coordinatorRuntime.run({
      workspaceId: typeof input.workspaceId === "string" && input.workspaceId ? input.workspaceId : null,
      message: input.message,
      image: input.image,
    }),
    cancel: () => coordinatorRuntime.cancel(),
  };

  const task = {
    exists: (runId) => Boolean(runs.getInternal(runId)),
    conversation: (runId) => taskRuntime.getConversation(runId),
    run: (runId, input) => taskRuntime.run({ runId, message: input.message, image: input.image }),
    cancel: (runId) => taskRuntime.cancel(runId),
    startSession: (runId) => taskRuntime.startSession(runId),
    activateSession: (runId, sessionId) => taskRuntime.activateSession(runId, cleanText(sessionId, 80, "会话 ID", true)),
    deleteSession: (runId, sessionId) => taskRuntime.deleteSession(runId, cleanText(sessionId, 80, "会话 ID", true)),
    getRoleRuns: (...args) => taskRuntime.getRoleRuns(...args),
    getWorkflowPlan: (...args) => taskRuntime.getWorkflowPlan(...args),
  };

  return { dispatcher, task };
}
