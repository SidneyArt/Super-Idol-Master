# Super Idol Master（多智能体数字角色资产生产线）文档中心

本目录是项目开发、部署、交接和比赛演示的统一资料入口。文档按用途分为“上手与运行”“部署与远程环境”“架构与技术决策”“产品与需求”四类。

## 推荐阅读顺序

1. [系统架构概览](../ARCHITECTURE.md)：先理解代码结构、数据流、组件边界和安全边界。
2. [当前工程基线](./getting-started/current-project-baseline.md)：确认当前真正已经实现和验证的能力。
3. [本地全栈网站运行与维护](./getting-started/local-fullstack-web.md)：启动本地前端、后端和 SQLite。
4. [DGX 环境与访问](./deployment/dgx-access-and-network.md)：了解 SSH、Tailscale 和远程节点关系。
5. [AutoRemesher 部署指南](./deployment/dgx-autoremesher-deployment.md)：在 DGX Spark 上独立部署自动拓扑 API，不部署本项目。

## 目录分类

```text
docs/
├── README.md
├── getting-started/    # 当前基线、本地运行和日常维护
├── deployment/         # DGX、网络、远程服务和生成流水线
├── architecture/       # 技术实现、Runtime ADR 和选型记录
└── product/            # PRD、用户流程和验收范围
```

## 上手与运行

- [当前工程基线与运行信息](./getting-started/current-project-baseline.md)：仓库位置、真实运行证据、当前流程和已知边界。
- [本地全栈网站运行与维护](./getting-started/local-fullstack-web.md)：Windows 启动方式、API、状态机、SQLite 和预览策略。

## 部署与远程环境

- [DGX 环境与访问](./deployment/dgx-access-and-network.md)：Tailscale、公司电脑经 ECS SSH 隧道访问、两台 DGX 的关系和网络排障。
- [DGX / ComfyUI 全链路对应关系](./deployment/dgx-pipeline-integration.md)：Qwen Image、SDPose、Pixal3D、AutoRemesher、SkinTokens 和产物门禁。
- [DGX Spark AutoRemesher 独立 API 部署指南](./deployment/dgx-autoremesher-deployment.md)：仅上传 API 安装包，支持 Tailscale 直连或 ECS SSH 隧道，完成无 Token 服务升级、端口、调用和真实 GLB 验收，无需部署整站。
- [独立 API 安装包说明](../deploy/dgx-autoremesher/README.md)：部署目录内文件职责与安全边界。

## 架构与技术决策

- [技术实现指南](./architecture/technical-implementation-guide.md)：完整架构、Job 系统、数据模型、3D 预览与测试方案。
- [Agent Runtime 技术决策：采用 Pi](./architecture/agent-runtime-pi-adr.md)：当前正式 Runtime 决策及边界。
- [Agent 后端基础框架选型](./architecture/agent-backend-selection.md)：早期候选方案调研，结论冲突时以 ADR 为准。

## 产品与需求

- [产品需求文档](./product/super-idol-master-prd.md)：目标用户、用户流程、功能范围、验收标准和比赛交付。
- [DGX Spark Hackathon 参赛审计与提交清单](./product/hackathon-submission-audit.md)：按提交要求和评分权重核对当前证据、缺口、演示脚本与正式提交门禁。

## 文档维护规则

- 真实运行状态变化时，更新 `getting-started/current-project-baseline.md`。
- 本地接口、数据库或启动命令变化时，更新 `getting-started/local-fullstack-web.md`。
- DGX 地址、端口、部署命令或远程服务变化时，更新 `deployment/` 中的对应文档。
- 架构决策变化时新增或更新 `architecture/` 中的 ADR，不在 PRD 中覆盖技术结论。
- 产品范围和验收标准变化时更新 `product/`。
- 移动或重命名文档后，必须检查并修复仓库内全部相对链接。
- 不在文档中保存 SSH 私钥、密码、真实服务令牌或第三方 API Key。
- 生成资源只写入项目 `output/`，数据库只写入 `web/data/`。
