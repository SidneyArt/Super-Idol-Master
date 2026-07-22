# DGX / ComfyUI 全链路对应关系

> 分类：部署与远程环境

更新日期：2026-07-22

## 1. 一一对应表

| 网站阶段 | 后端 Job | Python 脚本 | DGX 服务／工作流 | 成功证据 |
| --- | --- | --- | --- | --- |
| 2D | `2d` | `run_2d_generation.py` | `2D_Gen_QwenImage2512.json` / Qwen Image | 节点 60 PNG 已下载 |
| QA | `qa` | `run_tpose_qa.py` | SDPose Wholebody | 关键点 JSON、覆盖图、评分 |
| 3D | `3d` | `run_3d_generation.py` | `3D_Gen_Pixal3D.json` | 节点 308 静态 GLB 已下载 |
| TOPOLOGY | `topology` | `run_3d_retopology.py` | AutoRemesher HTTP 服务 | 四边面拓扑 GLB，纹理经 Blender 回烘 |
| RIG | `rig` | `run_3d_skinning.py` | `3D_Skin_SkinTokens.json` | 使用拓扑 GLB 作为输入，SkinTokens GLB 已下载 |
| OUT | 无推理 | Node 下载 API | 本机产物存储 | HTTP 字节数与本地文件一致 |

AutoRemesher 不运行在 ComfyUI 中，而是 DGX 上的独立 HTTP 服务。服务不要求 Bearer Token；Windows 可以通过 `http://100.120.236.113:8190` 在 Tailscale 私网中直连，也可以经 ECS SSH 隧道使用 `http://127.0.0.1:8190`。网站设置面板只需配置服务地址、目标四边面数和请求超时。

拓扑服务 `1.1.1` 会先在临时副本上清理并体素重建生成网格，再调用 AutoRemesher；默认使用体素分辨率 `256`、最多 150,000 个输入面和 `adaptivity=0.0`。原始 GLB 保留不变，并继续作为基础色纹理回烘来源。这样可以避免重复半边、孔洞和非流形高密度网格触发 AutoRemesher 原生堆损坏，同时让输出数量尽量接近请求的目标四边面数。

回烘完成后，服务按 60° 夹角写入平滑顶点法线，并保留边界与高角度硬边。前端三维预览直接使用 GLB 法线，不在浏览器中合并顶点，因此不会破坏智能 UV 产生的纹理接缝。

## 2. 自动 T-Pose 检查

DGX 已安装 `OpenposePreprocessor`，但缺少旧 OpenPose 的 `body_pose_model.pth`，且 DGX 不能直接连接 Hugging Face，首次调用会卡在下载。系统没有依赖这条不可用链路，而是复用 DGX 已存在的：

```text
/home/sidney/comfy/ComfyUI/models/checkpoints/sdpose_wholebody_fp16.safetensors
```

QA 图：

```text
LoadImage
  → CheckpointLoaderSimple(sdpose_wholebody_fp16.safetensors)
  → SDPoseKeypointExtractor
  ├→ SavePoseKpsAsJsonFile
  └→ SDPoseDrawKeypoints → PreviewImage
```

自动判定使用真实关键点，不是提示词匹配：

- 画面必须且只能有 1 个人。
- 鼻、颈、肩、肘、腕、髋、膝、踝置信度必须达到阈值。
- 双臂相对肩宽的最大垂直误差不超过 25%。
- 左右肘夹角都至少 150°。
- 肩线倾斜不超过 16%。
- 头、髋、踝顺序和覆盖率证明全身可见。
- 综合得分至少 80 分。

## 3. 2026-07-18 真实 E2E 证据

任务 ID：

```text
6251e426-c2a2-47c7-9a3c-4607555aba13
```

### QA

```text
Prompt: 2a4bb12f-2f32-4a35-b739-31acf492f681
Score: 94 / 100
minConfidence: 0.8447
armHorizontalError: 0.0712
rightElbowAngle: 172.75°
leftElbowAngle: 172.88°
bodyCoverage: 0.7261
```

### Pixal3D

```text
Prompt: 2bbe05b5-583a-45be-bae8-66ea66b88772
文件大小: 36,807,352 bytes
GLB: glTF 2.0
nodes: 1
meshes: 1
skins: 0
joints: 0
materials: 1
```

### SkinTokens

```text
Prompt: bc87f335-023d-4d2f-8f18-7074a532568b
文件大小: 45,726,624 bytes
GLB: glTF 2.0
nodes: 51
meshes: 1
skins: 1
joints: 49
materials: 1
```

静态模型无 skin/joints，绑骨模型有 1 个 skin 和 49 个 joints，证明 SkinTokens 产物不是静态 GLB 的重命名副本。

### 下载 API

```text
image  HTTP 200 / 1,458,068 bytes
model  HTTP 200 / 36,807,352 bytes
rigged HTTP 200 / 45,726,624 bytes
```

## 4. 故障边界

- DGX 或任何工作流依赖缺失：页面显示 `MISSING`，不应启动对应阶段。
- ComfyUI 队列被其他客户端占用：网站任务进入真实 pending，不能取消别人的任务。
- Node 后端重启：运行中的本地 Job 标记 failed；不会假定远程任务成功。
- 输出不在仓库 `output/`：后端拒绝登记。
- 3D 返回非 GLB、没有 mesh，或 GLB 文件头/JSON chunk/声明长度无效：后端拒绝推进。
- 自动拓扑服务返回非 GLB、没有 mesh 或超过大小上限：后端停留在拓扑阶段，保留原始静态 GLB。
- 绑骨只能读取 `topology_path`；缺少拓扑产物时，后端拒绝提交 SkinTokens。
- SkinTokens 目录没有 GLB，或 GLB 内没有 `skins` / `joints`：后端拒绝完成。
- QA 推理成功但姿态未通过：Job 可为 succeeded，但业务 `qa_status=failed`，流程停在 QA。
