export function createQualityGateRoutes({
  json,
  qualityGates,
  readBody,
}) {
  return async function qualityGateRoutes({ req, res, parts }) {
    if (
      req.method !== "POST" || parts[0] !== "api"
      || parts[1] !== "runs" || !parts[2]
      || !["start", "advance", "revert"].includes(parts[3])
    ) return false;
    const runId = parts[2];
    if (!qualityGates.exists(runId)) {
      json(res, 404, { error: "任务不存在" });
      return true;
    }
    if (parts[3] === "start") {
      const body = await readBody(req);
      const result = await qualityGates.start(runId, body);
      json(res, result ? 200 : 404, result || { error: "任务不存在" });
      return true;
    }
    if (parts[3] === "advance") {
      const result = qualityGates.advance(runId);
      json(res, result ? 200 : 404, result || { error: "任务不存在" });
      return true;
    }
    const body = await readBody(req);
    const result = qualityGates.revert(runId, Number(body.stage));
    json(res, result ? 200 : 404, result || { error: "任务不存在" });
    return true;
  };
}
