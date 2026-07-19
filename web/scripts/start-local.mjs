import { spawn } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const children = [];
let stopping = false;

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

console.log("\nSuper Idol Master 本地系统正在启动…\n");

launch("后端", process.execPath, [join(root, "server", "index.mjs")], {
  NODE_NO_WARNINGS: "1",
});
launch("前端", process.execPath, [join(root, "scripts", "run-vinext.mjs"), "dev", "--host", "127.0.0.1", "--port", "3100"]);

try {
  await Promise.all([
    waitFor("http://127.0.0.1:8787/api/health"),
    waitFor("http://localhost:3100"),
  ]);
  console.log("\n✓ 前端：http://localhost:3100");
  console.log("✓ 后端：http://127.0.0.1:8787/api/health");
  console.log("✓ 数据库：web\\data\\super-idol-master.db");
  console.log("\n浏览器已打开。关闭本窗口或按 Ctrl+C 可停止服务。\n");
  if (process.env.NO_OPEN_BROWSER !== "1") {
    openBrowser("http://localhost:3100");
  }
} catch (error) {
  console.error(`\n启动失败：${error.message}`);
  stop(1);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
