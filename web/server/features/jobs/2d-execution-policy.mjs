export function select2dExecution({
  run,
  repairMode,
  defaultProcessConfig,
  imageEditConfig,
}) {
  if (repairMode) {
    return {
      processConfig: { mode: "api", repairMode: true, api: imageEditConfig },
      sourceImage: run.imagePathInternal,
      tposeOutput: true,
    };
  }
  if (run.pipelineType === "image_to_model") {
    return {
      processConfig: { ...defaultProcessConfig, mode: "api", api: imageEditConfig },
      sourceImage: run.sourceImagePathInternal,
      tposeOutput: true,
    };
  }
  return {
    processConfig: defaultProcessConfig,
    sourceImage: run.imagePathInternal,
    tposeOutput: false,
  };
}
