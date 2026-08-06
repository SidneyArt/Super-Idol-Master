import { spawn } from "node:child_process";

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

export function runJsonSubprocess({
  command,
  args,
  cwd,
  env,
  timeoutMs = 30_000,
  maxBuffer = DEFAULT_MAX_BUFFER,
  failureMessage = "子进程执行失败",
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBuffer) {
        child.kill();
        finish(() => reject(new Error(`${failureMessage}：输出超过 ${maxBuffer} 字节限制`)));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${failureMessage}：执行超过 ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      if (code !== 0) {
        reject(new Error((stderr || failureMessage).trim().slice(-1200)));
        return;
      }
      try {
        const line = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
        resolve(JSON.parse(line || "{}"));
      } catch (error) {
        reject(new Error(`${failureMessage}：没有返回有效 JSON`, { cause: error }));
      }
    }));
  });
}
