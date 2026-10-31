# 众安 Agent · IM 渠道技术准备稿（定稿）

- 版本：v1.0
- 日期：2026-10-30
- 状态：已实现并通过 55 条 IM 专项验收；企业微信生产租户联调仍需企业凭据
- 适用范围：通用 Webhook、企业微信（私聊 / 群聊）、Web/App 与 IM 的确认票据互通
- 关联材料：`REQUIREMENTS_1_3_IM_TECHNICAL_DRAFT.md`（历史草稿）、`参赛材料/01-技术文档/技术方案总览.md`、`ARCHITECTURE.md`

## 0. 本轮读了什么

本文的结论来自以下材料，不是凭经验补写：

| 材料 | 位置 | 采用方式 |
|---|---|---|
| 比赛要求（以用户截图为准） | `AI任务准备包_FinTechathon2026/00_比赛要求_以用户截图为准.md` | 确认“APP / IM 等渠道”是赛题要求；至少 3 个场景；没有指定必须使用企业微信 |
| 课程参考 | `AI任务准备包_FinTechathon2026/01_课程参考_开发与安全要点.md` | 只作为权限、确认、审计、幂等的实现参考，不作为评分硬性条款 |
| 官方启动包 | 微信文件 `bank-agent-starter-0.2.0.zip`，解压于项目外参考目录 `../参考_IM启动包_bank-agent-starter-0.2.0/bank-agent-starter` | 采用渠道边界、会话格式、消息幂等、票据与审计分层 |
| 官方包校验 | 压缩包 SHA-256 `0842430b6f737f2323d000fb6322cfd6fe6d095dd88b811c5580292a9d531f19` | 后续联调可复核是否为同一版本 |
| 当前项目代码 | `server.mjs:3291`、`server.mjs:3344`、`db.mjs:381` | 只列现状差距，不把“演示占位”写成“已实现” |

官方启动包版本为 `0.2.0`，渠道层只有两个文件：`channels/generic-webhook.mjs` 与 `channels/wecom.mjs`。它们解决了“收、转、发”的最小闭环，但没有解决企业微信验签、AES 解密、用户绑定、跨渠道票据和长任务异步回执。这些正是本文要补齐的部分。

## 1. 结论先行

### 1.1 赛题对 IM 的真实要求

赛题要求“支持用户通过 APP / IM 等渠道与 Agent 联通”，没有指定具体 IM 平台，也没有要求必须接入企业微信生产租户。因此本项目的验收口径应是：

1. Web / App 渠道可用；
2. 至少一个真实可调用的 IM 渠道可用；
3. 渠道只做传输，权限判定与业务执行仍由同一套 Agent 运行时完成；
4. 同一句话从 Web、Webhook、企业微信进入，得到的意图、计划摘要、风险级别、执行结果一致。

企业微信是“可选的真实 IM 载体”，通用 Webhook 是“可本地复现的 IM 适配层”。两者都必须遵守同一份 Envelope 契约。

### 1.2 本文完成到什么程度

本文已经完成：

- 官方参考包逐文件结论；
- IM 渠道统一 Envelope、会话、幂等、绑定、票据、审计、熔断的接口定义；
- 企业微信 GET/POST 验签与 AES 解密的可执行算法；
- 通用 Webhook 的 HMAC 签名、重放窗口、幂等表设计；
- SQLite 建表语句与迁移顺序；
- 当前代码差距表（精确到行）；
- P0/P1/P2 实施步骤与 55 条验收用例；
- 无真实企业凭据时的 dry-run 演示方法。

本文没有完成、也不应该假装完成：

- 企业微信真实租户的 `corpId / agentId / secret / token / EncodingAESKey` 配置；
- 真实企业微信网络联调（需要公网回调地址与平台后台权限）；
- 生产级短信/人脸/U-Key 强验证；
- 多租户、消息队列、分布式幂等。

> 结论：IM 渠道代码已按本稿落地，`npm run im:check` 55 条全过；真实企业微信租户仍需要企业侧凭据与公网回调地址，dry-run 可完整验证协议算法。

## 2. 官方参考包逐文件结论

| 文件 | 官方实现 | 可直接采用 | 必须补的缺口 |
|---|---|---|---|
| `channels/generic-webhook.mjs` | 32KB 上限、`userId:text` 十秒去重、返回 `reply/level/auditSeq` | Envelope 字段、JSON 错误语义、响应结构 | 无签名、无平台 messageId 幂等、无 timestamp 窗口、无持久化 |
| `channels/wecom.mjs` | access_token 缓存（提前 5 分钟刷新）、`message/send`、`dryRun`、回调归一化 | token 缓存与发送函数、dry-run 演示方式 | 无 SHA-1 验签、无 AES 解密、无 MsgId 幂等、无用户绑定、无群聊会话 |
| `channels/README.md` | 固定会话格式与“只做收转發” | 会话命名、加渠道的两个函数 | 未给出签名和票据 |
| `skills/im-channel/SKILL.md` | 平台 messageId 去重、五分钟超时、异步回执、密钥环境变量 | 去重键、超时策略、反模式清单 | 需要落成代码与表结构 |
| `track-pi/src/agent.ts` | `chat / confirm / cancel` 与注入拦截、票据流程 | 运行时接口命名 | 当前项目需把 `handleAgent` 抽成可复用的 chat 函数 |
| `shared/rules.ts` | `digestOf(tool, slots)`、`issueTicket`、`verifyTicket`、SHA-256 审计链 | 票据摘要与链式审计 | 票据需持久化并绑定渠道、用户、会话、过期时间 |
| `docs/03-架构与分层.md` | 五层结构、五个运行时接口 | 分层边界与接口表 | 本文按当前项目的六层实现落位 |
| `docs/04-渠道与交付.md` | 三分钟视频、交付清单、答辩问题 | 验收与答辩口径 | 本文补充可执行的 IM 测试矩阵 |

### 2.1 官方包没有给的三件事

1. **企业微信回调安全**：官方 `wecom.mjs` 只做归一化和发送，不验签、不解密。直接照抄会把“演示占位”当成“生产接入”。
2. **跨渠道票据**：官方票据在 `track-pi` 内存里，重启丢失，且没有 Web 确认页。IM 触发黄色/红色动作后无法安全回到 Web 完成密码输入。
3. **统一 Agent 入口**：官方 `chat(sessionId, text)` 是一个抽象接口；当前项目的 `handleAgent(req, res)` 与 HTTP 请求耦合，渠道不能直接复用完整 AI 工具链。

## 3. 目标架构

```text
Web / App ─────┐
通用 Webhook ──┼─→ Channel Adapter ─→ normalize ─→ dedupe ─→ resolveUser ─┐
企业微信 ──────┘         │                                              │
                         │ 只做收、转、发                                  ▼
                         │                                   Agent Runtime
                         │                                   ├─ 注入拦截
                         │                                   ├─ 意图 / 槽位
                         │                                   ├─ 查询工具
                         │                                   ├─ 任务计划 DAG
                         │                                   ├─ 权限策略
                         │                                   ├─ 动作执行
                         │                                   └─ 审计 / 熔断
                         ▼                                              │
                  render / send ◄──────────── reply / ticket ◄──────────┘
```

渠道适配层禁止做以下事情：

- 不判断“能不能转账”，只把消息交给运行时；
- 不解析金额后自行执行；
- 不把支付密码写入日志、URL、XML 或 IM 文本；
- 不把平台错误原文直接抛给用户。

### 3.1 运行时五个接口

与官方包保持一致，当前项目实现时建议抽成对象或函数组：

| 接口 | 输入 | 输出 | 当前项目对应 |
|---|---|---|---|
| `chat(envelope)` | 渠道、内部 userId、sessionId、文本 | `reply / planId / decision / ticket / auditSeq` | `handleAgent()` 内部逻辑 |
| `confirm(ticketId, password)` | 一次性票据、Web 输入的密码 | 执行结果或拒绝原因 | `/api/agent` 的 `pending` 分支需扩展 |
| `cancel(ticketId)` | 票据 | 取消结果 | 暂无 |
| `state(userId)` | 用户 | 账户、卡片、订阅、持仓快照 | `/api/finance/*` |
| `audit(userId, limit)` | 用户、条数 | 审计记录与链校验 | `/api/bank/audit-chain` |

## 4. 统一 Envelope 与会话

```ts
type ChannelEnvelope = {
  channel: 'webhook' | 'wecom';
  providerUserId: string;       // 平台侧用户标识，如企业微信 FromUserName
  userId: string;               // 内部用户 id，必须经过绑定表解析
  sessionId: string;            // 渠道前缀 + 用户；群聊带 ChatId
  messageId: string;            // 平台消息 id；没有时用 UUID，不能省
  text: string;                 // 已 trim，最长 300 字
  chatType: 'private' | 'group';
  receivedAt: string;           // ISO 8601
};
```

会话格式固定：

| 渠道 | sessionId |
|---|---|
| 通用 Webhook | `webhook:{userId}` |
| 企业微信私聊 | `wecom:{userId}` |
| 企业微信群聊 | `wecom:group:{ChatId}:{FromUserName}` |

三条铁律：

1. 不用平台 messageId 当 sessionId，否则每句话都是新会话；
2. 不用时间戳当 sessionId；
3. 群聊必须把 `ChatId` 放进 sessionId，不能把群消息当成私聊上下文。

### 4.1 用户绑定

```sql
CREATE TABLE IF NOT EXISTS channel_bindings (
  channel         TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  corp_id         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (channel, provider_user_id)
) STRICT;
```

解析顺序：

1. 查 `channel_bindings(channel, provider_user_id)`；
2. 仅当 `IM_ALLOW_USER_ID_FALLBACK=1` 时，允许 providerUserId 恰好等于内部 userId（本地演示）；
3. 仅当 `WECOM_DRY_RUN=1` 时，允许 `WECOM_DEMO_USER` 指定的演示用户；
4. 其余情况返回“尚未绑定账户”，并给出绑定入口，**不得默认落到 `u-lin`**。

当前代码 `server.mjs:3357` 在缺少 `FromUserName` 时直接回退 `u-lin`，必须删除。

## 5. 通用 Webhook 契约

### 5.1 请求

```http
POST /channel/message
Content-Type: application/json
X-Channel-Timestamp: 1700000000
X-Channel-Signature: sha256=<hex>
X-Idempotency-Key: msg-20261030-001
```

```json
{
  "userId": "u-lin",
  "sessionId": "webhook:u-lin",
  "messageId": "msg-20261030-001",
  "text": "查一下上个月的收支",
  "page": "agent"
}
```

### 5.2 签名

```text
canonical = timestamp + "\n" + rawBody
expected  = "sha256=" + HMAC-SHA256(WEBHOOK_SECRET, canonical)
```

- 必须用**原始请求体**计算，不能先 `JSON.parse` 再 `JSON.stringify`；
- timestamp 与服务器时间偏差超过 300 秒拒绝；
- 使用 `crypto.timingSafeEqual` 比较，禁止普通字符串比较；
- 未配置 `WEBHOOK_SECRET` 时，生产模式拒绝所有请求；本地演示可用 `WEBHOOK_ALLOW_UNSIGNED=1`，但必须在响应中标记 `demo: true`。

测试向量：

```text
secret = demo-secret
timestamp = 1700000000
body = {"userId":"u-lin","text":"查一下余额","messageId":"msg-001"}
signature = e717f7f25a41777b9bddfb9f156b177b2dde9d9ad2911c0291dd6d295b0b3447
```

### 5.3 幂等

```sql
CREATE TABLE IF NOT EXISTS channel_messages (
  channel        TEXT NOT NULL,
  message_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json  TEXT,
  status         TEXT NOT NULL DEFAULT 'processing',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (channel, message_id)
) STRICT;
```

规则：

- 首次请求写入 `processing`，完成后写 `done` 与 `response_json`；
- 重复 `messageId` 且 `request_digest` 相同：直接返回上次 JSON，不再执行；
- 重复 `messageId` 但内容不同：返回 `409 IDEMPOTENCY_CONFLICT`，不执行；
- `processing` 状态重复到达：返回 `202` 与 `retryAfterMs`，不重复执行；
- 保留期 24 小时，过期清理由启动时或定时任务完成。

### 5.4 响应

```json
{
  "ok": true,
  "channel": "webhook",
  "sessionId": "webhook:u-lin",
  "reply": "上月收入 18,600.00 元，支出 9,420.36 元……",
  "decision": {
    "level": "green",
    "requiresConfirm": false,
    "requiresStrongAuth": false
  },
  "planId": "plan-20261030-001",
  "ticketId": null,
  "auditSeq": 418
}
```

- 5 秒内必须返回；慢任务先返回 `202` 或“已收到，处理中”，完成后由 `send` 异步推送；
- 4xx 必须是 JSON，不能返回 200 包错误；
- 请求体上限 32KB，超出返回 `413 BODY_TOO_LARGE`；
- 文本上限 300 字，超出截断并在响应中标记 `truncated: true`。

## 6. 企业微信协议

### 6.1 环境变量

| 变量 | 用途 | 本地演示 |
|---|---|---|
| `WECOM_CORP_ID` | 企业标识 | 可空 |
| `WECOM_AGENT_ID` | 应用标识 | 可空 |
| `WECOM_SECRET` | 应用密钥 | 可空 |
| `WECOM_TOKEN` | 回调签名 Token | 设 `demo-token` |
| `WECOM_ENCODING_AES_KEY` | 43 位 EncodingAESKey | 可空（明文模式） |
| `PUBLIC_BASE_URL` | 确认短链接的站点根 | `http://localhost:4173` |
| `WECOM_DRY_RUN` | `1` 时只打印出站包 | 建议本地设为 `1` |

密钥只从环境变量或本机 gitignored 配置读取，不写入前端、不写入仓库。

### 6.2 GET 回调校验

企业微信首次配置回调 URL 时发送：

```text
GET /channel/wecom/callback?msg_signature=...&timestamp=...&nonce=...&echostr=...
```

算法：

```text
signature = SHA1(sort([WECOM_TOKEN, timestamp, nonce, echostr]).join(''))
```

排序是**字典序**，不是拼接顺序。校验通过后：

- 明文模式：原样返回 `echostr`；
- 加密模式：解密 `echostr`，返回解密后的明文。

当前代码 `server.mjs:3345-3349` 直接回显 `echostr`，没有校验，必须替换。

测试向量：

```text
token = demo-token
timestamp = 1700000000
nonce = abc
echostr = hello
排序后 = 1700000000abcdemo-tokenhello
msg_signature = da3927074977408af2827d99de2d4983e92b66c3
```

### 6.3 AES 解密

`EncodingAESKey` 为 43 位 Base64 字符，补一个 `=` 后解码得到 32 字节：

```text
key = Buffer.from(EncodingAESKey + "=", "base64")   // 32 bytes
iv  = key.subarray(0, 16)
decipher = AES-256-CBC(key, iv)
plain = PKCS7Unpad(decipher.update(ciphertext) + decipher.final())
```

`plain` 结构：

```text
16 字节随机数 | 4 字节消息长度（大端） | 消息明文 | CorpID
```

校验：

1. 长度字段不得超过剩余字节；
2. 尾部 CorpID 必须等于 `WECOM_CORP_ID`；
3. 去除 PKCS#7 填充后，再解析 XML。

POST 加密模式下，XML 形如：

```xml
<xml>
  <ToUserName><![CDATA[corp]]></ToUserName>
  <Encrypt><![CDATA[base64-ciphertext]]></Encrypt>
  <AgentID><![CDATA[1000002]]></AgentID>
</xml>
```

`msg_signature` 的计算对象是 `Encrypt` 字段，不是整个 XML。

### 6.4 POST 消息解析

明文或解密后的 XML 至少读取：

```xml
<ToUserName>corp</ToUserName>
<FromUserName>zhangsan</FromUserName>
<CreateTime>1700000000</CreateTime>
<MsgType>text</MsgType>
<Content>查余额</Content>
<MsgId>1234567890123456</MsgId>
<AgentID>1000002</AgentID>
<ChatId>group-chat-id</ChatId>
```

规则：

- 只处理 `MsgType=text`；其他类型返回空串或“暂不支持”；
- `MsgId` 必填，作为 `channel_messages.message_id`；
- `FromUserName` 经绑定表解析为内部 userId；
- 有 `ChatId` 时按群聊处理，sessionId 为 `wecom:group:{ChatId}:{FromUserName}`；
- XML 解析使用字段级提取 + 实体反转义，不能用一个正则吞整段 XML；
- 回复文本做 CDATA 转义，若内容含 `]]>` 必须拆开；
- 单条文本超过 2048 字节时截断，避免企业微信拒收。

### 6.5 出站消息

```text
GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=...&corpsecret=...
POST https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=...
```

```json
{
  "touser": "zhangsan",
  "msgtype": "text",
  "agentid": 1000002,
  "text": { "content": "已生成转账计划，请点击确认：https://..." }
}
```

- token 缓存 `expires_in - 300` 秒；
- 发送返回 `40014 / 42001`（token 无效/过期）时，清缓存并重试一次；
- `WECOM_DRY_RUN=1` 时只记录出站包，不访问外网；
- 群聊消息需使用 `chatid` 字段或应用可见范围配置，具体以企业后台为准；本文不假设群机器人 webhook 可用。

### 6.6 5 秒超时与异步回执

企业微信被动回复要求 5 秒内返回。策略：

1. 查询类且 4 秒内完成：直接返回被动 XML；
2. 可能超时（模型调用、长计划）：立即返回“已收到，正在处理”，把请求放入内存队列；
3. 处理完成后调用 `message/send` 主动回执；
4. 同一 `MsgId` 的异步任务只允许一个，重复回调直接返回“处理中”；
5. 进程重启后 `processing` 消息不自动重跑，避免重复扣款；由用户重新发起或人工处理。

## 7. 待确认与强验证票据

### 7.1 为什么 IM 不接收密码

企业微信文本、Webhook JSON、URL 参数都会进入平台日志、网关日志和浏览器历史。支付密码一旦进入这些通道，就无法证明“只有用户本人看见”。因此：

- IM 只返回确认链接；
- 密码只在 Web/App 的密码卡输入；
- 服务端只接受 `POST /api/agent/confirm` 的 HTTPS 请求体；
- 短链接只含随机 `ticketId`，不含金额、账号、原文。

### 7.2 票据表

```sql
CREATE TABLE IF NOT EXISTS agent_tickets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  channel     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  args_json   TEXT NOT NULL,
  digest      TEXT NOT NULL,
  plan_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'used', 'expired', 'cancelled')),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  used_at     TEXT
) STRICT;
```

### 7.3 摘要

```text
canonical = JSON.stringify({
  userId, sessionId, channel, tool, planId,
  args: Object.keys(args).sort().map(k => [k, args[k]])
})
digest = SHA-256(canonical).hex.slice(0, 16)
```

票据绑定用户、会话、渠道、工具、参数、计划；任一字段改变，摘要不匹配，拒绝执行。

### 7.4 生命周期

```text
IM 发起黄色/红色动作
  → 运行时生成计划与 ticket（pending, TTL 120s）
  → IM 回复：“已生成计划，点击确认：{PUBLIC_BASE_URL}/#/confirm/{ticketId}”
  → 用户打开 Web/App
  → GET /api/agent/ticket/{id} 只返回展示信息（不含密码）
  → 用户输入密码
  → POST /api/agent/confirm { ticketId, password }
  → 原子更新 status=pending → used（WHERE expires_at > now）
  → 仅执行票据绑定的节点
  → 写审计，异步 message/send 回执
```

失败语义：

| 情况 | 结果 |
|---|---|
| 票据不存在 | `404 TICKET_NOT_FOUND` |
| 已使用 | `409 TICKET_USED` |
| 已过期 | `410 TICKET_EXPIRED` |
| 用户/会话/渠道不匹配 | `403 TICKET_MISMATCH` |
| 参数摘要不匹配 | `409 TICKET_DIGEST_MISMATCH` |
| 密码错误 | `403 PASSWORD_INVALID`，计入熔断 |
| 重复提交同一票据 | 第二次返回第一次结果，不重复执行 |

IM 文本“确认/取消”只能作为辅助入口：必须绑定最近一张未过期票据，并再次校验摘要；群聊中默认禁用裸“确认”，强制点击链接。

## 8. 审计与熔断

### 8.1 审计字段

当前 `audit_log` 只有 `id/user_id/action/target/detail/created_at`（`db.mjs:381-388`）。IM 接入需要新增：

```sql
ALTER TABLE audit_log ADD COLUMN channel TEXT;
ALTER TABLE audit_log ADD COLUMN session_id TEXT;
ALTER TABLE audit_log ADD COLUMN message_id TEXT;
ALTER TABLE audit_log ADD COLUMN plan_id TEXT;
ALTER TABLE audit_log ADD COLUMN node_id TEXT;
ALTER TABLE audit_log ADD COLUMN input_digest TEXT;
ALTER TABLE audit_log ADD COLUMN result_ref TEXT;
```

事件序列：

```text
intent.received → plan.created → policy.decided
→ node.executed / node.paused / node.blocked / node.failed
```

哈希链输入必须包含新增字段，否则“改渠道字段”不会破坏链校验。现有 `writeAudit()` 需要扩展参数，旧调用保持兼容。

### 8.2 熔断

按 `userId + channel` 维度：

| 触发 | 阈值 | 动作 |
|---|---|---|
| 密码连续失败 | 5 次 / 10 分钟 | 资金动作锁定 15 分钟 |
| 过期票据重复提交 | 3 次 / 10 分钟 | 锁定票据入口 |
| 短时间高频消息 | 20 条 / 分钟 | 返回 `429 RATE_LIMITED` |
| 同一幂等键内容不一致 | 1 次 | 返回 `409`，写红色审计 |

熔断期间查询仍可用；资金动作返回 `CIRCUIT_OPEN`，并提示人工接管或重新验证。熔断事件本身写入审计链。

## 9. 实现结果（2026-10-30）

| 能力 | 落点 | 状态 |
|---|---|---|
| Webhook HMAC 签名、时间窗、32KB 上限 | `server.mjs` `/channel/message`；`channels/im.mjs` `verifyWebhookSignature` | 已实现 |
| messageId 持久化幂等与冲突检测 | `db.mjs` `channel_messages`、`startChannelMessage`、`finishChannelMessage` | 已实现 |
| 企业微信 GET SHA-1 验签与 AES 解密 | `channels/im.mjs` `wecomSignature`、`decryptWecom`；`server.mjs` GET 分支 | 已实现 |
| 企业微信 POST 明文/加密解析 | `channels/im.mjs` `parseWecomXml`；`server.mjs` POST 分支 | 已实现 |
| FromUserName 绑定与群聊会话 | `db.mjs` `channel_bindings`、`resolveChannelUser`；`channelSessionId` | 已实现 |
| access_token 缓存、失效重试、`message/send`、dry-run | `channels/im.mjs` `getWecomAccessToken`、`sendWecomText` | 已实现 |
| 5 秒超时：立即 ack + 异步回执 | `server.mjs` `processWecomMessage` + `setImmediate` | 已实现 |
| 持久化票据、Web 确认页、密码只在 Web 输入 | `db.mjs` `agent_tickets`；`/confirm/:id`、`GET /api/agent/ticket/:id`、`POST /api/agent/confirm` | 已实现 |
| 审计渠道字段与哈希链兼容 | `db.mjs` `writeAudit` / `auditPayload` / `verifyAuditChain` | 已实现 |
| 复用同一套 Agent 处理链路 | `server.mjs` `callAgentChat` 同进程回环调用 `/api/agent` | 已实现 |
| 企业微信用户绑定管理 | `GET/POST /api/bank/channel/bindings`、`bind`、`unbind`；设置页绑定/解绑 | 已实现 |
| 设置页渠道自测 | `POST /api/channel/selftest`，内部生成签名，不暴露 Webhook Secret | 已实现 |
| 速率限制与密码失败熔断 | 20 条/分钟；5 次密码失败锁定 15 分钟；查询仍可用 | 已实现（进程内） |
| IM 专项验收 | `scripts/im-check.mjs` | 55/55 通过 |

实现后的已知限制：

- `callAgentChat` 通过本机 `127.0.0.1` 回环复用 `/api/agent`，没有把 `handleAgent` 拆成纯函数。这样做保证 Web 与 IM 走同一套注入拦截、工具、策略和执行逻辑，但多一次本机 HTTP 往返；后续可无损替换为直接函数调用。
- 真实企业微信联调仍需 `WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET`、公网 HTTPS 回调地址和企业后台配置；本地只能验证协议算法与 dry-run。
- 速率限制与熔断状态保存在进程内，重启后清零；未落表持久化。比赛演示足够，生产化需替换为共享存储。

## 10. 实施步骤（均已落地）

以下三阶段对应本次实现，已完成并通过回归：

### P0：渠道骨架与安全（已实现）

1. `db.mjs` 增加 `channel_bindings`、`channel_messages`、`agent_tickets` 与审计字段迁移；
2. `channels/im.mjs` 实现 HMAC、SHA-1、AES-256-CBC、PKCS#7、XML、token 缓存与 `message/send`；
3. `/channel/message` 加签名、body 上限、messageId 幂等、统一响应；
4. `/channel/wecom/callback` GET 验签/解密，POST 解析/绑定/幂等；
5. `scripts/im-check.mjs` 覆盖测试向量与重放。

### P1：完整 Agent 与票据（已实现）

1. `callAgentChat` 同进程复用 `/api/agent` 的注入拦截、查询工具、AI 计划、策略与执行；
2. IM 出站 token 缓存 + `message/send` + dry-run；
3. 5 秒超时：快速 ack + 异步回执；
4. 黄色/红色动作签发持久化票据，返回 `PUBLIC_BASE_URL/confirm/{id}`；
5. Web 确认页与 `GET /api/agent/ticket/:id`、`POST /api/agent/confirm`；
6. 审计写渠道字段，绑定管理 API 与设置页入口。

### P2：一致性与演示（已实现）

1. 同一句话分别走 Web、Webhook、WeCom，比较 `intent / digest / level / 执行结果`；
2. 速率限制、密码失败熔断与渠道自测端点；
3. dry-run 演示命令、`npm run im:check` 与文档/参赛材料同步；
4. 明确列出未完成项（真实租户联调、熔断持久化）。

## 11. 验收用例

| # | 用例 | 预期 |
|---|---|---|
| 1 | Webhook 正确签名 + 新 messageId | 200，返回 reply/decision/auditSeq |
| 2 | Webhook 错误签名 | 401 `SIGNATURE_INVALID` |
| 3 | Webhook 时间戳超过 300 秒 | 401 `TIMESTAMP_OUT_OF_WINDOW` |
| 4 | 同一 messageId 重放 | 200，返回同一响应，不重复执行 |
| 5 | 同一 messageId 不同内容 | 409 `IDEMPOTENCY_CONFLICT` |
| 6 | 请求体超过 32KB | 413 `BODY_TOO_LARGE` |
| 7 | 未绑定用户 | 200/403，提示绑定，不落到 u-lin |
| 8 | WeCom GET 明文正确签名 | 原样返回 echostr |
| 9 | WeCom GET 错误签名 | 401 |
| 10 | WeCom GET 加密 echostr | 返回解密明文 |
| 11 | WeCom POST 明文 XML | 解析并回复 |
| 12 | WeCom POST 加密 XML | 验签、解密、回复 |
| 13 | 错误 CorpID | 拒绝，不解析消息 |
| 14 | 私聊消息 | sessionId = `wecom:{userId}` |
| 15 | 群聊消息 | sessionId = `wecom:group:{ChatId}:{FromUserName}` |
| 16 | 同一 MsgId 重推 | 只执行一次 |
| 17 | access_token 过期 | 自动刷新并重试一次 |
| 18 | 长任务超过 5 秒 | 先 ack，后 message/send 回执 |
| 19 | IM 消息包含密码 | 拒绝并提示改用 Web 确认 |
| 20 | 票据重放/改金额/换用户/过期 | 全部拒绝，写审计 |

## 12. 本地演示

### 12.0 一条命令（推荐）

```powershell
npm run im:demo
```

脚本会自动复制临时数据库、启动一个带 `WEBHOOK_SECRET / WECOM_TOKEN / EncodingAESKey / dry-run` 的临时服务，依次演示：签名 Webhook 页面导览、大额转账票据链接、企业微信加密 XML 回调与异步 dry-run 回执，结束后关闭服务并清理临时库。无需企业凭据，也不会改动现场数据。

### 12.1 Webhook

```powershell
# 终端 A：启动项目
$env:WEBHOOK_SECRET="demo-secret"
npm start
```

```powershell
# 终端 B：生成签名并发送
node -e "const c=require('node:crypto');const ts=Math.floor(Date.now()/1000);const body=JSON.stringify({userId:'u-lin',text:'查一下余额',messageId:'msg-001'});const sig=c.createHmac('sha256','demo-secret').update(ts+'\n'+body).digest('hex');fetch('http://127.0.0.1:4173/channel/message',{method:'POST',headers:{'content-type':'application/json','x-channel-timestamp':String(ts),'x-channel-signature':'sha256='+sig,'x-idempotency-key':'msg-001'},body}).then(r=>r.text()).then(console.log)"
```

重复执行同一条命令，应返回同一份结果，且数据库只新增一条消息记录。

### 12.2 企业微信 dry-run

设置：

```powershell
$env:WECOM_TOKEN="demo-token"
$env:WECOM_DRY_RUN="1"
$env:IM_ALLOW_USER_ID_FALLBACK="1"
npm start
```

发送明文 XML：

```powershell
$ts=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$nonce="abc"
$sig=(node -e "const c=require('node:crypto');console.log(c.createHash('sha1').update(['demo-token','$ts','$nonce',''].sort().join('')).digest('hex'))")
```

没有 `echostr` 时签名对象为空串；实际联调以企业微信后台生成的参数为准。dry-run 下服务端只打印 `message/send` 出站包，不访问外网。

## 13. 风险与边界

- **真实企业微信联调需要公网 HTTPS 回调地址与企业后台权限**，本地只能验证协议算法和 dry-run 流程；
- **企业微信 5 秒超时**不可用“同步等待模型”硬扛，必须 ack + 异步；
- **模型不可用时**，IM 仍应返回规则兜底结果，不能返回 500；
- **密码永不过 IM**，确认链接只带随机票据；
- **群聊默认不执行资金动作**，只允许查询和生成待确认链接，避免群内误触发；
- **审计链字段扩展后**，旧记录的哈希校验要兼容：新增字段为空时按旧 payload 计算，避免历史链断裂；
- 本文不构成生产安全认证；真实银行接入还需独立渗透测试、密钥托管、合规评审。

## 14. 定稿结论

官方启动包给出了正确的渠道边界，但只完成了演示级“收、转、发”。本项目的 IM 要经得起评委检查，必须补上四件事：

1. 企业微信真实验签与 AES 解密，而不是回显 `echostr`；
2. 平台 messageId 持久化幂等，避免重复扣款；
3. 用户绑定与固定会话，禁止固定 `u-lin`；
4. 持久化票据 + Web 确认，让 IM 只承载文本，不承载密码。

按第 10 节 P0 → P1 → P2 已完成实施，并用第 11 节用例验收：`npm run im:check` 55/55、`npm run visitor:check` 25/25 通过；333 条浏览器冒烟 + 104 条原专项 + 21 条页面感知全部通过。IM 渠道已经从“材料里的契约”变成“可现场演示的能力”。

---

### 附录 A：官方包文件索引

```text
../参考_IM启动包_bank-agent-starter-0.2.0/bank-agent-starter/
├─ channels/generic-webhook.mjs   通用 webhook（32KB、10 秒去重）
├─ channels/wecom.mjs             token 缓存、发送、dry-run、归一化
├─ channels/README.md             会话格式与新增渠道方法
├─ skills/im-channel/SKILL.md     去重、超时、反模式
├─ shared/rules.ts                digest / ticket / 审计链
├─ track-pi/src/agent.ts          chat / confirm / cancel
└─ docs/03-架构与分层.md           五层结构与五个运行时接口
```

### 附录 B：新增表汇总

```sql
-- 用户绑定
channel_bindings(channel, provider_user_id) PRIMARY KEY, user_id → app_users

-- 消息幂等
channel_messages(channel, message_id) PRIMARY KEY,
  request_digest, response_json, status, created_at, updated_at

-- 跨渠道票据
agent_tickets(id) PRIMARY KEY,
  user_id, session_id, channel, tool, args_json, digest, plan_id,
  status, expires_at, created_at, used_at
```

### 附录 C：与历史草稿的关系

`REQUIREMENTS_1_3_IM_TECHNICAL_DRAFT.md` 是 2026-10-30 早些时候的审稿草稿，保留其第 1、3 项权限与任务规划的详细论证。本文在其基础上补齐了：官方包实测结论、Webhook HMAC、企业微信 AES 细节、绑定与幂等表、票据生命周期、实现落点、55 条验收用例。后续以本文为准。