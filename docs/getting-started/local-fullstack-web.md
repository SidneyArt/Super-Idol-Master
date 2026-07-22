# 本地全栈网站运行与维护

> 分类：上手与运行

更新日期：2026-07-21

## 1. 当前实现

Super-Idol-Master 现在是可实际运行的本地全栈系统：

- 前端：React 19 + Vinext，`http://localhost:3100`。
- 后端：Node.js HTTP API，`http://127.0.0.1:8787`。
- 数据库：Node 内置 SQLite，`web/data/super-idol-master.db`。
- DGX：Tailscale 地址 `http://100.120.236.113:8188`。
- 产物：只接受仓库 `output/` 下的真实文件，再由下载 API 交付。

前后端仅监听本机回环地址，不具备公网访问能力，也不会把管理接口暴露给局域网。

## 2. 启动

双击任一文件：

```text
D:\dgx比赛\Super-Idol-Master\启动本地网站.cmd
D:\dgx比赛\Super-Idol-Master\start-local.cmd
```

命令行方式：

```powershell
cd "D:\dgx比赛\Super-Idol-Master\web"
npm run local
```

验证：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
Invoke-RestMethod http://127.0.0.1:8787/api/system?force=1
```

运行日志：

```text
web/data/runtime-out.log
web/data/runtime-err.log
```

### 2.1 配置自动拓扑 API

在网站右上角打开“请求设置”，选择“拓扑 API”，即可配置服务地址、目标四边面数和请求超时。配置保存在本机 SQLite 中。

当前 DGX AutoRemesher 服务运行在受控的 Tailscale 私网中，不要求 Bearer Token。默认服务地址为 `http://100.120.236.113:8190`。

根据 Windows 的网络方式选择服务地址：

| 网络方式 | 拓扑 API 服务地址 |
| --- | --- |
| Windows 可以直接访问 DGX Tailscale | `http://100.120.236.113:8190` |
| 公司电脑通过 ECS SSH 隧道 | `http://127.0.0.1:8190` |

公司电脑不能运行 Tailscale 时，先在独立的 Windows PowerShell 窗口中建立转发并保持窗口运行：

```powershell
ssh -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -N -L 8190:100.120.236.113:8190 root@<ECS-PUBLIC-IP>
```

然后执行 `curl.exe --noproxy "*" --fail-with-body http://127.0.0.1:8190/healthz`。返回 `ready: true` 后，再把设置面板中的服务地址保存为 `http://127.0.0.1:8190`。

不要配置 Bearer Token。如果拓扑上传在 `uploading_glb` 阶段报告 Windows 错误 `10053`，同时 DGX 日志出现 `HTTP 401`，说明 DGX 仍在运行旧版鉴权服务，需要更新 API 服务；这不是普通的 SSH 隧道故障。

`web/.env.local` 中的 `TOPOLOGY_*` 变量仍可作为首次默认值。设置面板保存过的值优先于环境变量，因此日常切换 DGX 或其他兼容 API 时无需修改文件和重启后端。

## 3. 严格状态机

待处理阶段不可点击，已完成阶段可以通过受控 `revert` 操作回退。后端不提供任意 `PATCH stage` 或手工 QA 放行接口；回退只允许指向当前阶段之前的已完成阶段，并清除目标阶段及其下游产物引用。

```text
IDEA
  --确认设定--> 2D
  --Qwen Image 返回 PNG--> 2D / 待确认
  --用户确认--> QA
  --SDPose 检查通过--> QA / 待确认
  --用户确认--> 3D
  --Pixal3D 返回静态 GLB--> 3D / 待确认
  --用户确认--> TOPOLOGY
  --AutoRemesher 返回拓扑 GLB--> TOPOLOGY / 待确认
  --用户确认--> RIG
  --SkinTokens 返回带骨骼 GLB--> RIG / 待确认
  --用户确认--> OUT / completed
```

以上是页面按钮触发的手动路径。用户通过 Asset Agent 明确指定终点时，Supervisor 会创建持久化的 `agent_workflow_plans` 记录；每个异步 Job 完成后自动恢复编排，并在门禁通过后代替重复的阶段确认。自动路径不会绕过 SDPose、Visual QA、GLB mesh 或 skin / joints 检查。

失败行为：

- 2D 失败：停留在 2D，可重试。
- QA 未通过：停留在 QA，只能重新生成 2D 或重新检查。
- 3D 失败：停留在 3D，上游 PNG 保留。
- 拓扑失败：停留在 TOPOLOGY，原始静态 GLB 保留。
- 绑骨失败：停留在 RIG，原始静态 GLB 与拓扑 GLB 均保留。
- 页面点击阶段卡片不会解锁后续阶段。
- 手动路径中的生成或检查任务成功后停留在当前阶段；存在用户明确授权的持续执行计划时，后端完成事件可以自动推进到计划目标。
- 回退到 2D 会清除 PNG、QA、3D、TOPOLOGY 和 RIG 引用；回退到 QA 保留 PNG；回退到 3D 保留已通过 QA；回退到 TOPOLOGY 保留静态 GLB；回退到 RIG 保留静态 GLB 与拓扑 GLB。

## 4. API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/health` | API 和 SQLite 健康检查 |
| `GET` | `/api/system` | ComfyUI、队列、节点和模型依赖检查 |
| `GET` | `/api/runs` | 任务列表 |
| `POST` | `/api/runs` | 使用资产名称新建任务 |
| `GET` | `/api/runs/:id` | 任务、自动 QA 和事件详情 |
| `GET` | `/api/runs/:id/agent/messages` | 获取当前任务的 Agent 对话 |
| `POST` | `/api/runs/:id/agent/messages` | 向 Asset Agent 下达任务或持续执行目标 |
| `POST` | `/api/runs/:id/agent/cancel` | 取消当前 Agent 推理请求 |
| `POST` | `/api/runs/:id/start` | 保存正反提示词，确认角色设定并进入 2D |
| `POST` | `/api/runs/:id/generate-2d` | 执行 Qwen Image |
| `POST` | `/api/runs/:id/check-tpose` | 执行 SDPose 自动检查 |
| `POST` | `/api/runs/:id/generate-3d` | 执行 Pixal3D |
| `POST` | `/api/runs/:id/retopologize` | 调用 DGX AutoRemesher 服务并回烘纹理 |
| `POST` | `/api/runs/:id/rig` | 执行 SkinTokens |
| `POST` | `/api/runs/:id/advance` | 用户确认当前阶段完成并进入下一阶段 |
| `POST` | `/api/runs/:id/revert` | 回退到指定已完成阶段并清除下游产物引用 |
| `GET` | `/api/runs/:id/download/image` | 下载真实 PNG |
| `GET` | `/api/runs/:id/download/model` | 下载真实静态 GLB |
| `GET` | `/api/runs/:id/download/topology` | 下载真实拓扑 GLB |
| `GET` | `/api/runs/:id/download/rigged` | 下载真实绑骨 GLB |
| `POST` | `/api/runs/:id/reset` | 清除任务产物引用并回到 IDEA |
| `DELETE` | `/api/runs/:id` | 删除任务和事件 |
| `GET` | `/api/animations` | 获取本机 Mixamo 动画库 |
| `POST` | `/api/animations` | 导入并检查 Mixamo FBX 动画 |
| `GET` | `/api/animations/:id/file` | 读取动画 FBX 文件 |
| `DELETE` | `/api/animations/:id` | 删除动画记录和本地 FBX 文件 |

所有生成接口只运行仓库内固定 Python 脚本。用户提示词只作为脚本参数，不会作为 Shell 命令执行。

## 5. 数据库字段

`runs` 的关键字段：

| 字段 | 含义 |
| --- | --- |
| `current_stage` | 严格状态机的当前阶段 |
| `status` | `active` / `completed` / `failed` |
| `job_type` | `2d` / `qa` / `3d` / `topology` / `rig` / `none` |
| `generation_status` | 当前 DGX Job 状态；历史字段名，现用于所有工作流 |
| `generation_progress` | ComfyUI 实时事件计算的实际进度 |
| `generation_prompt_id` | ComfyUI 真正的 prompt ID |
| `generation_current_node` | 当前执行节点 |
| `image_path` | 本机真实 PNG 路径 |
| `model_path` | 本机真实静态 GLB 路径 |
| `topology_path` | 本机真实拓扑 GLB 路径；SkinTokens 的唯一模型输入 |
| `rigged_model_path` | 本机真实绑骨 GLB 路径 |
| `qa_status` | SDPose 业务判定 |
| `qa_score` | 自动检查得分 |
| `qa_metrics` | 关键点置信度、角度、水平误差等 JSON |
| `qa_overlay_path` | 姿态骨架覆盖图的 Web 路径 |

`run_events` 记录真实启动、成功、失败、用户阶段确认和清理事件。旧原型通过阶段卡片生成的任意推进记录已经从当前数据库清除。

## 6. 真实进度

Python 客户端提交工作流时携带唯一 `client_id`。Node 后端以同一 ID 连接 ComfyUI WebSocket，监听：

- `execution_start`
- `execution_cached`
- `executing`
- `executed`
- `progress`

百分比来自已完成节点数和节点内部 `value/max`。没有新事件时进度不会自行增长；Python 最终还会核对 `/history/:prompt_id` 并下载产物，完成后才写 100%。

## 7. 系统健康检查

`GET /api/system` 不只判断 8188 可达，还读取 `/object_info` 并逐一核对三个 JSON 工作流用到的节点。QA 额外检查：

- `SDPoseKeypointExtractor`
- `SDPoseDrawKeypoints`
- `SavePoseKpsAsJsonFile`
- `sdpose_wholebody_fp16.safetensors`

页面顶部四项必须显示：

```text
Qwen Image READY
SDPose READY
Pixal3D READY
SkinTokens READY
```

## 8. 构建验证

```powershell
cd "D:\dgx比赛\Super-Idol-Master\web"
npm run lint
npm run build

cd "D:\dgx比赛\Super-Idol-Master"
uv run --locked --project web/server/pipeline python -m compileall -q web/server/pipeline
```

Vinext 本地环境已关闭图片优化，避免缺少 Cloudflare `ASSETS/IMAGES` 绑定导致 `reading 'fetch'` 错误。

## 9. 分阶段资产预览

页面预览区与真实流程产物严格对应，不再用 2D 图片替代 3D 结果：

| 页面阶段 | 预览内容 |
| --- | --- |
| IDEA / 2D | Qwen Image 生成的本地 PNG |
| QA | SDPose 输出的关键点覆盖图 |
| 3D | `/download/model` 返回的真实静态 GLB |
| RIG / OUT | 优先使用 `/download/rigged` 返回的真实绑骨 GLB；绑骨尚未完成时暂看静态 GLB |

3D 预览基于 Three.js 和 GLTFLoader，直接读取后端保存的 GLB，支持：

- 左键旋转、滚轮缩放、右键平移；
- 材质 / 拓扑线框一键切换，线框按 GLB 中实际保存的三角面显示；
- 自动旋转开关和重置视角；
- 绑骨模型默认显示骨骼，可点击骨骼并使用旋转环临时摆姿态；
- Mixamo FBX 动画导入、骨骼重定向、播放、暂停、重播、时间轴、循环、速度和原地移动预览；
- 实时展示 Mesh、Bone、顶点和三角面数量；
- 模型加载中和加载失败的明确状态提示。

查看阶段卡片只改变展示内容，不会推进或回退数据库中的状态机。

### 9.1 导入并预览 Mixamo 动画

从 Mixamo 下载动画时，建议选择以下参数：

- `Format`：`FBX Binary`；
- `Skin`：`Without Skin`；
- `Frames per Second`：`30`；
- 原地行走或跑步动作：下载前开启 Mixamo 的 `In Place`；即使源动画带水平位移，查看器也会默认启用“原地移动”。

使用步骤：

1. 打开任意已绑定 GLB 的预览界面。
2. 点击胶片图标“Mixamo 动画预览”。
3. 点击“导入 FBX”，选择不超过 15 MB 的动画文件。
4. 系统解析动画并检查 Mixamo 核心骨骼。导入成功后，该动画会出现在所有工作空间和绑定角色的动画列表中。
5. 选择动画并点击“播放”。播放期间可暂停、拖动时间轴、调整速度，以及切换循环和原地移动。
6. 点击“恢复静态姿态”，回到模型原始绑定姿态并重新启用手动选骨功能。

动画库保存在 Windows 本地 `web/data/mixamo-animations/`，索引存放在 SQLite 的 `animation_assets` 表中。动画重定向和播放都在浏览器内完成，不调用 Mixamo 在线服务，不依赖 DGX，也不会把动作写回或导出到原始 GLB。删除动画时会同时删除 SQLite 记录和对应的本地 FBX 文件。
