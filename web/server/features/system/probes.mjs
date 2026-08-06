import { PROCESS_KINDS } from "../../settings.mjs";

export function createSystemProbes({ settingsStore }) {
  let cache = null;
  let cacheAt = 0;

  function invalidate() {
    cache = null;
    cacheAt = 0;
  }

  async function fetchComfy(baseUrl, path, timeout = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let response = await fetch(`${baseUrl}/${path}`, { signal: controller.signal });
      if (response.status === 404) response = await fetch(`${baseUrl}/api/${path}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkTopology(config) {
    const started = Date.now();
    const baseline = { configured: Boolean(config.url), online: false, ready: false, url: config.url || "", latencyMs: 0, architecture: null };
    if (!config.url) return baseline;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${config.url}/healthz`, { signal: controller.signal });
      const health = response.ok ? await response.json() : {};
      return { ...baseline, online: response.ok, ready: response.ok && health.ready === true, latencyMs: Date.now() - started, architecture: typeof health.architecture === "string" ? health.architecture : null };
    } catch {
      return { ...baseline, latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  async function check(force = false) {
    if (!force && cache && Date.now() - cacheAt < 15_000) return cache;
    const configs = Object.fromEntries(PROCESS_KINDS.map((kind) => [kind, settingsStore.processConfig(kind)]));
    const endpointPromises = new Map();
    for (const config of Object.values(configs)) {
      if (config.mode === "api" || endpointPromises.has(config.url)) continue;
      endpointPromises.set(config.url, (async () => {
        const started = Date.now();
        try {
          const [stats, queue, objectInfo] = await Promise.all([
            fetchComfy(config.url, "system_stats", 5000),
            fetchComfy(config.url, "queue", 5000),
            fetchComfy(config.url, "object_info", 15_000),
          ]);
          return { online: true, stats, queue, objectInfo, latencyMs: Date.now() - started };
        } catch {
          return { online: false, queue: {}, objectInfo: {}, latencyMs: Date.now() - started };
        }
      })());
    }
    const topologyPromise = checkTopology(settingsStore.topologyConfig());
    const endpoints = new Map();
    await Promise.all([...endpointPromises.entries()].map(async ([url, promise]) => endpoints.set(url, await promise)));
    const topology = await topologyPromise;
    const checks = {};
    for (const kind of PROCESS_KINDS) {
      const config = configs[kind];
      if (config.mode === "api") {
        checks[kind] = { ready: Boolean(config.api.apiKey), online: Boolean(config.api.apiKey), missing: config.api.apiKey ? [] : ["API Key"], url: config.api.baseUrl, latencyMs: 0 };
        continue;
      }
      const endpoint = endpoints.get(config.url);
      const missing = [...new Set(Object.values(config.workflow).map((node) => node.class_type))].filter((name) => !endpoint.objectInfo[name]);
      const checkpointOptions = endpoint.objectInfo.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
      for (const node of Object.values(config.workflow)) {
        if (node.class_type === "CheckpointLoaderSimple" && node.inputs?.ckpt_name && !checkpointOptions.includes(node.inputs.ckpt_name)) missing.push(node.inputs.ckpt_name);
      }
      checks[kind] = { ready: endpoint.online && missing.length === 0, online: endpoint.online, missing: [...new Set(missing)], url: config.url, latencyMs: endpoint.latencyMs };
    }
    const endpointValues = [...endpoints.values()];
    const urls = [...endpoints.keys()];
    const devices = endpointValues.flatMap((item) => Array.isArray(item.stats?.devices) ? item.stats.devices : []).map((device) => ({
      name: typeof device.name === "string" ? device.name : "NVIDIA GPU",
      type: typeof device.type === "string" ? device.type : "cuda",
      index: Number.isFinite(Number(device.index)) ? Number(device.index) : null,
      vramTotal: Number.isFinite(Number(device.vram_total)) ? Number(device.vram_total) : null,
      vramFree: Number.isFinite(Number(device.vram_free)) ? Number(device.vram_free) : null,
      torchVramTotal: Number.isFinite(Number(device.torch_vram_total)) ? Number(device.torch_vram_total) : null,
      torchVramFree: Number.isFinite(Number(device.torch_vram_free)) ? Number(device.torch_vram_free) : null,
    }));
    const value = {
      online: endpointValues.every((item) => item.online),
      url: urls.length === 1 ? urls[0] : "多个端点",
      latencyMs: Math.max(0, ...endpointValues.map((item) => item.latencyMs)),
      version: [...new Set(endpointValues.map((item) => item.stats?.system?.comfyui_version).filter(Boolean))].join(", ") || null,
      queue: { running: endpointValues.reduce((total, item) => total + (item.queue.queue_running?.length || 0), 0), pending: endpointValues.reduce((total, item) => total + (item.queue.queue_pending?.length || 0), 0) },
      devices,
      topology,
      workflows: checks,
      pipelineReady: Object.values(checks).every((item) => item.ready) && topology.ready,
    };
    cache = value;
    cacheAt = Date.now();
    return value;
  }

  return { check, invalidate };
}
