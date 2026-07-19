import { spawn } from "node:child_process";
import { join } from "node:path";

const command = process.argv[2] || "dev";
const extraArgs = process.argv.slice(3);
const cli = join(process.cwd(), "node_modules", "vinext", "dist", "cli.js");
const child = spawn(process.execPath, [cli, command, ...extraArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || ".wrangler/wrangler.log",
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
