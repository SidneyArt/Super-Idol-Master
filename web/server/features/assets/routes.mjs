export function createAssetRoutes({
  createAnimationAsset,
  deleteAnimationAsset,
  deleteWorkspaceAsset,
  getAnimationAsset,
  getRunRow,
  json,
  listAnimationAssets,
  listWorkspaceAssets,
  readBody,
  streamAssetPreview,
  streamDownload,
}) {
  return async function assetRoutes({ req, res, parts }) {
    if (parts[0] === "api" && parts[1] === "animations") {
      if (req.method === "GET" && parts.length === 2) {
        json(res, 200, { animations: listAnimationAssets() });
        return true;
      }
      if (req.method === "POST" && parts.length === 2) {
        const animation = await createAnimationAsset(await readBody(req, 22_000_000));
        json(res, 201, { animation, animations: listAnimationAssets() });
        return true;
      }
      if (parts[2]) {
        const animationId = decodeURIComponent(parts[2]);
        const animation = getAnimationAsset(animationId);
        if (!animation) {
          json(res, 404, { error: "动画不存在" });
          return true;
        }
        if (req.method === "GET" && parts[3] === "file" && parts.length === 4) {
          streamAssetPreview(res, animation.filePath);
          return true;
        }
        if (req.method === "DELETE" && parts.length === 3) {
          json(res, 200, deleteAnimationAsset(animationId));
          return true;
        }
      }
    }
    if (
      parts[0] === "api" && parts[1] === "workspaces"
      && parts[2] && parts[3] === "assets"
    ) {
      const workspaceId = decodeURIComponent(parts[2]);
      if (req.method === "GET" && parts.length === 4) {
        json(res, 200, { assets: listWorkspaceAssets(workspaceId) });
        return true;
      }
      if (
        req.method === "DELETE" && parts[4] && parts[5]
        && parts.length === 6
      ) {
        json(res, 200, deleteWorkspaceAsset(
          workspaceId,
          decodeURIComponent(parts[4]),
          decodeURIComponent(parts[5]),
        ));
        return true;
      }
    }
    if (
      parts[0] === "api" && parts[1] === "runs" && parts[2]
      && req.method === "GET"
      && (parts[3] === "preview" || parts[3] === "download")
      && parts[4]
    ) {
      const existing = getRunRow(parts[2]);
      if (!existing) {
        json(res, 404, { error: "任务不存在" });
        return true;
      }
      const paths = {
        source: existing.sourceImagePathInternal,
        image: existing.imagePathInternal,
        model: existing.modelPathInternal,
        topology: existing.topologyPathInternal,
        rigged: existing.riggedModelPathInternal,
      };
      if (!(parts[4] in paths)) {
        throw new Error(parts[3] === "preview" ? "未知资产类型" : "未知产物类型");
      }
      if (parts[3] === "preview") streamAssetPreview(res, paths[parts[4]]);
      else streamDownload(res, paths[parts[4]], `${existing.name}-${parts[4]}`);
      return true;
    }
    return false;
  };
}
