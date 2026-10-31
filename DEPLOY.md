# 发布与对外使用

本项目是一个 Node.js 24 + SQLite 的单实例 Web 应用。发布前先决定目标：

| 场景 | 方式 | 稳定性 |
|---|---|---|
| 临时给评委/朋友看 | Cloudflare 快速隧道 | 电脑和终端必须保持运行，重启后 URL 变化 |
| 长期公网访问 | 云主机 / Render / Railway / Fly + Docker | 需要账号、持久磁盘和域名（可选） |
| 局域网演示 | 同一 Wi-Fi 直接访问电脑 IP | 只在同一网络可用 |

## 0. 发布前必做

1. **设置访问口令**：公网暴露时至少启用 Basic Auth，否则任何人都能改演示数据、消耗 AI 额度。
2. **换掉演示密钥**：`WEBHOOK_SECRET`、`WECOM_TOKEN`、`WECOM_ENCODING_AES_KEY` 不要用仓库里的 demo 值。
3. **确认数据是模拟数据**：账户、流水、产品均为虚构，不接真实银行。
4. **单实例**：SQLite 写操作不支持多副本同时挂载同一文件；不要开多个实例共享一个数据库。

## 1. 临时公网链接（最快）

当前机器已安装 `cloudflared`。启动服务后另开终端：

```powershell
# 终端 A：启动应用（示例口令 demo / 换成你自己的密码）
$env:DEMO_AUTH="demo:change-me-please"
$env:WEBHOOK_SECRET="change-me-webhook"
npm start
```

```powershell
# 终端 B：建立公网隧道
npm run share:mobile
```

终端 B 会打印 `https://xxxx.trycloudflare.com`。把这个地址和 Basic Auth 用户名/密码发给使用者。

注意：

- 终端 B 关闭或电脑休眠，链接立即失效；
- 每次重启隧道 URL 都会变化；
- 企业微信回调如果用这个地址，需要在隧道重启后同步更新后台回调 URL；
- `PUBLIC_BASE_URL` 可以留空，确认链接会按请求 Host 自动生成；如果反向代理改写了 Host，再显式设置。

## 2. Docker（推荐长期发布）

```powershell
docker build -t zhongan-bank-agent .
docker run -d --name zhongan-bank -p 4173:4173 ^
  -v zhongan-data:/app/data ^
  -e DEMO_AUTH="demo:change-me-please" ^
  -e WEBHOOK_SECRET="change-me-webhook" ^
  -e ARK_API_KEY="你的模型 Key" ^
  zhongan-bank-agent
```

- `-v zhongan-data:/app/data` 保存 SQLite，容器重建不丢数据；首次启动会把镜像里的基线库复制进卷。
- 模型 Key 也可以不设，改挂载 `data/ai-config.local.json`（不要提交到仓库）。
- 本地千问 TTS 权重（2.4GB）没有打进镜像；容器内会自动回退云端或浏览器语音。要本地 TTS，另起 `scripts/start-qwen-tts.cmd` 并设置 `QWEN_TTS_API=http://host.docker.internal:7861`（Linux 下用宿主机地址）。

## 3. Render / Railway / Fly

### Render

1. New → Web Service → 选择仓库（含 `Dockerfile`）。
2. Environment 加 `DEMO_AUTH`、`WEBHOOK_SECRET`、模型 Key。
3. 添加 Persistent Disk，挂载路径 `/app/data`。
4. Health Check Path 填 `/api/health`。

### Railway

1. New Project → Deploy from repo。
2. Variables 同上。
3. 添加 Volume，挂载 `/app/data`。
4. 生成域名。

### Fly.io

```powershell
fly launch --dockerfile Dockerfile
fly volumes create zhongan_data --size 1
# fly.toml 里挂载：
# [mounts]
#   source = "zhongan_data"
#   destination = "/app/data"
fly deploy
```

## 4. 自有云主机（Ubuntu 示例）

```bash
sudo apt install -y nodejs npm caddy
# Node 需要 24+；用 nvm 安装更稳
npm install
npm run db:check
sudo tee /etc/systemd/system/zhongan-bank.service >/dev/null <<'EOF'
[Unit]
Description=Zhongan Bank Agent
After=network.target

[Service]
WorkingDirectory=/opt/zhongan-bank
ExecStart=/usr/bin/node server.mjs
Environment=PORT=4173 HOST=127.0.0.1
Environment=DEMO_AUTH=demo:change-me
Environment=WEBHOOK_SECRET=change-me
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now zhongan-bank
```

Caddy 反代并自动 HTTPS：

```caddyfile
bank.example.com {
  reverse_proxy 127.0.0.1:4173
}
```

## 5. 环境变量

| 变量 | 作用 |
|---|---|
| `PORT` / `HOST` | 监听端口与地址；容器内用 `4173` / `0.0.0.0` |
| `FUND_DB_PATH` | SQLite 路径，默认 `data/finance.sqlite` |
| `DEMO_AUTH` | `用户名:密码`，启用 Basic Auth；留空关闭 |
| `WEBHOOK_SECRET` | 通用 Webhook HMAC 密钥 |
| `WECOM_CORP_ID` / `WECOM_AGENT_ID` / `WECOM_SECRET` | 企业微信应用凭据 |
| `WECOM_TOKEN` / `WECOM_ENCODING_AES_KEY` | 企业微信回调验签与解密 |
| `WECOM_DRY_RUN` | `1` 时只打印出站包，不真发 |
| `IM_ALLOW_USER_ID_FALLBACK` | `1` 时允许平台 UserID 等于内部用户 ID（仅本地演示） |
| `PUBLIC_BASE_URL` | 确认链接的兜底站点根；默认按请求 Host 生成 |
| `VISITOR_MODE` | `1` 时每个访问者独立工作区，互不影响 |
| `VISITOR_STORAGE_LIMIT_MB` | 访客工作区总容量上限，默认 `100`；超出按最久未访问淘汰 |
| `VISITOR_TEMPLATE_USER` | 克隆模板用户，默认 `u-lin` |
| `PUBLIC_RATE_LIMIT` | 免口令公开模式下每个 IP 每 10 分钟可用的 AI/自测/语音请求数，默认 30 |
| `AI_GATEWAY_BASE_URL` / `AI_GATEWAY_API_KEY` / `AI_GATEWAY_MODEL` | 服务端默认模型；建议填硅基流动免费模型（XingChenAGI/Xing4.0-29B），Key 只留在服务端环境变量或 `.env`，接口不回显 |
| `ASR_MODEL` | 默认语音识别模型名 |

## 5.1 访客隔离模式（对外发布建议开启）

```powershell
$env:VISITOR_MODE="1"
$env:VISITOR_STORAGE_LIMIT_MB="100"
$env:VISITOR_TEMPLATE_USER="u-lin"
```

行为：

- 第一次访问：服务器从 `u-lin` 克隆一份完整工作区（账户、卡、200 条流水、订阅、账单、持仓、免密策略），分配 `v-xxxx` 用户。
- 浏览器保存 `zhongan_vid`（HttpOnly）与 `zhongan_uid` 两个 Cookie；同一浏览器下次回来仍是自己的数据。
- 不同访客、不同浏览器的数据完全隔离；模板用户和其他访客不在用户列表与转账目录中出现。
- 访客只能看自己的资料；请求体里的 `userId` 会被服务端强制改写为当前访客，无法越权。
- 企业微信：每个 `FromUserName` 首次发消息时自动开通 `w-xxxx` 工作区；在网页设置里绑定企微 UserID 后，两条渠道合并到同一份数据。
- 容量达到 `VISITOR_STORAGE_LIMIT_MB` 时，按最久未访问顺序删除旧工作区，模板用户永不被淘汰；日志里会打印 `[visitor] 已清理 …`。
- 当 `VISITOR_MODE=1` 且未配置 `DEMO_AUTH`（公开免口令）时，自动启用每 IP 限流：`/api/agent`、`/api/ai/test`、`/api/channel/selftest`、`/api/tts` 每 10 分钟最多 `PUBLIC_RATE_LIMIT` 次，无 Cookie 新建访客每 10 分钟最多 `PUBLIC_VISITOR_CREATE_LIMIT` 次，并禁止通过 `/api/ai/config` 改写 AI 配置，避免陌生人消耗模型额度。
- 访客可以在设置 → AI 模型里选择「硅基流动（默认）」或「自定义网关」。默认模型使用服务端已配置的 SiliconFlow Key，不向前端返回；自定义配置只写当前客户端 localStorage，并通过 `X-AI-Config` 请求头随请求转发，不会覆盖其他访客或服务端默认配置。自定义网关地址必须是公开 http/https，localhost、私有网段和保留地址会被服务端拒绝。
- 浏览器本地保留的是访客身份、界面偏好和 AI 自定义配置；账本数据在服务器按访客隔离存储，换设备或清 Cookie 会得到一份新工作区。

验收：

```powershell
npm run visitor:check
```

## 6. 企业微信发布配置

> 企业微信不是赛题强制项：赛题要求 APP / IM 渠道联通，通用 Webhook 适配器已满足 IM 要求；企业微信是可选的真实 IM 载体。要接真实企微，按下面步骤配置。

1. 企业微信管理后台 → 应用 → 接收消息 → 设置 API 回调。
2. URL：`https://你的域名/channel/wecom/callback`。
3. Token 与 EncodingAESKey 填后台生成的随机值，并写入环境变量。
4. 设置 `PUBLIC_BASE_URL=https://你的域名`，`WECOM_DRY_RUN` 不设为 `1`。
5. 重启服务。
6. 在 App 设置 → 渠道接入 → 企业微信用户绑定，填入测试成员的 UserID。
7. 在企微发“查余额”，应收到异步回执；大额转账会回一个 `/confirm/<ticketId>` 链接，密码只在网页输入。

## 7. 重置演示数据

```powershell
npm run db:seed
```

容器内：

```bash
docker exec zhongan-bank npm run db:seed
```

重置会恢复 200 条流水、订阅、账户和理财持仓；执行前先停写入或选择低峰期。

## 8. 发布后自检

```powershell
npm run check
npm run im:check
curl -u demo:你的密码 https://你的域名/api/health
curl -u demo:你的密码 https://你的域名/api/bank/audit-chain?user=u-lin
```

预期：`check` 通过、IM 55 条通过、健康检查返回 `ok:true`、审计链 `valid:true`。

## 9. 已知边界

- 应用没有完整账号体系，`DEMO_AUTH` 只是共享口令；不适合承载真实用户数据。
- SQLite 适合单实例演示；多实例需要换 PostgreSQL 并重做数据层。
- 本地千问 TTS 需要额外 Python/torch 环境；公网部署默认回退浏览器语音。
- 演示数据会被访问者修改；对外演示建议定期 `db:seed`。
- 这不是生产银行系统，不构成合规或安全认证。