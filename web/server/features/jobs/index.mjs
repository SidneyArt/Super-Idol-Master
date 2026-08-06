const JOB_ACTIONS = {
  "generate-2d": "2d",
  "check-tpose": "qa",
  "generate-3d": "3d",
  retopologize: "topology",
  rig: "rig",
};

export function createJobsFeature({ runs, startJob }) {
  function accepts(action) {
    return Object.hasOwn(JOB_ACTIONS, action);
  }

  function start(runId, action) {
    if (!runs.getInternal(runId)) return null;
    return startJob(runId, JOB_ACTIONS[action]);
  }

  return { accepts, start };
}
