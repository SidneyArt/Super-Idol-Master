const JOB_ACTIONS = {
  "generate-2d": "2d",
  "check-tpose": "qa",
  "generate-3d": "3d",
  retopologize: "topology",
  rig: "rig",
};

export function createJobRoutes({ getRunRow, json, startJob }) {
  return async function jobRoutes({ req, res, parts }) {
    if (
      req.method !== "POST" || parts[0] !== "api"
      || parts[1] !== "runs" || !parts[2] || !JOB_ACTIONS[parts[3]]
    ) return false;
    if (!getRunRow(parts[2])) {
      json(res, 404, { error: "任务不存在" });
      return true;
    }
    json(res, 202, startJob(parts[2], JOB_ACTIONS[parts[3]]));
    return true;
  };
}
