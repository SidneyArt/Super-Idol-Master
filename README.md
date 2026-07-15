# Super-Idol-Master 数字偶像管家

## ComfyUI 工作流调用

调用脚本位于 `scripts/comfy_workflow/run_comfy_workflows.py`，默认连接：

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
python scripts/comfy_workflow/run_comfy_workflows.py 2d \
  --positive "美式3d卡通，严格的T-Pose，全身出镜，纯白背景" \
  --negative "低分辨率，肢体畸形，画面过饱和"
```

### 从图片生成 3D 资源

脚本先通过 `/upload/image` 上传图片，再将返回的 ComfyUI 文件名注入节点 `122`；节点 `309` 和 `313` 使用本次运行的随机种子：

```bash
python scripts/comfy_workflow/run_comfy_workflows.py 3d path/to/character.png
```

### 连续运行 2D 和 3D

`pipeline` 会先运行 2D 工作流，再把生成图片自动传给 3D 工作流：

```bash
python scripts/comfy_workflow/run_comfy_workflows.py pipeline \
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
└── 3d/<时间>_<prompt_id>/
    ├── submitted_workflow.json
    ├── history.json
    ├── *.glb
    └── 其他由 history 返回的预览或纹理资源
```

调用过程与 workshop helper 一致：提交 `/api/prompt` 获得 `prompt_id`，轮询 `/api/history/<prompt_id>`，完成后使用 `/api/view` 下载远端生成资源。脚本同时兼容没有 `/api` 前缀的标准 ComfyUI 路由。
