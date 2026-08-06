export function hasRepairableTposeSource(run) {
  return Boolean(run)
    && run.currentStage === 2
    && (run.qaStatus === "failed" || run.qaStatus === "passed")
    && Boolean(run.imagePathInternal);
}

export function canStartTposeModelRepair(run, repairMode) {
  return repairMode === true && hasRepairableTposeSource(run);
}

export function captureTposeRepairSource(run) {
  return {
    id: run.id,
    currentStage: run.currentStage,
    qaStatus: run.qaStatus,
    imagePathInternal: run.imagePathInternal,
    qaMetricsJson: run.qaMetricsJson,
    updatedAt: run.updatedAt,
  };
}

export function isCurrentTposeRepairSource(snapshot, currentRun) {
  return hasRepairableTposeSource(currentRun)
    && snapshot.id === currentRun.id
    && snapshot.currentStage === currentRun.currentStage
    && snapshot.qaStatus === currentRun.qaStatus
    && snapshot.imagePathInternal === currentRun.imagePathInternal
    && snapshot.qaMetricsJson === currentRun.qaMetricsJson
    && snapshot.updatedAt === currentRun.updatedAt;
}
