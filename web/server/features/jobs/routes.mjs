export function createJobRoutes({ jobs, json }) {
  return async function jobRoutes({ req, res, parts }) {
    if (
      req.method !== "POST" || parts[0] !== "api"
      || parts[1] !== "runs" || !parts[2] || !jobs.accepts(parts[3])
    ) return false;
    const result = jobs.start(parts[2], parts[3]);
    if (!result) {
      json(res, 404, { error: "任务不存在" });
      return true;
    }
    json(res, 202, result);
    return true;
  };
}
