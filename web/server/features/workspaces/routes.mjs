export function createWorkspaceRoutes({
  cleanText,
  createWorkspaceRecord,
  deleteWorkspaceRecord,
  getWorkspacesSummary,
  json,
  readBody,
}) {
  return async function workspaceRoutes({ req, res, url, parts }) {
    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      json(res, 200, { workspaces: getWorkspacesSummary() });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      json(res, 201, createWorkspaceRecord(await readBody(req)));
      return true;
    }
    if (
      req.method === "DELETE" && parts[0] === "api"
      && parts[1] === "workspaces" && parts[2] && parts.length === 3
    ) {
      json(res, 200, deleteWorkspaceRecord(
        cleanText(decodeURIComponent(parts[2]), 80, "工作空间 ID", true),
      ));
      return true;
    }
    return false;
  };
}
