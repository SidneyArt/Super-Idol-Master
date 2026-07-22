# DGX Spark Hackathon 参赛审计与提交清单

> 审计日期：2026-07-22  
> 依据：组委会提供的项目提交要求与评审标准截图  
> 原则：只把代码、文档、真实运行记录或正式提交链接能够证明的内容标为完成

## 1. 组委会要求

### 1.1. 提交材料

| 提交项 | 要求 | 当前证据 | 状态 |
| --- | --- | --- | --- |
| 项目开源提交 | 完整项目上传至 GitHub、码云等开源平台，以 URL 提交 | Git 远端为 `https://github.com/SidneyArt/Super-Idol-Master.git`；2026-07-22 未登录公网检查返回 `404` | 未完成；需将仓库设为公开、验证 URL，并选择开源许可证 |
| 项目说明文档 | 600 字以上，说明作品特点、核心亮点、技术实现、架构设计和优化方案 | 根目录 `README.md`、`ARCHITECTURE.md` 和 PRD | 已覆盖 |
| 部署说明 | 说明如何利用本地算力部署智能体、如何优化大模型 | README、DGX 集成文档、AutoRemesher 独立部署文档 | 已覆盖；ARM64 冒烟测试已完成，正式提交前需补真实角色资产连续验收结果 |
| 技术栈说明 | 列明 NVIDIA SDK、NVIDIA 模型和 StepFun 模型 | 本文第 3 节和 README 的运行位置表 | 部分完成；目前没有直接集成 NVIDIA NIM、TensorRT 或 Nemotron，不应虚报 |
| 作品演示视频 | 清晰展示功能及核心亮点 | 仓库中没有正式视频 URL | 待团队完成 |
| 团队资料 | 团队合影 | 仓库中没有团队合影 | 待团队完成 |
| 赛事征文 | 参赛成果记录或 DGX Spark 黑客松“十日谈”开发历程 | PRD 有内容素材，但没有公开文章 URL | 待团队完成 |

### 1.2. 评分权重

| 评分项 | 权重 | 组委会关注点 |
| --- | ---: | --- |
| 项目实用性、行业落地价值与技术创新性 | 25% | 技术、架构与方案创新，体现 DGX Spark 优势，解决真实技术痛点 |
| 智能体融合与模型优化技术深度 | 25% | 多智能体协同、模型调优深度和差异化技术方案 |
| 项目完整性 | 20% | 功能、稳定性、前后端、文档、逻辑和现场可演示性 |
| 平台适配性 | 15% | DGX Spark 全栈能力、NVIDIA 开源模型或 SDK、StepFun 模型使用 |
| 演示效果 | 10% | 视频流畅、表达清晰、逻辑严谨、核心价值直观 |
| 赛事征文 | 5% | 成果记录和开发历程 |

## 2. 按评分项的当前审计

### 2.1. 项目实用性、行业价值与创新性（25%）

**已有优势**

- 面向独立游戏、数字偶像和角色原型团队，将原本分散的概念图、T-Pose、图生 3D、拓扑、绑骨和导出步骤组织为可追溯资产流水线。
- 不是单次生成 Demo：每个阶段都有真实文件、事件、状态、质量报告和可回退边界。
- 将 StepFun 云端推理与 DGX Spark 本地多模型计算拆成控制面和计算面；AutoRemesher 也可作为独立 API 替换，不要求把整站部署到 DGX。
- 自动拓扑位于 Pixal3D 和 SkinTokens 之间，解决直接对高密度生成网格绑骨时的拓扑质量、UV 和纹理继承问题。

**证据**

- `web/server/index.mjs` 中的七阶段状态机和产物硬校验。
- `web/server/pipeline/` 中四套真实 ComfyUI 工作流与五个执行入口。
- `deploy/dgx-autoremesher/` 中的 ARM64 编译补丁、Blender 回烘桥和独立服务。

**剩余风险**

- AutoRemesher 已在 DGX Spark AArch64 上完成编译和合成立方体 GLB 的端到端 API 冒烟测试；正式提交前仍需用真实角色 GLB 完成连续验收。
- 当前行业价值主要由产品流程说明支持；若要提高可信度，应补充单角色制作耗时、人工操作次数减少量和失败拦截案例。

### 2.2. 智能体融合与模型优化深度（25%）

**已有优势**

- 九种逻辑角色形成两级编排：`Coordinator` 管理工作空间和多任务，任务级 `Supervisor` 驱动状态机，七个专业 Agent 提交独立结构化报告。
- 专业角色拥有不同输入证据、JSON Schema、工具和禁止事项，不是把同一个系统提示词复制多次。
- 使用“确定性硬门禁 + 模型语义复核”：SDPose、背景像素和 glTF 结构解析不可被语言模型覆盖。
- `PromptPolicy` 会在模型审稿后补齐八类 T-Pose 约束；Qwen Image 工作流保留 Lightning 4-step LoRA，兼顾演示时延。
- 角色调用具备唯一源键、最大 turn、单次报告、持久化计划、失败暂停和重启收敛机制。

**本轮已修复**

- Agent 健康状态现在返回全部八个任务级角色，不再只显示 `Supervisor`、`Art Director` 和 `Visual QA`。
- 总调度委派不再永久修改任务 Agent 的 `request`／`auto` 权限设置。
- StepFun API 与 DGX Qwen Image 的完成事件分别记录真实来源，避免评审日志误报。
- Visual QA 报告增加自洽校验；当文字证据出现手持道具或非纯白背景时，结构化结论不能继续误判为通过。

**剩余风险**

- 尚无模型消融实验。建议固定三个角色样例，对比“无专业 Agent”“只有 Visual QA”“完整门禁链”的通过率、人工复核次数和错误拦截情况。
- 当前专业 Agent 默认仍调用 StepFun 云端模型；PRD 中规划的 NVIDIA Nemotron 本地复核尚未落地，不能作为已实现亮点提交。

### 2.3. 项目完整性（20%）

**已有优势**

- React/Vinext 前端、Node.js API、SQLite、Python 适配层、DGX 服务、审批、通知、会话、3D 查看器和部署文档形成完整闭环。
- 输入图片具有 MIME、魔数和尺寸校验；工作流具有结构和大小校验；产物路径必须位于 `output/`。
- Python 单元测试覆盖 StepFun 图片 API、T-Pose QA 和 AutoRemesher 客户端；Node 测试覆盖设置密钥隐藏、Agent 角色状态和 Visual QA 自洽校验。
- `npm test` 已统一执行 Node 测试、Python 测试和生产构建。

**本轮已优化**

- Three.js 3D 查看器改为按需加载，避免没有 3D 资产时也进入首屏主包。
- 工作区、任务和设置不再等待较慢的 DGX 系统探测，首屏先进入可操作状态，再异步补充显存和服务健康度。
- 修复 UI 将所有 2D 阶段固定标为 Qwen Image 的来源误导。
- 更新构建链及 `sharp`、`postcss` 等传递依赖，完整依赖审计达到 0 个已知漏洞。

**剩余风险**

- 需要在正式演示机器上连续执行至少三次完整流程，记录成功率、阶段耗时和失败恢复结果。
- SQLite 由 Node 22 的实验性 `node:sqlite` 提供；比赛环境必须固定 Node.js 版本，不应现场临时升级。

### 2.4. 平台适配性（15%）

**当前真实技术栈**

| 类别 | 实际使用 | 说明 |
| --- | --- | --- |
| NVIDIA 平台 | NVIDIA DGX Spark | 承载 ComfyUI GPU 工作流和 AutoRemesher 独立服务；AutoRemesher 本身主要使用 CPU |
| NVIDIA 软件栈 | DGX 环境中的 CUDA／PyTorch GPU 运行时，由 ComfyUI 和模型节点间接使用 | 仓库没有直接调用 TensorRT、NIM 或 CUDA SDK API，不应写成直接集成 |
| DGX 本地模型／流程 | Qwen Image、SDPose Wholebody、Pixal3D／TRELLIS2、SkinTokens | 这些是部署在 DGX 上的本地工作流，不代表它们都是 NVIDIA 官方模型 |
| StepFun Agent 模型 | 默认 `step-3.7-flash` | 用于 Coordinator、Supervisor 和七个专业角色的模型推理 |
| StepFun 图片模型 | 默认 `step-image-edit-2` | 用于文生图和图生图；文生图可切换到 DGX Qwen Image |
| 几何处理 | AutoRemesher + Blender | 通过 DGX Tailscale 私有网络中的独立 API 提供拓扑、UV 和基础色回烘 |

**本轮已优化**

- `/api/system` 现在透传 ComfyUI `system_stats` 中的真实设备、GPU／统一内存、队列和延迟信息。
- AutoRemesher `/healthz` 已纳入整条流水线健康度，未配置或离线时不再显示全部就绪。
- DGX Spark AArch64 的 Geogram x86 汇编误判已有自动补丁和恢复文档。

**剩余风险**

- 评分标准明确提到 NVIDIA 开源模型和 SDK。目前项目的 NVIDIA 优势主要来自 DGX Spark 本地算力与 CUDA／PyTorch 运行环境，没有直接接入 NVIDIA 模型。若时间允许，优先增加一个本地 Nemotron 视觉复核适配器，并保留 StepFun 为主审、Nemotron 为本地第二意见的差异化设计。
- 应保存一张 `/api/system` 或页面状态截图，证明设备名称、统一内存、工作流节点和队列确实来自 DGX Spark。

### 2.5. 演示效果（10%）

建议正式视频控制在 4–5 分钟：

1. 20 秒说明行业问题和最终交付物。
2. 40 秒展示总调度 Agent 从多角色需求创建工作空间、生成／分析合集图并拆分任务。
3. 90 秒展示单任务持续执行、审批、专业 Agent 活动和 SDPose 双重门禁。
4. 60 秒展示静态 GLB、自动拓扑、SkinTokens 骨骼以及最终 GLB 下载。
5. 40 秒展示 DGX 设备／统一内存、队列、工作流健康度和 StepFun／DGX 来源边界。
6. 30 秒总结结构化多 Agent、确定性门禁和云边协同价值。

正式录制前应准备固定成功样例和本地录屏备份，但不得把备份视频或旧产物描述成当前刚生成的结果。

### 2.6. 赛事征文（5%）

仓库中的 PRD、架构决策、ARM64 修复记录和真实链路基线已经能够组成文章素材。建议文章围绕以下主线：

1. 为什么数字角色生成不能停在“出一张图”。
2. 如何从单 Agent 改为结构化专业角色与确定性门禁。
3. StepFun 云端制作主管与 DGX Spark 本地资产工厂如何分工。
4. AutoRemesher 在 AArch64 上的 Geogram 汇编问题和修复过程。
5. 三个真实失败案例，以及系统如何暂停而不是伪装成功。

公开后把文章 URL、平台和发布日期补到本节。

## 3. 正式提交前的硬性门禁

- [ ] GitHub 仓库设为公开，并从未登录浏览器验证克隆和文档链接。
- [ ] 团队确认 MIT、Apache-2.0 或其他许可证，并添加根目录 `LICENSE`。
- [ ] 清理 Git 历史和当前分支中的 API Key、Token、SSH 私钥、数据库与生成隐私数据。
- [ ] 处理已经被 Git 跟踪的 17 个 `output/` 文件（约 64.28 MB）：只保留明确授权的精简演示证据，或迁移到发布附件；`.gitignore` 不会自动取消已跟踪文件。
- [ ] 在 DGX Spark 上完成 Qwen Image／SDPose／Pixal3D／AutoRemesher／SkinTokens 连续三次冒烟测试。
- [ ] 保存每个阶段的模型、工作流版本、耗时、输出路径和 DGX 设备指标。
- [ ] 录制并检查正式演示视频，上传后补充公开 URL。
- [ ] 准备团队合影。
- [ ] 发布赛事征文并补充 URL。
- [ ] 对照 README 从全新目录执行一次安装和启动，确认没有依赖开发者机器的绝对路径。
- [ ] 运行 `npm run lint`、`npm test`、`npm audit --omit=dev` 和 Python 语法检查。

## 4. 当前不能宣称的能力

- 可以宣称 AutoRemesher 已在 DGX Spark AArch64 上完成部署和合成 GLB 冒烟测试；在真实角色 GLB 连续验收完成前，不能宣称其已经通过生产角色资产验收。
- 不能宣称已经直接使用 NVIDIA NIM、TensorRT、Nemotron 或 OpenUSD；这些目前只存在于规划文档。
- 不能宣称所有数据都不离开内网；StepFun Agent 对话和 StepFun 图生图输入会发送到云端 API。
- 不能宣称 Asset Inspector 看过 3D 多视图或 Rigging QA 验证过动作形变；当前两者主要解释结构指标。
- 不能把“已配置 API Key”等同于外部图片 API 在线；正式演示前需要真实调用验证。
