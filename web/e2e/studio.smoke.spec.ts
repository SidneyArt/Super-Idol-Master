import { expect, test } from "@playwright/test";

async function waitForStudioReady(page: import("@playwright/test").Page) {
  await expect(page.getByText("准备就绪", { exact: true })).toBeVisible();
}

test("首页加载并切换工作空间", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".dispatcher-title h1")).toHaveText("角色实验室");
  await waitForStudioReady(page);

  await page.locator(".workspace-select-button").filter({ hasText: "宣传片资产" }).click();
  await expect(page.locator(".dispatcher-title h1")).toHaveText("宣传片资产");
});

test("打开任务并切换可查看的工作流阶段", async ({ page }) => {
  await page.goto("/?task=run-1");
  await expect(page.getByText("Nova", { exact: true }).first()).toBeVisible();
  await waitForStudioReady(page);

  await page.locator(".stage-step").filter({ hasText: "姿态标准化" }).locator(".stage-main").click();
  await expect(page.locator(".preview-header")).toContainText("2D 概念图");
  await page.locator(".stage-step").filter({ hasText: "姿态质量检查" }).locator(".stage-main").click();
  await expect(page.locator(".preview-header")).toContainText("SDPose");
});

test("Agent 消息可发送、排队和取消", async ({ page }) => {
  await page.goto("/?task=run-1");
  await expect(page.getByText("待命", { exact: true })).toBeVisible();
  const composer = page.getByPlaceholder("给 Agent 下达资产生成任务…");
  await composer.fill("保持请求");
  const send = page.getByRole("button", { name: "发送消息" });
  await expect(send).toBeEnabled();
  await send.click();

  const queuedComposer = page.getByPlaceholder("继续输入，消息将进入待发送队列…");
  await queuedComposer.fill("第二条排队消息");
  await page.getByRole("button", { name: "加入发送队列" }).click();
  await expect(page.getByRole("region", { name: "Agent 待发送队列" })).toContainText("第二条排队消息");

  const cancelRequest = page.waitForRequest("**/api/runs/run-1/agent/cancel");
  await page.getByRole("button", { name: "停止当前 Agent 请求" }).click();
  await cancelRequest;
});

test("Coordinator 可以切换历史会话", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /历史会话/ }).click();
  const switchRequest = page.waitForRequest((request) => (
    request.url().endsWith("/api/dispatcher/sessions/current")
    && request.method() === "PUT"
  ));
  await page.getByRole("button", { name: /^角色方案 B / }).click();
  await switchRequest;
  await expect(page.getByRole("button", { name: /历史会话/ })).toContainText("2 条消息");
});

test("Settings 可以打开、修改并保存", async ({ page }) => {
  await page.goto("/");
  await waitForStudioReady(page);
  await page.getByRole("button", { name: "模型配置" }).click();
  const dialog = page.getByRole("form", { name: "模型配置" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "任务 Agent" }).click();
  const agentSection = dialog.getByRole("region", { name: "任务 Agent API 配置" });
  await agentSection.getByLabel("Base URL").first().fill("https://example.test/v1");

  const saveRequest = page.waitForRequest((request) => (
    request.url().endsWith("/api/settings") && request.method() === "PUT"
  ));
  await dialog.getByRole("button", { name: "保存配置" }).click();
  await saveRequest;
  await expect(dialog).toBeHidden();
});

test("审批操作和通知跳转保持可用", async ({ page }) => {
  await page.goto("/");
  const approvalCard = page.locator(".approval-card").filter({ hasText: "创建角色任务" });
  await expect(approvalCard).toBeVisible();
  const approveRequest = page.waitForRequest("**/api/approvals/7/approve");
  await approvalCard.getByRole("button", { name: "批准" }).click();
  await approveRequest;

  await page.goto("/?task=run-1");
  await page.getByRole("button", { name: /通知，1 条未读/ }).click();
  await expect(page.getByText("任务完成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /任务完成/ }).click();
  await expect(page).toHaveURL(/\?task=run-1$/);
});
