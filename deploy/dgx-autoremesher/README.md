# AutoRemesher 独立 API 安装包

本目录是可以单独复制到 DGX Spark 的安装包，不需要在 DGX 上部署或运行 Super Idol Master。

安装后的调用关系如下：

```text
任意后端客户端
  → HTTP POST /v1/remesh
  → DGX Spark 上的 AutoRemesher API
  → Blender：GLB 转 OBJ
  → AutoRemesher：自动拓扑
  → Blender：重建 GLB、UV 和基础色纹理
  → HTTP 返回拓扑后的 GLB
```

## 最短部署流程

在保存本项目代码的 Windows 电脑中，只上传本目录：

> `scp` 命令在 Windows PowerShell 中执行，不要复制到 DGX Bash。PowerShell 提示符通常以 `PS` 开头，DGX Bash 提示符通常以 `sidney@spark-` 开头。

```powershell
scp -r .\deploy\dgx-autoremesher dgx:~/autoremesher-api-installer
ssh dgx
```

远端目标目录应当是一个尚不存在的新目录。如果同名目录已经存在，请更换目录名；否则 `scp -r` 可能产生一层额外的 `dgx-autoremesher` 子目录。

然后在 DGX Spark 中执行：

```bash
cd ~/autoremesher-api-installer
sudo bash install.sh
```

AutoRemesher 已经编译安装、只需更新 API 服务时，可以跳过依赖安装和重新编译：

```bash
sudo bash install.sh --service-only
```

`--service-only` 是已部署环境的推荐升级方式。它会更新 API、Blender 桥接和 systemd 单元，并删除旧版环境文件中遗留的 `TOPOLOGY_SERVICE_TOKEN`。当前服务不要求也不读取 Bearer Token。

新版服务会在临时副本上清理网格，以分辨率 `256` 执行体素重建，并把交给 AutoRemesher 的输入限制到最多 150,000 个面，以规避重复半边、孔洞和非流形高密度网格触发的原生内存崩溃。原始 GLB 不会被修改，纹理回烘仍以原始 GLB 为来源。

脚本会自行下载并编译上游 AutoRemesher、安装 Blender 和运行依赖，并启动 `autoremesher-api.service`。

DGX Spark 使用 AArch64。安装脚本会自动移除上游的 x86 编译参数，并修补内置 Geogram 1.8.3 将 Linux ARM64 误判为 x86、生成 `pause` 和 `lock` 汇编指令的问题。

如果旧版脚本已经因 `unknown mnemonic 'pause'` 失败，从 Windows PowerShell 上传新版 `install.sh` 和 `arm64-geogram.patch`，再在 DGX 中重新执行安装脚本即可；不需要清理已有编译目录。

检查服务：

```bash
curl --noproxy '*' --fail-with-body http://127.0.0.1:8190/healthz
sudo systemctl --no-pager --full status autoremesher-api
grep -nE 'Authorization|Bearer|401' /opt/autoremesher-api/service.py
grep -n '^TOPOLOGY_SERVICE_TOKEN=' /etc/autoremesher-api.env
```

最后两条 `grep` 命令应当没有输出。

健康检查中的 `version` 应至少为 `1.1.1`，`preprocessMaxFaces` 应为 `150000`，`preprocessVoxelResolution` 应为 `256`，`smoothShadingAngle` 应为 `60.0`。如需调整，在 `/etc/autoremesher-api.env` 中修改预处理或平滑着色参数后重启服务；不建议对未经验证的高密度生成模型关闭体素重建。

`1.1.1` 会在回烘和导出前写入平滑顶点法线，并保留边界与夹角超过 60° 的硬边。该处理不会修改 UV 或基础色纹理；三维预览器可以直接使用 GLB 自带法线，不需要在前端合并顶点。

## 真实模型回归

安装包提供了不修改 systemd 服务的回归脚本。升级前后都可以在 DGX 用户目录运行：

```bash
cd ~/autoremesher-api-installer
bash regression-test.sh /path/to/character.glb 50000
```

脚本依次验证 GLB 转 OBJ、临时网格预处理、AutoRemesher、纹理回烘和最终 GLB 文件头。成功时输出 `REGRESSION_OK`；失败产生的工作目录会保留，便于查看原生程序日志。

服务升级后，可以通过正式 HTTP API 运行同一类回归：

```bash
bash api-regression-test.sh \
  http://127.0.0.1:8190 \
  /path/to/character.glb \
  50000 \
  /tmp/api-retopologized.glb
```

成功时会输出 `API_REGRESSION_OK`，并使用已安装的 Blender 桥接复验响应中的网格、材质和图像。

## 调用地址

- Windows 可以直接访问 DGX Tailscale：配置 `http://100.120.236.113:8190`；
- 公司电脑不能使用 Tailscale：通过 ECS 建立 SSH 本地转发，再配置 `http://127.0.0.1:8190`。

SSH 隧道示例必须在 Windows PowerShell 中运行，并保持窗口打开：

```powershell
ssh -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -N -L 8190:100.120.236.113:8190 root@<ECS-PUBLIC-IP>
```

网站“请求设置 → 拓扑 API”中只填写服务地址、目标四边面数和超时时间，不配置 Bearer Token。

完整的网络配置、API 调用、更新和排障方法见 [DGX Spark AutoRemesher 独立 API 部署指南](../../docs/deployment/dgx-autoremesher-deployment.md)。

## API

```http
GET /healthz
POST /v1/remesh?target_quads=50000
Content-Type: model/gltf-binary
```

`POST /v1/remesh` 的请求体和成功响应体都是 GLB 文件。服务默认只执行一个并发任务；繁忙时返回 `HTTP 429`。

## 安全边界

服务默认不鉴权，只应在 Tailscale 等私有网络中使用。不要把端口 `8190` 直接暴露到公网；通过 Tailscale ACL 或防火墙只允许可信调用方访问。
