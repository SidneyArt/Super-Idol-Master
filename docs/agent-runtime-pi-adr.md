# Agent Runtime 技术决策：采用 Pi

> 状态：建议采纳，待 Stepfun 兼容性 Spike 通过后生效  
> 决策日期：2026-07-20  
> 适用范围：Asset Agent 的对话、工具调用、流式事件与长期 Runtime 演进  
> 不包含：GPU Job 编排、ComfyUI 工作流、资产存储和前端视觉实现

## 1. 决策摘要

Super-Idol-Master 建议采用以下两个包作为 Asset Agent 的 Runtime 基础：

```text
@mariozechner/pi-agent-core
@mariozechner/pi-ai
```

不引入 `pi-coding-agent`，也不向 Asset Agent 暴露 Shell、任意文件读写、Git 或代码编辑工具。

Pi 只负责项目不值得重复实现的通用 Agent 能力：

- 模型调用和供应商适配。
- Agent Loop 和 Tool Calling。
- 工具参数 Schema 与执行生命周期。
- Agent 状态、上下文转换和流式事件。
- 工具调用前后钩子和有界停止条件。

项目继续拥有所有领域和生产可靠性能力：

- Run、Job、Asset 和 QA 状态机。
- SQLite 持久化和重启恢复。
- DGX / ComfyUI 调度、进度、取消和失败处理。
- 高成本操作审批和幂等控制。
- 资产 ID、路径安全和导出权限。
- 面向前端的 API、SSE 与统一事件协议。

这不是购买一个完整 Agent 产品，也不是从零开发 Agent。它是在轻量 Runtime 上实现项目自己的领域工具和策略层。

## 2. 为什么现在需要重新决策

早期选型文档假设项目仍缺少完整会话服务和任务层，因此曾建议用 OpenCode Server 快速验证 MVP。当前工程已经发生实质变化：

- `web/server/index.mjs` 已经是 Node.js ESM 本地后端。
- SQLite 已经持久化 Run、阶段、Job 状态和生成进度。
- `startJob()` 已经统一校验阶段并通过固定参数启动 Python 工作流。
- Qwen Image、SDPose、Pixal3D 和 SkinTokens 的确定性链路已经跑通。
- 前端 Asset Agent 面板已经存在，但目前只返回固定占位文本。
- 当前只允许一个活动 GPU Job，生成工具必须顺序执行。

因此项目现在不缺另一个完整 Agent Server。真正缺少的是可以嵌入现有 Node 进程的 Agent Loop、模型适配和工具事件流。

## 3. 选型原则

本决策按以下顺序评估候选方案：

1. **领域匹配**：是否适合资产生产 Agent，而不是终端代码 Agent或个人聊天助理。
2. **最小权限**：能否默认只注册白名单领域工具。
3. **模型可替换**：能否接入 Stepfun、云模型和后续 DGX 本地模型。
4. **嵌入成本**：能否直接进入现有 Node 后端，避免新增常驻服务和协议桥。
5. **可测试性**：是否支持结构化工具、事件追踪、上下文控制和确定性边界。
6. **长期维护**：是否减少自研 Runtime 代码，同时避免过度绑定大型平台。

以下能力不作为当前选型加分项：

- Shell、Git 和代码编辑。
- Telegram、Discord、Slack 等外部渠道。
- 自主修改 Skills 或长期自我进化。
- 无边界的子 Agent 委派。
- 由 LLM 长时间等待 GPU Job。

## 4. Pi 与当前项目的匹配度

### 4.1 进程和技术栈匹配

当前后端运行在 Node.js 22.13 以上的 ESM 环境。`pi-agent-core` 和 `pi-ai` 是 TypeScript/JavaScript 包，可以直接嵌入现有后端，不需要增加 Python Agent 服务、Headless Server 或 Gateway。

短期可在 `.mjs` 中使用，长期后端模块化时再逐步迁移到 TypeScript。不能为了接入 Pi 先重写现有后端。

### 4.2 模型供应商匹配

`pi-ai` 支持自定义 OpenAI-compatible 模型定义，包括 `baseUrl` 和兼容性选项。这与项目计划使用的 Stepfun Chat Completions 接口方向一致，也为以下演进保留空间：

- Stepfun 云模型。
- OpenAI、Anthropic 或其他云模型。
- DGX 上通过 vLLM、SGLang、Ollama 或兼容网关提供的本地模型。
- Supervisor、Art Director、Visual QA 使用不同模型的路由。

但“协议兼容”不等于“行为已经验证”。正式采用前必须验证 Stepfun 的工具调用、流式增量、图片输入、错误格式和 reasoning 参数兼容性。

### 4.3 工具安全匹配

Asset Agent 只需要有限领域工具。Pi 允许显式注册工具，并提供参数解析、`beforeToolCall`、`afterToolCall` 和逐工具执行模式。项目可以在调用领域服务前统一检查：

- 当前 Run 阶段。
- Job 是否已经运行。
- 输入资产是否存在且属于当前 Run。
- 是否需要用户确认。
- 本轮是否已经创建生成 Job。
- 重试次数和幂等键是否有效。

Pi 默认支持并行工具执行，但本项目的状态改变工具必须统一设置为 `sequential`。只读工具将来也只能在确认没有一致性风险后并行。

### 4.4 前端事件匹配

Pi 会发出 Agent、消息和工具执行事件，可以映射为项目自己的稳定事件：

```text
Pi event                    Product event
agent_start              -> agent.run.started
message_update           -> agent.message.delta
tool_execution_start     -> agent.tool.started
tool_execution_update    -> agent.tool.progress
tool_execution_end       -> agent.tool.completed
agent_end                -> agent.run.completed
```

前端不能直接依赖 Pi 的事件类型。后端应先转换为项目事件，避免未来升级或替换 Runtime 时改动 UI。

Agent 进度与 GPU 进度必须分开：

- 右侧 Asset Agent 面板展示模型文本和工具调用状态。
- 主预览区使用现有 `generation_progress` 展示 DGX Job 的 0 到 100% 水平进度条，替代环形加载。
- 生成工具创建 Job 后立即返回，不让 Pi 持续等待数分钟。

### 4.5 上下文和持久化匹配

Pi 支持自定义 Agent Message、上下文转换和裁剪，适合只向模型提供：

- 最近若干条会话消息。
- 当前 Run 和阶段。
- Prompt、QA 摘要和有效资产。
- 活动 Job 与待确认操作。
- 当前允许调用的工具。

但是 Pi 内存状态不能成为唯一事实来源。消息、Agent Run、Tool Call 和业务事件仍需先写 SQLite。每次请求可以从数据库恢复所需上下文，再创建或恢复 Pi Agent 状态。

## 5. Pi 不会替项目解决什么

采用 Pi 后仍然需要开发以下模块：

```text
ConversationRepository   会话和消息持久化
AgentRuntimeAdapter      隔离 Pi 类型和事件
ContextBuilder           从 Run/Job/Asset 构建受限上下文
AssetToolRegistry        领域工具及严格 Schema
ToolPolicy               阶段、权限、成本和幂等校验
AgentEventBridge         Pi 事件转项目 SSE 事件
ContinuationDispatcher  Job 完成后的短 Agent 续跑
ApprovalService          3D、绑骨、导出等一次性授权
```

这些不是 Pi 的缺陷，而是正确的产品所有权边界。任何候选 Agent Runtime 都不应该决定本项目的生产状态机和资产安全规则。

## 6. 长期开发实用性

### 6.1 有利因素

**模型切换成本较低。** 业务工具不直接绑定某一家模型 SDK，比赛期可使用 Stepfun，后续可以增加本地模型或其他供应商。

**不重复维护通用 Agent Loop。** 流式响应、工具结果回填、多轮执行、取消信号和事件生命周期看似简单，但边界错误很多。复用 Runtime 能把精力集中在资产生产能力上。

**产品事件与 Runtime 解耦。** 通过 Adapter 归一化事件后，前端、数据库和评测只依赖项目协议，Pi 可升级或替换。

**适合角色化调用。** Supervisor、Art Director 和 Visual QA 可以共享同一 Runtime 和模型层，以不同提示词、工具集和输出 Schema 运行，不需要部署多个 Agent 服务。

**支持渐进式复杂度。** MVP 先做单 Agent 和少量工具；后续再增加上下文压缩、模型路由、续跑和视觉输入，不必一开始引入完整多 Agent 平台。

### 6.2 主要风险与缓解措施

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Pi 当前是 `0.x` 版本，API 仍可能变化 | 升级可能破坏事件或类型 | 锁定精确版本；所有 Pi 使用集中在 Adapter；升级先跑合约测试 |
| Stepfun 只是协议层面兼容 | Tool Call、图片或流式格式可能不同 | 先做最小 Spike；保存固定响应 Fixture；不通过则暂用自建 Provider Adapter |
| Pi 状态主要在进程内 | 后端重启会丢失未持久化对话 | SQLite 作为唯一事实来源；事件和消息先落库再推送 |
| 默认并行执行工具 | 可能与单 GPU 队列和阶段状态冲突 | Runtime 全局设为 `sequential`；每轮最多一个写工具 |
| 上游快速演进 | 长期维护受第三方节奏影响 | 只使用 core/ai 公共 API；不依赖 coding-agent 内部实现；保留替换接口 |
| 工具能力扩大后权限变复杂 | Agent 可能尝试越权或重复生成 | Policy 独立于提示词；高成本操作要求后端签发的一次性 Approval |

## 7. 为什么不选择其他方案

以下结论是针对 Super-Idol-Master 的匹配度，不代表框架的通用质量排名。

### 7.1 不从零自研 Agent Loop

自研轻量 Loop 在第一天可能只有几十行，但生产化后会逐步承担：

- 流式响应和取消。
- 多轮 Tool Call 与结果顺序。
- 非法参数、未知工具和半截流恢复。
- 上下文裁剪和不同供应商消息转换。
- 事件追踪、超时、停止条件和测试 Fixture。
- 图片输入和模型间差异。

这些能力不是产品差异化。完全自研会形成长期维护负担，并容易让模型 SDK 类型渗透到业务代码。

保留自研 Loop 作为降级方案：如果 Pi 的 Stepfun 兼容性 Spike 失败，或 Adapter 为绕过 Pi 缺陷变得比 Loop 本身更复杂，再回退到受控自研实现。

### 7.2 不选择 OpenCode

OpenCode 的 Headless Server、OpenAPI、SSE、Session、自定义工具和 `allow/ask/deny` 权限非常适合快速构建代码 Agent 原型。

当前项目已经有自己的 Node API、SQLite、Run、Job 和前端状态。再引入 OpenCode Server 会产生两套会话、事件、权限和生命周期，需要额外处理：

- OpenCode Session 与项目 Run 的映射。
- 两个服务的启动、健康检查和退出。
- OpenCode 事件到产品事件的桥接。
- 禁用 Shell、文件编辑、搜索和其他代码工具。
- 桌面分发时的额外进程和配置。

如果未来产品增加“让 Agent 修改 ComfyUI 插件或代码”的开发者模式，OpenCode 可以作为独立代码子 Agent，而不是 Asset Agent 主 Runtime。

### 7.3 不选择 OpenClaw

OpenClaw 的核心价值是 Gateway、WebSocket 控制面、多渠道、设备节点、长期会话和多 Agent 路由。它适合长期运行的个人助理或消息平台入口。

这些能力对当前本地资产工作台明显过量，并会引入 Gateway、渠道鉴权、节点配对和插件治理等新的运维边界。项目当前需要的是进程内 Runtime，而不是另一个应用平台。

未来如果要支持 Telegram、Discord 或远程设备发起生成任务，可以把 OpenClaw 放在外部渠道层，通过受控 API 调用 Super-Idol-Master，仍不替代内部 Job Orchestrator。

OpenClaw 的仓库许可证元数据当前不能仅凭 GitHub API 自动确认，正式商业分发前必须单独复核具体许可证和依赖条款。

### 7.4 不选择 Hermes

Hermes 提供 Python 集成、API Server、流式会话、MCP、插件、记忆、Skills 和子 Agent，适合以自主助理能力为产品中心的场景。

Super-Idol-Master 的核心要求却是可预测、可回放和有人确认的 GPU 生产流程。长期记忆、自主 Skill 演进和大量内建工具会增加：

- 行为回归测试范围。
- 权限和本地文件安全审计。
- Python Agent 服务与现有 Node API 的桥接。
- 桌面启动、升级和故障定位成本。

如果未来“长期学习创作者偏好”成为核心卖点，可以单独引入受控记忆服务，不必因此把整个 Runtime 替换为 Hermes。

### 7.5 不选择 Claude Agent SDK

Claude Agent SDK 在工具、权限、Session、恢复和流式输出方面成熟，适合希望快速获得 Claude Agent 能力且接受供应商绑定的团队。

本项目不选择它作为主 Runtime 的主要原因是：

- 核心模型绑定 Claude，无法自然承载 Stepfun 比赛模型和 DGX 本地模型。
- SDK 延续 Claude Code 的部分能力和产品假设，超过当前领域 Agent 所需范围。
- SDK 源码许可、Anthropic 服务条款和模型调用条款需要分别评估。
- 将来切换供应商需要替换 Runtime，而不仅是模型配置。

如果项目明确长期 Claude-only，并且 Agent 效果优先级远高于供应商可替换性，可以重新评估该方案。

### 7.6 不选择 Codex SDK

Codex 是面向软件开发的 coding agent。它擅长理解代码库、编辑文件、运行命令和完成开发任务，但 Asset Agent 的主要工作是理解角色意图、调用受控生成工具并解释资产状态。

将 Codex 作为主 Runtime 会引入与仓库、工作目录、沙箱和代码执行相关的概念，同时绑定 OpenAI 模型供应商。即使能够严格限制权限，得到的仍是与业务方向不匹配的抽象。

Codex 更适合未来作为开发者工具：例如生成 ComfyUI 自定义节点、修改工作流适配器、诊断脚本或维护项目代码。它不应获得生产资产状态机的直接控制权。

## 8. 项目特定评分

评分为 1 到 5，5 表示最符合当前项目。权重和分数只服务于本次决策。

| 方案 | 领域匹配 25% | 最小权限 20% | 模型可替换 15% | 嵌入成本 15% | 可测试性 15% | 长期维护 10% | 加权分 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Pi core + ai | 5 | 5 | 5 | 5 | 4 | 4 | **4.75** |
| 自研受控 Loop | 5 | 5 | 5 | 5 | 3 | 2 | **4.40** |
| Claude Agent SDK | 4 | 4 | 1 | 4 | 4 | 4 | **3.55** |
| OpenCode Server | 2 | 2 | 5 | 2 | 3 | 3 | **2.70** |
| Codex SDK | 2 | 3 | 1 | 3 | 4 | 3 | **2.60** |
| Hermes | 2 | 2 | 4 | 2 | 3 | 2 | **2.45** |
| OpenClaw | 1 | 2 | 4 | 1 | 3 | 1 | **1.95** |

Pi 相对自研 Loop 的优势并不在功能上形成数量级差距，而在于减少非差异化 Runtime 维护。选择 Pi 的前提是通过 Adapter 控制依赖范围，而不是让 Pi 类型进入整个项目。

## 9. 目标架构

```text
Asset Agent UI
    │ POST message / SSE events
    ▼
Conversation API
    │
    ▼
Project AgentRuntime interface
    │
    ▼
PiRuntimeAdapter
    ├── pi-agent-core: loop, tools, events
    └── pi-ai: Stepfun / cloud / local model
    │
    ▼
AssetToolRegistry + ToolPolicy
    │
    ▼
RunService / JobService / AssetService
    │
    ▼
Python adapters -> ComfyUI on DGX
```

建议项目接口只暴露归一化类型：

```ts
interface AgentRuntime {
  run(input: AgentRunInput, sink: AgentEventSink): Promise<AgentRunResult>;
  cancel(agentRunId: string): Promise<void>;
}

type ProductAgentEvent =
  | { type: "agent.run.started"; agentRunId: string }
  | { type: "agent.message.delta"; text: string }
  | { type: "agent.tool.started"; toolCallId: string; name: string }
  | { type: "agent.tool.completed"; toolCallId: string; result: unknown }
  | { type: "agent.run.completed"; messageId: string }
  | { type: "agent.run.failed"; code: string; message: string };
```

领域工具第一批控制在：

```text
get_run_context
update_character_prompt
confirm_character_idea
generate_concept_image
get_job_status
```

第二批再增加 T-Pose、3D 和绑骨工具。3D、绑骨和导出必须经过后端一次性 Approval，不能把聊天中的“确认”直接当作授权。

## 10. 实施门槛与验证顺序

### Gate 1：Pi / Stepfun 兼容性 Spike

只做一个无业务依赖的最小验证：

1. 普通中文流式对话。
2. 单次结构化 Tool Call。
3. Tool Result 回填后的第二轮回答。
4. 非法参数和未知工具错误。
5. 主动取消和请求超时。
6. 如需 Visual QA，再验证一张受控图片输入。

退出条件：全部成功，并保存脱敏 Fixture。失败时先尝试 `pi-ai` compatibility 配置；仍失败再评估自定义 Provider 或自研 Loop。

### Gate 2：只读接入

- 持久化每个 Run 的 Session 和 Message。
- 接入 `get_run_context`。
- Pi 事件转换成项目 SSE 事件。
- 刷新页面后能恢复会话。

### Gate 3：首个写工具

- 接入 `update_character_prompt` 和 `generate_concept_image`。
- 全局工具执行设为 `sequential`。
- 一次 Agent Run 最多创建一个 Job。
- 主预览区显示真实 DGX 水平进度条。

### Gate 4：高成本操作

- 增加 3D、绑骨和导出的一次性 Approval。
- 增加 Job 完成后的幂等 Agent 续跑。
- 建立固定 Tool Call 合约测试和模型行为评测集。

## 11. 重新评估条件

出现以下任一情况时重新评估 Pi：

- Stepfun 核心 Tool Calling 或流式协议无法通过合理 Adapter 兼容。
- Pi 升级长期频繁破坏公共 API，Adapter 维护成本超过自研 Loop。
- 产品转为 Claude-only，并需要 Claude Agent SDK 的专有能力。
- 产品转为代码生成和仓库维护工具，OpenCode 或 Codex 成为主要工作负载。
- 产品核心转为多渠道长期个人助理，OpenClaw 的 Gateway 能力成为必要条件。
- 自主记忆和 Skill 学习成为核心卖点，并有资源治理 Hermes 的安全边界。

## 12. 参考资料与核对信息

2026-07-20 核对 npm：

- `@mariozechner/pi-agent-core`：`0.73.1`，MIT。
- `@mariozechner/pi-ai`：`0.73.1`，MIT。
- `opencode-ai`：`1.18.3`，MIT。
- `@anthropic-ai/claude-agent-sdk`：`0.3.215`，许可证需按其 README 和服务条款评估。
- `@openai/codex-sdk`：`0.144.6`，Apache-2.0。

官方或项目资料：

- [Pi Agent Core README](https://github.com/badlogic/pi-mono/tree/main/packages/agent)
- [Pi AI README](https://github.com/badlogic/pi-mono/tree/main/packages/ai)
- [OpenCode Server](https://opencode.ai/docs/server/)
- [OpenCode Custom Tools](https://opencode.ai/docs/custom-tools/)
- [OpenCode Permissions](https://opencode.ai/docs/permissions/)
- [OpenClaw Architecture](https://docs.openclaw.ai/concepts/architecture)
- [Hermes Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [OpenAI Codex SDK](https://developers.openai.com/codex/sdk)
- [当前工程基线](./current-project-baseline.md)
- [技术实现指南](./technical-implementation-guide.md)

Agent 框架仍在快速演进。版本、许可证和服务条款必须在正式发布或商业分发前再次复核，不能只依赖本 ADR 的历史快照。
