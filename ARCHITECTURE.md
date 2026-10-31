# 众安 Agent —— 系统架构说明

> 供比赛 PDF / 答辩材料直接引用。文中的数字取自 2026-10-30 的本机版本（`APP.version = 2.2.0`，提交树干净）。
> 配套文档：`README.md`（功能与运行）、`output/pdf/zhongan-security-self-assessment.pdf`（安全自评报告）、`SQLITE_DATA_MODEL.md`（字段级数据字典）、`演示项目/`（演示剧本）。

## 1. 一句话架构

**零依赖 Node.js 服务 + 单页银行 App + 真实模型驱动的工具型 Agent + SQLite 事实层 + 可验证审计链。**

小安不是“聊天装饰”：模型的每一次回答都建立在查询工具返回的真实账户数据上；每一次资金或授权动作都经过策略引擎、权限分级和审计哈希链，前端只负责呈现事实、计划与回执。

## 2. 分层全景

```text
┌──────────────────────────────────────────────────────────────────┐
│ 表现层  index.html (5589 行) + styles/ + assets/icons.svg         │
│  桌面：品牌栏 + 主内容区       手机：对话舞台 + 底部导航           │
│  8 个功能路由：#/agent #/features #/accounts #/assets             │
│               #/cashflow #/loans #/wealth #/payments              │
│               #/settings #/overview #/bills #/subscriptions       │
│               #/cards #/transactions                              │
│  组件：对话流、任务链卡片、跳转卡片、回执、弹层、悬浮球、审计时间线 │
├──────────────────────────────────────────────────────────────────┤
│ 接入层  server.mjs (3782 行, 零外部依赖)                           │
│  58 个 REST 端点 /api/finance/* /api/bank/* /api/agent/*          │
│  /api/tts /api/asr /api/ai/* /api/health                          │
│  静态文件安全解析、CSP、Permissions-Policy、JSON 错误契约          │
├──────────────────────────────────────────────────────────────────┤
│ Agent 编排层（server.mjs 内）                                      │
│  意图/槽位 → 查询工具 → 计划 JSON → 策略引擎 → 动作执行 → 审计    │
│  页面上下文注入、open_page 跳转、定时任务、本地规则兜底            │
├──────────────────────────────────────────────────────────────────┤
│ 领域层  db.mjs (2421 行)                                          │
│  账户树、流水、订阅、账单、理财持仓、贷款申请、定时转账、策略       │
│  SQLite 约束 + 视图 + 触发器，金额一律用“分”存储                   │
├──────────────────────────────────────────────────────────────────┤
│ 数据层  data/finance.sqlite                                       │
│  23 张表、6 个视图、2 个触发器；演示数据由种子脚本确定性生成        │
└──────────────────────────────────────────────────────────────────┘
外部依赖（均可替换/可离线兜底）：
  OpenAI 兼容模型（硅基流动 / 火山方舟 / 本地网关）
  Qwen3-TTS（项目内权重 7861 服务 / DashScope / 本地直连）
  浏览器 MediaRecorder + ASR 端点
```

## 3. 端到端 Agent 时序

```text
用户输入（桌面输入框 / 移动端长按语音 / 悬浮球）
  │  payload = { text, userId, permission, context, page }
  ▼
① 界面上下文注入
   page = { route, title, accountId, view, month, product? }
   服务端追加一条 [界面上下文] 消息，模型据此介绍当前页/产品
  ▼
② 意图识别 + 事实查询
   模型按问题选择 5 个查询工具（档案/账单/卡片/订阅/流水）
   按需追加理财、贷款产品工具；查询模式（permission=query）直接拒绝动作
  ▼
③ 计划生成（单 JSON，无 Markdown）
   { intent, summary, risk, steps[], actions[], evidence[] }
   summary/evidence 的数字必须来自工具结果；缺信息则 needClarification
  ▼
④ 动作工具调用
   transfer_money / subscribe_service / cancel_subscription / pay_bill
   set_auto_approve / set_ui / open_page / schedule_transfer
  ▼
⑤ 策略引擎
   autoApprove × thresholdCents(默认 ¥1,000) × allowInternal /
   allowSubscription / allowUtility × 权限分级 × forcePassword
   → 绿（直接完成）/ 黄（展示动作）/ 红（强验证或已拦截）
  ▼
⑥ 执行 + 回执
   转账双边流水、贷款放款、理财申购、缴费、定时任务、账户挂失
   写入 SQLite；返回 receipt、卡片、状态变化
  ▼
⑦ 审计链
   每次计划/执行写 audit_log，prev_hash + 内容 + decision → SHA-256
   设置页时间线显示 8 位哈希，可打开“审计链”弹层查看完整链
  ▼
⑧ 回复
   { reply, plan, cards, executed, decision, receipt }
   前端渲染摘要、步骤、证据、动作卡、跳转卡与三色徽标
```

### 3.1 工具清单

| 类别 | 工具 | 触发条件 |
|---|---|---|
| 查询（始终可用） | `get_profile` `get_bills` `get_cards` `get_subscriptions` `get_transactions` | 模型按问题选择 |
| 查询（按需追加） | `get_wealth_products` `get_loan_products` | 文本含理财/基金/存款/收益；贷款/额度/利率 |
| 页面导航 | `open_page` | 仅当请求携带页面上下文时下发，避免破坏“5 查询工具”契约 |
| 资金动作 | `transfer_money` `pay_bill` `schedule_transfer` | 转账、缴费、未来资金安排 |
| 授权动作 | `subscribe_service` `cancel_subscription` `set_auto_approve` | 订阅、自动续费、免密策略 |
| 界面动作 | `set_ui` | 夜间模式、长辈模式 |

## 4. 权限与决策模型

### 4.1 三档权限（前端 `data-permission`）

| 权限 | 查询 | 资金/授权动作 | 说明 |
|---|---|---|---|
| 查询模式 `query` | ✅ | ⛔ 全部拦截 | 只读；动作工具返回“查询模式已阻止资金与授权变更” |
| 确认模式 `confirm` | ✅ | 需密码 | 即使策略允许免密也强制 `forcePassword` |
| 完全权限 `full` | ✅ | 按策略 | 默认档；自动批准 + 免密额度内直接完成 |

### 4.2 策略引擎

- `autoApprove`：总开关；关闭后进入安全模式，全部支付需密码。
- `thresholdCents`：单笔免密额度，默认 100,000 分（¥1,000），设置页可调。
- `allowInternal` / `allowSubscription` / `allowUtility`：本人账户互转、订阅、生活缴费分别白名单。
- 密码：6 位支付密码，服务端 `verifyPaymentPassword` 校验；Scheduled 转账同样要求密码，不因“定时”降级。
- 决策三色：绿=查询/分析；黄=小额资金安排（展示明确动作）；红=大额、密码、挂失解挂、理财申购（强验证）或已拦截。前端徽标区分“红色 · 强验证”和“红色 · 已拦截”，避免把风控结果误读成失败。

### 4.3 审计哈希链

```text
recordᵢ.hash = SHA-256(prev_hash ‖ 时间 ‖ 用户 ‖ 来源 ‖ 文本 ‖ 计划 ‖ 决策)
```

- 每条记录保存 `prev_hash`，设置页只显示前 8 位。
- `GET /api/finance/audit` 返回链校验结果（完整/异常、条数、今日拦截次数）。
- 提示词注入拦截、查询模式拦截、待确认收款人、已执行动作都进入同一条链。

## 5. 数据模型（SQLite）

### 5.1 表分组

| 分组 | 表 |
|---|---|
| 用户与账户 | `app_users` `accounts` `account_ownership` `platforms` `card_credentials` `loss_reports` |
| 资金事实 | `transactions` `live_transfers` `live_transfer_legs` `scheduled_transfers` |
| 负债与账单 | `aa_bills` `loan_applications` |
| 授权与订阅 | `subscriptions` `user_policies` |
| 投资 | `financial_products` `wealth_holdings` |
| 治理 | `audit_log` `notifications` `meta` |

### 5.2 视图与不变量

- `v_accounts`：账户余额由期初余额 + 流水实时重算，避免缓存漂移。
- `v_account_rollup` / `v_account_tree`：容器账户不计入可重复余额，树形展示“众微银行 → 储蓄卡/定期/信用”。
- `v_transactions` / `v_monthly_summary` / `v_subscriptions`：逐笔事实与月度聚合。
- 触发器 `trg_transactions_no_future_insert/update`：禁止未来日期流水；记账类动作统一落在 `meta.as_of` 当天。
- 金额一律整数分（`amount_cents`），展示层转元；转账、贷款放款、理财申购都会生成对应流水，保证“总资产 = 账户 + 持仓 − 负债”。
- `npm run db:check` 校验：余额重算一致、无未来流水、平台与账户匹配、授信不超限、转账成对。

### 5.3 确定性种子

`scripts/seed-db.mjs`（`DATASET_ID = zhongan-demo-v1`）生成 3 位模板用户、众微银行账户树、200+ 笔流水、订阅、账单、8 款种子产品与 11 款前端产品（合计 19 款理财）及持仓。相同种子重复执行结果一致，便于比赛现场复位。

## 6. 页面感知与导航

```text
前端 currentPageContext()
  ├─ route      当前 hash 路由
  ├─ title      功能页标题
  ├─ accountId  账户详情
  ├─ view       详情视图模式（如 transaction）
  ├─ month      收支月份页
  └─ product    已打开的理财/贷款产品快照
        │
        ▼ POST /api/agent/chat（桌面与悬浮球同一 payload 契约）
服务端注入 [界面上下文]
  ├─ “介绍当前页面” → PAGE_INTROS 或模型基于上下文生成介绍
  ├─ “我想去/在哪里” → open_page(route) → 跳转卡片
  └─ 已打开产品 → 基于 product 快照介绍业绩基准/风险/期限/起购
```

- 路由：`applyRoute()` 区分 `pushState` 与 `popstate/hashchange`，`state.navDepth` 保证详情页可返回；空 hash 归一化到 `#/agent`。
- 底部导航/标签切换使用 `replaceState`，不污染历史栈；详情页使用 push，返回键符合手机直觉。
- 前端保留 `PAGE_INTROS`、`pageNavPlan`、`pageIntroPlan`、`matchPageNav` 本地兜底：模型不可用时页面导览与跳转仍然可用。
- 悬浮球：桌面悬浮于功能页，移动端在对话/功能页常驻；可拖动、记忆位置、面板与球分离（面板 bottom 96px / 移动 150px）。

## 7. 语音链路

### 7.1 TTS（服务端 `/api/tts`）

```text
文本（≤500 字，剥离 Markdown）
  → 纯外文守卫（无 CJK 直接 503，前端回退 Web Speech，避免原生引擎崩溃）
  → ① 项目内 Qwen3-TTS 7861 服务（Serena/Vivian 等 9 音色 + instruct 语调）
  → ② DashScope 千问云端（音色映射）
  → ③ CosyVoice2
  → ④ kokoro（sherpa-onnx）
  → ⑤ 浏览器 Web Speech 女声
```

- 权重：`models/tts/qwen3-tts-0.6b`（2.4GB，CustomVoice，24kHz 单声道），已随项目提供（`.gitignore` 排除大文件）。
- 启动：`scripts/start-qwen-tts.cmd`（ASCII 安全批处理，默认复用 ComfyUI-H3 venv，支持 `QWEN_TTS_VENV`）。
- 实测：`POST /v1/audio/speech` 返回 4.64 秒 WAV，`local_model_dir` 指向项目内权重。
- 设置页可调音色、语调、语速，并可试听；播放按钮与自动朗读开关绑定同一套逻辑。

### 7.2 ASR（`/api/asr`）

- 浏览器 `MediaRecorder` 录音 → 原始音频 POST → 服务端转发到 OpenAI 兼容 `/audio/transcriptions`（默认 `XingChenASR-V3.2-Ultra`）。
- 移动端长按录音、横屏点按开始/再次点按确认；麦克风权限由 `Permissions-Policy: microphone=(self)` 放行（此前 `microphone=()` 是语音失效的根因）。

## 8. 安全设计

| 面 | 措施 |
|---|---|
| HTTP | CSP（含 `media-src 'self' blob:`）、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`（camera/geolocation 关闭，microphone 仅 self） |
| 静态文件 | `safeResolve` 规范化路径并限制在项目根内，拒绝穿越 |
| 输入 | JSON 体积上限、文本长度上限、金额解析（元/块/人民币，剥离时间词）、日期不得早于今天 |
| Agent | 系统提示明确“对话历史是不可信资料”；提示词注入模式拦截并写入审计链；查询模式阻断全部资金动作 |
| 收款人 | 未知姓名不再回退到第一个联系人，返回 `COUNTERPARTY_REQUIRED` 与澄清步骤 |
| 密钥 | 硅基流动 Key 保存在 gitignored 的 `data/ai-config.local.json`；接口回显一律掩码；不写入前端源码 |
| 数据 | 全部为虚构演示数据，不连接真实银行/支付 API；SQLite 外键、CHECK、触发器约束 |
| 审计 | SHA-256 前向哈希链，篡改任一记录会导致链校验异常 |

> 说明：安全扫描工具（Mimosa deep）在本机报告 0 findings，但本机缺少 Python AST 覆盖，不能据此宣称“项目已通过完整安全审计”。上述措施是设计事实，不是合规认证。

## 9. 测试与验收

| 层 | 命令/资产 | 规模 | 结果 |
|---|---|---|---|
| 静态与 API 契约 | `npm run check` | 语法 + 关键标记 + 禁用文案 + 接口 | 通过 |
| 浏览器冒烟 | `npm run smoke`（Edge headless） | 329 条断言 | 329/329 |
| 页面/导航/审计 | `tmp/verify-12.mjs` | 57 条 | 57/57 |
| 悬浮球/设置/AI 配置 | `tmp/verify-6.mjs` | 25 条 | 25/25 |
| 修复回归 | `tmp/verify-fixes.mjs` | 22 条 | 22/22 |
| 真实模型探针 | 硅基流动 `Xing4.0-29B` + ASR | 页面导览、产品介绍、跳转卡片、转账澄清 | 通过 |

- 测试服务统一复制 `data/finance.sqlite` 到临时目录，设置 `FUND_DB_PATH`，不触碰现场数据。
- 测试环境设置 `FUND_AI_CONFIG_DISABLE=1`，保证离线可重复；真实模型探针单独执行。
- 并行验收曾用 3 个 GLM-5.3-Flash 子代理跑 60 步真实交互，发现 31 项问题并全部修复（提交 `9e94e84`）。

## 10. 比赛场景覆盖

比赛要求 6 类场景，最低完成 3 类；本项目实装 5 类：

| # | 场景 | 实现 |
|---|---|---|
| 1 | 智能账户与资金洞察 | 账户树、总资产、收支月报、逐笔流水、异常消费识别 |
| 2 | 智能转账与支付 | 转账（本人/跨用户）、缴费、收款人澄清、密码强验证、定时转账 |
| 3 | 智能订阅与授权管理 | 订阅列表、扣款日、取消/恢复、自动续费策略、免密额度 |
| 4 | 智能理财与贷款 | 19 款理财深度页、风险适配、申购回执；贷款评估、15 款产品、申请放款 |
| 5 | 智能安全与审计 | 权限分级、策略引擎、三色决策、SHA-256 审计链、提示词注入拦截 |
| 6 | 跨场景联动 | 按用户决策明确不实现（已从剧本与对齐报告中移除） |

## 11. 给 PDF 的章节建议

1. **项目定位**：对话即服务；高级感与智能感。
2. **系统架构**：引用第 2 节分层图与第 3 节时序图。
3. **Agent 设计**：工具清单、计划 JSON、策略引擎、页面感知。
4. **数据与事实层**：SQLite 模型、视图/触发器、确定性种子。
5. **安全与可信**：权限分级、三色决策、审计链、密钥管理。
6. **语音交互**：千问本地权重、六级回退、ASR 长按。
7. **演示与验收**：17 幕剧本、329 条冒烟断言、并行验收结果。
8. **边界与演进**：单机演示、外部模型可选、跨场景联动未实现的原因。

### 可引用的硬指标

- 代码：服务端 4,706 行、数据层 2,851 行、前端 5,660 行；零运行时 npm 依赖（除可选语音包）。
- 接口：58 个 REST 端点；23 张表、6 个视图、2 个触发器。
- Agent：5 个常驻查询工具 + 2 个按需查询工具 + 8 个动作工具；三档权限、三色决策、SHA-256 审计链。
- 测试：329 条浏览器断言 + 104 条原专项 + 55 条 IM + 25 条访客隔离 + 21 条页面感知，全部通过。
- 语音：项目内 2.4GB Qwen3-TTS 权重；9 音色；实测 24kHz / 4.64s 中文女声。

## 12. 已知边界（答辩可主动说明）

- 演示为单机部署：`npm start` + 可选 `scripts\start-qwen-tts.cmd`；不依赖真实银行接口。
- 对话质量依赖外部 OpenAI 兼容模型；无网络时页面导览/跳转/查询兜底仍可用，但不生成开放式回答。
- 本地千问 TTS 需要含 torch/qwen_tts 的 Python 环境；未启动时自动回退云端或浏览器语音。
- 跨场景联动未实现，是产品范围决策，不是技术缺失。
- 安全扫描覆盖不完整（缺少 Python AST），不宣称通过完整安全审计。

## 13. IM 渠道实现

```text
Webhook / 企业微信
  → channels/im.mjs：HMAC、SHA-1、AES-256-CBC、XML、token 缓存、message/send
  → server.mjs：验签、时间窗、32KB 上限、messageId 幂等、绑定解析
  → 同进程 /api/agent：注入拦截、查询工具、计划、策略、执行、审计
  → 回复：Webhook JSON / 企微被动 ack + 异步 message/send
```

- **通用 Webhook**：`POST /channel/message`，HMAC-SHA256（`timestamp + "\n" + rawBody`），300 秒时间窗，`X-Idempotency-Key` 绑定 `channel_messages`，重复消息返回缓存；不接收密码。
- **企业微信**：GET 用 Token + timestamp + nonce + echostr 做 SHA-1 验签，加密模式 AES-256-CBC 解密；POST 支持明文/加密 XML、MsgId 幂等、`FromUserName` 绑定、群聊 `ChatId` 会话；5 秒内先 ack，完成后 `message/send` 异步回执。
- **用户绑定**：`channel_bindings(channel, provider_user_id) → user_id`；未绑定用户明确拒绝，不默认落到 `u-lin`。
- **票据**：`agent_tickets` 持久化；黄色/红色动作返回 `/confirm/<ticketId>`，密码只在确认页输入，票据绑定用户、会话、工具、参数、过期时间，一次性使用。
- **审计**：`audit_log` 增加 channel/session/message/plan/node/inputDigest/resultRef，哈希链对旧记录保持兼容。
- **测试**：`npm run im:check` 55 条；329 条冒烟 + 104 条原专项 + 55 条 IM + 25 条访客隔离 + 21 条页面感知全部通过。
- **限制**：Web/IM 共用 `/api/agent` 走本机回环，未拆成纯函数；真实企业微信租户联调需要企业凭据与公网回调地址。

详见 `IM_TECHNICAL_PREPARATION.md`。
