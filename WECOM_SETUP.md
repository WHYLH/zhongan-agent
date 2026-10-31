# 企业微信接入指南（众安 Agent）

> 目标：让企业微信成员给自建应用发消息，Agent 自动回复；每个企微 UserID 自动获得独立工作区，可在网页设置里绑定合并。
> 本文只写操作步骤，不包含任何真实密钥。

## 0. 先确认两件事

1. **固定 HTTPS 地址**：企业微信回调 URL 必须长期稳定。当前 `*.trycloudflare.com` 是临时隧道，cloudflared 重启后会变，只适合先做测试。
2. **企业微信管理员权限**：需要能登录企业微信管理后台，创建自建应用、查看 Secret、配置回调。

## 1. 企业微信后台拿 5 个值

| 值 | 位置 |
|---|---|
| `CorpID` | 我的企业 → 企业信息 → 企业ID |
| `AgentID` | 应用管理 → 自建 → 你的应用 → AgentId |
| `Secret` | 同上 → Secret（点查看，可能要求管理员验证） |
| `Token` | 应用 → 接收消息 → 设置API接收 → 随机生成 |
| `EncodingAESKey` | 同上 → 随机生成（43 位） |

再记下：**服务器公网 IP `<服务器公网IP>`**。

## 2. 配置企业可信 IP

应用管理 → 你的应用 → 企业可信IP → 添加：

```text
<服务器公网IP>
```

不配置这一项，调用 `message/send` 会报 `60020 not allow to access from your ip`。

## 3. 选稳定回调地址

### 方案 A：已有域名 + Caddy（推荐，证书自动）

1. 域名 DNS 加一条 A 记录：`wecom.你的域名 → <服务器公网IP>`。
2. 服务器安装 Caddy（只占 443，不碰 80 的 cet4-coach）：

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

3. `/etc/caddy/Caddyfile`：

```caddyfile
{
  auto_https disable_redirects
}

wecom.你的域名 {
  reverse_proxy 127.0.0.1:4174
}
```

4. `systemctl reload caddy`，等待证书签发；`curl -I https://wecom.你的域名/` 应返回 200。
5. 回调 URL 填 `https://wecom.你的域名/channel/wecom/callback`。

### 方案 B：Cloudflare 命名隧道（有 Cloudflare 账号/域名）

1. Cloudflare Zero Trust → Networks → Tunnels → 创建隧道。
2. Public Hostname：`wecom.你的域名` → `http://127.0.0.1:4174`。
3. 把隧道 Token 写入服务器（不要让 token 进仓库/聊天记录）：

```bash
# 在服务器上执行，按提示粘贴 token
cloudflared service install <TUNNEL_TOKEN>
systemctl enable --now cloudflared
```

4. 如果原来的 `zhongan-tunnel.service` 是 quick tunnel，可停用它，避免两个隧道抢入口（只停这个新服务，不要碰红线服务）。
5. 回调 URL 填 `https://wecom.你的域名/channel/wecom/callback`。

### 方案 C：先用当前 quick tunnel 测试

当前地址：

```text
https://administrative-consecutive-belief-martin.trycloudflare.com
```

回调 URL 填：

```text
https://administrative-consecutive-belief-martin.trycloudflare.com/channel/wecom/callback
```

缺点：`zhongan-tunnel` 重启或服务器重启后地址会变，需要重新去企微后台改回调；只建议验证流程，不建议长期。

## 4. 配服务器环境变量

编辑 `/opt/zhongan-agent/.env`（root 600），把这 5 个值换成企业微信后台的，并设置回调域名：

```text
WECOM_CORP_ID=...
WECOM_AGENT_ID=...
WECOM_SECRET=...
WECOM_TOKEN=...
WECOM_ENCODING_AES_KEY=...
PUBLIC_BASE_URL=https://wecom.你的域名
```

删除或注释：

```text
WECOM_DRY_RUN=1
```

保留：

```text
VISITOR_MODE=1
VISITOR_STORAGE_LIMIT_MB=100
VISITOR_TEMPLATE_USER=u-lin
```

重启并检查：

```bash
systemctl restart zhongan-agent
sleep 2
systemctl is-active zhongan-agent
curl -s http://127.0.0.1:4174/api/health
tail -30 /var/log/zhongan-agent.log
```

验证企业微信凭据（不会打印 Secret）：

```bash
cd /opt/zhongan-agent
runtime/bin/node -e "
const fs=require('fs');
const env=fs.readFileSync('.env','utf8').split('\n').filter(Boolean).reduce((a,l)=>{const i=l.indexOf('=');if(i>0)a[l.slice(0,i)]=l.slice(i+1);return a;},{});
fetch('https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid='+encodeURIComponent(env.WECOM_CORP_ID)+'&corpsecret='+encodeURIComponent(env.WECOM_SECRET))
  .then(r=>r.json()).then(d=>console.log(d.errcode===0?'gettoken ok':'gettoken fail: '+d.errcode+' '+d.errmsg));
"
```

## 5. 在企微后台保存回调

应用 → 接收消息 → 设置API接收：

- URL：`https://wecom.你的域名/channel/wecom/callback`
- Token / EncodingAESKey：与 `.env` 完全一致
- 保存时企微会发 GET 验证；服务端必须已经用新配置重启，否则会提示回调验证失败。

保存成功后，在应用“接收消息”里确认已开启。

## 6. 测试

1. 应用可见范围加入你的企微账号（或测试成员）。
2. 在企微里给应用发：`查余额`。
3. 第一次发消息会自动开通 `w-xxxx` 工作区（独立数据），随后收到异步回执。
4. 发 `我想进入理财页`，应收到文字回复；企业微信出站由服务端 `message/send` 推送。
5. 网页打开 `https://wecom.你的域名` → 设置 → 渠道接入：
   - 在“企业微信用户绑定”里填你的企微 UserID（企业微信管理后台成员详情里的 UserID，不是昵称）；
   - 绑定后，企微消息和网页访客读写同一份数据。
6. 群里 @ 应用默认只允许查询，资金动作会被权限门拦截，这是设计行为。

## 7. 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 保存回调提示“回调地址验证失败” | Token/AESKey 不一致；服务没重启；URL 不对；quick tunnel 已换地址 | 核对 `.env` 与后台；`systemctl restart zhongan-agent`；`tail -50 /var/log/zhongan-agent.log` |
| 企微发消息没回复 | `WECOM_DRY_RUN=1` 还在；没配可信 IP；Secret 错 | 删除 dry-run；加 IP；`gettoken` 自检 |
| `60020 not allow to access from your ip` | 服务器 IP 不在企业可信IP | 添加 `<服务器公网IP>` |
| `40013 invalid corpid` | CorpID 错 | 重新复制企业ID |
| `40001 invalid credential` | Secret 错或已重置 | 重新查看 Secret |
| `301002` / 无权限 | 应用可见范围不含该成员 | 调整可见范围 |
| `45009` | API 调用超频 | 降低频率，等待重置 |
| 回调 GET 401 | Token 不匹配 | 核对后台 Token 与 `.env` |
| 回调 GET 400 解密失败 | EncodingAESKey/CorpID 不匹配 | 核对 43 位 Key 与 CorpID |
| 网页绑定后企微仍进新工作区 | 绑定的是昵称不是 UserID；绑定的不是当前浏览器 | 用成员 UserID；在同一个浏览器设置页绑定 |

## 8. 安全

- 密钥只写 `/opt/zhongan-agent/.env`（600），不进仓库、不进聊天、不写日志。
- 不要继续使用 `wecom-demo-secret` / `demo-token` / demo AES Key。
- `.env` 里删除 `WECOM_DRY_RUN=1` 才会真实发送。
- 公开免口令模式已有每 IP 限流；企业微信回调走签名校验，不受该限流影响。
- 真实企微联调需要企业管理员配合；不要用个人微信或未授权账号测试。

## 9. 需要你提供/确认

- [ ] 选择稳定地址：A 域名 + Caddy / B Cloudflare 命名隧道 / C 先用 quick tunnel 测试
- [ ] 已创建自建应用并拿到 CorpID、AgentID、Secret
- [ ] 已生成 Token、EncodingAESKey
- [ ] 已把 `<服务器公网IP>` 加入企业可信 IP
- [ ] 应用可见范围包含测试成员
- [ ] 告诉我选的方案和域名（不要发 Secret/Token/AESKey 到聊天，直接写服务器 `.env`）