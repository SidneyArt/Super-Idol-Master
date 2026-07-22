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

### 2.1 当前确认可用的部署与调用方式

本项目当前采用以下边界：

| 位置 | 部署内容 | 地址 |
| --- | --- | --- |
| Windows | Super Idol Master 网站、Node.js 后端、SQLite 和生成结果 | `http://127.0.0.1:8787` |
| DGX Spark | AutoRemesher、Blender 和独立 Python HTTP 服务 | DGX TCP `8190` |
| ECS（公司电脑不能运行 Tailscale 时） | 只作为 SSH 转发跳板，不运行 AutoRemesher | 公网 SSH → DGX Tailscale 地址 |

AutoRemesher API 当前为**无应用层 Token**版本。安全边界由 Tailscale、SSH、Tailnet ACL 和防火墙提供，不应把 DGX 的 TCP `8190` 直接映射到公网。

调用地址取决于 Windows 到 DGX 的网络路径：

- Windows 已加入 DGX 所在的 Tailnet：使用 `http://100.120.236.113:8190`；
- 公司电脑不能使用 Tailscale：先建立 ECS SSH 隧道，再使用 `http://127.0.0.1:8190`。

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

首次上传时，远端目标目录应当不存在。如果 `~/autoremesher-api-installer` 已存在，`scp -r` 可能把文件放入嵌套的 `~/autoremesher-api-installer/dgx-autoremesher`；此时应改用一个新的目标目录名，并进入实际包含 `install.sh` 的目录。

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

### 5.2 已编译环境只更新 API 服务

如果 `/opt/autoremesher/autoremesher` 已存在且可以执行，不要重新编译。将最新版安装包上传到一个新的远端目录，然后使用 `--service-only`：

在 Windows PowerShell 中执行：

```powershell
scp -r .\deploy\dgx-autoremesher dgx:~/autoremesher-api-installer-update
ssh dgx
```

`~/autoremesher-api-installer-update` 也应使用尚不存在的新目录名。后续再次升级时，可以换成带日期或版本号的目录名，避免 `scp` 产生嵌套目录。

在 DGX Bash 中执行：

```bash
cd ~/autoremesher-api-installer-update
sudo bash install.sh --service-only
```

该命令会更新以下内容，但不会重新编译 AutoRemesher：

- `/opt/autoremesher-api/service.py`；
- `/opt/autoremesher-api/blender_bridge.py`；
- `/opt/autoremesher/run-headless`；
- `/etc/systemd/system/autoremesher-api.service`；
- systemd 服务状态。

安装脚本还会删除旧版 `/etc/autoremesher-api.env` 中遗留的 `TOPOLOGY_SERVICE_TOKEN`，并为旧环境补充安全的网格预处理默认值。当前服务不读取 Bearer Token。

如果只需要紧急替换 `service.py`，可以使用以下最小升级流程。

在 Windows PowerShell 中执行：

```powershell
scp .\deploy\dgx-autoremesher\service.py dgx:~/service.py.new
ssh dgx
```

在 DGX Bash 中执行：

```bash
sudo cp /opt/autoremesher-api/service.py /opt/autoremesher-api/service.py.bak
sudo install -o root -g root -m 0755 ~/service.py.new /opt/autoremesher-api/service.py
sudo sed -i '/^TOPOLOGY_SERVICE_TOKEN=/d' /etc/autoremesher-api.env
sudo systemctl restart autoremesher-api.service
sudo systemctl --no-pager --full status autoremesher-api.service
```

`service.py` 的备份只用于紧急回滚。日常升级优先使用 `install.sh --service-only`，以保证服务脚本、Blender 桥接和 systemd 单元保持同一版本。

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
TOPOLOGY_SMOOTH_SHADING_ANGLE=60.0
TOPOLOGY_PREPROCESS_MAX_FACES=150000
TOPOLOGY_PREPROCESS_MERGE_DISTANCE_RATIO=0.0000001
TOPOLOGY_PREPROCESS_VOXEL_RESOLUTION=256
TOPOLOGY_ADAPTIVITY=0.0
TOPOLOGY_WORK_ROOT=/var/tmp/autoremesher-api
AUTOREMESHER_BIN=/opt/autoremesher/run-headless
BLENDER_BIN=/usr/bin/blender
QT_QPA_PLATFORM=xcb
```

`TOPOLOGY_PREPROCESS_VOXEL_RESOLUTION` 控制临时网格的体素重建精度，默认值为 `256`。该步骤把重复半边、孔洞和非流形结构转换为较规则的临时表面，是规避原生崩溃的主要措施。设置为 `0` 会关闭体素重建，不建议用于未经验证的生成模型。

`TOPOLOGY_PREPROCESS_MAX_FACES` 只限制送入 AutoRemesher 的临时 OBJ，默认上限为 150,000。原始 GLB 不会被覆盖，纹理回烘仍读取原始 GLB。

`TOPOLOGY_PREPROCESS_MERGE_DISTANCE_RATIO` 按模型包围盒对角线计算近邻点合并阈值。默认值只用于清理几乎完全重合的顶点，不应将其当作减面强度参数。

`TOPOLOGY_ADAPTIVITY=0.0` 用于让输出数量尽量接近请求的目标四边面数。提高该值会生成更自适应、但通常更少的四边面。

`TOPOLOGY_SMOOTH_SHADING_ANGLE=60.0` 会为拓扑 GLB 写入平滑顶点法线，同时保留边界和超过 60° 的硬边。该设置不会改变 UV 或基础色纹理；设为 `0` 会让几乎所有边保持硬边，设为 `180` 会平滑所有内部边。

修改后重启：

```bash
sudo systemctl restart autoremesher-api
sudo systemctl --no-pager --full status autoremesher-api
```

## 7. 配置网络访问

建议通过 Tailscale 地址访问 DGX，并在 Tailnet ACL 或防火墙中只允许调用方的后端机器访问 TCP `8190`。

### 7.1 Windows 可以直接访问 Tailscale

从 Windows 调用方检查端口：

```powershell
Test-NetConnection 100.120.236.113 -Port 8190
Invoke-RestMethod http://100.120.236.113:8190/healthz
```

AutoRemesher API 默认不鉴权，只适合运行在受控的 Tailscale 私有网络中。不要把端口 `8190` 直接暴露到公网，并使用 Tailnet ACL 或防火墙只允许可信调用方访问。

### 7.2 公司电脑不能使用 Tailscale

如果 Windows 不能安装或运行 Tailscale，但已有一台同时能访问公网和 DGX Tailnet 的 ECS，可以通过 ECS 建立本地端口转发。此方案不会在 ECS 上部署 AutoRemesher。

在一个独立的 Windows PowerShell 窗口中执行，并保持该窗口运行：

```powershell
ssh `
  -o ServerAliveInterval=60 `
  -o ServerAliveCountMax=3 `
  -o ExitOnForwardFailure=yes `
  -N `
  -L 8190:100.120.236.113:8190 `
  root@<ECS-PUBLIC-IP>
```

单行形式：

```powershell
ssh -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -N -L 8190:100.120.236.113:8190 root@<ECS-PUBLIC-IP>
```

链路为：

```text
Windows 127.0.0.1:8190
  → ECS 公网 SSH
  → ECS 的 Tailscale 网络
  → DGX 100.120.236.113:8190
```

建立隧道后，在另一个 PowerShell 窗口中检查：

```powershell
curl.exe --noproxy "*" --fail-with-body http://127.0.0.1:8190/healthz
```

预期返回：

```json
{"ready": true, "architecture": "aarch64", "maxConcurrency": 1}
```

如果 `8190` 已被其他本机进程占用，应先查明占用者，不要叠加启动多个相同转发：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8190
```

SSH 窗口关闭、电脑休眠、公司网络切换或 ECS 到 DGX 的 Tailscale 链路中断，都会使拓扑请求失败。重新建立隧道后可以直接重试拓扑阶段，不需要重新生成静态 3D 模型。

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

`/healthz` 只能证明服务存活，不能单独证明旧版 Token 鉴权已经移除。升级后还应执行以下检查。

在 DGX Bash 中确认已安装服务不包含旧鉴权逻辑：

```bash
grep -nE 'Authorization|Bearer|401' /opt/autoremesher-api/service.py
grep -n '^TOPOLOGY_SERVICE_TOKEN=' /etc/autoremesher-api.env
```

两条命令都应当没有输出。

通过 Windows 调用地址发送一个故意无效的空文件请求：

```powershell
curl.exe --noproxy "*" -sS -o NUL -w "HTTP %{http_code}" `
  -X POST `
  -H "Content-Type: model/gltf-binary" `
  --data-binary "@NUL" `
  "http://127.0.0.1:8190/v1/remesh?target_quads=50000"
```

当前无 Token 服务应返回 `HTTP 413`，表示请求已经到达 `/v1/remesh`，但输入不是有效 GLB。如果返回 `HTTP 401`，说明 DGX 仍在运行旧版鉴权服务，应按“5.2 已编译环境只更新 API 服务”重新升级。

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

- 服务地址：根据网络路径选择下表中的地址；
- 目标四边面数：默认 `50,000`；
- 请求超时：默认 `3,600` 秒。

| Windows 网络方式 | 服务地址 |
| --- | --- |
| 可以直接访问 DGX Tailscale | `http://100.120.236.113:8190` |
| 通过 ECS SSH 隧道 | `http://127.0.0.1:8190` |

不要填写 Bearer Token。当前 DGX 服务没有应用层鉴权；如果其他兼容 API 要求鉴权，应由该 API 的接入适配单独处理，不能把旧版 DGX Token 配置混入当前流程。

配置保存在调用方的 SQLite 数据库中。服务地址可以替换为其他兼容 `/v1/remesh` 请求协议的 API。

也可以使用 `web/.env.local` 提供首次默认值：

```dotenv
TOPOLOGY_SERVICE_URL=http://127.0.0.1:8190
TOPOLOGY_TARGET_QUADS=50000
TOPOLOGY_TIMEOUT_SECONDS=3600
```

上例适用于 ECS SSH 隧道。Windows 能直接访问 Tailscale 时，把 `TOPOLOGY_SERVICE_URL` 改为 `http://100.120.236.113:8190`。

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

### 10.1 上传阶段出现 `ConnectionAbortedError 10053`

如果页面在 `progress=10 message=uploading_glb` 后报告 Windows 错误 `10053`，按以下顺序判断：

1. 在 Windows 执行 `curl.exe --noproxy "*" http://127.0.0.1:8190/healthz`，确认隧道仍然可用；
2. 在 DGX 执行 `sudo journalctl -u autoremesher-api -n 100 --no-pager`；
3. 如果日志中同一时间出现 `POST /v1/remesh ... 401`，根因不是普通断网，而是 DGX 仍在运行要求 Bearer Token 的旧版 `service.py`；
4. 按“5.2 已编译环境只更新 API 服务”升级，然后用空文件请求确认返回 `HTTP 413` 而不是 `HTTP 401`；
5. 如果没有 `401` 且健康检查失败，再重新建立 SSH 隧道并重试拓扑阶段。

旧版服务可能在客户端尚未上传完整个 GLB 时提前返回 `401` 并关闭连接，因此 Python `requests` 在 Windows 上看到的可能是 `ConnectionAbortedError 10053`，而不是直观的 `HTTP 401`。

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

### 10.2 Qt 样式文本后出现 `double free or corruption`

如果任务错误中出现 `QComboBox`、`QPushButton` 等样式文本，并在 DGX 日志中看到以下内容：

```text
double free or corruption (out)
Aborted (core dumped)
```

说明 AutoRemesher 原生进程在处理输入网格时发生堆损坏，不是 Token、SSH 隧道或 HTTP 地址错误。新版服务会过滤 Qt 样式噪声，并在临时副本上执行松散顶点清理、近邻点合并、法线重算、体素重建和受控预减面。

先确认服务已经升级：

```bash
curl --noproxy '*' --fail-with-body http://127.0.0.1:8190/healthz
grep '^TOPOLOGY_PREPROCESS_' /etc/autoremesher-api.env
```

健康检查响应中的 `version` 应至少为 `1.1.1`，`preprocessMaxFaces` 默认应为 `150000`，`preprocessVoxelResolution` 默认应为 `256`，`smoothShadingAngle` 默认应为 `60.0`。

如果真实模型在默认设置下仍然崩溃，可以把 `TOPOLOGY_PREPROCESS_VOXEL_RESOLUTION` 降到 `192`，重启服务后重试。不要覆盖原始 GLB，也不需要重新生成前面的 2D 和 3D 资产。

安装包中的回归脚本可以绕过 HTTP，在 DGX 上直接验证完整处理链：

```bash
cd ~/autoremesher-api-installer-update
bash regression-test.sh /path/to/character.glb 50000
```

服务升级后，使用正式 HTTP API 回归脚本验证上传、服务处理、下载和 GLB 结构：

```bash
bash api-regression-test.sh \
  http://127.0.0.1:8190 \
  /path/to/character.glb \
  50000 \
  /tmp/api-retopologized.glb
```

### 10.3 DGX Spark 实测记录

2026-07-22 已在 DGX Spark AArch64 环境完成以下验证：

- AutoRemesher 与 Geogram ARM64 补丁编译成功；
- `/opt/autoremesher/autoremesher` 和 `/usr/bin/blender` 均可执行；
- `autoremesher-api.service` 为 `enabled` 和 `active`；
- systemd 服务监听 `0.0.0.0:8190`，`/healthz` 返回 `ready: true`；
- 已安装 `service.py` 不包含 `Authorization`、`Bearer` 或 `401` 鉴权逻辑；
- `/etc/autoremesher-api.env` 不包含遗留的 `TOPOLOGY_SERVICE_TOKEN`；
- Windows 经 ECS SSH 隧道访问 `127.0.0.1:8190` 成功；
- 无效空请求返回 `HTTP 413` 而不是 `HTTP 401`，证明无 Token 的 `/v1/remesh` 路由已生效；
- 728 字节的合成立方体 GLB 以 `target_quads=1000` 调用成功，API 返回 `HTTP 200`；
- 输出为 69,020 字节的有效 GLB，Blender 复验得到 1,826 个顶点和 1,004 个面。

同日使用“美式卡通女忍者”的 38,256,380 字节 Pixal3D GLB 完成修复后回归：原始 696,639 面的临时网格经分辨率 `256` 的体素重建得到 64,424 面；AutoRemesher 在 12.658 秒内生成 40,589 个四边面和 729 个非四边面；回烘后的 8,769,252 字节 GLB 经 Blender 复验包含 1 个网格、165,520 个顶点、82,952 个三角面、1 个材质和 1 张图像。

服务升级到 `1.1.0` 后，同一真实 GLB 通过正式 `POST /v1/remesh?target_quads=50000` 得到 `HTTP 200`，API 回归脚本记录总耗时 23 秒、输出 8,769,252 字节，结构复验结果一致。服务完成后仍为 `active/running`，`NRestarts=0`；Windows 经 ECS SSH 隧道访问 `http://127.0.0.1:8190/healthz` 同样成功。

以上记录证明 ARM64 部署、API 基础链路和一次真实角色本机处理链可用，但不替代升级后 HTTP API 的连续验收。正式使用前仍应连续检查实际生成角色的拓扑质量、UV、基础色回烘和后续 SkinTokens 绑骨结果。

## 11. 限制说明

- AutoRemesher 主要使用 CPU，部署到 DGX Spark 并不会直接利用其 GPU；
- AutoRemesher CLI 只接收和输出 OBJ，因此 API 使用 Blender 完成 GLB 转换；
- 当前只回烘基础色纹理；GLB 会写入平滑顶点法线，但法线贴图、粗糙度贴图、金属度贴图和透明度贴图尚未回烘；
- glTF/GLB 不原生保存四边面，导出的 GLB 是由四边面拓扑拆分得到的三角面；
- 高密度输入默认先在临时副本上以分辨率 `256` 执行体素重建，并限制到最多 150,000 个面；该步骤用于提高原生 AutoRemesher 的稳定性，不会修改原始 GLB；
- 当前默认单并发，第二个同时到达的任务会收到 `HTTP 429`；
- 每个请求使用临时工作目录，响应结束后自动删除输入、中间文件和输出副本。

## 12. 验收清单

- [ ] DGX 上只有 AutoRemesher API，不依赖 Super Idol Master 进程；
- [ ] `autoremesher-api.service` 为 `active (running)`；
- [ ] DGX 本机 `/healthz` 返回 `ready: true`；
- [ ] 已安装服务和环境文件中没有旧版 Bearer Token 鉴权配置；
- [ ] 调用方能够直接访问 DGX 的 TCP `8190`，或通过 ECS SSH 隧道访问本机 `127.0.0.1:8190`；
- [ ] 无效空请求返回 `HTTP 413`，而不是 `HTTP 401`；
- [ ] TCP `8190` 仅能从受信任的 Tailnet 客户端访问；
- [ ] 真实 GLB 能够通过 API 生成有效的拓扑 GLB；
- [ ] 调用方能够把返回文件交给后续绑骨流程。
