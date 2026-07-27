# 架构概览

本文档帮助开发者和 Agent 快速理解 Super Idol Master 的代码结构、运行边界和关键数据流。架构或职责发生变化时，应同步更新本文档。

最后更新日期：2026-07-27

## 1. 项目结构

```text
Super-Idol-Master/
├── README.md                         # 项目介绍、启动与使用说明
├── ARCHITECTURE.md                   # 本文档
├── docs/                             # 产品、工程、接入与技术决策文档
│   ├── README.md                     # 文档索引
│   ├── getting-started/              # 当前基线与本地运行维护
│   ├── deployment/                   # DGX、网络、流水线与服务部署
│   ├── architecture/                 # 技术实现、ADR 与选型记录
│   └── product/                      # PRD 与产品验收范围
├── deploy/
│   └── dgx-autoremesher/             # 可单独上传的 ARM64 AutoRemesher API 安装包
├── web/
│   ├── app/
│   │   ├── page.tsx                  # 工作空间首页、任务控制台和 Agent 面板
│   │   ├── globals.css               # 全局界面样式
│   │   └── components/ModelViewer.tsx # Three.js GLB 预览器
│   ├── server/
│   │   ├── index.mjs                 # HTTP API、状态机、Job 与产物校验
│   │   ├── agent-runtime.mjs         # Supervisor、多 Agent 与持续执行计划
│   │   ├── approval-runtime.mjs      # 权限模式、审批队列与全局通知
│   │   ├── coordinator-runtime.mjs   # 跨工作空间总调度与批量任务委派
│   │   ├── gpu-resource-scheduler.mjs # 全局 FIFO 生成资源队列与唯一 GPU 槽
│   │   ├── conversation-context.mjs  # Agent 上下文窗口与 token 用量估算
│   │   ├── settings.mjs              # 工作流、端点、模型和密钥配置
│   │   └── pipeline/                 # 后端私有 Python / uv 子项目
│   │       ├── pyproject.toml         # Python 版本约束与直接依赖
│   │       ├── uv.lock                # 可复现依赖锁
│   │       ├── .python-version        # 固定 Python 3.12
│   │       ├── comfy_client.py        # ComfyUI 上传、提交、轮询和下载客户端
│   │       ├── run_*.py               # 各阶段受控执行入口
│   │       ├── crop_character_sheet.py
│   │       └── *.json                 # 默认 ComfyUI 工作流模板
│   ├── scripts/
│   │   ├── start-local.mjs           # 前后端联合启动器
│   │   ├── run-vinext.mjs            # Vinext 命令入口
│   │   └── verify-stepfun-pi.mjs     # Agent API 兼容性检查
│   ├── data/                         # SQLite 与运行时工作流，不进入 Git
│   └── public/generated/             # 页面预览资源，不进入 Git
├── output/                           # Python 下载的正式生成产物，不进入 Git
├── start-local.cmd                   # 本地启动入口
└── 启动本地网站.cmd                  # 本地启动入口
```

当前系统采用本地模块化单体结构。前端、API、Agent Runtime 和 Job 编排位于同一个 `web/` 应用中；计算密集型生成任务通过 `web/server/pipeline/` 中的后端私有 Python 执行器委派给 DGX / ComfyUI。

## 2. 高层系统图

```text
┌──────────────┐       HTTP 轮询 / JSON       ┌──────────────────────────────┐
│ Windows 用户 │ <──────────────────────────> │ React / Vinext 本地控制台    │
└──────────────┘                              └──────────────┬───────────────┘
                                                           │ HTTP
                                                           ▼
                                            ┌──────────────────────────────┐
                                            │ Node.js 本地 API             │
                                            │                              │
                                            │ 状态机 / Job / 产物校验      │
                                            │ Agent Runtime / 设置管理     │
                                            └───────┬──────────┬───────────┘
                                                    │          │
                                      SQLite / 文件 │          │ OpenAI 兼容 API
                                                    ▼          ▼
                                      ┌─────────────────┐  ┌─────────────────┐
                                      │ 本地持久化      │  │ Stepfun        │
                                      │ data/ + output/ │  │ Agent / 图片 API│
                                      └─────────────────┘  └─────────────────┘
                                                    
                                            固定 Python 子进程
                                                    │
                                                    ▼
                                      ┌─────────────────────────┐
                                      │ DGX / ComfyUI           │
                                      │ Qwen Image / SDPose     │
                                      │ Pixal3D / SkinTokens    │
                                      └─────────────────────────┘
```

主数据流如下：

1. 用户选择工作空间，直接创建任务，或向总调度 Agent 描述一个包含多个角色的项目。
2. 总调度 Agent 可以建立工作空间；收到合集原画时，先识别角色与归一化边界框，再通过固定裁切脚本生成受控的单体原画。
3. 每个角色保存为独立 Run，并由总调度 Agent 把目标委派给该 Run 的专属 Asset Agent。
4. Node.js API 校验工作流类型和当前阶段，并将 Run、事件和 Agent 计划写入 SQLite。
5. 后端以固定脚本和白名单参数启动一个 Python 子进程。文生图与图生图选择各自配置，后续阶段使用 ComfyUI。
6. Python 客户端上传输入、提交工作流并下载产物；后端通过 WebSocket 接收节点进度。
7. Job 完成后，后端验证输出路径和文件结构，再登记 PNG 或 GLB。
8. 如果存在持续执行计划，完成事件会恢复 Supervisor 编排；质量门禁通过后才启动下一阶段。
9. 前端轮询 Run、子 Agent 和计划状态，展示进度、报告及最终产物。

## 3. 核心组件

### 3.1. 本地控制台

**名称：** Super Idol Master Web Console

**职责：**

- 创建、选择、重置和删除角色任务；
- 创建和切换工作空间，在工作空间内查看任务列表；
- 承载跨任务的总调度 Agent、合集原画上传和批量拆分反馈；
- 展示六阶段状态、ComfyUI 进度和事件历史；
- 预览概念图、姿态覆盖图、静态 GLB 和绑骨 GLB；
- 提供工作流版本、ComfyUI 地址、Agent 模型和 API Key 设置；
- 承载 Asset Agent 对话、自动编排状态和多 Agent 活动记录。

**技术栈：** React 19、Next.js 16、Vinext、TypeScript、Three.js、CSS。

**运行方式：** 由 `npm run local` 在 `127.0.0.1:3100` 启动，仅作为本机应用使用。

### 3.2. 本地 API 与工作流编排器

**名称：** Local Orchestrator API

**职责：**

- 提供 Run、Agent、设置、工作流上传和产物下载 API；
- 执行严格阶段状态机，不允许跳过上游产物或质量门禁；
- 管理单任务 Job 状态和 Python 子进程；
- 通过进程级全局 FIFO 调度器统一管理普通任务与合集图生成，任一时刻只允许一个生成任务占用 GPU 资源；
- 接收 ComfyUI WebSocket 进度，并持久化当前节点；
- 验证输出路径、图片存在性、GLB 头、mesh、skin 和 joints；
- 在 Job 完成或失败后触发 Agent 持续执行计划。

**技术栈：** Node.js 22、原生 `node:http`、`node:sqlite`、WebSocket、Python 子进程。

**运行方式：** 由本地启动器在 `127.0.0.1:8787` 启动。

### 3.3. Agent Runtime

**名称：** Coordinator + Asset Agent Runtime

**职责：** 将自然语言意图转换为有限的领域工具调用，在工作空间与任务两个层级协调专业角色。

总调度层的 `Coordinator` 可以列出或创建工作空间、读取图片模型状态、分析合集原画、创建多个角色任务，并分别调用这些任务的 Asset Agent。它不能执行任意 Shell 或绕过 Run 状态机。任务层由 `Supervisor` 编排，并按阶段调用 `Art Director`、`Visual QA`、`Character Consistency`、`Asset Inspector`、`Rigging QA`、`Export Specialist` 和 `Workflow Doctor`。

总调度 Agent 与每个任务的 Asset Agent 都有独立权限模式：

- `request`：所有变更型工具先写入审批队列；批准前不修改任务、不启动 Job；
- `auto`：在既有状态机、单 GPU Job 和质量门禁范围内自动批准工具调用。

两个层级的 Agent 也分别维护持久化会话。新建会话不会删除旧消息，用户可以从会话选择器恢复历史；总调度会话限定在所属工作空间，任务会话限定在所属 Run。前端显示按实际系统提示词和最近 24 条消息估算的上下文用量，以及模型的 131,072 token 上限。

持续流水线目标只在登记目标时审批一次。批准代表允许系统自动执行到指定终点，但 SDPose、各专业 Agent、产物结构检查和失败暂停机制仍然生效。总调度 Agent 委派已经获批的目标时，不会永久修改任务 Agent 自己的权限模式。

角色边界：

| 角色 | 可执行操作 | 禁止操作 |
| --- | --- | --- |
| `Supervisor` | 读取状态、更新提示词、推进或回退、启动阶段 Job、登记持续执行目标 | 绕过状态机、伪造产物、执行任意 Shell |
| `Art Director` | 提交结构化 `PromptPlan`，检查身份、风格、姿态约束与提示词冲突 | 修改 Run、启动 Job |
| `Visual QA` | 提交结构化视觉质检报告，检查主体、全身、朝向、遮挡和背景 | 覆盖 SDPose 硬门禁、推进流程 |
| `Character Consistency` | 比较参考原画、角色提示词和 T-Pose 的身份锚点 | 重复姿态质检、修改角色设定、推进流程 |
| `Asset Inspector` | 解释静态 GLB 的 mesh、primitive、材质、纹理和场景指标 | 覆盖 GLB 解析硬门禁、声称看到了未提供的渲染证据 |
| `Rigging QA` | 解释 skin、joints、层级和动画指标 | 覆盖 skin/joints 硬门禁、声称验证了未提供的动作形变 |
| `Export Specialist` | 检查最终 GLB 的通用交付就绪度并提交告警 | 写入或转换文件、假定未指定的引擎规范已经满足 |
| `Workflow Doctor` | 在 Job 失败后分类原因并提交安全修复建议 | 修改工作流、启动重试、声称建议已经执行 |

持续执行计划保存在 `agent_workflow_plans`。例如目标为“完成自动拓扑的 3D 模型”时，完成事件按顺序驱动：

```text
生成 2D
  → 自动确认合格 2D
  → 运行 SDPose
  → 调用 Visual QA
  → 调用 Character Consistency
  → 图片与身份门禁通过
  → 生成 3D
  → 检查 GLB mesh
  → 调用 Asset Inspector
  → AutoRemesher 自动拓扑与纹理回烘
  → 检查拓扑 GLB mesh
  → 完成计划
```

任一质量门禁未通过时，计划进入 `blocked`；Job 或结果处理失败时进入 `failed`。系统重启不会把中断计划误报为继续运行。

**技术栈：** `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、StepFun OpenAI 兼容 API。

### 3.4. Python 生成适配层

**名称：** ComfyUI Workflow Adapter

**职责：**

- 将经过后端校验的参数注入固定工作流节点；
- 上传本地图片或 GLB；
- 调用 `/api/prompt`、`/api/history/<prompt_id>` 和 `/api/view`；
- 下载并输出本次执行的真实产物路径；
- 将所有本地输出限制在项目 `output/` 目录。

**技术栈：** Python、Requests、Pillow、ComfyUI HTTP API。

**运行边界：** `pipeline/` 是 Node 后端的私有子项目，不属于面向用户的仓库级脚本。uv 根据 `.python-version`、`pyproject.toml` 和 `uv.lock` 创建 `pipeline/.venv`；联合启动器先执行 `uv sync --locked`，后端随后直接调用该虚拟环境的解释器。除显式设置 `PYTHON_COMMAND` 用于调试外，运行时不依赖系统 Python 或 `PATH`。

### 3.5. DGX 生成服务

**名称：** DGX / ComfyUI Runtime

**职责：** 承载 Qwen Image、SDPose Wholebody、Pixal3D 和 SkinTokens 等 GPU 工作流。

**连接方式：** 默认使用受控网络访问 `http://100.120.236.113:8188`；可以采用公司内网、VPN、SSH 隧道或 Tailscale。各阶段可以在设置面板中使用独立端点和工作流版本。

## 4. 状态机与质量门禁

| 阶段 | 入口条件 | 执行器 | 成功证据 | 下一阶段门禁 |
| --- | --- | --- | --- | --- |
| 角色描述 / 原画 | Run 已创建；图生模型任务另需受控路径内的单体原画 | Supervisor / Art Director | 已保存提示词或原画 | 角色设定已确认或存在持续执行授权 |
| 2D / T-Pose 图 | 文生模型需正向提示词；图生模型需原画 | Qwen Image 或对应 StepFun 图片 API | PNG 文件存在于受控路径 | 用户确认，或持续计划自动确认 |
| T-Pose 检查 | 2D 图片存在 | SDPose + Visual QA + Character Consistency | 关键点评分、覆盖图、视觉与身份结构化报告 | SDPose 为 `passed`，Visual QA 与身份检查均为 `pass` |
| 3D 模型生成 | T-Pose 硬门禁通过 | Pixal3D + Asset Inspector | 有效 glTF 2.0 GLB，至少一个 mesh | 用户确认，或 Asset Inspector 放行持续计划 |
| 自动拓扑 | 静态 GLB 存在 | AutoRemesher + Blender | 有效拓扑 GLB，至少一个 mesh | 用户确认，或持续计划自动确认 |
| 自动绑骨 | 拓扑 GLB 存在 | SkinTokens + Rigging QA | 有效 GLB，至少一个 skin 和 joint | 用户确认，或 Rigging QA 放行持续计划 |
| 资产导出 | 绑骨 GLB 存在 | 本地 API | 可下载最终 GLB | 流水线完成 |

状态机以 SQLite 中的 Run 为唯一事实来源。浏览阶段卡片不会改变真实阶段；所有推进、回退、开始、成功、失败和 Agent 结论都会形成事件记录。

## 5. 数据存储

### 5.1. SQLite

**位置：** `web/data/super-idol-master.db`

| 表 | 用途 |
| --- | --- |
| `workspaces` | 工作空间名称、描述和时间信息 |
| `runs` | 所属工作空间、工作流类型、角色任务、当前阶段、Job、QA 和产物路径 |
| `run_events` | 创建、推进、回退、Job 和质量检查事件 |
| `app_settings` | ComfyUI 端点、工作流版本、模型和本地密钥配置 |
| `dispatcher_conversations` | 总调度 Agent 的会话元数据和标题 |
| `dispatcher_conversation_state` | 每个工作空间当前选中的总调度会话 |
| `dispatcher_messages` | 总调度 Agent 按工作空间保存的对话历史 |
| `agent_permission_modes` | 总调度和各任务 Agent 的 `request` / `auto` 权限模式 |
| `approval_requests` | 待审批操作、序列化参数、状态、结果和失败信息 |
| `app_notifications` | 待审批、阶段完成、失败和流程完成通知 |
| `agent_conversations` | 每个 Run 的 Asset Agent 会话元数据和标题 |
| `agent_conversation_state` | 每个 Run 当前选中的 Asset Agent 会话 |
| `agent_messages` | 每个 Run 的 Agent 对话历史 |
| `agent_role_runs` | Art Director、各阶段 QA、资产检查、导出检查与失败诊断的执行状态和输入输出 |
| `agent_reports` | 各专业 Agent 提交的结构化报告 |
| `agent_workflow_plans` | 跨异步 Job 的目标、状态和恢复信息 |

数据库启用 WAL 和外键约束。服务启动时会把无法恢复的运行中 Job、角色调用和流水线计划标记为中断，避免产生虚假的活动状态。

### 5.2. 文件系统

| 路径 | 用途 | 是否进入 Git |
| --- | --- | --- |
| `output/` | Python 下载的 PNG、GLB、工作流快照和历史记录 | 否 |
| `web/public/generated/` | 前端直接展示的预览图片和姿态覆盖图 | 否 |
| `web/data/runtime-workflows/` | 每次 Job 使用的临时工作流 JSON | 否 |
| `web/server/pipeline/*.json` | 后端使用的默认、可追踪工作流模板 | 是 |
| `web/server/pipeline/.venv/` | uv 管理的 Python 3.12 虚拟环境 | 否 |

数据库只保存本地绝对路径和前端预览 URL，不把二进制产物写入 SQLite。

## 6. 外部集成与 API

### 6.1. StepFun

**用途：**

- 为 Pi Agent Runtime 提供文本、视觉和工具调用模型；
- 分别为文生图与图生图阶段提供图片生成或编辑 API。

**集成方式：** OpenAI 兼容的 HTTP API。默认 Agent 模型为 `step-3.7-flash`；文生图和图生图默认都使用 `step-image-edit-2`，但拥有独立的模型、端点与密钥配置。

### 6.2. ComfyUI

**用途：** 执行 Qwen Image、SDPose、Pixal3D 和 SkinTokens 工作流。

**集成方式：** HTTP 上传与提交、历史轮询、产物下载，以及 WebSocket 实时进度。

### 6.3. Tailscale

**用途：** 在不公开暴露 ComfyUI 的情况下，让 Windows 控制台访问 DGX 私网地址。

**边界：** Tailscale 只提供网络连通性，应用本身不管理节点身份和访问策略。

## 7. 部署与基础设施

**当前部署形态：**

- 控制面：Windows 本地单机；
- 计算面：NVIDIA DGX 上的 ComfyUI；
- 网络：Tailscale 私网；
- 数据库：Windows 本地 SQLite；
- 产物：Windows 本地文件系统和 DGX 临时输出。

`npm run local` 会同时启动 Node.js API 和 Vinext 开发服务器，等待健康检查成功后打开浏览器。关闭启动窗口或按 `Ctrl+C` 会终止前后端进程。

**CI/CD：** 当前仓库未配置自动 CI/CD。发布和运行以本地脚本为主。

**监控与日志：** 当前使用控制台日志、`run_events`、Job 进度字段和 ComfyUI 队列状态；尚未接入集中式指标、追踪或告警系统。

## 8. 安全考虑

**认证方式：** 本地控制台暂不提供用户登录。安全模型依赖回环地址监听和受控本机访问。

**关键实践：**

- 前端与 API 默认监听 `127.0.0.1`，不直接暴露到局域网或公网。
- ComfyUI 通过 Tailscale 私网访问，不开放公共 `8188` 端口。
- Asset Agent 仅获得有限领域工具，不获得 Shell、Git 或任意文件系统权限。
- 后端使用固定 Python 脚本与参数数组启动子进程，不拼接用户 Shell 命令。
- 工作流上传限制为 500 KB，并校验必需节点和 JSON 结构。
- 生成结果必须解析到项目 `output/` 内；下载前再次检查文件存在性。
- 图片附件校验 MIME、文件签名和 4 MB 大小限制。
- API Key 不写入响应，不提交到 Git；设置接口只返回是否已配置。

**已知限制：** 如果未来需要让其他设备访问本地控制台，必须先增加身份认证、授权、TLS、CSRF 防护和更严格的网络策略，不能只修改监听地址。

## 9. 开发与测试环境

**本地搭建：** 见 [`README.md`](./README.md) 的“快速开始”。

**主要命令：**

```powershell
cd web
npm run local
npm run lint
npm run build
npm run agent:verify
```

**代码质量工具：** ESLint、TypeScript/Vinext 生产构建、Node.js 语法检查。

**当前测试边界：**

- `npm test` 依次执行 Node 单元测试、Python 单元测试和生产构建；
- `npm run lint` 执行静态检查；
- `npm run agent:verify` 验证模型文本、图片和工具调用兼容性；
- Python 工作流以真实 DGX E2E 运行结果为主要集成证据；
- 当前已有设置密钥、Agent 角色状态、StepFun 图片 API、T-Pose QA 和拓扑客户端单元测试，但仍没有完整的 API 集成测试或浏览器 E2E 套件。

## 10. 未来规划与架构债务

- 为状态机、自动流水线恢复、质量门禁和 API 增加确定性自动测试。
- 增加 Job 取消、超时、重试策略和服务重启后的安全续跑协议。
- 将前端轮询升级为 SSE 或 WebSocket 事件推送，减少重复请求。
- 为 Asset Inspector 与 Rigging QA 增加服务端多视图和标准动作变形渲染，扩展现有结构指标。
- 将二进制资产从 Run 单路径演进为带版本和谱系的资产实体。
- 在现有 DGX 设备、统一内存、队列和延迟展示基础上，增加阶段耗时、错误率和 Agent 质量评估。
- 如果开放多用户或远程控制台，补充认证、RBAC、审计和密钥管理。

这些项目是规划，不代表当前已经实现。

## 11. 项目标识

**项目名称：** Super Idol Master

**仓库地址：** [https://github.com/SidneyArt/Super-Idol-Master](https://github.com/SidneyArt/Super-Idol-Master)

**主要运行平台：** Windows 本地控制台 + NVIDIA DGX

**最后更新日期：** 2026-07-21

## 12. 术语表

**Run：** 一次角色资产生产任务，是状态机和持久化的主实体。

**Job：** 某个阶段的一次异步生成或检查执行，例如 2D、QA、3D 或 rig。

**Supervisor：** 唯一可以修改 Run、推进状态机和启动 Job 的主 Agent。

**Art Director：** 只负责提示词质检与修订的专业 Agent。

**Visual QA：** 只负责图片姿态和构图语义质量复核的专业 Agent。

**Character Consistency：** 只负责角色身份锚点连续性复核的专业 Agent。

**Asset Inspector：** 只负责静态 GLB 结构指标解释的专业 Agent。

**Rigging QA：** 只负责绑骨结构指标解释的专业 Agent。

**Export Specialist：** 只负责最终资产交付就绪判断的专业 Agent。

**Workflow Doctor：** 只负责失败诊断和修复建议、不执行修复的专业 Agent。

**持续执行计划：** 用户指定终点后，跨越多个异步 Job 自动恢复和推进的持久化编排记录。

**硬门禁：** 不能由语言模型意见绕过的确定性条件，例如 SDPose 必须为 `passed`、GLB 必须包含 mesh。

**ComfyUI：** 承载节点式 GPU 生成工作流的服务。

**GLB：** glTF 2.0 的二进制容器格式，用于静态或带骨骼的 3D 资产。

---

本文档结构参考 [architecture.md](https://architecture.md/) 模板，并根据当前仓库实现进行了裁剪。
