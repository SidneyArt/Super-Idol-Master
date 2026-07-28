# Super Idol Master（多智能体数字角色资产生产线）本地控制台

这是 `Super-Idol-Master` 主仓库内的本地全栈网站，包含 React/Vinext 前端、Node.js API 和 SQLite 数据库，并连接 DGX 上的 ComfyUI 工作流。

## 启动

在主仓库根目录双击：

```text
启动本地网站.cmd
```

也可以使用 PowerShell：

```powershell
cd web
npm install
npm run local
```

需要 Node.js 22.19 或更高版本。首次启动会安装依赖。

Asset Agent 使用 Stepfun Step Plan。首次运行前复制 `.env.example` 为 `.env.local`，并设置：

```text
STEPFUN_API_KEY=your-api-key
```

可单独验证 Pi 的文本、工具调用和图片兼容性：

```powershell
npm run agent:verify
```

## 地址

- 前端：`http://localhost:3100`
- API 健康检查：`http://127.0.0.1:8787/api/health`
- 默认 DGX / ComfyUI：`http://100.120.236.113:8188`

访问 DGX 前，需要当前电脑已加入相同的 Tailscale 虚拟网络并获得对应访问权限。

## 主要功能

- 工作空间首页、分组任务列表和跨任务总调度 Agent；
- 总调度 Agent 可分析多角色合集原画、裁切单体角色、批量建任务并委派给专属 Asset Agent；
- 总调度与任务 Agent 可分别选择请求批准或 `Auto` 模式；
- 右上角通知中心展示待审批、生成完成和流程完成提醒，并支持 `View` 跳转；
- IDEA → 2D → 自动 T-Pose QA → 3D → 自动拓扑 → 自动绑骨 → 导出的严格状态机；
- 原画 → T-Pose 图 → 自动 T-Pose QA → 3D → 自动拓扑 → 自动绑骨 → 导出的图生模型工作流；
- 文生图与图生图模型可独立配置；
- 调用 DGX 上真实的 Qwen Image、SDPose、Pixal3D 和 SkinTokens 工作流；
- ComfyUI WebSocket 真实进度与任务事件记录；
- 静态和绑骨 GLB 的交互式 3D 预览；
- 材质、拓扑线框、骨骼显示、临时摆姿态、自动旋转和视角控制；
- 可复用的 Mixamo FBX 动画库，以及播放、暂停、时间轴、循环、速度和原地移动预览；
- SQLite 持久化任务、产物路径和执行历史。
- Pi 驱动的 Asset Agent，可完善提示词、推进或回退流程、重新生成并分析参考图片。
- Pi 多角色协作：Supervisor 在提示词、T-Pose、静态 3D、绑骨、导出和失败诊断节点调用对应的受控专业 Agent。
- 目标驱动的持续执行：用户指定“生成到模型”或“自动做到绑骨”后，异步 Job 完成事件会自动恢复流水线；质量门禁未通过时才暂停。

## 多 Agent 调用边界

- `Supervisor` 是唯一拥有状态修改和 Job 工具的角色。
- `Art Director` 只提交结构化 `PromptPlan`；配置 Agent API 后，聊天更新提示词和页面“确认设定”都会触发检查。
- `Visual QA` 只提交结构化图片质量报告；它检查朝向、遮挡和背景，不覆盖 SDPose 的关键点硬门禁。
- `Character Consistency` 只检查角色身份锚点；`Asset Inspector`、`Rigging QA` 和 `Export Specialist` 只解释确定性 GLB 指标并提交阶段报告。
- `Workflow Doctor` 只在 Job 失败后提交诊断和安全建议，不修改工作流，也不直接重试。
- 持续执行计划保存在 `agent_workflow_plans`，子 Agent 运行和报告保存在 `agent_role_runs`、`agent_reports`；Run API 会返回最新状态。
- Agent 面板会显示 Supervisor 编排目标，以及 Art Director、Visual QA、Character Consistency、Asset Inspector、Rigging QA、Export Specialist 与 Workflow Doctor 的活动和结构化结论。
- 没有配置 Agent API Key 时跳过多角色调用，原有确定性流水线仍可使用。

## 不进入 Git 的本机内容

- `node_modules/` 和构建目录；
- `data/` 中的 SQLite 数据库和运行日志；
- `data/mixamo-animations/` 中用户导入的 Mixamo FBX 动画；
- `public/generated/` 中的任务预览图片；
- 本地环境变量和 DGX 生成产物。

系统边界见主仓库的 `ARCHITECTURE.md`，完整运行说明见 `docs/getting-started/local-fullstack-web.md`。
