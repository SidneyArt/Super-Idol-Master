# Super-Idol-Master 文档索引

本目录是项目开发、交接和比赛演示的统一资料入口。实现前先看“当前基线”，涉及远程设备时再看“DGX 环境与访问”。

## 当前必读

1. [系统架构概览](../ARCHITECTURE.md)
   - 代码结构、高层系统图、组件边界、数据存储、安全和架构路线图。
2. [当前工程基线与运行信息](./current-project-baseline.md)
   - 当前仓库、已实现脚本、真实运行结果、已知问题和安全边界。
3. [DGX 环境与访问](./dgx-access-and-network.md)
   - Tailscale、SSH、ComfyUI、两台 DGX 的访问关系和排障方法。
4. [本地全栈网站实施方案](./local-fullstack-web.md)
   - Windows 本地启动方式、前后端边界、SQLite 数据库和 API 约定。
5. [DGX / ComfyUI 全链路对应关系](./dgx-pipeline-integration.md)
   - 四套真实工作流、自动 SDPose QA、状态机、产物校验与 E2E 证据。

## 产品与工程设计

- [产品需求文档](./super-idol-master-prd.md)：用户流程、功能范围、验收和比赛交付。
- [技术实现指南](./technical-implementation-guide.md)：完整架构、Job 系统、数据模型、SSE、3D 预览与测试。
- [Agent Runtime 技术决策：采用 Pi](./agent-runtime-pi-adr.md)：结合当前 Node 全栈基线，对 Pi、OpenCode、OpenClaw、Hermes、Claude、Codex 和自研 Loop 的正式取舍。
- [Agent 后端选型](./agent-backend-selection.md)：Agent Runtime 与编排器的职责和候选方案。

## 维护规则

- 真实运行状态与访问地址变化时，优先更新 `current-project-baseline.md` 和 `dgx-access-and-network.md`。
- 接口、数据库表或启动命令变化时，同步更新 `local-fullstack-web.md`。
- 不在仓库中保存 SSH 私钥、密码、临时令牌或第三方 API Key。
- 生成资源只写入项目 `output/`，数据库只写入 `web/data/`。
