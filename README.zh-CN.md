# dsh-3301

> 曾用名 `dsh-proxy`；项目与包名现统一为 `dsh-3301`。

## 把你的 DeepSeek Harness（DSH）端口代理到 `http://<本机IP>:3301`，并额外施加安全协议，让你内网可以任何时候访问 DSH（包括手机）。

> ~~⚠️ **仅适用于 DSH 1.1。** DeepSeek Harness **1.2** 加入了**本地 token 验证**，会破坏这种反向代理方式（代理无法再透传访问界面）。本项目面向 DSH **1.1**。若你用的是 1.2+，需要别的访问方式。~~
>
> ✅ **已更新：** 这个限制已经解决。本项目同时以 **DSH 插件**形式提供（身份 `dsh-3301`），在
> 当前 DSH 上可用 —— 见下方[插件形态](#插件形态dsh-3301)。独立代理形态继续保留。

[English](./README.md) · **中文**

在 [DSH](https://github.com/deepseek-ai/dsh) Web GUI 前面的**带密码反向代理**（HTTP + WebSocket）；也可作为 DSH **插件**（`dsh-3301`）运行，插件形态的口令可选（默认不设）。

DSH 保持绑定在 `127.0.0.1`（仅回环，安全）。本代理绑定 `0.0.0.0`，让局域网内的手机能通过密码访问它。插件形态默认**没有口令**：可自行设置，也可留空。

> **无需额外安装依赖** —— CLI 形态纯 Node 内置模块；插件形态复用 DSH 已自带的包。跨平台（macOS / Linux / Windows × x86 / ARM）—— 已在 Windows 实测；macOS/Linux 由代码中的平台分支保证，尚未在真机验证。

## 给 agent 看（TL;DR）

DSH 前面的带密码反向代理。DSH 保持回环；本代理绑定 `0.0.0.0:3301` 并转发 HTTP + WebSocket 给它。认证是签名 cookie（30 天会话）、可选 HTTPS、带速率限制。运行：`DSH_PROXY_PASS=<密码> node lib/cli.js`。macOS 停止：`launchctl bootout gui/$(id -u)/com.dsh.lan-proxy`。详见下文。

> **插件形态（当前 DSH 首选）：** `node tools/deploy.mjs dsh-3301`（或 `dsh plugin --profile web add dsh-3301`）
> → 重启 DSH → 手机打开 `http://<本机IP>:3301`。默认没有口令；设置卡片在
> **设置 → 插件 → 插件配置 → dsh-3301**。详见下文。

## 插件形态（`dsh-3301`）

上面的独立代理仍然可用；但在当前 DSH 上，推荐方式是**插件**，包/插件身份为 **`dsh-3301`**
（npm 上的 `dsh-proxy` 已被另一个无关的"LLM 网关"插件占用）。

- DSH 本体始终只绑定 `127.0.0.1`，不对局域网暴露。
- 插件在 **DSH 进程内**开启局域网入口（默认 `0.0.0.0:3301`）：没有独立进程、没有计划任务，随 DSH 启停。
- **默认没有口令**：未设置口令时入口不校验；保存时把口令留空即**清除**口令。
- 口令只存 **salt + scrypt 校验子**（`$DSH_HOME/dsh-3301/auth.json`），磁盘上无明文；**改/清除口令仅限本机（loopback）**。
- 登录是**表单**（口令只在登录那一次过网），带按 IP 的失败锁定与签名会话 cookie（默认 **30 天**）。
- 会话来自官方 `ctx.connection.authenticatedUrl()`（不再读取你的凭据文件）；客户端兜底用
  `ctx.webServer.tapIndex()` 在压缩前注入，不需要改写 HTML。

```sh
dsh plugin --profile web add dsh-3301     # npm 上架后
node tools/deploy.mjs dsh-3301            # 或把本仓库部署进 profile
```

装完重启 DSH，打开 **设置 → 插件 → 插件配置 → dsh-3301**：

| 项 | 说明 |
|---|---|
| 启用入口 | 关闭即释放监听端口 |
| 监听地址 | `0.0.0.0`（局域网可达）/ `127.0.0.1`（仅本机） |
| 监听端口 | 默认 `3301` |
| 用户名 | 登录表单用户名，默认 `dsh` |
| 安全验证周期 | 会话 cookie 有效期，默认 **30 天** |
| 失败次数上限 / 锁定时长 | 超过即锁定该 IP |
| 注入客户端兜底 | 注入 `__DSH_TRANSPORT__.ownsHost`，让局域网页面的设置平面可用 |
| 口令 | 只写输入框：留空 = 清除；修改须填当前口令 |

首次设置也可在本机打开 `http://127.0.0.1:3301/__gate/setup`；
`http://127.0.0.1:3301/__gate/health` 无需认证即可查看入口状态。

卡片观感与 DSH 官方插件卡片一致（沿用官方 `dsh-client-ui-settings-plugins`（BSD-3-Clause）的样式声明
与主题变量）；实现代码均为本项目自行编写。

> 独立 CLI（`node lib/cli.js`，环境变量 `DSH_PROXY_*`）未改动，仍支持在 DSH 之外单独跑代理。

## 为什么

> 本节描述**独立 CLI 形态**；上面的插件形态在认证上不同（表单登录 + scrypt），也不需要自带的 TLS。

- **DSH 保持回环** —— 从不直接暴露。
- **Cookie 会话认证** —— 避免 Basic-Auth 反复弹窗（会破坏 WebSocket/SSE 应用）。首次请求通过 Basic Auth，之后签发签名会话 cookie；后续请求（含 WebSocket 升级）凭 cookie 通过。会话 cookie 持久 **30 天**（Max-Age），浏览器重启不用重新认证。代理把它的 cookie **追加**到 DSH 自己的 Set-Cookie（如语言偏好）后面，而不是覆盖，所以 DSH 设置能持久。
- **HTTPS（可选）** —— 自签证书加密密码/会话传输。
- **速率限制** —— 登录失败过多会锁定 IP。
- **无需额外安装依赖** —— CLI 纯 Node 内置模块；插件复用 DSH 自带包。
- **3301!**
  
## 运行（独立 CLI）

> 以 DSH 插件方式运行见上文。

```bash
DSH_PROXY_PASS=你的密码 node lib/cli.js
# 或安装 bin 后
DSH_PROXY_PASS=你的密码 dsh-3301
```

然后从局域网任意设备打开 `http://<本机IP>:3301`。

### 环境变量（仅独立 CLI 形态；插件形态在设置卡片里配置）

| 变量 | 默认 | 含义 |
|---|---|---|
| `DSH_PROXY_PORT` | `3301` | 监听端口 |
| `DSH_PROXY_HOST` | `0.0.0.0` | 监听地址 |
| `DSH_PROXY_USER` | `dsh` | Basic Auth 用户名 |
| `DSH_PROXY_PASS` | *(必填)* | Basic Auth 密码 |
| `DSH_UPSTREAM` | `127.0.0.1:3080` | 上游 DSH 地址 |
| `DSH_PROXY_SECRET_FILE` | `os.tmpdir()/dsh-3301-secret` | 会话签名密钥文件 |
| `DSH_PROXY_CERT` | `/tmp/dsh-3301-cert.pem` | HTTPS 证书（存在则启用 TLS） |
| `DSH_PROXY_KEY` | `/tmp/dsh-3301-key.pem` | HTTPS 私钥 |

## HTTPS（推荐，仅独立 CLI 形态）

> 插件形态的 `3301` 入口是明文 HTTP —— 网络不可信时请在前面加 TLS 或隧道。

生成一次自签证书，代理即走 HTTPS：

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /tmp/dsh-3301-key.pem -out /tmp/dsh-3301-cert.pem \
  -days 365 -subj "/CN=dsh-3301"
```

浏览器会提示一次自签证书警告 —— 接受一次即可。之后密码和会话在网络上加密传输。

## macOS launchd（开机自启，仅独立 CLI 形态）

> 插件随 DSH 启停，无需 launchd。

见 `com.dsh.lan-proxy.plist`（模板）。加载：

```bash
launchctl bootstrap gui/$(id -u) /path/to/com.dsh.lan-proxy.plist
```

### 手动停止 / 启动

```bash
# 停止（关掉代理）
launchctl bootout gui/$(id -u)/com.dsh.lan-proxy

# 重新启动
launchctl bootstrap gui/$(id -u) /path/to/Library/LaunchAgents/com.dsh.lan-proxy.plist

# 查看状态
launchctl list | grep dsh.lan-proxy
```

## 安全说明与风险

**已加固：**
- DSH 保持回环（从不直接暴露）。
- 认证是 HMAC-SHA256 签名 cookie + 常量时间比较 + `HttpOnly` —— 防篡改、抗时序攻击。
- 速率限制（5 次失败 → 锁 5 分钟）默认开启。
- HTTPS（启用时）加密密码和会话传输。

**已知风险 / 需注意：**
- **弱 / 明文密码** —— 默认示例用短数字密码，且明文存在 launchd plist 里。能读 plist（或进程环境）的人能看到密码。**请用强随机密码**，并尽量别明文存配置。
- **自签证书** —— 浏览器提示一次警告。加密是真实的（RSA 2048），但证书不是受信任 CA 签发，首次连接若用户盲目接受而不核对指纹，理论上可能被中间人攻击。
- **局域网暴露** —— 代理绑定 `0.0.0.0`，局域网内任何人都能尝试访问，密码是唯一门禁。在不可信网络上这不够。
- **无 IP 白名单** —— 仅密码访问。如需更严控制，放到 VPN（如 Tailscale）后面或加 IP 白名单。

**推荐部署：**
1. 用**强密码**（≥12 位，混合字符）。
2. **启用 HTTPS**（可信局域网用自签即可）。
3. 局域网不可信时放到 **VPN**（Tailscale/WireGuard）后面。
4. 密码别明文存配置（用 0600 权限的密钥文件，或从安全来源读环境变量）。

## 参与贡献

欢迎贡献！有帮助的方向：

- **IP 白名单** / 每用户访问控制。
- **OAuth2 / SSO** 登录（用已有账号替代密码）。
- 用 mkcert 或 Let's Encrypt 做**正式 TLS**。
- **暴力破解加固**（指数退避、持久锁定状态）。
- **测试** 和 CI。
- 更好的文档 / 翻译。

开 issue 或 PR —— 见 [GitHub 仓库](https://github.com/)。

## 鸣谢

本项目由 [Aztech Labs](https://github.com/Aztech-Lab) 使用 DeepSeek Harness（Deepseek-V4.1-Flash）完成。

<img src="lib/3301.PNG" width="50%" alt="3301">

## 许可证

MIT
