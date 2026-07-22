# DGX Spark AutoRemesher 独立 API 部署指南

> 分类：部署与远程环境  
> 更新日期：2026-07-22  
> 适用范围：将 DGX Spark 作为独立 AutoRemesher API 节点

## 1. 部署边界

DGX Spark 上只部署 AutoRemesher API，不部署 Super Idol Master，也不需要启动它的 Web、数据库、Agent、ComfyUI 工作流或其他流水线。

```text
Super Idol Master 或其他后端
  │  上传原始 GLB
  ▼
HTTP API：http://<DGX-IP>:8190/v1/remesh
  │
  ├─ Blender：GLB 转 OBJ
  ├─ AutoRemesher：自动拓扑
  └─ Blender：重建 GLB、UV 和基础色纹理
  │  返回拓扑后的 GLB
  ▼
调用方继续执行绑骨或其他流程
```

API 与调用方完全解耦。只要能够发送 HTTP 请求和接收二进制 GLB，任何后端都可以使用该服务。

## 2. 一条安装命令是否足够

下面的命令可以完成 DGX 本机上的编译、安装和 systemd 服务启动：

```bash
sudo bash install.sh
```

但执行它之前，必须先把本项目中的 `deploy/dgx-autoremesher` 目录单独上传到 DGX。执行后还需要允许调用方访问服务端口，并把 API 地址配置到调用方。

不需要把整个 Super Idol Master 仓库复制到 DGX。

## 3. 部署前提

DGX Spark 需要满足以下条件：

- 使用 Ubuntu 24.04 ARM64；
- 当前账户具有 `sudo` 权限；
- 可以访问 Ubuntu 软件源和 GitHub；
- 根分区至少保留约 10 GB 可用空间；
- TCP `8190` 未被其他进程占用。

检查命令：

```bash
uname -m
sudo -v
df -h /
ss -ltn 'sport = :8190'
```

## 4. 只上传独立安装包

在保存 Super Idol Master 源码的 Windows 电脑中，进入仓库根目录并执行：

> 以下命令只能在显示 `PS D:\...>` 的 Windows PowerShell 中执行，不能在显示 `sidney@spark-...$` 的 DGX Bash 中执行。如果 Bash 因反引号进入 `>` 等待状态，按 `Ctrl+C` 取消。

```powershell
scp -r .\deploy\dgx-autoremesher dgx:~/autoremesher-api-installer
ssh dgx
```

这里上传的只有 API 安装脚本、Python 服务、Blender 桥接脚本和 systemd 配置，不包含 Web 应用及其运行数据。

在 DGX 中确认文件完整：

```bash
cd ~/autoremesher-api-installer
ls -la
test -f install.sh
test -f service.py
test -f blender_bridge.py
test -f autoremesher-api.service
```

## 5. 在 DGX 中安装

```bash
cd ~/autoremesher-api-installer
sudo bash install.sh
```

安装脚本会自动执行以下操作：

1. 安装 Qt 5、TBB、Mesa、Xvfb、Blender 和 C++ 构建工具；
2. 从上游仓库下载固定版本的 AutoRemesher；
3. 移除上游不适用于 ARM64 的 `-march=x86-64-v2` 参数；
4. 修补内置 Geogram 1.8.3 将 Linux ARM64 误判为 x86、生成 `pause` 和 `lock` 汇编指令的问题；
5. 在 DGX Spark 上原生编译 AutoRemesher；
6. 安装独立 HTTP API 到 `/opt/autoremesher-api`；
7. 启用并启动 `autoremesher-api.service`；
8. 调用本机 `/healthz` 检查服务状态。

AutoRemesher 的源代码和二进制默认位于：

```text
/opt/autoremesher-src
/opt/autoremesher
```

API 服务文件位于：

```text
/opt/autoremesher-api
/etc/autoremesher-api.env
/etc/systemd/system/autoremesher-api.service
```

### 5.1 ARM64 汇编错误恢复

旧版安装包可能在最终链接阶段出现以下错误：

```text
unknown mnemonic `pause'
lto-wrapper failed
make: *** [autoremesher] 错误 1
```

这是内置 Geogram 1.8.3 将 Linux ARM64 误判为 x86 导致的。新版安装包已自动应用 `arm64-geogram.patch`。如果首次安装已经在此处失败，只需要从 Windows PowerShell 重新上传安装脚本和补丁：

```powershell
scp .\deploy\dgx-autoremesher\install.sh .\deploy\dgx-autoremesher\arm64-geogram.patch dgx:~/autoremesher-api-installer/
```

然后在 DGX Bash 中续编：

```bash
cd ~/autoremesher-api-installer
sudo bash install.sh
```

不需要删除 `/opt/autoremesher-src`。脚本会修补已有源码，并在现有编译结果上继续构建。

## 6. 配置监听地址

配置文件默认监听 `0.0.0.0:8190`。如需只绑定 DGX 的 Tailscale 地址，执行：

```bash
sudoedit /etc/autoremesher-api.env
```

示例：

```dotenv
TOPOLOGY_HOST=100.120.236.113
TOPOLOGY_PORT=8190
TOPOLOGY_MAX_CONCURRENCY=1
TOPOLOGY_JOB_TIMEOUT_SECONDS=3600
TOPOLOGY_TEXTURE_SIZE=2048
TOPOLOGY_WORK_ROOT=/var/tmp/autoremesher-api
AUTOREMESHER_BIN=/opt/autoremesher/run-headless
BLENDER_BIN=/usr/bin/blender
QT_QPA_PLATFORM=xcb
```

修改后重启：

```bash
sudo systemctl restart autoremesher-api
sudo systemctl --no-pager --full status autoremesher-api
```

## 7. 配置网络访问

建议通过 Tailscale 地址访问 DGX，并在 Tailnet ACL 或防火墙中只允许调用方的后端机器访问 TCP `8190`。

从 Windows 调用方检查端口：

```powershell
Test-NetConnection 100.120.236.113 -Port 8190
Invoke-RestMethod http://100.120.236.113:8190/healthz
```

AutoRemesher API 默认不鉴权，只适合运行在受控的 Tailscale 私有网络中。不要把端口 `8190` 直接暴露到公网，并使用 Tailnet ACL 或防火墙只允许可信调用方访问。

## 8. API 调用方法

### 8.1 健康检查

```http
GET /healthz
```

示例响应：

```json
{
  "ready": true,
  "architecture": "aarch64",
  "maxConcurrency": 1
}
```

### 8.2 自动拓扑

```http
POST /v1/remesh?target_quads=50000
Content-Type: model/gltf-binary
```

请求体是原始 GLB，成功响应体是拓扑后的 GLB。

在任意能够访问 DGX 的 Linux 客户端测试：

```bash
export AUTOREMESHER_API_URL=http://100.120.236.113:8190

curl --fail-with-body \
  -H "Content-Type: model/gltf-binary" \
  --data-binary @character.glb \
  "${AUTOREMESHER_API_URL}/v1/remesh?target_quads=50000" \
  --output character-retopologized.glb
```

主要状态码：

| 状态码 | 含义 |
| --- | --- |
| `200` | 成功，响应体为 GLB |
| `400` | 参数无效 |
| `413` | 输入文件为空或超过大小限制 |
| `429` | 当前拓扑 Worker 正忙 |
| `500` | Blender、AutoRemesher 或文件转换失败 |

`target_quads` 的允许范围为 `1,000` 到 `1,000,000`，默认值为 `50,000`。

## 9. Super Idol Master 作为调用方

这一节只配置运行 Super Idol Master 后端的机器，不在 DGX 上部署该项目。

推荐在网站右上角打开“请求设置”，进入“拓扑 API”页签，填写：

- 服务地址：`http://100.120.236.113:8190`；
- 目标四边面数：默认 `50000`；
- 请求超时：默认 `3600` 秒。

配置保存在调用方的 SQLite 数据库中。服务地址可以替换为其他兼容 `/v1/remesh` 请求协议的 API。

也可以使用 `web/.env.local` 提供首次默认值：

```dotenv
TOPOLOGY_SERVICE_URL=http://100.120.236.113:8190
TOPOLOGY_TARGET_QUADS=50000
TOPOLOGY_TIMEOUT_SECONDS=3600
```

设置面板保存值优先于环境变量；修改 `.env.local` 后需要重启 Node.js 后端。配置完成后，流程将变为：

```text
3D 模型生成
  → HTTP 调用 DGX AutoRemesher API
  → 保存返回的拓扑 GLB
  → 自动绑骨
```

DGX 不需要知道调用方的数据库、任务 ID 或后续绑骨实现，只负责接收 GLB 并返回处理结果。

## 10. 运行维护

查看状态和日志：

```bash
sudo systemctl status autoremesher-api
sudo journalctl -u autoremesher-api -n 200 --no-pager
sudo journalctl -u autoremesher-api -f
```

停止或重新启用：

```bash
sudo systemctl disable --now autoremesher-api
sudo systemctl enable --now autoremesher-api
```

更新本项目提供的 API 包时，只需重新上传目录并再次运行安装脚本：

```powershell
scp -r .\deploy\dgx-autoremesher dgx:~/autoremesher-api-installer-new
```

```bash
cd ~/autoremesher-api-installer-new
sudo bash install.sh
```

如果 AutoRemesher 已经编译成功，仅更新 API 服务、配置或 systemd 单元，可跳过依赖安装和重新编译：

```bash
sudo bash install.sh --service-only
```

已有的 `/etc/autoremesher-api.env` 会保留其他运行参数；旧版留下的 `TOPOLOGY_SERVICE_TOKEN` 会在升级时删除。

### 10.1 DGX Spark 实测记录

2026-07-22 已在 DGX Spark AArch64 环境完成以下验证：

- AutoRemesher 与 Geogram ARM64 补丁编译成功；
- systemd 服务监听 TCP `8190`，`/healthz` 返回 `ready: true`；
- 无 Token 版本能够在 Tailscale 私网中启动并响应；
- 728 字节的合成立方体 GLB 以 `target_quads=1000` 调用成功，API 返回 `HTTP 200`；
- 输出为 69,020 字节的有效 GLB，Blender 复验得到 1,826 个顶点和 1,004 个面。

以上记录证明 ARM64 部署和 API 处理链路可用，不替代真实角色资产验收。正式使用前仍应选取实际生成的角色 GLB，检查拓扑质量、UV、基础色回烘和后续 SkinTokens 绑骨结果。

## 11. 限制说明

- AutoRemesher 主要使用 CPU，部署到 DGX Spark 并不会直接利用其 GPU；
- AutoRemesher CLI 只接收和输出 OBJ，因此 API 使用 Blender 完成 GLB 转换；
- 当前只回烘基础色纹理，法线、粗糙度、金属度和透明度尚未回烘；
- glTF/GLB 不原生保存四边面，导出的 GLB 是由四边面拓扑拆分得到的三角面；
- 当前默认单并发，第二个同时到达的任务会收到 `HTTP 429`；
- 每个请求使用临时工作目录，响应结束后自动删除输入、中间文件和输出副本。

## 12. 验收清单

- [ ] DGX 上只有 AutoRemesher API，不依赖 Super Idol Master 进程；
- [ ] `autoremesher-api.service` 为 `active (running)`；
- [ ] DGX 本机 `/healthz` 返回 `ready: true`；
- [ ] 调用方能够访问 DGX 的 TCP `8190`；
- [ ] TCP `8190` 仅能从受信任的 Tailnet 客户端访问；
- [ ] 真实 GLB 能够通过 API 生成有效的拓扑 GLB；
- [ ] 调用方能够把返回文件交给后续绑骨流程。
