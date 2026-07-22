import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";

const root = process.cwd();
const pipelineDir = join(root, "server", "pipeline");
const backendUrl = "http://127.0.0.1:8787/api/health";
const frontendUrl = "http://localhost:3100";
const expectedDatabasePath = resolve(root, "data", "super-idol-master.db");
const children = [];
let stopping = false;

function normalizePath(value) {
  const normalized = resolve(String(value || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function isCurrentBackendRunning() {
  try {
    const response = await fetch(backendUrl, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.ok === true && normalizePath(health.databasePath) === normalizePath(expectedDatabasePath);
  } catch {
    return false;
  }
}

async function isCurrentFrontendRunning() {
  try {
    const response = await fetch(frontendUrl, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    return (await response.text()).includes("Super Idol Master");
  } catch {
    return false;
  }
}

function canConnect(host, port) {
  return new Promise((complete) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      complete(connected);
    };
    socket.setTimeout(750, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function isPortInUse(port) {
  if (await canConnect("127.0.0.1", port)) return true;
  return canConnect("::1", port);
}

function launch(label, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
    windowsHide: false,
  });
  child.label = label;
  children.push(child);
  child.on("exit", (code) => {
    if (!stopping && code !== 0) {
      console.error(`\n[${label}] 意外退出，代码 ${code ?? "unknown"}`);
      stop(1);
    }
  });
  return child;
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待服务超时：${url}`);
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  }
}

function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 500);
}

function syncPythonEnvironment() {
  console.log("正在同步后端 Python 环境（uv）…");
  const result = spawnSync("uv", ["sync", "--locked", "--project", pipelineDir], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  if (result.error?.code === "ENOENT") throw new Error("未找到 uv，请先安装 uv 并确保 uv 命令已加入 PATH");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`uv sync 失败，退出代码 ${result.status ?? "unknown"}`);
}

console.log("\nSuper Idol Master 本地系统正在启动…\n");

try {
  const [reuseBackend, reuseFrontend] = await Promise.all([
    isCurrentBackendRunning(),
    isCurrentFrontendRunning(),
  ]);
  if (!reuseBackend && await isPortInUse(8787)) {
    throw new Error("端口 8787 已被其他程序占用；请关闭占用程序，或为后端配置其他 API_PORT");
  }
  if (!reuseFrontend && await isPortInUse(3100)) {
    throw new Error("端口 3100 已被其他程序占用；请关闭占用程序后重试");
  }

  if (reuseBackend) {
    console.log("检测到当前项目的后端已在运行，将直接复用。");
  } else {
    syncPythonEnvironment();
    launch("后端", process.execPath, [join(root, "server", "index.mjs")], {
      NODE_NO_WARNINGS: "1",
    });
  }
  if (reuseFrontend) {
    console.log("检测到当前项目的前端已在运行，将直接复用。");
  } else {
    launch("前端", process.execPath, [join(root, "scripts", "run-vinext.mjs"), "dev", "--host", "127.0.0.1", "--port", "3100"]);
  }
  await Promise.all([
    waitFor(backendUrl),
    waitFor(frontendUrl),
  ]);
  console.log("\n✓ 前端：http://localhost:3100");
  console.log("✓ 后端：http://127.0.0.1:8787/api/health");
  console.log("✓ 数据库：web\\data\\super-idol-master.db");
  if (process.env.NO_OPEN_BROWSER !== "1") {
    openBrowser(frontendUrl);
  }
  if (reuseBackend && reuseFrontend) {
    console.log("\n系统已由另一个启动窗口托管，本窗口可以直接关闭。\n");
    process.exit(0);
  }
  if (reuseBackend || reuseFrontend) {
    console.log("\n关闭本窗口或按 Ctrl+C 只会停止本次新启动的组件；复用的组件会继续运行。\n");
  } else {
    console.log("\n关闭本窗口或按 Ctrl+C 可停止服务。\n");
  }
} catch (error) {
  console.error(`\n启动失败：${error.message}`);
  stop(1);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
