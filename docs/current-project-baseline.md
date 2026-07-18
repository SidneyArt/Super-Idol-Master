# 当前工程基线与运行信息

更新日期：2026-07-18

## 1. 仓库与目录

- 正确仓库：`https://github.com/SidneyArt/Super-Idol-Master.git`
- Windows 工作目录：`D:\dgx比赛\Super-Idol-Master`
- 本地流程网站：`D:\dgx比赛\Super-Idol-Master\web`
- Python 流水线：`D:\dgx比赛\Super-Idol-Master\scripts\comfy_workflow`
- 生成结果：`D:\dgx比赛\Super-Idol-Master\output`

此前误认过 `OmniEcho`，也误克隆过其他仓库；后续工作只以 `Super-Idol-Master` 为准。

## 2. 已实现的生成流水线

| 阶段 | 脚本 | 工作流 | 主要产物 |
| --- | --- | --- | --- |
| 2D 概念图 | `run_2d_generation.py` | `2D_Gen_QwenImage2512.json` | PNG |
| 图片转 3D | `run_3d_generation.py` | `3D_Gen_Pixal3D.json` | GLB、纹理、预览 |
| 自动绑骨 | `run_3d_skinning.py` | `3D_Skin_SkinTokens.json` | 带骨骼 GLB |
| 全流程编排 | `run_comfy_workflows.py` | 依次调用以上三项 | 完整角色资产 |

默认 ComfyUI 地址：`http://100.120.236.113:8188`

客户端已设置 `requests.Session.trust_env = False`，用于避免 Windows 环境代理错误接管 Tailscale 私网请求。

## 3. 已验证的真实结果

2D 生成已经成功。最近一次确认的产物：

```text
output\2d\20260718-182703_375fd754-86f3-496e-bcf1-2e2eb22a27ce\
node-60_01_Qwen-Image-2512_00048_.png
```

该图片能够证明 2D 工作流和远程 ComfyUI 调用正常，但人物手臂下垂，不满足严格 T-Pose。进入 3D 重建前应重新生成“双臂水平展开、全身完整、正视图、白色背景”的版本。

## 4. 当前产品流程

```text
角色描述
  → 2D 概念图
  → T-Pose 质量检查
  → 3D 模型生成
  → SkinTokens 自动绑骨
  → GLB 导出与验证
```

T-Pose 检查是显式质量门，未通过时不应自动推进到 3D。

## 5. 本地网站现状与改造目标

`web/` 已有一个流程可视化前端，展示六个生产阶段和最近一次 2D 图片。当前状态原本只是浏览器内演示，不具备真实持久化。

本轮改造目标：

- 前端可创建、选择、推进、重置和删除角色任务。
- 后端提供任务 CRUD、阶段推进、系统健康检查 API。
- 2D 阶段可由网页后端实际调用 Python/ComfyUI 工作流，完成后自动进入 QA。
- SQLite 持久化任务、阶段状态和操作时间。
- 使用 Windows CMD 脚本一键启动前端、后端并打开浏览器。
- 默认只监听本机回环地址，不把管理服务暴露到公网。

## 6. 安全边界

- 不把 ComfyUI `8188` 直接开放到公网。
- SSH 私钥只保存在用户目录 `.ssh`，不复制进项目。
- 本地网站默认访问范围是当前电脑；如需局域网或 Tailscale 共享，要单独调整监听地址和防火墙。
- 后端不得执行任意用户输入的 Shell 命令；真正接入 Python 生成脚本时使用固定命令模板和参数白名单。
