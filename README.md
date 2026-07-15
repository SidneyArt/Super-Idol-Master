# Super-Idol-Master 数字偶像管家

## ComfyUI 工作流调用

脚本按 workflow 分开维护，共享 HTTP 客户端，总脚本只负责编排：

```text
scripts/comfy_workflow/
├── comfy_client.py             # 上传、提交、轮询、下载和 output 边界
├── run_2d_generation.py        # 2D_Gen_QwenImage2512.json
├── run_3d_generation.py        # 3D_Gen_Pixal3D.json
├── run_3d_skinning.py          # 3D_Skin_SkinTokens.json
└── run_comfy_workflows.py      # 2D -> 3D -> 蒙皮总流程
```

默认连接：

```text
http://100.120.236.113:8188
```

如果实际端口不是 ComfyUI 默认的 `8188`，可通过每个命令的 `--comfyui-url` 参数或 `COMFYUI_URL` 环境变量修改。

安装依赖：

```bash
python -m pip install -r scripts/comfy_workflow/requirements.txt
```

### 生成 2D 图片

脚本把正向提示词注入节点 `268`，反向提示词注入节点 `269`，随机种子注入节点 `282`：

```bash
python scripts/comfy_workflow/run_2d_generation.py \
  --positive "美式3d卡通，严格的T-Pose，全身出镜，纯白背景" \
  --negative "低分辨率，肢体畸形，画面过饱和"
```

### 从图片生成 3D 资源

脚本先通过 `/upload/image` 上传图片，再将返回的 ComfyUI 文件名注入节点 `122`；节点 `309` 和 `313` 使用本次运行的随机种子：

```bash
python scripts/comfy_workflow/run_3d_generation.py path/to/character.png
```

### 给 3D 模型蒙皮

蒙皮脚本只注入节点 `23.inputs.mesh_path`。可传 ComfyUI 服务器上的绝对路径：

```bash
python scripts/comfy_workflow/run_3d_skinning.py \
  /home/sidney/comfy/ComfyUI/output/3d/pixal3d_00018_.glb
```

也可以传本地 GLB；脚本会先上传到 ComfyUI，再生成服务器侧绝对路径：

```bash
python scripts/comfy_workflow/run_3d_skinning.py path/to/model.glb
```

导出的节点 `27/28/29` 是一个与蒙皮生成无关、指向旧模型的预览分支。提交时会删除这个分支，避免旧路径影响单输入的蒙皮任务。

### 运行完整流程

总脚本依次运行 2D、3D 和 SkinTokens 蒙皮。3D 节点 `308` 返回的服务器 GLB 路径会直接注入蒙皮节点 `23`：

```bash
python scripts/comfy_workflow/run_comfy_workflows.py \
  --positive "美式3d卡通，严格的T-Pose，全身出镜，纯白背景" \
  --negative "低分辨率，肢体畸形，画面过饱和"
```

可用 `--seed 1234` 固定随机种子，用 `--timeout 3600` 调整每个工作流的最长等待时间。

### 输出目录

所有本地写入都限制在项目的 `output/` 目录：

```text
output/
├── 2d/<时间>_<prompt_id>/
│   ├── submitted_workflow.json
│   ├── history.json
│   └── node-60_*.png
├── 3d/<时间>_<prompt_id>/
    ├── submitted_workflow.json
    ├── history.json
    ├── *.glb
    └── 其他由 history 返回的预览或纹理资源
└── skin/<时间>_<prompt_id>/
    ├── submitted_workflow.json
    ├── history.json
    └── SkinTokens 返回的蒙皮模型和预览资源
```

调用过程与 workshop helper 一致：提交 `/api/prompt` 获得 `prompt_id`，轮询 `/api/history/<prompt_id>`，完成后使用 `/api/view` 下载远端生成资源。脚本同时兼容没有 `/api` 前缀的标准 ComfyUI 路由。
