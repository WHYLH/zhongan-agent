# AI Banking Agent：权限分级、任务规划与 IM 渠道技术准备稿

> 状态：历史草稿（2026-10-30）。IM 渠道的定稿见 [IM_TECHNICAL_PREPARATION.md](./IM_TECHNICAL_PREPARATION.md)；本文保留第 1 项权限分级与第 3 项任务规划的详细论证，供逐段审阅。
>
> 原状态说明：待外部 AI 审稿。本文先准备赛题第 1 项“权限分级机制”和第 3 项“意图理解与任务规划”，同时给出官方 `bank-agent-starter-0.2.0` 参考包的 IM 接入方案。本文只做架构和接口准备，不覆盖当前前端与数据库实现。

## 1. 目标与边界

系统分成六层：

```text
IM / Web / App 请求
        ↓
Channel Adapter：验签、解析、会话映射、幂等、回复格式
        ↓
Intent & Planner：意图识别、槽位补齐、任务 DAG、计划摘要
        ↓
Policy Engine：绿/黄/红权限判定、自动批准策略、强验证要求
        ↓
Executor：查询工具与银行动作工具，按节点顺序执行
        ↓
Audit & Circuit Breaker：审计链、操作回执、失败计数、异常熔断
```

渠道适配器不直接判断“能不能转账”，只把消息转换为统一请求并调用 Agent；权限策略只在服务端执行，前端显示的“查询/确认/完全权限”属于用户体验模式，不能成为后端放行条件。

当前项目已有以下可复用实现：

| 能力 | 当前实现 | 本稿的收束方式 |
|---|---|---|
| 查询/动作工具 | `TOOL_DEFS`、`ACTION_TOOL_DEFS` | 保持查询工具与动作工具分离，模型不能直接调用数据库写操作 |
| 规则预路由 | `detectActionSteps()` | 作为低延迟入口，返回不了确定意图时再调用模型 |
| 风险判定 | `stepSecurityLevel()`、`decisionForStep()` | 统一输出 `level / requiresConfirm / requiresStrongAuth` |
| 执行编排 | `runActionSteps()`、`executeAgentStepInner()` | 采用节点状态机，遇到密码/强验证时暂停而不是继续执行 |
| 审计 | `writeAudit()`、`listAudit()` | 增加计划摘要、渠道、幂等键、票据摘要和结果引用 |
| Webhook | `/channel/message` | 改为统一 Channel Envelope，保留兼容字段 |
| 企业微信 | `/channel/wecom/callback` | 增加签名验签、`FromUserName` 映射、`MsgId` 幂等和异步回执 |

## 2. 第 1 项：权限分级机制

### 2.1 风险级别与执行策略

权限判定不只看“用户当前选择的模式”，而是对每一个计划节点计算风险。节点风险取基础风险、金额风险、目标风险和可逆性风险的最大值。

| 级别 | 默认策略 | 当前比赛演示动作 |
|---|---|---|
| `green` 绿色 | Agent 确认意图后自动执行 | 余额、账户、流水、账单分析、产品收益和订阅查询 |
| `yellow` 黄色 | 先展示计划和影响，等待用户确认 | 小额转账、取消订阅、开通订阅、卡片锁定、生活缴费 |
| `red` 红色 | 必须强验证，验证前不执行动作 | 大额转账、自动批准策略变更、挂失/解挂、理财申购赎回、密码修改 |

赛题规定的日累计 1000 元阈值应作为默认演示策略；实现时同时保留单笔和日累计两个判断：

```text
transferRisk = max(
  baseRisk(transfer),
  amount > 1000 ? red : yellow,
  dailyTotal + amount > 1000 ? red : yellow,
  newPayee ? red : yellow,
  irreversible ? red : yellow
)
```

“完全权限”不会绕过红色强验证。它只表示允许 Agent 进入执行预览，最终是否执行仍由服务端 `PolicyDecision` 决定。这样既能保留演示时的流畅体验，也能对应赛题要求的“高风险强验证”。

### 2.2 服务端决策结构

建议统一为以下结构，前端和 IM 只消费结果，不自行推导权限：

```ts
type PolicyDecision = {
  level: 'green' | 'yellow' | 'red';
  allow: boolean;
  requiresConfirm: boolean;
  requiresStrongAuth: boolean;
  factors: Array<'password' | 'sms' | 'face' | 'u_key'>;
  reasons: Array<{ code: string; message: string }>;
  dailyAmountYuan?: number;
  thresholdYuan?: number;
  ticket?: {
    id: string;
    digest: string;
    expiresAt: string;
    channel: string;
    sessionId: string;
  };
};
```

服务端策略输入必须来自可信数据：

```ts
type PolicyInput = {
  userId: string;
  channel: 'web' | 'app' | 'webhook' | 'wecom';
  sessionId: string;
  nodeId: string;
  tool: string;
  args: Record<string, unknown>;
  amountYuan?: number;
  sourceAccountId?: string;
  targetAccountId?: string;
  targetOwner?: 'self' | 'known_counterparty' | 'unknown';
  reversible: boolean;
  userPolicy: {
    autoApprove: boolean;
    thresholdYuan: number;
    allowInternal: boolean;
    allowSubscription: boolean;
    allowUtility: boolean;
  };
};
```

同一套决策函数必须被 Web、Webhook 和企业微信调用，不能在 `/channel/wecom/callback` 里复制一份“免密判断”。

### 2.3 自动批准与强验证

自动批准只覆盖显式允许的范围：

- 查询类操作始终走绿色路径；
- 本人账户互转可在策略开启时免密；
- 订阅续费、生活缴费只有在策略允许且金额不超过阈值时免密；
- 新增订阅、改变自动批准阈值、密码变更、挂失、理财申购和大额转账强制进入红色路径；
- 红色节点即使 `autoApprove=true` 也必须产生 `requiresStrongAuth=true`。

强验证在本项目中采用 Web 回执卡模拟：

1. Agent 生成计划摘要和 `ticket`；
2. IM 只返回“请打开确认页”，不接收支付密码；
3. 用户在 Web/App 的密码卡或验证卡中完成输入；
4. 服务端校验 `ticket.digest`、用户、会话、过期时间和当前策略；
5. 验证成功后只执行该票据绑定的节点，不能重新解释原始文本。

密码不能通过企业微信文本、通用 Webhook 或 URL 参数传输。确认链接只携带随机票据 ID，票据正文和参数摘要保存在服务端。

### 2.4 审计与异常熔断

每次收到消息至少记录四类审计事件：

```text
intent.received → plan.created → policy.decided → node.executed / node.paused / node.blocked
```

审计字段：

```ts
type AuditEvent = {
  id: string;
  userId: string;
  channel: string;
  sessionId: string;
  idempotencyKey: string;
  planId?: string;
  nodeId?: string;
  intent?: string;
  tool?: string;
  level: 'green' | 'yellow' | 'red';
  decision: string;
  inputDigest: string;
  resultRef?: string;
  createdAt: string;
  prevHash: string;
  hash: string;
};
```

熔断按 `userId + channel` 维度维护，连续密码失败、过期票据重复提交、短时间高频消息和同一幂等键内容不一致时锁定动作入口。查询可以继续，资金动作进入人工接管/重新验证状态。熔断本身也写入审计链，并返回明确的 `circuit_open` 代码，不能只返回通用 500。

## 3. 第 3 项：意图理解与任务规划

### 3.1 统一意图结构

规则识别与模型识别最终都要归一化成同一个结构：

```ts
type Intent = {
  name:
    | 'balance' | 'cashflow' | 'transaction' | 'subscription'
    | 'card' | 'transfer' | 'bill' | 'wealth' | 'loan'
    | 'pay_bill' | 'cancel_subscription' | 'set_policy' | 'other';
  confidence: number;
  slots: Record<string, string | number | boolean>;
  missing: string[];
  evidence: Array<{ source: string; field: string; value: string }>;
  source: 'rule' | 'model';
};
```

规则层负责金额、手机号、日期、页面上下文和已知商户抽取；模型层负责同义表达、上下文省略和多轮语义。模型输出只能进入 `IntentValidator`，不能直接进入执行器。

示例：

```json
{
  "name": "transfer",
  "confidence": 0.94,
  "slots": {
    "payee": "林晓",
    "amountYuan": 100,
    "note": "午餐 AA",
    "fromAccountId": "wb-main"
  },
  "missing": [],
  "evidence": [
    {"source":"user_text","field":"amountYuan","value":"100"},
    {"source":"finance.accounts","field":"fromAccountId","value":"wb-main"}
  ],
  "source": "rule"
}
```

### 3.2 任务 DAG

复杂请求不能使用一段自然语言直接执行，应先生成带依赖关系的计划：

```ts
type PlanNode = {
  id: string;
  dependsOn: string[];
  kind: 'query' | 'decision' | 'action' | 'confirm' | 'strong_auth' | 'open_page';
  tool: string;
  args: Record<string, unknown>;
  state: 'ready' | 'waiting' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  level: 'green' | 'yellow' | 'red';
  evidenceRefs: string[];
};

type TaskPlan = {
  planId: string;
  sessionId: string;
  intent: Intent;
  nodes: PlanNode[];
  digest: string;
  createdAt: string;
};
```

“关闭爱奇艺自动续费并打开腾讯视频自动续费”应拆成：

```text
n1 查询爱奇艺订阅      green
n2 取消爱奇艺续费      yellow，依赖 n1
n3 查询腾讯视频产品    green
n4 开通腾讯视频续费    yellow，依赖 n3
```

“分析上月收支并给出节省意见”应拆成：

```text
n1 读取账户余额        green
n2 读取上月流水        green
n3 分类聚合与异常识别  green，依赖 n2
n4 生成节省建议        green，依赖 n3
```

### 3.3 计划生命周期

```text
RECEIVED
  → NORMALIZED
  → INTENT_RESOLVED
  → SLOTS_FILLED
  → PLAN_PREVIEWED
  → POLICY_CHECKED
  → WAITING_CONFIRM / WAITING_STRONG_AUTH
  → EXECUTING
  → COMPLETED / PARTIAL_FAILED / CANCELLED / CIRCUIT_OPEN
```

执行规则：

1. 计划生成后计算 `digest`，节点参数改变就必须重新生成计划；
2. 绿色查询可以自动执行，结果写入 `evidenceRefs`；
3. 黄色节点暂停并创建确认票据，票据确认后只执行对应节点及其已满足依赖；
4. 红色节点暂停到强验证完成，不能被自动批准策略覆盖；
5. 任一动作失败，后续依赖节点不执行，向用户返回已完成节点和失败节点；
6. 每个动作携带幂等键，重复回调不能产生第二笔转账、第二次扣款或第二次订阅；
7. 用户说“取消”时，未执行节点全部标记 `cancelled`，已完成节点不回滚，回执中明确列出状态。

### 3.4 模型提示词边界

模型负责结构化意图、真实数据查询与动作工具调用；所有动作工具的执行统一进入服务端策略引擎（三色等级、票据、密码、审计），不因调用来源而放宽：

```text
你是银行业务意图解析器。只输出 JSON，不输出 Markdown。
只能选择给定的 intent、tool 和字段；缺字段放入 missing，不要猜。
所有金额、余额、账户、订阅、产品利率必须来自工具证据。
可以调用给定的动作工具；只有工具返回 executed 才能声称扣款、转账或开通。
计划节点只能引用工具目录中的工具，并填写 dependsOn。
```

服务端随后执行：JSON Schema 校验 → 工具白名单校验 → 参数边界校验 → 数据库事实校验 → 权限分级 → 票据签发 → 执行。

## 4. IM 渠道怎么打通

### 4.1 官方启动包提供的抽象

官方 `bank-agent-starter-0.2.0` 的渠道层明确只做三件事：收消息、转给 Agent、发回复。对应文件：

- `channels/generic-webhook.mjs`：接收 `{ userId, text, sessionId? }`，十秒去重，返回 `reply / level / auditSeq`；
- `channels/wecom.mjs`：企业微信 access token 缓存、文本消息归一化、文本消息发送和 dry-run；
- `channels/README.md`：固定会话格式 `webhook:{userId}`、`wecom:{userId}`、`wecom:group:{chatId}:{userId}`；
- `track-pi/src/agent.ts`：会话草稿、确认票据、工具前后钩子和审计链；
- `shared/rules.ts`：工具画像、三色判定、确认票据摘要和 SHA-256 审计链。

这套分层可以直接映射到当前项目，当前 `/channel/message` 与 `/channel/wecom/callback` 应保留为兼容入口，但把共同部分抽成 `normalize → agent → render` 三个函数。

### 4.2 通用 Webhook

建议兼容官方格式，同时支持当前项目字段：

```http
POST /channel/message
Content-Type: application/json
X-Channel-Signature: sha256=<hex>
X-Idempotency-Key: <provider-message-id>
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

```json
{
  "ok": true,
  "sessionId": "webhook:u-lin",
  "reply": "上月收入……，支出……",
  "decision": {"level":"green","requiresConfirm":false},
  "planId": "plan-…",
  "auditSeq": 418
}
```

生产接入需要：请求体上限、签名密钥、时间戳窗口、消息 ID 幂等和速率限制。官方示例使用 `userId:text` 做演示去重；正式实现应优先使用平台 `messageId`，避免用户连续发送相同文本时被错误合并。

### 4.3 企业微信回调

企业微信有两条方向：

```text
用户 → 企业微信 → /channel/wecom/callback → Agent
Agent → 企业微信 message/send → 用户
```

首次配置回调 URL 时，企业微信会发 GET：

```text
GET /channel/wecom/callback
  msg_signature=<signature>
  timestamp=<timestamp>
  nonce=<nonce>
  echostr=<encrypted_echo>
```

必须按企业微信规则用 Token、`timestamp`、`nonce` 排序后 SHA-1 校验 `msg_signature`，加密模式下使用 `EncodingAESKey` 解密 `echostr`，校验成功后原样返回解密字符串。当前项目只回显 `echostr`，这是演示占位，不能作为真实企业微信接入完成的证明。

文本 POST 回调至少读取：

```xml
<MsgType>text</MsgType>
<FromUserName>external-user-or-member-id</FromUserName>
<CreateTime>...</CreateTime>
<MsgId>...</MsgId>
<Content>查余额</Content>
<AgentID>...</AgentID>
```

归一化结果：

```ts
{
  channel: 'wecom',
  providerUserId: FromUserName,
  userId: resolveWecomUser(FromUserName),
  sessionId: `wecom:${FromUserName}`,
  messageId: MsgId,
  text: Content,
  receivedAt: CreateTime
}
```

群聊使用 `wecom:group:{ChatId}:{FromUserName}`，不能把所有企业微信用户都写成当前项目的 `u-lin`。用户映射表建议放在 SQLite：

```text
channel_bindings(channel, provider_user_id, user_id, corp_id, created_at, updated_at)
```

企业微信要求回调尽快返回。查询类请求可以在回调内完成；模型调用或支付流程超过平台超时时间时，先返回“已收到，处理中”，随后通过 `message/send` 发送最终回执。官方 `wecom.mjs` 已经给出了 access token 两小时缓存、提前五分钟刷新和 dry-run 发消息的最小实现。

### 4.4 IM 中的黄色确认与红色强验证

IM 本身只承载文本和确认入口，不承载支付密码：

```text
企业微信：给林晓转 100 元
      ↓
Agent 生成黄色计划 + ticket
      ↓
企业微信：已生成转账计划，点击网页确认后执行：<短链接>
      ↓
用户在 Web/App 输入支付密码
      ↓
POST /api/agent/confirm { ticketId, password }
      ↓
执行单个绑定节点，写入审计，调用企业微信 message/send 回传结果
```

确认链接不能把密码、完整账户号或原始文本放进 URL。短链接只含一次性 `ticketId`，打开后由服务端读取用户、会话、计划摘要和过期时间。

企业微信文本“确认”“取消”可以映射到当前会话的待处理票据，但“确认”必须绑定最近一张未过期票据，且再次校验 `planDigest`；没有待处理票据时返回“当前没有待确认操作”。

### 4.5 当前项目需要补的 IM 代码

现有实现已经具备展示闭环，但距离可答辩的技术闭环还有以下差异：

| 位置 | 当前状态 | 准备改造 |
|---|---|---|
| `/channel/message` | JSON 入站、能调用 Agent、能返回文本 | 加签名、`messageId` 幂等、统一 Envelope、返回 `planId/ticketId` |
| `/channel/wecom/callback` GET | 直接回显 `echostr` | 加 Token/SHA-1，兼容明文和加密模式 |
| `/channel/wecom/callback` POST | 手写正则解析 XML，固定 `u-lin` | XML 解析、`FromUserName` 映射、`MsgId` 幂等、群聊会话 |
| 企业微信出站 | 当前只在回调内同步返回 XML | 接 `gettoken` 缓存和 `message/send` 异步回执 |
| 待确认操作 | Web 有密码卡，IM 只返回提示 | 生成短链接票据，确认完成后回发 IM |
| 会话 | App 有 `userId`，IM 缺独立绑定 | SQLite `channel_bindings` + 固定 sessionId 格式 |
| 审计 | 已有 `writeAudit` | 增加 channel/messageId/planId/nodeId 字段 |

## 5. 建议的实现顺序

### P0：先完成赛题第 1、3 项展示闭环

1. 抽出 `buildTaskPlan()`，统一返回节点、依赖、风险和证据；
2. 抽出 `evaluatePolicy()`，把绿色/黄色/红色判定集中到一个服务端函数；
3. 为黄色和红色节点签发一次性确认票据；
4. 前端展示计划节点、风险级别、确认/强验证状态和执行回执；
5. 写入一条可查询的 Agent 操作审计。

### P1：打通通用 Webhook 和企业微信回调

1. 新增 `channels/normalize.mjs`，统一 Web、Webhook、WeCom 的 Envelope；
2. 新增 `channels/dedupe.mjs`，SQLite 保存 `channel + providerMessageId`；
3. 新增 `channels/wecom-crypto.mjs`，实现验签、AES 解密和回调校验；
4. 把当前 XML 正则替换为字段解析；
5. 接入 access token 缓存与 `message/send` 出站；
6. 确认/密码场景返回 Web 短链接，完成后异步回发 IM。

### P2：跨渠道一致性验收

同一用户分别从 Web、通用 Webhook、企业微信发送相同请求，必须得到相同的：

```text
intent.name
plan.digest
policy.level
requiresConfirm / requiresStrongAuth
执行结果与 audit.resultRef
```

渠道差异只能出现在消息包装方式：Web 显示卡片，Webhook 返回 JSON，企业微信返回文本或图文消息。

## 6. 审稿验收清单

### 权限分级

- [ ] 查询余额和流水走绿色自动执行；
- [ ] 1000 元以内小额转账生成黄色确认卡；
- [ ] 单笔或日累计超过 1000 元进入红色强验证；
- [ ] 自动批准不能绕过红色节点；
- [ ] 挂失、密码修改、理财申购具有强验证标识；
- [ ] 票据绑定用户、会话、工具、参数摘要和过期时间；
- [ ] 重放旧票据、改金额、换用户和跨会话确认均失败；
- [ ] 每个节点都有审计事件，失败和取消同样可查。

### 意图与任务规划

- [ ] 模糊请求先追问一个关键槽位；
- [ ] 多动作请求生成有依赖关系的 DAG；
- [ ] 查询节点先产生证据，动作节点引用证据；
- [ ] 节点失败后不执行后续依赖节点；
- [ ] 用户取消只取消未执行节点；
- [ ] 模型无法调用时规则路径仍能完成已覆盖场景；
- [ ] 模型不得直接返回“已转账”等未执行结果。

### IM

- [ ] 通用 Webhook 有签名、请求体上限、messageId 幂等；
- [ ] 企业微信 GET 验签后返回 echostr；
- [ ] 企业微信 POST 能解析私聊和群聊；
- [ ] `FromUserName` 能映射到内部 userId；
- [ ] access token 有缓存和刷新；
- [ ] 超时任务用异步 `message/send` 回执；
- [ ] IM 不接收密码，确认跳转 Web/App；
- [ ] Web、Webhook、WeCom 对同一计划生成一致 digest 和风险级别。

## 7. 结论

官方启动包最值得直接采用的是渠道边界、固定 sessionId、消息幂等和 Agent 的“意图 → 策略 → 票据 → 执行 → 审计”分层。当前项目的核心业务工具和前端演示已经具备，下一轮应把企业微信的真实验签、用户绑定、出站回执和跨渠道确认补上，并把第 1、3 项要求收敛成同一套服务端计划与策略接口。
