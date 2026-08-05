export function createQualityGateRoutes({
  advanceRun,
  assetAgent,
  confirmCharacterIdea,
  existsSync,
  getRunRow,
  imageContent,
  json,
  readBody,
  revertRun,
}) {
  return async function qualityGateRoutes({ req, res, parts }) {
    if (
      req.method !== "POST" || parts[0] !== "api"
      || parts[1] !== "runs" || !parts[2]
      || !["start", "advance", "revert"].includes(parts[3])
    ) return false;
    const runId = parts[2];
    const existing = getRunRow(runId);
    if (!existing) {
      json(res, 404, { error: "任务不存在" });
      return true;
    }
    if (parts[3] === "start") {
      const body = await readBody(req);
      if (assetAgent.status().configured) {
        const referenceImage = existing.pipelineType === "image_to_model"
          && existing.sourceImagePathInternal
          && existsSync(existing.sourceImagePathInternal)
          ? imageContent(existing.sourceImagePathInternal)
          : null;
        try {
          await assetAgent.reviewPromptsOnly(
            runId,
            body,
            "确认角色设定前检查提示词",
            referenceImage,
          );
        } catch (error) {
          console.warn("[art-director] 检查提示词失败，已忽略：", error?.message || error);
        }
      }
      json(res, 200, {
        ...confirmCharacterIdea(runId, body),
        agentRoleRuns: assetAgent.getRoleRuns(runId),
      });
      return true;
    }
    if (parts[3] === "advance") {
      json(res, 200, advanceRun(runId));
      return true;
    }
    const body = await readBody(req);
    json(res, 200, revertRun(runId, Number(body.stage)));
    return true;
  };
}
