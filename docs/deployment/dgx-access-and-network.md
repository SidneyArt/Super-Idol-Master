# DGX 环境与访问

> 分类：部署与远程环境

更新日期：2026-07-18

## 1. 网络结论

两台 DGX 当前通过 Tailscale 虚拟组网访问。`100.x` 地址位于 Tailscale 使用的 CGNAT 私网范围，不是可直接在公网路由的服务器地址。

因此：

- 当前电脑加入相同 Tailnet 且 ACL 放行后，可以访问 DGX。
- 公网用户不能直接通过 `100.x` 地址访问。
- ComfyUI 和 AutoRemesher API 建议继续保持 Tailscale 私有访问。
- 如将来需要域名，应使用 Cloudflare Tunnel、Tailscale Funnel 或独立反向代理，并增加身份验证；不要直接暴露 `8188`。

## 2. 第一台 DGX

- Tailscale IP：`100.120.236.113`
- 用户提供的 SSH 登录名：`Sidney`
- SSH：端口 `22`
- ComfyUI：端口 `8188`
- AutoRemesher API：端口 `8190`，无应用层 Token，仅允许受信任的 Tailnet 客户端访问
- 已知使用端口：`22`、`3000`、`8000`、`8188`、`8190`

Windows PowerShell 登录命令：

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519_dgx_spark" Sidney@100.120.236.113
```

ComfyUI：

```text
http://100.120.236.113:8188
```

AutoRemesher API：

```text
http://100.120.236.113:8190
```

SSH 用户名区分大小写。如果上述用户名失败，应让设备所有者在 DGX 上执行 `whoami` 后确认，不要反复猜测账户名。

## 3. 第二台 DGX

此前记录的 Tailscale IP：`100.113.24.119`。

已知访问方式是先进入第一台，再从第一台继续 SSH：

```bash
ssh sidney@100.113.24.119
```

第二台的用户名、密钥安装状态和服务端口仍需以设备上的实际配置为准。若希望 Windows 一条命令直连第二台，需要给第二台安装当前电脑的公钥，并配置 `ProxyJump` 或直接开放 Tailnet SSH 权限。

## 4. 当前电脑 SSH 密钥

本项目使用的专用公钥文件名：

```text
%USERPROFILE%\.ssh\id_ed25519_dgx_spark.pub
```

私钥文件名：

```text
%USERPROFILE%\.ssh\id_ed25519_dgx_spark
```

私钥不得发送给任何人、不得提交 Git。只需要让 DGX 所有者把 `.pub` 公钥内容加入目标用户的 `~/.ssh/authorized_keys`。

## 5. 已知排障记录

### 浏览器出现 502

`HTTP 502` 说明 Tailscale 网络路径通常已经到达目标，但目标端口后的服务未正常响应，常见原因：

- ComfyUI 尚未启动或刚重启。
- ComfyUI 只监听 `127.0.0.1`，没有监听 Tailscale 可达地址。
- 端口被代理、容器或服务管理器占用。
- 上游进程崩溃。

### 浏览器无法连接

优先检查：

```powershell
tailscale status
Test-NetConnection 100.120.236.113 -Port 8188
Test-NetConnection 100.120.236.113 -Port 22
```

### Python 可以 SSH，但请求异常

Windows 代理环境可能影响 HTTP 客户端。项目的 ComfyUI 客户端已经关闭环境代理继承；不要删除 `session.trust_env = False`，除非确认部署环境必须通过代理。

## 6. 不记录在文档中的信息

- SSH 私钥和私钥口令。
- DGX 登录密码。
- Tailscale 临时认证密钥。
- 网站或仓库的短期部署令牌。

