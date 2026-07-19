# Super Idol Master 本地控制台

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

需要 Node.js 22.13 或更高版本。首次启动会安装依赖。

## 地址

- 前端：`http://localhost:3100`
- API 健康检查：`http://127.0.0.1:8787/api/health`
- 默认 DGX / ComfyUI：`http://100.120.236.113:8188`

访问 DGX 前，需要当前电脑已加入相同的 Tailscale 虚拟网络并获得对应访问权限。

## 主要功能

- IDEA → 2D → 自动 T-Pose QA → 3D → 自动绑骨 → 导出的严格状态机；
- 调用 DGX 上真实的 Qwen Image、SDPose、Pixal3D 和 SkinTokens 工作流；
- ComfyUI WebSocket 真实进度与任务事件记录；
- 静态和绑骨 GLB 的交互式 3D 预览；
- 材质、拓扑线框、骨骼显示、自动旋转和视角控制；
- SQLite 持久化任务、产物路径和执行历史。

## 不进入 Git 的本机内容

- `node_modules/` 和构建目录；
- `data/` 中的 SQLite 数据库和运行日志；
- `public/generated/` 中的任务预览图片；
- 本地环境变量和 DGX 生成产物。

完整运行说明见主仓库的 `docs/local-fullstack-web.md`。
