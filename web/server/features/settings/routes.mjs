export function createSettingsRoutes({
  invalidateSystemCache,
  json,
  readBody,
  settingsStore,
}) {
  return async function settingsRoutes({ req, res, url, parts }) {
    if (
      parts[0] === "api" && parts[1] === "settings"
      && parts[2] === "workflows" && parts[3]
    ) {
      const kind = parts[3];
      if (req.method === "GET" && parts[4]) {
        json(res, 200, settingsStore.getWorkflow(kind, parts[4]));
        return true;
      }
      if (req.method === "POST" && parts.length === 4) {
        const result = settingsStore.uploadWorkflow(kind, await readBody(req, 750_000));
        invalidateSystemCache();
        json(res, 201, result);
        return true;
      }
      if (req.method === "DELETE" && parts[4]) {
        const result = settingsStore.removeWorkflow(kind, parts[4]);
        invalidateSystemCache();
        json(res, 200, result);
        return true;
      }
    }
    if (req.method === "POST" && url.pathname === "/api/settings/agent/models") {
      json(res, 200, await settingsStore.fetchAgentModels(await readBody(req, 50_000)));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/settings") {
      json(res, 200, settingsStore.publicSettings());
      return true;
    }
    if (req.method === "PUT" && url.pathname === "/api/settings") {
      const result = settingsStore.update(await readBody(req, 2_500_000));
      invalidateSystemCache();
      json(res, 200, result);
      return true;
    }
    return false;
  };
}
