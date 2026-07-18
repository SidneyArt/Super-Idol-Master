# 本地全栈网站实施方案

更新日期：2026-07-18

## 1. 目标

在 Windows 当前电脑上运行一个完整的 Super-Idol-Master 管理网站，包含：

- React/Vinext 前端。
- 独立 Node.js HTTP API 后端。
- SQLite 本地数据库。
- 双击 `启动本地网站.cmd` 即可启动。
- 浏览器访问 `http://localhost:3100`。

用户已明确要求本地运行，因此本轮不进行公网部署。

## 2. SQLite 选择理由

- 单文件数据库，不需要安装 MySQL、PostgreSQL 或 Docker。
- 适合单机比赛 Demo 和少量任务记录。
- 支持事务、索引和结构化查询，比浏览器 LocalStorage 更可靠。
- 数据文件可直接备份，迁移到服务端数据库时也容易导出。

数据库计划位置：

```text
web\data\super-idol-master.db
```

该文件是运行数据，不提交 Git。

## 3. 进程结构

```text
浏览器 http://localhost:3100
          │
          ├── Vinext 前端（3100）
          │       │
          │       └── HTTP JSON 请求
          │
          └── Node API（8787）
                  │
                  ├── SQLite 数据库
                  └── DGX / ComfyUI 健康检查
```

前端和后端都只监听 `127.0.0.1`。后端通过允许列表处理跨端口请求，仅允许本地前端来源。

## 4. 数据模型

首版使用两张表：

### `runs`

| 字段 | 用途 |
| --- | --- |
| `id` | 任务唯一 ID |
| `name` | 角色任务名称 |
| `positive_prompt` | 正向提示词 |
| `negative_prompt` | 反向提示词 |
| `current_stage` | 当前阶段，0～5 |
| `status` | `active`、`completed`、`failed` |
| `qa_status` | `pending`、`passed`、`failed`；控制是否允许进入 3D |
| `generation_status` | `idle`、`running`、`succeeded`、`failed` |
| `generation_message` | 2D 生成进度或错误信息 |
| `preview_path` | 最近预览图路径或 URL |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

### `run_events`

| 字段 | 用途 |
| --- | --- |
| `id` | 自增 ID |
| `run_id` | 对应任务 |
| `event_type` | 创建、推进、重置、失败等 |
| `stage` | 事件发生阶段 |
| `message` | 人类可读说明 |
| `created_at` | 发生时间 |

## 5. API 契约

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 后端和数据库健康检查 |
| `GET` | `/api/system` | 检查 ComfyUI 是否可达 |
| `GET` | `/api/runs` | 查询任务列表 |
| `POST` | `/api/runs` | 新建任务 |
| `GET` | `/api/runs/:id` | 查询任务和事件 |
| `PATCH` | `/api/runs/:id/stage` | 推进或回退任务阶段 |
| `PATCH` | `/api/runs/:id/qa` | 保存 T-Pose 通过/未通过判定 |
| `POST` | `/api/runs/:id/regenerate` | 检查未通过后返回 2D 阶段 |
| `POST` | `/api/runs/:id/generate-2d` | 调用 DGX 工作流重新生成 2D 图片 |
| `POST` | `/api/runs/:id/reset` | 重置到第一阶段 |
| `DELETE` | `/api/runs/:id` | 删除任务及事件 |

所有写入 API 都校验输入；阶段只能是 `0` 到 `5`。`qa_status` 不是 `passed` 时，后端拒绝进入阶段 3 及之后的流程。

## 6. 启动约定

根启动脚本（两个入口功能相同）：

```text
D:\dgx比赛\Super-Idol-Master\启动本地网站.cmd
D:\dgx比赛\Super-Idol-Master\start-local.cmd
```

脚本职责：

1. 检查 Node.js 和 npm。
2. 缺少依赖时自动执行安装。
3. 创建 `web\data`。
4. 同时启动前端和后端。
5. 服务就绪后打开默认浏览器。
6. 用户按 `Ctrl+C` 时关闭两个服务。

## 7. 当前执行边界

2D 生成按钮已经接入固定的 Python 工作流 `run_2d_generation.py`。后端只允许使用数据库中的正向/负向提示词调用这一固定脚本，生成结果必须位于项目 `output/`，然后复制到网站预览目录。流程闭环如下：

```text
QA 未通过
  → 返回 2D
  → 点击重新生成
  → 后端调用 DGX / ComfyUI
  → 生成中锁定阶段切换
  → 新图片保存成功
  → 自动进入待 QA 状态
  → QA 通过后解锁 3D
```

3D 和绑骨按钮尚未接入执行队列。继续接入时需要增加：

- 固定参数白名单。
- 长任务队列和取消机制。
- 日志与进度推送。
- 输出文件路径校验。
- 对 3D、绑骨高成本动作的显式确认。

该边界可保证网站先稳定可用，同时避免在比赛机器上执行未经约束的远程命令。

## 8. 本地图片兼容说明

Vinext 本地运行时没有 Cloudflare 的 `ASSETS` 和 `IMAGES` 绑定。项目已关闭本地图片优化，预览图直接从 `public/` 提供。

如果更新前已经打开过网站，并看到 `Cannot read properties of undefined (reading 'fetch')`：

1. 在启动窗口按 `Ctrl+C`，或直接关闭该窗口。
2. 重新双击 `启动本地网站.cmd`。
3. 浏览器按 `Ctrl+F5` 强制刷新。

该问题只影响旧版图片优化请求，不影响 SQLite 数据。
