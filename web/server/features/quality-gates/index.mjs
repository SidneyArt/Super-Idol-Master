import { existsSync } from "node:fs";

export {
  canStartTposeModelRepair,
  captureTposeRepairSource,
  hasRepairableTposeSource,
  isCurrentTposeRepairSource,
} from "./tpose-repair-policy.mjs";

export function createQualityGatesFeature({
  runs,
  agents,
  imageContent,
  exists = existsSync,
  warn = (...args) => console.warn(...args),
}) {
  async function start(runId, input = {}) {
    const run = runs.getInternal(runId);
    if (!run) return null;
    if (agents.status().configured) {
      const referenceImage = run.pipelineType === "image_to_model"
        && run.sourceImagePathInternal
        && exists(run.sourceImagePathInternal)
        ? imageContent(run.sourceImagePathInternal)
        : null;
      try {
        await agents.reviewPromptsOnly(runId, input, "确认角色设定前检查提示词", referenceImage);
      } catch (error) {
        warn("[art-director] 检查提示词失败，已忽略：", error?.message || error);
      }
    }
    return { ...runs.confirm(runId, input), agentRoleRuns: agents.getRoleRuns(runId) };
  }

  function advance(runId) {
    if (!runs.getInternal(runId)) return null;
    return runs.advance(runId);
  }

  function revert(runId, targetStage) {
    if (!runs.getInternal(runId)) return null;
    return runs.revert(runId, targetStage);
  }

  return { advance, exists: (runId) => Boolean(runs.getInternal(runId)), revert, start };
}
