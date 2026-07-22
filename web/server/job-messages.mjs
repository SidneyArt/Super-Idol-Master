export function jobStartMessage(jobType, processConfig) {
  if (jobType === "2d") {
    return processConfig.mode === "api"
      ? `正在调用图片 API ${processConfig.api.model} 生成 2D 概念图`
      : "正在调用 DGX Qwen Image 生成 2D 概念图";
  }

  const messages = {
    qa: "正在调用 DGX SDPose 自动检查 T-Pose",
    "3d": "正在调用 DGX Pixal3D 生成静态 GLB",
    topology: "正在调用 DGX AutoRemesher 执行自动拓扑与纹理回烘",
    rig: "正在调用 DGX SkinTokens 自动绑骨",
  };
  const message = messages[jobType];
  if (!message) throw new Error(`未知任务类型：${jobType}`);
  return message;
}
