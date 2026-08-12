import { defineConfig, devices } from "@playwright/test";

function withEnvironment(name: string, value: string, command: string) {
  return process.platform === "win32"
    ? `set "${name}=${value}" && ${command}`
    : `${name}=${value} ${command}`;
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://localhost:4181",
    trace: "retain-on-failure",
  },
  projects: [{
    name: "chromium",
    use: { ...devices["Desktop Chrome"], channel: "chrome" },
  }],
  webServer: [
    {
      command: withEnvironment("STUDIO_MOCK_API_PORT", "8791", "node e2e/mock-server.mjs"),
      port: 8791,
      reuseExistingServer: false,
    },
    {
      command: withEnvironment("NEXT_PUBLIC_API_URL", "http://127.0.0.1:8791", "npm run dev -- --port 4181"),
      port: 4181,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
