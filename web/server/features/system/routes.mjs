export function createSystemRoutes({
  assetAgent,
  checkComfyUi,
  databasePath,
  gpuScheduler,
  json,
  sourceMtimeMs,
}) {
  return async function systemRoutes({ req, res, url }) {
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        database: "sqlite",
        gpuScheduler: gpuScheduler.status(),
        databasePath,
        sourceMtimeMs,
        capabilities: [
          "workspace-assets-v1",
          "workspace-delete-v1",
          "mixamo-animation-library-v1",
          "global-gpu-scheduler-v1",
        ],
        agent: assetAgent.status(),
      });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/system") {
      json(res, 200, {
        api: true,
        database: true,
        agent: assetAgent.status(),
        comfyui: await checkComfyUi(url.searchParams.get("force") === "1"),
      });
      return true;
    }
    return false;
  };
}
