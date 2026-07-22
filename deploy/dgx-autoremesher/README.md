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

然后在 DGX Spark 中执行：

```bash
cd ~/autoremesher-api-installer
sudo bash install.sh
```

AutoRemesher 已经编译安装、只需更新 API 服务时，可以跳过依赖安装和重新编译：

```bash
sudo bash install.sh --service-only
```

脚本会自行下载并编译上游 AutoRemesher、安装 Blender 和运行依赖，并启动 `autoremesher-api.service`。

DGX Spark 使用 AArch64。安装脚本会自动移除上游的 x86 编译参数，并修补内置 Geogram 1.8.3 将 Linux ARM64 误判为 x86、生成 `pause` 和 `lock` 汇编指令的问题。

如果旧版脚本已经因 `unknown mnemonic 'pause'` 失败，从 Windows PowerShell 上传新版 `install.sh` 和 `arm64-geogram.patch`，再在 DGX 中重新执行安装脚本即可；不需要清理已有编译目录。

检查服务：

```bash
curl http://127.0.0.1:8190/healthz
sudo systemctl status autoremesher-api
```

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
