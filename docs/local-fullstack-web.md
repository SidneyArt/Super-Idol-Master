# 本地全栈网站运行与维护

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
  --用户确认--> RIG
  --SkinTokens 返回带骨骼 GLB--> RIG / 待确认
  --用户确认--> OUT / completed
```

以上是页面按钮触发的手动路径。用户通过 Asset Agent 明确指定终点时，Supervisor 会创建持久化的 `agent_workflow_plans` 记录；每个异步 Job 完成后自动恢复编排，并在门禁通过后代替重复的阶段确认。自动路径不会绕过 SDPose、Visual QA、GLB mesh 或 skin / joints 检查。

失败行为：

- 2D 失败：停留在 2D，可重试。
- QA 未通过：停留在 QA，只能重新生成 2D 或重新检查。
- 3D 失败：停留在 3D，上游 PNG 保留。
- 绑骨失败：停留在 RIG，静态 GLB 保留。
- 页面点击阶段卡片不会解锁后续阶段。
- 手动路径中的生成或检查任务成功后停留在当前阶段；存在用户明确授权的持续执行计划时，后端完成事件可以自动推进到计划目标。
- 回退到 2D 会清除 PNG、QA 和 3D/RIG 引用；回退到 QA 保留 PNG；回退到 3D 保留已通过 QA；回退到 RIG 保留静态 GLB。

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
| `POST` | `/api/runs/:id/rig` | 执行 SkinTokens |
| `POST` | `/api/runs/:id/advance` | 用户确认当前阶段完成并进入下一阶段 |
| `POST` | `/api/runs/:id/revert` | 回退到指定已完成阶段并清除下游产物引用 |
| `GET` | `/api/runs/:id/download/image` | 下载真实 PNG |
| `GET` | `/api/runs/:id/download/model` | 下载真实静态 GLB |
| `GET` | `/api/runs/:id/download/rigged` | 下载真实绑骨 GLB |
| `POST` | `/api/runs/:id/reset` | 清除任务产物引用并回到 IDEA |
| `DELETE` | `/api/runs/:id` | 删除任务和事件 |

所有生成接口只运行仓库内固定 Python 脚本。用户提示词只作为脚本参数，不会作为 Shell 命令执行。

## 5. 数据库字段

`runs` 的关键字段：

| 字段 | 含义 |
| --- | --- |
| `current_stage` | 严格状态机的当前阶段 |
| `status` | `active` / `completed` / `failed` |
| `job_type` | `2d` / `qa` / `3d` / `rig` / `none` |
| `generation_status` | 当前 DGX Job 状态；历史字段名，现用于所有工作流 |
| `generation_progress` | ComfyUI 实时事件计算的实际进度 |
| `generation_prompt_id` | ComfyUI 真正的 prompt ID |
| `generation_current_node` | 当前执行节点 |
| `image_path` | 本机真实 PNG 路径 |
| `model_path` | 本机真实静态 GLB 路径 |
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
python -m py_compile scripts\comfy_workflow\*.py
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
- 绑骨模型的骨骼显示开关；
- 实时展示 Mesh、Bone、顶点和三角面数量；
- 模型加载中和加载失败的明确状态提示。

查看阶段卡片只改变展示内容，不会推进或回退数据库中的状态机。
