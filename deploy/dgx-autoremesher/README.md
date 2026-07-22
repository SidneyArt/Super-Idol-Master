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

```powershell
scp -r .\deploy\dgx-autoremesher dgx:~/autoremesher-api-installer
ssh dgx
```

然后在 DGX Spark 中执行：

```bash
cd ~/autoremesher-api-installer
sudo bash install.sh
```

脚本会自行下载并编译上游 AutoRemesher、安装 Blender 和运行依赖、生成 API Token，并启动 `autoremesher-api.service`。

查看 Token：

```bash
sudo grep '^TOPOLOGY_SERVICE_TOKEN=' /etc/autoremesher-api.env
```

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
Authorization: Bearer <token>
Content-Type: model/gltf-binary
```

`POST /v1/remesh` 的请求体和成功响应体都是 GLB 文件。服务默认只执行一个并发任务；繁忙时返回 `HTTP 429`。

## 安全边界

不要把端口 `8190` 无保护地暴露到公网。建议使用 Tailscale ACL、云防火墙或反向代理，只允许可信后端访问，并始终携带 Bearer Token。
