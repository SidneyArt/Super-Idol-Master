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
| 自动 T-Pose QA | `run_tpose_qa.py` | DGX SDPose Wholebody | 关键点 JSON、覆盖图、评分 |
| 图片转 3D | `run_3d_generation.py` | `3D_Gen_Pixal3D.json` | GLB、纹理、预览 |
| 自动绑骨 | `run_3d_skinning.py` | `3D_Skin_SkinTokens.json` | 带骨骼 GLB |
| 全流程编排 | `run_comfy_workflows.py` | 依次调用以上三项 | 完整角色资产 |

默认 ComfyUI 地址：`http://100.120.236.113:8188`

客户端已设置 `requests.Session.trust_env = False`，用于避免 Windows 环境代理错误接管 Tailscale 私网请求。

## 3. 已验证的真实结果

本地网站的 Qwen → SDPose → Pixal3D → SkinTokens 全链路已经真实跑通。固定验证任务：

```text
run_id: 6251e426-c2a2-47c7-9a3c-4607555aba13
SDPose: 94 分，Prompt 2a4bb12f-2f32-4a35-b739-31acf492f681
Pixal3D: 36,807,352 bytes，Prompt 2bbe05b5-583a-45be-bae8-66ea66b88772
SkinTokens: 45,726,624 bytes，1 skin / 49 joints，Prompt bc87f335-023d-4d2f-8f18-7074a532568b
```

完整证据见 `docs/dgx-pipeline-integration.md`。

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

`web/` 已是完整本地全栈系统，不再是浏览器内演示。当前能力：

- 前端可创建、选择、重置和删除角色任务；阶段卡片只能查看。
- 后端以严格状态机控制流程，不提供手工阶段跳转和手工 QA 放行。
- Qwen 2D 完成后自动调用 DGX SDPose；QA 通过才允许 Pixal3D。
- Pixal3D 和 SkinTokens 均由网站实际提交，下载并登记真实 GLB。
- SQLite 持久化任务、阶段状态和操作时间。
- 使用 Windows CMD 脚本一键启动前端、后端并打开浏览器。
- 默认只监听本机回环地址，不把管理服务暴露到公网。

## 6. 安全边界

- 不把 ComfyUI `8188` 直接开放到公网。
- SSH 私钥只保存在用户目录 `.ssh`，不复制进项目。
- 本地网站默认访问范围是当前电脑；如需局域网或 Tailscale 共享，要单独调整监听地址和防火墙。
- 后端不得执行任意用户输入的 Shell 命令；真正接入 Python 生成脚本时使用固定命令模板和参数白名单。
