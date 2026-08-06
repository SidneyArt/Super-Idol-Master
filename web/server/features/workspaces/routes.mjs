export function createWorkspaceRoutes({
  json,
  readBody,
  workspaces,
}) {
  return async function workspaceRoutes({ req, res, url, parts }) {
    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      json(res, 200, { workspaces: workspaces.list() });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      json(res, 201, workspaces.create(await readBody(req)));
      return true;
    }
    if (
      req.method === "DELETE" && parts[0] === "api"
      && parts[1] === "workspaces" && parts[2] && parts.length === 3
    ) {
      json(res, 200, workspaces.remove(decodeURIComponent(parts[2])));
      return true;
    }
    return false;
  };
}
