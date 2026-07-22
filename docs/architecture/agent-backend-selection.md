# Agent 后端基础框架选型分析

> 分类：架构与技术决策
>
> 更新日期：2026-07-16  
> 适用项目：Super-Idol-Master 数字偶像管家

> 本文保留为早期候选方案调研。基于当前 Node 全栈工程的正式 Runtime 决策见
> [Agent Runtime 技术决策：采用 Pi](./agent-runtime-pi-adr.md)，若结论冲突以该 ADR 为准。

## 1. 背景与目标

项目的未来目标是构建一个对话式桌面应用，让用户通过自然语言完成以下流程：

1. AI 文生图，生成角色概念图。
2. 用户选择、修改或重新生成图片。
3. AI 根据图片生成 3D 模型。
4. AI 自动完成骨骼绑定和蒙皮。
5. 用户预览并导出最终资产。

当前工程已经通过 Python 和 ComfyUI 实现了确定性的 `2D → 3D → SkinTokens 蒙皮`流程：

- `web/server/pipeline/run_2d_generation.py`
- `web/server/pipeline/run_3d_generation.py`
- `web/server/pipeline/run_3d_skinning.py`
- `web/server/pipeline/run_comfy_workflows.py`

因此，选型重点并不是寻找一个能够自由操作 Shell 的代码 Agent，而是寻找一个可以嵌入桌面应用、支持多轮对话、能够稳定调用领域工具的 Agent Runtime。

## 2. 核心结论

针对本项目，建议如下：

1. **长期产品底座：优先选择 Pi 的 `pi-agent-core` 和 `pi-ai`。**
2. **快速验证 MVP：使用 OpenCode Server。**
3. 如果能够接受 Claude 模型锁定，且首要目标是快速获得较好的 Agent 效果，可以使用 **Claude Agent SDK Python**。
4. 不建议直接将 Codex、OpenClaw 或 Hermes 作为本项目的核心 Agent Runtime。

无论最终选择哪个框架，都不应让 LLM 自由控制整个生成管线。LLM 应负责理解意图、补充参数、选择工具和解释结果；2D 生成、3D 生成、自动绑定、重试、取消和资产保存应由确定性的任务编排器负责。

## 3. 候选工具对比

| 工具 | 主要优点 | 主要缺点 | 本项目适用性 |
|---|---|---|---|
| Claude Code / Claude Agent SDK | 提供 Python 和 TypeScript SDK；工具调用、会话恢复、MCP、权限控制和结构化输出较成熟；Agent 效果较好 | 主要绑定 Claude；调用成本较高；SDK 和云服务受 Anthropic 商业条款约束；仍带有代码 Agent 的设计假设 | 适合快速开发高质量、Claude-only 的 MVP |
| Codex | 提供 Python 和 TypeScript SDK；核心代码采用 Apache 2.0 许可证；支持流式事件、图片输入、结构化输出和沙箱 | 官方定位为 coding-focused Agent；绑定 OpenAI；Python SDK 仍处于 Beta；领域工具编排并非核心定位 | 不建议作为主要 Runtime，可作为代码类子 Agent |
| OpenCode | MIT 许可证；提供 Headless HTTP Server、OpenAPI 和 TypeScript SDK；支持大量模型供应商及本地模型；具备自定义工具、插件、权限和会话事件 | 本质仍是完整代码 Agent；默认文件和 Shell 工具增加攻击面；运行和打包成本高于轻量 Runtime；Python SDK 相对不成熟 | 最适合快速验证、模型横向对比和原型开发 |
| Pi | MIT 许可证；拆分出统一模型层 `pi-ai` 和运行时 `pi-agent-core`；支持多模型供应商；可通过 TypeScript SDK 或 JSON-RPC 嵌入；核心较小 | 主要面向 TypeScript/Node.js；默认不包含 MCP、子 Agent、权限弹窗和后台任务；生产能力需要自行补充 | 最适合长期产品底座 |
| OpenClaw | 具备完整 Gateway、会话、记忆、多 Agent、设备接入和聊天平台集成；插件体系完整 | 面向长期运行的个人助理和多渠道聊天；架构庞大；攻击面和运维复杂度较高；对单机创作工具存在明显冗余 | 适合未来作为 Telegram、Discord 等外部渠道层 |
| Hermes | MIT 许可证；Python 实现；提供 HTTP/SSE、JSON-RPC、ACP、MCP、插件、记忆、技能和子 Agent | 默认工具和自主能力很多；自主技能学习使行为更难测试和复现；安全、依赖与桌面打包成本较高 | 只有在长期记忆和自主助理是核心卖点时才值得考虑 |

## 4. 各方案详细分析

### 4.1 Claude Agent SDK

Claude Agent SDK 提供 Python 和 TypeScript 接口，可以复用 Claude Code 的 Agent Loop、上下文管理、工具权限和会话机制。它支持：

- 自定义进程内工具。
- MCP Server。
- 工具允许列表和拒绝列表。
- 多轮会话、恢复和分叉。
- 流式消息和结构化输出。

对于当前以 Python 为主的工程，Claude Agent SDK Python 的接入成本较低。可以直接把现有 ComfyUI 调用封装为自定义工具。

主要问题是模型和供应商锁定。即使通过 AWS Bedrock 或 Google Vertex AI 调用，底层仍然是 Claude。SDK 源代码许可证与 Anthropic 服务商业条款也需要分别评估，不能只依据某一个仓库中的 MIT 声明判断产品分发条件。

适用场景：

- 需要尽快完成高质量 MVP。
- 团队愿意长期使用 Claude。
- 能够接受云端模型成本和商业条款约束。

### 4.2 Codex

Codex 提供 Python 和 TypeScript SDK，支持多轮 Thread、流式事件、图片输入和不同级别的文件系统沙箱。

但是，OpenAI 官方将 Codex SDK 定位为 coding-focused Agent。对于更广泛的业务编排，官方建议使用通用 Agents SDK，将 Codex 作为其中的代码专家或 MCP Server。

本项目的主要任务是生成图片、3D 模型和绑定模型，而不是修改代码仓库。因此直接使用 Codex 会引入较多与 Git、工作目录、文件编辑和代码执行相关的概念。

适用场景：

- 未来需要自动编写 ComfyUI 节点、插件或生成脚本。
- 将 Codex 作为专门处理代码任务的子 Agent。

### 4.3 OpenCode

OpenCode 的优势是提供完整的 Headless Server：

- 通过 HTTP 和 OpenAPI 控制 Session。
- 通过 SDK 发送 Prompt、取消任务并监听事件。
- 支持大量云模型供应商和本地模型。
- 支持 TypeScript 自定义工具和插件。
- 支持按工具配置 `allow`、`ask` 和 `deny` 权限。

这使 OpenCode 很适合快速验证桌面对话 UI、不同模型和工具调用链路。领域工具可以使用 TypeScript 定义，再调用现有 Python 脚本或本地 Python 服务。

但是，OpenCode 的核心仍然是代码 Agent。正式产品必须禁用不需要的文件、Shell、编辑和搜索工具，否则会扩大桌面应用的本地安全边界。

适用场景：

- 快速完成可交互原型。
- 同时测试 Claude、OpenAI、Google 和本地模型。
- 暂时不希望自己实现会话和事件协议。

### 4.4 Pi

Pi 的仓库将不同层次拆分为：

- `pi-ai`：统一多供应商 LLM API。
- `pi-agent-core`：Agent Loop、工具调用和状态管理。
- `pi-coding-agent`：完整的终端代码 Agent。

本项目只需要前两层，不需要引入完整的 `pi-coding-agent`。这样可以只向模型注册少量领域工具，避免默认暴露 Shell、任意文件编辑和代码执行能力。

Pi 同时支持：

- TypeScript 进程内 SDK。
- JSON-RPC 子进程模式。
- 多模型供应商。
- 自定义工具、扩展和 Skills。
- 会话状态和上下文压缩。

Pi 没有默认提供完整的权限审批、MCP、后台任务和子 Agent。这意味着团队需要自己实现这些产品能力，但也意味着底层不会带入大量与当前业务无关的假设。

适用场景：

- 希望长期保持模型供应商可替换。
- 愿意维护自己的任务系统、权限策略和桌面协议。
- 桌面端采用 Electron，或者可以接受 Node.js Sidecar。

### 4.5 OpenClaw

OpenClaw 是一个完整的自托管 Agent Gateway，主要面向：

- Telegram、Discord、Slack、WhatsApp 等消息渠道。
- 长期运行的个人助理。
- 跨设备节点。
- 多 Agent 路由。
- 会话、记忆和后台服务。

这些能力很强，但并不是当前桌面生成工具的核心需求。直接基于 OpenClaw 开发，会让团队同时承担 Gateway、消息渠道、插件运行时、权限、设备和会话镜像等复杂概念。

OpenClaw 更适合作为未来的外部接入层。例如，用户可以在 Telegram 中发起生成任务，OpenClaw 再调用本项目的后端 API。

### 4.6 Hermes

Hermes 是以 Python 为主的通用自主 Agent，提供：

- OpenAI-compatible HTTP API。
- SSE、JSON-RPC 和 ACP。
- MCP、插件和大量内建工具。
- 长期记忆、会话搜索和自主 Skills。
- 子 Agent 和任务委派。

其优势是功能完整，而且与当前 Python 工程技术栈接近。但自主学习、自动修改 Skills 和大量默认工具会降低生产流程的确定性。对于角色资产生成产品，这些能力还会增加安全审计、行为回归测试和桌面打包的成本。

适用场景：

- 产品定位本身就是能够长期学习用户习惯的个人助理。
- 团队愿意对记忆、技能更新和工具权限进行完整治理。

## 5. 推荐的系统架构

```text
Desktop UI
    │
    │ WebSocket / SSE
    ▼
Conversation Service
    │
    ▼
Agent Runtime
    │
    │ 仅调用白名单领域工具
    ▼
Job Orchestrator
    ├── 2D Generation Job
    ├── 3D Generation Job
    ├── Rigging Job
    ├── Validation Job
    └── Export Job
    │
    ▼
ComfyUI / 其他生成服务
    │
    ▼
SQLite + Artifact Store
```

### Agent Runtime 的职责

- 理解用户想创建的角色。
- 将自然语言转换成结构化角色规格。
- 判断缺少哪些必要信息。
- 调用领域工具。
- 向用户解释进度、错误和下一步操作。
- 根据用户反馈发起局部重试或新的版本。

### Job Orchestrator 的职责

- 保存任务状态。
- 控制阶段顺序。
- 处理超时、失败、取消和重试。
- 保存随机种子、输入参数、工作流版本和输出资产。
- 在应用重启后恢复任务。
- 向桌面端推送进度事件。

### LLM 不应负责的内容

- 长时间同步等待 GPU 任务。
- 自行猜测任务是否执行成功。
- 通过任意 Shell 命令控制 ComfyUI。
- 直接拼接未经校验的本地或服务器文件路径。
- 决定是否覆盖用户已有资产。
- 在没有确认的情况下自动进入高成本阶段。

## 6. 建议的领域工具

第一阶段只向 Agent 暴露以下工具：

```text
create_character_spec
generate_character_images
list_generated_images
select_character_image
generate_3d_model
inspect_3d_model
rig_character_model
get_job_status
cancel_job
list_artifacts
export_character_asset
```

每个工具都应使用严格的 JSON Schema，并返回结构化结果。例如，生成类工具不应一直等待任务完成，而应返回：

```json
{
  "job_id": "job_01J...",
  "stage": "image_generation",
  "status": "queued"
}
```

桌面端通过 WebSocket 或 SSE 订阅状态变化。Agent 可以在任务完成事件到达后继续对话，而不需要保持一次 LLM 请求长时间运行。

## 7. 安全和可靠性要求

### 最小权限

- 不向 Agent 暴露任意 Shell。
- 不向 Agent 暴露任意文件读写。
- 所有本地文件访问限制在项目 Workspace 和 Artifact 目录内。
- 对导出、删除、覆盖和高成本任务设置确认步骤。

### 可恢复任务

- 每个阶段拥有独立的 `job_id`。
- 保存输入、输出、种子、模型版本和 ComfyUI Workflow 版本。
- 应用重启后能够恢复轮询或查询远端任务。
- 重试操作生成新的 Attempt，不直接覆盖历史记录。

### 人工确认节点

建议至少设置以下确认节点：

1. 从候选图片中选择最终概念图。
2. 确认开始生成高成本 3D 模型。
3. 检查 3D 模型后确认开始自动绑定。
4. 确认导出格式和目标目录。

## 8. 分阶段落地方案

### 阶段一：验证对话和工具调用

建议使用 OpenCode Server：

1. 启动 Headless Server。
2. 禁用 Shell、文件编辑和其他无关内建工具。
3. 添加 2D、3D、绑定和任务查询工具。
4. 接入桌面对话界面。
5. 横向测试 Claude、OpenAI 和本地模型。

这一阶段的目标是验证用户体验和工具 Schema，而不是确定最终 Runtime。

### 阶段二：建立稳定任务层

将当前同步 Python 脚本重构为任务 API：

- 提交任务。
- 查询状态。
- 取消任务。
- 获取输出资产。
- 恢复未完成任务。

初期可以使用 FastAPI、SQLite 和进程内任务队列。开始支持并发用户或远程部署后，再考虑 PostgreSQL、Redis、Celery、Dramatiq 或其他持久化任务系统。

### 阶段三：切换长期 Agent Runtime

使用 `pi-agent-core` 和 `pi-ai` 替换原型阶段的 OpenCode 会话层：

- 保留已经稳定的领域工具 Schema。
- 保留桌面端事件协议。
- 保留任务和资产存储。
- 只替换 Agent Runtime Adapter。

通过适配层隔离具体框架，避免业务代码直接依赖 Pi、OpenCode 或 Claude SDK 的消息类型。

## 9. 最终选型建议

### 长期推荐

选择 **Pi 的 `pi-agent-core` + `pi-ai`**，原因如下：

- 模型供应商可替换。
- MIT 许可证。
- 核心足够小。
- 可以避免代码 Agent 的默认工具和行为。
- 适合构建严格受控的领域 Agent。
- 能够通过 SDK 或 JSON-RPC 嵌入桌面应用。

### MVP 推荐

选择 **OpenCode Server**，原因如下：

- 已有 HTTP/OpenAPI 服务接口。
- 会话、事件、取消和权限机制开箱可用。
- 容易进行多模型横向测试。
- 能够快速把现有 Python 脚本包装为自定义工具。

### 纯 Python 快速方案

如果团队不希望引入 Node.js，并且能接受 Claude 锁定，可以选择 **Claude Agent SDK Python**。如果不能接受供应商锁定，则应考虑实现一个轻量的 Python 工具调用循环，而不是因为 Hermes 使用 Python 就引入完整的 Hermes Agent。

## 10. 参考资料

- [Claude Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk)
- [Claude Agent SDK Custom Tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Claude Agent SDK Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [OpenAI Codex SDK](https://developers.openai.com/codex/sdk)
- [OpenCode Server](https://opencode.ai/docs/server/)
- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [OpenCode Custom Tools](https://opencode.ai/docs/custom-tools/)
- [OpenCode Permissions](https://opencode.ai/docs/permissions/)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi RPC Mode](https://pi.dev/docs/latest/rpc)
- [Pi Usage](https://pi.dev/docs/latest/usage)
- [OpenClaw Agent Runtimes](https://docs.openclaw.ai/concepts/agent-runtimes)
- [OpenClaw Gateway Architecture](https://docs.openclaw.ai/concepts/architecture)
- [Hermes Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [Hermes API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)

以上结论基于 2026-07-16 的官方文档。Agent 框架发展较快，在进入正式开发前，应再次确认 SDK 稳定性、许可证、商业服务条款和桌面分发限制。
