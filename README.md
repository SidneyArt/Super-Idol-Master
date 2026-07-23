# Super Idol Master：多智能体数字角色资产生产线

> 第二届 **NVIDIA DGX Spark Hackathon 十日黑客松**参赛作品

![多智能体数字角色资产生产线](docs/assets/multi-agent-character-asset-pipeline.png)

Super Idol Master 是一套端到端数字角色资产生产系统。用户可以从角色描述、单体原画或多角色合集原画开始，持续生成通过质量检查的 T-Pose 原画、静态 3D 模型和带骨骼 GLB 资产。

系统以 **Pi** 作为智能体运行时与模型适配层，接入 **StepFun step-3.7-flash** 模型，并结合自研状态机、质量门禁和持久化机制，构建受控、可恢复的多智能体闭环。系统共包含九种逻辑角色：由 `Coordinator` 负责跨任务调度，`Supervisor` 负责任务流程编排，并协同七个专业 Agent 完成规划、质检、反馈与自动修复。

项目以 **NVIDIA DGX Spark** 作为核心本地算力底座，将部分 2D 资源生成以及 3D 模型生成、自动拓扑和骨骼绑定等 GPU 重计算任务部署在本地。系统能够根据专业 Agent 的评审结果与确定性质量门禁，自主判断流程应该继续、重试、回退还是修复，最终形成一条可持续推进、可自动质检、可从中断与异常中恢复的数字角色资产生产线。

## 核心能力

- 工作空间首页：不同工作空间保存各自的任务列表，已有任务自动归入“默认工作空间”。
- 总调度 Agent：可创建工作空间与任务，分析多角色合集原画、拆分单体角色，并把目标委派给各任务的专属 Asset Agent。
- 独立 Agent 会话：总调度 Agent 与每个任务的 Asset Agent 都能新建、切换并恢复会话，同时显示当前上下文估算用量和 131,072 token 上限。
- 分级 Agent 权限：总调度 Agent 和每个任务的 Asset Agent 可分别选择“请求批准”或 `Auto`；请求批准模式会在执行生成、推进、回滚或批量调度前暂停。
- 全局通知中心：待审批、阶段生成完成、质量检查结果和全流程完成都会在右上角提醒，`View` 可跳转到对应工作空间或任务。
- 两套可选资产流水线：
  - `角色描述 → 2D / T-Pose 图 → T-Pose QA → 3D → 自动拓扑 → 自动绑骨 → 导出`；
  - `角色原画 → T-Pose 图 → T-Pose QA → 3D → 自动拓扑 → 自动绑骨 → 导出`。
- 通过 ComfyUI HTTP API 和 WebSocket 调用 DGX，展示真实队列、节点进度和执行结果。
- 文生图支持 StepFun 云端 API 与 DGX Qwen Image 两种接入方式；图生图使用 StepFun 云端 API，并分别提供模型、Base URL 与 API Key 配置。
- 静态与绑骨 GLB 的交互式 3D 预览，包括材质、线框、骨骼、临时摆姿态和自动旋转。
- Mixamo 动画预览：导入一次 FBX 动画后可供所有绑定角色复用，支持播放、暂停、时间轴、循环、速度和原地移动；预览姿态不会写回 GLB。
- SQLite 持久化任务、阶段、事件、配置、Agent 对话和质检报告。
- Pi 驱动的分层多 Agent 协作：一个跨任务 `Coordinator`、每个任务一个 `Supervisor`，再按阶段调用七个只读专业 Agent；角色、工具和结构化输出互相隔离。
- 目标驱动的持续执行。用户说“帮我一路生成到模型”后，系统会自动执行后续阶段，不再逐步等待人工确认；只有质量门禁失败或外部任务异常时才暂停。

## 自定义 Agent 与协作机制

系统共定义九种逻辑角色。`Coordinator` 位于工作空间层；每个角色任务拥有独立的 Asset Agent 会话，其中 `Supervisor` 是唯一能编排该任务状态机的主角色；其余七个专业 Agent 只提交结构化意见，不能直接修改任务或启动 GPU Job。这里的 Asset Agent 是任务级运行容器和对话入口，不是额外的第十个角色。

```text
用户
  │
  ├─ Coordinator（工作空间级总调度）
  │    ├─ 生成或分析多角色合集图
  │    ├─ 创建工作空间与多个角色任务
  │    └─ 将目标委派给每个任务的 Asset Agent
  │
  └─ Asset Agent（每个 Run 独立会话与上下文）
       └─ Supervisor（唯一任务编排者）
            ├─ Art Director
            ├─ Visual QA
            ├─ Character Consistency
            ├─ Asset Inspector
            ├─ Rigging QA
            ├─ Export Specialist
            └─ Workflow Doctor
```

### 角色、输入与权限边界

| Agent | 所在层级 | 主要输入 | 结构化输出或工具 | 权限边界 |
| --- | --- | --- | --- | --- |
| `Coordinator` | 工作空间 | 用户目标、合集原画、工作空间和最近任务批次 | 列出／创建工作空间、生成合集图、拆分角色、创建任务、继续最近任务、委派目标 | 不执行 Shell，不直接写资产，不绕过任务状态机 |
| `Supervisor` | 单个任务 | Run 状态、提示词、QA、Job、产物和最近会话 | `get_run_context`、`update_character_prompts`、`advance_workflow`、`execute_pipeline_goal`、`revert_workflow`、`run_stage_job` | 唯一可改变 Run 的 Agent；一次对话最多直接启动一个 GPU Job |
| `Art Director` | 生成前 | 用户设定、正反向提示词、目标阶段 | `PromptPlan`：最终提示词、身份锚点、姿态约束、问题与决定 | 只提交报告；不能修改 Run 或启动生成 |
| `Visual QA` | T-Pose 质检 | 待检图片、SDPose 指标、背景像素证据 | 视觉报告：全身、单主体、正视、手臂、遮挡、空手、白底、置信度与决定 | 不能覆盖 SDPose 硬门禁；置信度低于 `0.8` 不能放行 |
| `Character Consistency` | T-Pose 质检 | 参考原画、待检 T-Pose、角色提示词 | 身份连续性报告：匹配／漂移锚点、置信度与决定 | 只判断身份，不重复姿态检查，不修改角色设定 |
| `Asset Inspector` | 静态 3D | GLB 解析器给出的 mesh、primitive、材质、纹理和场景指标 | 静态资产质量报告 | 没有多视图渲染证据时不得声称看见穿模或缺面；不能覆盖 GLB 结构检查 |
| `Rigging QA` | 自动绑骨后 | skin、joints、node、animation 等 GLB 指标 | 绑骨质量报告 | 没有动作渲染时不得声称验证了形变；缺少 skin／joints 必须拒绝 |
| `Export Specialist` | 导出前 | 最终 GLB 的几何、材质、纹理、骨骼、场景和动画指标 | 通用 GLB 交付报告与 warnings | 不写文件；未指定时不能假设已满足 Unity、Unreal 或 VRM 专属规范 |
| `Workflow Doctor` | Job 失败后 | 失败阶段、受控任务摘要和真实错误信息 | 失败分类、可能原因、重试建议与安全检查动作 | 不读取不存在的日志，不修改工作流，不自动重试 |

### 一次完整协作如何发生

以“把这个角色自动做到可导出的带骨骼模型”为例：

1. `Coordinator` 将大型目标拆成角色任务，并把 `export` 终点委派给各任务。任务级权限设置不会因委派被永久改成 `Auto`。
2. `Supervisor` 建立持久化的 `agent_workflow_plans` 记录。若处于“请求批准”模式，用户批准的是明确终点，而不是让模型获得无限权限。
3. `Art Director` 先输出 `PromptPlan`。本地 `PromptPolicy` 再确定性补齐单主体、完整全身、严格正视、T-Pose、双臂水平、肢体无遮挡、空手和纯白背景等硬约束。
4. 2D Job 异步提交到 StepFun 图片 API 或 DGX Qwen Image。Job 完成事件写入 SQLite 后，`Supervisor` 从计划状态恢复，而不是依赖一段持续占用进程的长对话。
5. SDPose 先执行关键点和背景像素硬检查；随后 `Visual QA` 检查视觉语义，`Character Consistency` 独立检查身份锚点。三者必须全部放行才能进入 3D。
6. Pixal3D 返回静态 GLB 后，后端先解析 glTF 结构并确认至少存在一个 mesh，再由 `Asset Inspector` 解释结构质量。语言模型意见不能把无 mesh 文件判为合格。
7. AutoRemesher 在 DGX 独立 API 中重建拓扑，Blender 重新展开 UV 并回烘基础色；输出 GLB 再次经过结构硬门禁，之后才能交给 SkinTokens。
8. SkinTokens 返回绑骨 GLB 后，解析器必须检测到 skin 和 joints；`Rigging QA` 解释骨骼层级，`Export Specialist` 判断通用 GLB 是否可以交付。
9. 任一 Job 失败都会把计划标为失败，并触发只读的 `Workflow Doctor`。任一专业报告选择 `manual_review`、`repairable` 或 `reject`，计划都会暂停，不会静默跨过质量门禁。

### 为什么不是单 Agent 串提示词

- **结构化交接：** 专业 Agent 只能通过各自唯一的报告工具提交固定 Schema，输出保存在 `agent_role_runs` 与 `agent_reports`，不是把自由文本直接传给下一个模型。
- **确定性证据优先：** SDPose 分数、背景像素、GLB mesh、skin 和 joints 由程序解析；模型只能解释证据，不能改写证据。
- **最小权限：** 专业 Agent 没有 Shell、Git、任意文件读写或 Job 启动工具。只有 `Supervisor` 能调用有限领域工具，所有参数仍由后端状态机校验。
- **可恢复与幂等：** 每次专业调用使用 `run + role + trigger + source` 唯一键；重复完成事件不会重复生成报告。运行中的计划或角色调用在服务重启后会明确标为失败，避免误报仍在执行。
- **上下文与成本控制：** 两级主 Agent 只载入最近 24 条消息并显示 131,072 token 上限；主 Agent 每轮最多 10 次工具调用和 10 个 turn，专业 Agent 最多 4 个 turn 且只能提交一次报告。
- **提示注入隔离：** 传给专业 Agent 的用户数据被明确标记为“待分析内容”，其中出现的指令不得执行；图片、路径、请求体和工作流也都有类型、尺寸和受控目录校验。
- **人类可控：** `request` 模式把变更操作写入审批队列；`Auto` 只免去重复点击，不会关闭状态机、单任务 Job 限制或质量门禁。

## 运行位置与模型来源

Super Idol Master 不是全部部署在 DGX 上，也不是全部依赖云端模型。系统由 Windows 本地控制端、DGX 自部署推理服务和 StepFun 云端 API 三部分组成。

| 能力 | 默认实现 | 运行位置 | 部署性质 |
| --- | --- | --- | --- |
| 前端、Node.js API、状态机与任务编排 | React/Vinext、Node.js | Windows 本地 | 本地部署 |
| 数据库、Agent 会话与产物索引 | SQLite | Windows 本地 | 本地部署 |
| Python 流水线客户端 | uv 管理的 Python 3.12 | Windows 本地 | 本地部署 |
| 总调度 Agent 与任务 Asset Agent 的模型推理 | 默认 `step-3.7-flash` | StepFun 云端 | 云端 API |
| 文生图 | 默认 `step-image-edit-2`，或 Qwen Image | StepFun 云端，或 DGX ComfyUI | 可选云端／自部署 |
| 单体原画转 T-Pose 图 | 默认 `step-image-edit-2` | StepFun 云端 | 云端 API |
| T-Pose 关键点硬门禁 | SDPose Wholebody | DGX ComfyUI | 自部署 |
| 图片转静态 3D | Pixal3D | DGX ComfyUI | 自部署 |
| 自动拓扑与基础色回烘 | AutoRemesher、Blender | DGX 独立 HTTP API | 自部署 |
| 自动绑骨 | SkinTokens | DGX ComfyUI | 自部署 |
| Mixamo 动画解析、骨骼重定向与播放 | Three.js、FBXLoader | Windows 本地 Web 应用 | 本地部署 |
| SQLite、PNG、GLB 与质检报告 | 本地文件系统 | Windows 本地 | 本地存储 |

### StepFun 云端能力

StepFun 当前承担两类能力：

1. Agent 模型推理：总调度 Agent 和每个任务的 Asset Agent 默认使用 `step-3.7-flash`。Pi Runtime、工具权限和任务状态机运行在本地，但对话上下文会发送到配置的 StepFun API。
2. 图片生成与编辑：文生图和图生图默认使用 `step-image-edit-2`。文生图可以切换为 DGX 上的 Qwen Image；上传角色原画的图生图流程当前使用 StepFun 云端 API。

任务 Agent 与总调度 Agent 的模型配置彼此独立；两者各自拥有文生图和图生图配置，可以使用不同的 Base URL、模型与 API Key。所有配置均可在网站的“请求设置”面板中维护。

使用 StepFun 图片模型时，角色提示词以及图生图任务的输入图片会发送到云端 API，返回图片下载到 Windows 本地 `output/`。如果数据不能离开内网，应把文生图切换为 DGX Qwen Image，并为图生图流程接入自部署的兼容 API。

### DGX 自部署能力

DGX 上运行的是推理和几何处理服务，不部署 Super Idol Master 的网站、SQLite 或 Agent 会话：

```text
DGX ComfyUI：Qwen Image、SDPose、Pixal3D、SkinTokens
DGX 独立 API：AutoRemesher + Blender
```

Windows 后端通过 HTTP、WebSocket 或独立拓扑 API 调用 DGX，并把生成结果下载到本地。AutoRemesher 服务不要求 Bearer Token：Windows 可以通过受控的 Tailscale 私网直接调用；公司电脑不能运行 Tailscale 时，也可以经 ECS SSH 隧道把 DGX 的 `8190` 转发到本机 `127.0.0.1:8190`。该服务还可以替换成其他兼容 `/v1/remesh` 协议的 API。

## 工作流程

创建任务时可以选择“文生模型”或“图生模型”。图生模型任务必须提供一张单体角色原画；总调度 Agent 也可以从合集原画中生成这些单体输入。

```text
角色描述
  │
  ├─ Art Director：检查角色身份、风格和 T-Pose 约束
  ▼
2D 概念图（StepFun 云端或 DGX Qwen Image）
  │
  ├─ SDPose：确定性关键点与姿态硬门禁
  ├─ Visual QA：视觉语义复核
  ├─ Character Consistency：角色身份连续性复核
  ▼
静态 3D 模型
  │
  ├─ GLB mesh 结构检查
  ├─ Asset Inspector：静态资产结构解释
  ▼
自动拓扑
  │
  ├─ DGX AutoRemesher：重建拓扑
  ├─ Blender：重新展开 UV 与基础色回烘
  ▼
自动绑骨
  │
  ├─ GLB skin / joints 结构检查
  ├─ Rigging QA：绑骨结构复核
  ├─ Export Specialist：导出就绪检查
  ▼
资产导出
```

```text
单体角色原画
  │
  ├─ StepFun 云端图生图：保持角色身份并转换为标准 T-Pose
  ▼
T-Pose 图
  │
  ├─ SDPose + Visual QA 双重质量门禁
  ▼
静态 3D 模型 → AutoRemesher 自动拓扑 → 自动绑骨 → 资产导出
```

Asset Agent 支持把以下自然语言目标登记为持久化执行计划：

```text
帮我一路生成到模型
自动做到绑骨完成
生成并检查 T-Pose
```

异步 GPU Job 完成后，后端会自动恢复编排并启动下一阶段。任一确定性硬门禁或专业 Agent 未放行、Job 失败或本地服务重启时，计划会明确标记为暂停或失败，不会静默越过质量门禁。Job 失败时 Workflow Doctor 只生成诊断报告，不会自行修改工作流或重试。

## 快速开始

### 环境要求

- Windows 10 或更高版本；
- Node.js 22.19 或更高版本；
- [uv](https://docs.astral.sh/uv/)；Python 3.12 由 uv 自动安装和固定；
- Windows 后端能够通过公司内网、VPN、SSH 隧道或其他受控网络访问 DGX 服务；
- 使用总调度 Agent 或 Asset Agent 时需要 StepFun API Key；
- 使用 StepFun 文生图或图生图时，需要对应的图片模型 API Key。

### 安装依赖

```powershell
cd web
npm install
cd ..
uv sync --locked --project web/server/pipeline
```

### 配置 StepFun 云端模型

复制 `web/.env.example` 为 `web/.env.local`，至少填写：

```dotenv
STEPFUN_API_KEY=your-api-key
```

`STEPFUN_API_KEY` 用于 Agent 模型。云端图片模型建议分别配置：

```dotenv
STEPFUN_TEXT_IMAGE_BASE_URL=https://api.stepfun.com/step_plan/v1
STEPFUN_TEXT_IMAGE_MODEL=step-image-edit-2
STEPFUN_TEXT_IMAGE_API_KEY=your-image-api-key

STEPFUN_IMAGE_EDIT_BASE_URL=https://api.stepfun.com/step_plan/v1
STEPFUN_IMAGE_EDIT_MODEL=step-image-edit-2
STEPFUN_IMAGE_EDIT_API_KEY=your-image-api-key
```

也可以在网站“请求设置”中分别配置任务 Agent、总调度 Agent、文生图模型、图生图模型、拓扑 API、各阶段 ComfyUI 地址和工作流版本。图片配置兼容原来的 `STEPFUN_IMAGE_*` 环境变量。API Key 只保存在本机环境变量或本地 SQLite 配置中，不会通过公开设置接口返回给前端。

如果文生图选择 DGX Qwen Image，则该阶段不调用 StepFun 图片模型；Agent 对话仍然使用各自配置的 StepFun Agent 模型。

### 启动网站

在项目根目录双击：

```text
启动本地网站.cmd
```

也可以使用 PowerShell：

```powershell
cd web
npm run local
```

启动后的默认地址：

- 前端：`http://localhost:3100`
- API 健康检查：`http://127.0.0.1:8787/api/health`
- DGX / ComfyUI：`http://100.120.236.113:8188`
- DGX / AutoRemesher：Tailscale 直连使用 `http://100.120.236.113:8190`；ECS SSH 隧道使用 `http://127.0.0.1:8190`

## 项目结构

```text
Super-Idol-Master/
├── ARCHITECTURE.md              # 系统架构、组件边界和数据流
├── README.md                    # 项目概览与快速开始
├── docs/                        # PRD、运行基线、集成与技术决策
├── deploy/dgx-autoremesher/     # 可单独上传到 DGX 的自动拓扑 API 安装包
├── output/                      # 本地生成产物，不进入 Git
├── web/
│   ├── app/                     # React/Vinext 前端
│   ├── server/                  # Node.js API、Agent Runtime 和任务编排
│   │   └── pipeline/            # 后端私有 Python 执行器、uv 项目与工作流模板
│   ├── data/                    # SQLite 与运行时工作流，不进入 Git
│   ├── public/generated/        # 页面预览资源，不进入 Git
│   └── scripts/                 # 本地启动与 Agent 兼容性检查
├── start-local.cmd              # 英文文件名启动入口
└── 启动本地网站.cmd             # 中文文件名启动入口
```

详细组件职责、系统图、数据库表和安全边界见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 独立运行工作流

Python 执行器也可以通过锁定的 uv 环境脱离网站单独调用：

```powershell
uv run --locked --project web/server/pipeline python web/server/pipeline/run_2d_generation.py --positive "角色描述" --negative "低画质，肢体畸形"
uv run --locked --project web/server/pipeline python web/server/pipeline/run_tpose_qa.py path/to/character.png
uv run --locked --project web/server/pipeline python web/server/pipeline/run_3d_generation.py path/to/character.png
uv run --locked --project web/server/pipeline python web/server/pipeline/run_3d_retopology.py path/to/model.glb --service-url http://DGX:8190
uv run --locked --project web/server/pipeline python web/server/pipeline/run_3d_skinning.py path/to/retopologized.glb
```

所有下载到本机的生成结果都必须位于项目的 `output/` 目录。完整参数和工作流节点映射见 [`docs/deployment/dgx-pipeline-integration.md`](./docs/deployment/dgx-pipeline-integration.md)。

## 开发检查

```powershell
cd web
npm run lint
npm test
npm audit --omit=dev
npm run python:check
npm run agent:verify
```

`npm run local` 和 `npm run backend` 会先执行 `uv sync --locked`，之后 Node 后端直接调用 `web/server/pipeline/.venv` 中的解释器，不依赖系统 `PATH` 中的 Python。`PYTHON_COMMAND` 仅保留为显式调试覆盖。`agent:verify` 会实际访问配置的模型 API；运行前需要有效的 StepFun API Key。

## 文档

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)：系统结构、数据流、组件职责和架构边界。
- [`docs/README.md`](./docs/README.md)：全部项目文档索引。
- [`docs/getting-started/current-project-baseline.md`](./docs/getting-started/current-project-baseline.md)：当前工程基线和真实运行证据。
- [`docs/getting-started/local-fullstack-web.md`](./docs/getting-started/local-fullstack-web.md)：本地网站、API 和状态机说明。
- [`docs/deployment/dgx-pipeline-integration.md`](./docs/deployment/dgx-pipeline-integration.md)：DGX / ComfyUI 全链路映射。
- [`docs/deployment/dgx-autoremesher-deployment.md`](./docs/deployment/dgx-autoremesher-deployment.md)：在 DGX Spark 上独立部署自动拓扑 API，不部署 Super Idol Master。
- [`docs/architecture/agent-runtime-pi-adr.md`](./docs/architecture/agent-runtime-pi-adr.md)：Agent Runtime 技术决策。
- [`docs/product/hackathon-submission-audit.md`](./docs/product/hackathon-submission-audit.md)：按比赛要求与评分标准整理的证据、差距和提交清单。

## 安全边界

- 前端和管理 API 默认只监听本机回环地址。
- ComfyUI 和无鉴权的 AutoRemesher API 不应直接暴露到公网；当前通过 Tailscale 私网访问，并由 Tailnet ACL 控制允许连接的设备和用户。
- 后端只执行固定 Python 脚本和白名单参数，不向 Asset Agent 暴露 Shell、任意文件读写或 Git。
- 工作流上传会校验 JSON 结构、必需节点和大小。
- 后端会校验生成路径必须位于 `output/`，并检查 PNG、GLB、mesh、skin 和 joints 等产物证据。
- `.env.local`、SQLite 数据库、运行时工作流和生成产物不得提交到 Git。
