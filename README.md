# Super Idol Master：数字偶像资产管家

Super Idol Master 是一套运行在 Windows 本地控制台与 NVIDIA DGX 生成节点之间的角色资产生产系统。首页以工作空间组织不同项目和任务，并提供总调度 Agent；用户可以从角色描述、单体原画或多角色合集原画开始，把角色持续推进为通过质检的 T-Pose、静态 3D 模型和带骨骼 GLB。

系统接入真实的 Qwen Image、SDPose、Pixal3D 和 SkinTokens 工作流，并以状态机、质量门禁和产物校验约束自动化过程。

## 核心能力

- 工作空间首页：不同工作空间保存各自的任务列表，已有任务自动归入“默认工作空间”。
- 总调度 Agent：可创建工作空间与任务，分析多角色合集原画、拆分单体角色，并把目标委派给各任务的专属 Asset Agent。
- 两套可选资产流水线：
  - `角色描述 → 2D / T-Pose 图 → T-Pose QA → 3D → 自动绑骨 → 导出`；
  - `角色原画 → T-Pose 图 → T-Pose QA → 3D → 自动绑骨 → 导出`。
- 通过 ComfyUI HTTP API 和 WebSocket 调用 DGX，展示真实队列、节点进度和执行结果。
- 文生图和图生图分别提供 Stepfun 模型、Base URL 与 API Key 配置，其他阶段继续使用 ComfyUI。
- 静态与绑骨 GLB 的交互式 3D 预览，包括材质、线框、骨骼和自动旋转。
- SQLite 持久化任务、阶段、事件、配置、Agent 对话和质检报告。
- Pi 驱动的多 Agent 协作：
  - `Supervisor` 负责理解目标、修改状态和编排 Job；
  - `Art Director` 负责检查并修订生成提示词；
  - `Visual QA` 负责复核单主体、全身、朝向、遮挡和背景。
- 目标驱动的持续执行。用户说“帮我一路生成到模型”后，系统会自动执行后续阶段，不再逐步等待人工确认；只有质量门禁失败或外部任务异常时才暂停。

## 工作流程

创建任务时可以选择“文生模型”或“图生模型”。图生模型任务必须提供一张单体角色原画；总调度 Agent 也可以从合集原画中生成这些单体输入。

```text
角色描述
  │
  ├─ Art Director：检查角色身份、风格和 T-Pose 约束
  ▼
2D 概念图
  │
  ├─ SDPose：确定性关键点与姿态硬门禁
  ├─ Visual QA：视觉语义复核
  ▼
静态 3D 模型
  │
  ├─ GLB mesh 结构检查
  ▼
自动绑骨
  │
  ├─ GLB skin / joints 结构检查
  ▼
资产导出
```

```text
单体角色原画
  │
  ├─ Stepfun 图生图：保持角色身份并转换为标准 T-Pose
  ▼
T-Pose 图
  │
  ├─ SDPose + Visual QA 双重质量门禁
  ▼
静态 3D 模型 → 自动绑骨 → 资产导出
```

Asset Agent 支持把以下自然语言目标登记为持久化执行计划：

```text
帮我一路生成到模型
自动做到绑骨完成
生成并检查 T-Pose
```

异步 GPU Job 完成后，后端会自动恢复编排并启动下一阶段。SDPose 不通过、Visual QA 未放行、Job 失败或本地服务重启时，计划会明确标记为暂停或失败，不会静默越过质量门禁。

## 快速开始

### 环境要求

- Windows 10 或更高版本；
- Node.js 22.19 或更高版本；
- Python 3；
- 能够访问 DGX / ComfyUI 的 Tailscale 网络；
- 使用 Asset Agent 时需要 Stepfun API Key。

### 安装依赖

```powershell
cd web
npm install
cd ..
python -m pip install -r scripts/comfy_workflow/requirements.txt
```

### 配置 Agent

复制 `web/.env.example` 为 `web/.env.local`，至少填写：

```dotenv
STEPFUN_API_KEY=your-api-key
```

也可以在网站设置面板中分别配置 Agent、文生图模型、图生图模型、各阶段 ComfyUI 地址和工作流版本。图片配置支持 `STEPFUN_TEXT_IMAGE_*` 与 `STEPFUN_IMAGE_EDIT_*` 环境变量，并兼容原来的 `STEPFUN_IMAGE_*`。API Key 只保存在本机环境变量或本地 SQLite 配置中。

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

## 项目结构

```text
Super-Idol-Master/
├── ARCHITECTURE.md              # 系统架构、组件边界和数据流
├── README.md                    # 项目概览与快速开始
├── docs/                        # PRD、运行基线、集成与技术决策
├── output/                      # 本地生成产物，不进入 Git
├── scripts/comfy_workflow/      # Python 客户端、工作流 JSON 和阶段脚本
├── web/
│   ├── app/                     # React/Vinext 前端
│   ├── server/                  # Node.js API、Agent Runtime 和任务编排
│   ├── data/                    # SQLite 与运行时工作流，不进入 Git
│   ├── public/generated/        # 页面预览资源，不进入 Git
│   └── scripts/                 # 本地启动与 Agent 兼容性检查
├── start-local.cmd              # 英文文件名启动入口
└── 启动本地网站.cmd             # 中文文件名启动入口
```

详细组件职责、系统图、数据库表和安全边界见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 独立运行工作流

Python 脚本也可以脱离网站单独调用：

```powershell
python scripts/comfy_workflow/run_2d_generation.py --positive "角色描述" --negative "低画质，肢体畸形"
python scripts/comfy_workflow/run_tpose_qa.py path/to/character.png
python scripts/comfy_workflow/run_3d_generation.py path/to/character.png
python scripts/comfy_workflow/run_3d_skinning.py path/to/model.glb
```

所有下载到本机的生成结果都必须位于项目的 `output/` 目录。完整参数和工作流节点映射见 [`docs/dgx-pipeline-integration.md`](./docs/dgx-pipeline-integration.md)。

## 开发检查

```powershell
cd web
npm run lint
npm run build
npm run agent:verify
```

`agent:verify` 会实际访问配置的模型 API；运行前需要有效的 Stepfun API Key。当前仓库以 ESLint、生产构建和 Agent 兼容性脚本为主要自动检查，尚未建立完整的单元测试与 E2E 测试套件。

## 文档

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)：系统结构、数据流、组件职责和架构边界。
- [`docs/README.md`](./docs/README.md)：全部项目文档索引。
- [`docs/current-project-baseline.md`](./docs/current-project-baseline.md)：当前工程基线和真实运行证据。
- [`docs/local-fullstack-web.md`](./docs/local-fullstack-web.md)：本地网站、API 和状态机说明。
- [`docs/dgx-pipeline-integration.md`](./docs/dgx-pipeline-integration.md)：DGX / ComfyUI 全链路映射。
- [`docs/agent-runtime-pi-adr.md`](./docs/agent-runtime-pi-adr.md)：Agent Runtime 技术决策。

## 安全边界

- 前端和管理 API 默认只监听本机回环地址。
- ComfyUI 不应直接暴露到公网；远程访问通过受控的 Tailscale 网络完成。
- 后端只执行固定 Python 脚本和白名单参数，不向 Asset Agent 暴露 Shell、任意文件读写或 Git。
- 工作流上传会校验 JSON 结构、必需节点和大小。
- 后端会校验生成路径必须位于 `output/`，并检查 PNG、GLB、mesh、skin 和 joints 等产物证据。
- `.env.local`、SQLite 数据库、运行时工作流和生成产物不得提交到 Git。
