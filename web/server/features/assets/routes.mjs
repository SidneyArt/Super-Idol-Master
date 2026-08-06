export function createAssetRoutes({
  assets,
  json,
  readBody,
}) {
  return async function assetRoutes({ req, res, parts }) {
    if (parts[0] === "api" && parts[1] === "animations") {
      if (req.method === "GET" && parts.length === 2) {
        json(res, 200, { animations: assets.animations.list() });
        return true;
      }
      if (req.method === "POST" && parts.length === 2) {
        const animation = await assets.animations.create(await readBody(req, 22_000_000));
        json(res, 201, { animation, animations: assets.animations.list() });
        return true;
      }
      if (parts[2]) {
        const animationId = decodeURIComponent(parts[2]);
        const animation = assets.animations.get(animationId);
        if (!animation) {
          json(res, 404, { error: "动画不存在" });
          return true;
        }
        if (req.method === "GET" && parts[3] === "file" && parts.length === 4) {
          assets.streamPreview(res, animation.filePath);
          return true;
        }
        if (req.method === "DELETE" && parts.length === 3) {
          json(res, 200, assets.animations.remove(animationId));
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
        json(res, 200, { assets: assets.listWorkspace(workspaceId) });
        return true;
      }
      if (
        req.method === "DELETE" && parts[4] && parts[5]
        && parts.length === 6
      ) {
        json(res, 200, assets.removeWorkspaceAsset(
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
      const asset = assets.runAsset(parts[2], parts[4]);
      if (asset === null) {
        json(res, 404, { error: "任务不存在" });
        return true;
      }
      if (asset === undefined) {
        throw new Error(parts[3] === "preview" ? "未知资产类型" : "未知产物类型");
      }
      if (parts[3] === "preview") assets.streamPreview(res, asset.filePath);
      else assets.streamDownload(res, asset.filePath, `${asset.run.name}-${parts[4]}`);
      return true;
    }
    return false;
  };
}
