export function rigInputPath(run) {
  return run.topologySkipped ? run.modelPathInternal : run.topologyPathInternal;
}
