# 众安 Agent

**众安 Agent**（参赛作品名，App 品牌为「众安」）——一个接入了 AI 的移动银行 App（FinTechathon2026 参赛项目）：对话即服务，说出目标即可查账户、办业务、看账单，AI 先查真实资金数据再生成可执行计划。

桌面端是 **顶部品牌栏 + 主内容区**：首页只保留清爽的小安对话与输入框，银行功能集中收在 `#/features` 页面。银行功能分为 **账号、资产、收支、贷款、理财、服务** 六个独立页面，订阅、代扣与自动缴费统一进入 `#/payments` 服务页，设置是独立页 `#/settings`，对话/功能/设置并列放在底部导航。用户说出目标后，Agent 先通过工具查询资金档案、账单、卡片、订阅与交易；办理类请求由模型直接调用动作工具执行（转账、订阅开通/取消、缴费、自动批准、定时转账等），高频话术另有规则引擎兜底解析——所有执行统一经过服务端三色策略与票据强验证。前端不内置规则规划，也不把离线当成正常模式。

当前主前端采用 Kimi 3.1 Pro 审查后的「深曜金融剧场」视觉：默认雾银日间主题，深色主题可切换；手机优先的对话舞台、六功能精密索引、墨金银行卡、统一弹层与细线层级。新版视觉样式位于 `styles/`，图标系统位于 `assets/`，业务接口和数据口径保持不变。

首次进入与刷新默认 **专注模式**，默认浅色主题；深色主题、竖屏预览与首开指引状态会记住，模式切换只在当前会话生效。

## 内置 TTS 语音（本地千问优先的回退链）

小安的开机问候与回复朗读按以下优先级自动选择引擎：

1. **项目内 Qwen3-TTS-0.6B 本地服务**——权重已随项目放在 `models/tts/qwen3-tts-0.6b`（2.4GB，9 个官方音色）。`npm start` 会自动探测 7861 端口，未启动时自动拉起 `scripts\start-qwen-tts.cmd`，随后优先使用本机 Qwen；默认 Serena 温柔女声，支持自然语言语调指令。需要手动控制时也可单独运行该脚本。
2. **千问 qwen-tts 云端 API**——设置 `DASHSCOPE_API_KEY` 时作为第二级（`QWEN_TTS_VOICE` 默认 Serena）。
3. **CosyVoice2-0.5B 本地开源引擎**——`npm run tts:cosyvoice`（阿里 FunAudioLLM 开源）。
4. **kokoro 轻量兜底**——`npm run tts:setup`（CPU 实时，秒出）。
6. **浏览器 Web Speech 女声**——所有本地/云端引擎不可用时的最终兜底，界面行为不变。

## 本地千问 TTS 启动

```powershell
scripts\start-qwen-tts.cmd
```

脚本默认复用 `C:\Users\whylh\Saved Games\ComfyUI-H3\TTS\qwen` 的 Python 环境（含 torch / qwen_tts / fastapi），也可用 `QWEN_TTS_VENV` 指向任意含依赖的 venv。服务启动后 `GET /v1/models` 会返回 9 个音色与实际权重目录；首次合成约 6 秒，之后常驻显存。`npm start` 的自动拉起可用 `QWEN_TTS_AUTOSTART=0` 关闭。`scripts/setup-qwen-tts.py` 只打印环境准备说明，不会联网下载权重。

```powershell
npm run tts:setup   # 下载 kokoro 模型（约 147MB）并安装 sherpa-onnx-node，已装过自动跳过
```

安装后重启 `npm start`，服务端 `/api/tts` 直接返回 WAV 音频；未安装或引擎不可用时自动回退浏览器 Web Speech 女声，界面行为不变。可用环境变量 `TTS_SPEAKER`（音色 id）、`TTS_SPEED`、`TTS_THREADS` 调整。

## IM 渠道（Webhook / 企业微信）

IM 适配器只负责收消息、归一化、验签、幂等与回消息；意图、权限、执行和审计仍走同一套 Agent。专项验收：

```powershell
npm run im:check   # 55 条协议与业务验收
npm run im:demo    # 自动起临时服务，跑签名 Webhook + 加密企微 + 票据链接，结束自动关闭
```

当前 55 条全过，覆盖签名、重放、32KB 上限、企业微信明文/加密回调、群聊会话、用户绑定、token 缓存与失效重试、异步回执、票据确认、审计链、限流熔断和跨渠道一致性。

通用 Webhook：

```http
POST /channel/message
X-Channel-Timestamp: <unix-seconds>
X-Channel-Signature: sha256=<hex>
X-Idempotency-Key: <provider-message-id>
```

签名内容是 `HMAC-SHA256(WEBHOOK_SECRET, timestamp + "\n" + 原始请求体)`，时间窗 300 秒。启动示例：

```powershell
$env:WEBHOOK_SECRET="demo-secret"
npm start
```

企业微信：

```powershell
$env:WECOM_CORP_ID="企业ID"
$env:WECOM_AGENT_ID="应用ID"
$env:WECOM_SECRET="应用密钥"
$env:WECOM_TOKEN="回调Token"
$env:WECOM_ENCODING_AES_KEY="43位EncodingAESKey"
$env:PUBLIC_BASE_URL="https://你的公网地址"
npm start
```

没有企业凭据时用 dry-run 验证协议：

```powershell
$env:WECOM_TOKEN="demo-token"
$env:WECOM_DRY_RUN="1"
npm start
```

渠道安全边界：`FromUserName` 通过 `channel_bindings` 映射到内部用户，未绑定用户不会被静默落到默认账户；设置页「渠道接入」可绑定/解绑企业微信 UserID；群聊默认只允许查询；IM 不接收支付密码，黄色/红色动作返回一次性票据链接，密码只在 `/confirm/<ticketId>` 页面输入。完整协议、测试向量与 55 条用例见 [IM_TECHNICAL_PREPARATION.md](./IM_TECHNICAL_PREPARATION.md)。

## 启动

## 参赛材料

截图中的 01 技术文档和 03 源代码与部署材料已集中整理：

- `参赛材料/01-技术文档/`：系统架构、核心算法、权限安全、任务规划、数据模型与 IM 契约；
- `参赛材料/03-源代码与部署材料/`：源代码清单、环境要求、启动/重置/测试命令和提交包规则；
- `npm run package:submission`：生成排除本机模型、密钥、日志和临时文件的提交 ZIP。

Node.js 24+。SQLite 数据层使用 Node 内置 `node:sqlite`，`npm start` 会自动准备 GitHub 上的 `dsh-our-free-model` 独立网关，读取本机生成的 Key，再启动 Agent；首次启动会拉取仓库，之后直接复用本机网关。

```powershell
npm start
```

打开 <http://localhost:4173>。自定义端口：

```powershell
$env:PORT=8080; npm start
```

## 访客隔离（对外发布）

默认所有访问者共用演示账户；对外发布时开启访客模式，每个访问者独立：

```powershell
$env:VISITOR_MODE="1"
$env:VISITOR_STORAGE_LIMIT_MB="100"
npm start
```

- 第一次访问克隆一份完整工作区，浏览器 Cookie 记住身份，下次回来还是自己的数据
- 不同访客互不可见；不能查看模板用户或其他访客资料，也不能向他们转账
- 企业微信每个 UserID 自动开通独立工作区；在设置里绑定后与网页访客合并
- 访客总容量达到 100MB 时自动淘汰最久未访问的工作区，模板用户不受影响
- 专项验收：`npm run visitor:check`；手动清理：`npm run visitor:prune`

## 发布给别人使用

发布前至少设置访问口令，避免公网链接被直接改数据或消耗 AI 额度：

```powershell
$env:DEMO_AUTH="demo:你的密码"
$env:WEBHOOK_SECRET="你的 Webhook 密钥"
npm start
```

快速公网链接（电脑需保持运行，URL 每次重启会变）：

```powershell
npm run share:mobile
```

长期发布用 Docker 或云主机，带持久磁盘保存 `/app/data`；完整步骤、环境变量、企业微信回调、数据重置和自检命令见 [DEPLOY.md](./DEPLOY.md)。

## 手机实时体验

电脑和手机在同一 Wi-Fi 时，手机直接打开电脑局域网地址：

```text
http://192.168.100.120:4173
```

局域网地址变化时，在电脑执行 `ipconfig`，把上面的地址替换成当前无线网卡 IPv4 地址。手机与电脑不在同一网络时，在项目目录另开一个终端执行：

```powershell
npm run share:mobile
```

命令会启动 Cloudflare 临时隧道并打印一个 `trycloudflare.com` 地址，手机打开这个地址即可。隧道终端保持运行，关闭它后链接失效。`cloudflared` 已安装在当前开发机；换电脑时先安装同名命令行工具。

前端改动保存后，手机刷新页面就能看到最新内容；`server.mjs` 或数据库代码改动后重启 `npm start`，再刷新手机页面。应用静态文件按请求读取，不需要为每次 CSS 或 HTML 修改重新构建。

默认内置模型为 `kilo-auto/free`，由该项目的免费路由自动选择当前可用模型；也可以在启动时固定到 DeepSeek V4.1 Flash 或网关清单里的其它模型：

```powershell
$env:OFM_MODEL = 'glm-5.3-flash-free'; npm start
```

网关源码来自 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)，本项目使用它的独立本地服务 `http://127.0.0.1:18900/v1`。

配置真实模型（OpenAI-compatible Chat Completions）。优先使用自托管聚合网关：

```powershell
$env:AGGREGATOR_BASE_URL = 'http://127.0.0.1:3000/v1'
$env:AGGREGATOR_API_KEY = '你的聚合网关访问令牌'
$env:AGGREGATOR_MODEL = 'auto'
npm start
```

也可以直接配置 Ark：

```powershell
$env:ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
$env:ARK_API_KEY = '你的 Key'
$env:ARK_MODEL = '你的模型 ID'
npm start
```

也兼容 `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL`。变量优先级为 `AGGREGATOR_*` → `AI_GATEWAY_*` → `ARK_*` → `DEEPSEEK_*`。密钥只在服务端读取，不会进入浏览器。聚合网关需要由部署者配置合法上游渠道，项目不内置来源不明的共享 Key。

默认使用硅基流动免费模型 `XingChenAGI/Xing4.0-29B`（中国电信星辰），服务端已配置 Key，接口只返回“已配置”状态，不回显 Key。访客在设置 → AI 模型里可以保存自己的 OpenAI 兼容网关、模型与 Key；这些配置只写当前客户端的 localStorage，并随对话请求通过请求头转发，不写入服务器全局配置。项目维护者仍可通过 `/api/ai/config` 写入本机 `data/ai-config.local.json`（已 gitignore，不进版本库）。

## 页面结构

- **顶部品牌栏**：品牌与日间/夜间切换。功能、设置和对话并列放在底部导航。
- **首页**：只显示小安欢迎语、对话线程、输入框和一行「快捷服务」——六大银行入口统一收在功能页 `#/features`，首页不与功能页重复；快捷服务是用户或小安一句话添加的自定义入口（问小安的话术或直达页面），由 `manage_quick_service` 工具或本地表单创建，偏好只存在本机。
- **银行功能页**：
  - `#/accounts`：银行卡列表与独立账户详情（余额/未偿、额度、账户资料、5 个快捷动作、按月流水）；「查询明细」进入 `#/accounts/<id>/tx` 独立卡流水页。
  - `#/assets`：总资产（含持仓市值）、欠款、资产构成、持仓产品、定期存款与产品目录。
  - `#/cashflow`：收入/支出合计、月份倒序；点击月份进入 `#/cashflow/<YYYY-MM>` 独立月份页；支出分类与逐笔流水。
  - `#/loans`：微粒贷 hero、逐题额度评估（一次一题）、15 款优选产品与分类、贷款计算器、我的贷款（额度/可用）与申请放款。
  - `#/wealth`：19 款在售产品（现金管理/固收/混合基金/商业养老金/定期存款）与深度产品页（业务规则时间线、交易规则、6 份产品档案、收益测算、协议购买）。
  - `#/settings`：主题、专注/详细模式、操作权限、自动批准、竖屏预览、长辈模式、AI 模型配置、语音播报、安全动态、渠道接入、页面说明与新手指引。
- **功能二级页**：`#/features` 承载账号、资产、收支、贷款、理财、服务六个功能入口（仅图标与名称，工行宫格式）；订阅、代扣与自动缴费在 `#/payments` 服务页内查看和处理。进入业务页后主工作区整体切换，页面顶部只有业务标题、更新时间与返回键。各页描述文字默认收起，可在设置页用「页面说明」开关打开。
- **旧路由兼容**：`#/overview`、`#/bills`、`#/subscriptions`、`#/cards`、`#/transactions` 仍可直接访问，但不再作为首页顶层卡片出现。
- **横屏与竖屏**：顶部品牌和主题切换，底部统一使用“对话 / 功能 / 设置”导航；功能页同样是独立主内容，不是抽屉或覆盖层。
- **设置**：按“外观 / 权限 / 智能 / 安全 / 帮助”分区；不放数据刷新、免责/风险/存储叙事。
- **新手帮助**：只在首次打开时自动出现，之后从设置中重新查看。
- **深浅色 / 竖屏**：主题与竖屏偏好写入本地，刷新后保持；专注/详细模式不持久化。
- **竖屏银行 App 交互**：功能页主体独立滚动，银行卡卡片单列展示，账户详情保留卡片头部、快捷服务和月份流水展开，并为底部系统手势区留出安全区空间。研究记录见 [FRONTEND_MOBILE_REVIEW.md](FRONTEND_MOBILE_REVIEW.md)。
- **视觉系统**：统一深松绿/暖白/琥珀状态色、线性 SVG 图标、加载骨架、页面进入动效和减弱动效支持。完整调研与公开来源见 [VISUAL_RESEARCH.md](VISUAL_RESEARCH.md)。

## 数据接口

GET 接口用于读取，`Cache-Control: no-store`，支持 HEAD；资金与配置动作使用 POST（转账、订阅、缴费、贷款申请、理财申购、AI 配置等，见下文服务接口表）。

| 接口 | 内容 |
|---|---|
| `/api/health` | 服务状态、AI 配置、可用工具与接口索引 |
| `/api/overview` | 首页汇总、账户、负债、计数与提示 |
| `/api/profile` | 完整档案：用户、账期、账户、负债 |
| `/api/bills` | 账期内账单与合计 |
| `/api/cards` | 银行卡/信用卡、额度与状态 |
| `/api/subscriptions` | 订阅、代扣、授权与拦截状态 |
| `/api/transactions?category=&limit=` | 交易明细，支持分类与条数过滤 |

SQLite 数据层位于 `data/finance.sqlite`，由 Node 24 内置 `node:sqlite` 读写（服务操作实时写库，账期数据保持只读语义）。数据库保留平台与账户层级用于计算资产和流水归属；账号页面只把银行卡作为用户入口，点击后进入该银行卡详情。

| SQLite 接口 | 用途 |
|---|---|
| `/api/finance/summary` | 数据集截止日、账户/订阅/流水数量、资产负债和完整性校验 |
| `/api/finance/platforms` | 平台清单：众微银行（当前种子仅 1 个平台） |
| `/api/finance/accounts` | `roots` 返回折叠树，`items` 返回平铺账户；包含余额、授信和可用额度 |
| `/api/finance/accounts/:id` | 单个账户详情和该账户最近流水 |
| `/api/finance/transactions` | 流水明细筛选：`platform`、`account`、`direction`、`from`、`to`、`category`、`subscription`、`limit`、`offset`、`order` |
| `/api/finance/monthly` | 指定日期范围或平台的月度收入、支出、转账汇总 |
| `/api/finance/products` | 众微银行公开产品目录、收益标签与来源日期 |
| `/api/finance/meta` | SQLite 数据集版本、截止日期和历史窗口 |
| `/api/finance/subscriptions` | 固定订阅、扣款账户、月费和历史扣款事实 |

示例：

```text
/api/finance/transactions?platform=微信支付&direction=expense&from=2026-08-01&to=2026-08-31
/api/finance/transactions?account=wb-debit&direction=income&from=2026-08-01&to=2026-10-23
```

重新生成确定性数据库或校验现有数据库：

```powershell
npm run db:seed
npm run db:check
npm run db:info
```

原有展示接口保持兼容；新的金融查询接口直接读取 `data/finance.sqlite`。替换为真实数据源时，只需保持 SQLite 查询层返回字段，前端与 Agent 工具协议无需改动。

## 桌面银行服务（实装）

应用以唯一使用账号 **林予安** 直接进入，首次打开先显示新手指引；引导结束后弹出默认模型说明（硅基流动免费模型的能力边界与自定义配置入口），确认后弹出欢迎资料窗；点「查看资料」展示资产概况、银行卡号与查询密码（默认 `123456`，可在「密码管理」中实时修改），确认后落在小安对话首页。**各功能页右下角都有小安悬浮球**（对话首页不显示），点击唤起悬浮对话框；关闭按钮 / 点遮罩 / Esc / 再点悬浮球都能退出。首页与悬浮对话框均支持**语音识别**：竖屏手机按住说话、松开发送（聆听时有声波动画），横屏与桌面点一下开始、再点一下确认结束；录音由浏览器 MediaRecorder 采集后上传 `/api/asr`，服务端用已配置的 OpenAI 兼容语音识别模型（默认 `XingChenAGI/XingChenASR-V3.2-Ultra`）转写，不再依赖浏览器自带识别。服务的 `Permissions-Policy` 已放行同源麦克风。每条小安回复自带 **🔊 朗读**，服务端优先使用本机 Qwen3-TTS（9 个官方音色 + 自然语言语气指令，设置页可调音色/语气/语速并试听），未启动本地服务时回退 DashScope 千问或本地 kokoro。沈知微、顾清晏两位用户的众微银行全量账户作为**转账收款方**数据存在——转账汇款的"众微银行账户"收款方包含他们的银行卡，选择即实时跨用户转账，对方账户实时入账并收到通知。小安的对话资金档案（五工具查询）同样按当前账号隔离。

账户详情页的快捷动作已从提示占位升级为可操作服务：

| 动作 | 行为 |
|---|---|
| 转账汇款 | 支持对手方转账与本行账户互转；校验支付密码与余额，实时更新账户余额并生成回执单号（可复制），附审计与通知记录 |
| 复制卡号 | 复制完整银行卡号（不再只复制脱敏号码） |
| 账户挂失 | 实时冻结账户（收付款/转账立即停止，卡片状态显示「已挂失」），支持解除挂失；原因可选，写入挂失工单 |
| 密码管理 | 查看当前密码、修改密码（原密码校验 + 6 位数字），新密码立即用于转账校验 |
| 查询明细 | 进入该卡独立流水页，按月份展示全部交易 |

服务数据（用户/凭据/挂失工单/实时转账/审计/通知）保存在 SQLite 的独立服务表中，与历史账期数据隔离；实时转账通过服务台账记账，`npm run db:check` 会同时校验台账与余额一致。服务操作通过审计日志留痕（`/api/bank/audit`）。

| 桌面银行服务接口 | 用途 |
|---|---|
| `/api/bank/users` | 用户列表 |
| `/api/bank/users/:id/overview` | 用户资料：资产概况、银行卡号、查询密码、通知与最近转账 |
| `/api/bank/credentials?user=&accountId=` | 单卡凭据（卡号/密码） |
| `POST /api/bank/transfer` | 实时转账（密码校验 + 余额校验 + 台账记账 + 回执） |
| `POST /api/bank/password` | 修改查询密码 |
| `POST /api/bank/loss-report` | 挂失 / 解除挂失 |
| `/api/bank/transfers?user=` / `/api/bank/notifications?user=` / `/api/bank/audit?user=` | 服务台账 / 通知 / 审计查询 |

`/api/finance/*` 与 `/api/bank/*` 均支持 `?user=` 参数按用户过滤数据（默认用户视角与历史行为一致）。

## Agent 工作流

`POST /api/agent` 只接收用户目标：

```json
{ "text": "近三个月哪个分类花得最多？" }
```

服务端随后：

1. 把五个查询工具交给模型：`get_profile`、`get_bills`、`get_cards`、`get_subscriptions`、`get_transactions`。
2. 模型先返回 `tool_calls`，服务端执行工具并把结果回传给模型。
3. 五个工具至少各调用一次后，模型输出结构化计划。

响应：

```json
{
  "ok": true,
  "source": "ai",
  "provider": "模型 ID",
  "model": "模型 ID",
  "latencyMs": 1820,
  "queries": [
    { "tool": "get_profile", "label": "资金档案", "count": 6 },
    { "tool": "get_bills", "label": "账单分析", "count": 150 }
  ],
  "plan": {
    "summary": "……",
    "risk": "……",
    "actions": [
      { "title": "……", "detail": "……", "amount": 436, "type": "transfer" }
    ]
  }
}
```

系统提示只描述角色、工具使用规则与 JSON 结构，不包含具体金额、场景或预设计划。计划中的数字由工具结果提供。

## 失败处理

没有 Key、上游超时、上游 5xx、返回格式不可解析时，接口返回非 2xx：

```json
{
  "ok": false,
  "error": {
    "code": "AI_NOT_CONFIGURED",
    "message": "AI 模型服务尚未配置，当前无法生成计划。",
    "retryable": true
  }
}
```

前端展示“小安暂时没有拿到结果”与原始原因，并提供**重试**和**检查设置**。未配置模型时，服务端仍会用本地规则完成常见意图（查收支、消费分析、推荐贷款、转账、订阅、缴费），开源问答类请求才返回 503。

## 测试

```powershell
npm run check
npm run smoke
npm run im:check
npm run visitor:check
```

- `check`：内联脚本语法、默认专注/浅色、首页入口卡、六个独立页面与 hash 路由、无右侧面板/抽屉、极简设置、零外链、无重复 id、无冗余说明文案、六个接口一致性、HEAD/405/404/400/503 行为，以及 mock 模型“五工具查询 → 计划”的完整链路和上游失败 502。
- `smoke`：329 条浏览器断言；首开指引、默认专注与刷新重置、清爽对话首页、六个页面逐一点击进入并从顶部返回 Agent、页面标题与独立路由、深链直达、设置与主题/竖屏、真实接口失败 + 重试、模型成功计划、竖屏独立功能页与底部导航、320–1440 五档宽度无横向溢出。
- `im:check`：55 条 Webhook/企业微信协议与业务验收。
- `visitor:check`：25 条访客隔离、企微自动开通、容量淘汰与审计链验收。

## 主要文件

| 文件 | 作用 |
|---|---|
| `index.html` | 完整前端：首页 Agent、六个独立功能页与 hash 路由、主题、竖屏布局、极简设置、首开指引、对话与失败重试 |
| `server.mjs` | 静态服务、数据接口、模型调用、五个 Agent 查询工具 |
| `db.mjs` | SQLite 连接、账户树、余额、流水筛选、月度汇总与完整性校验 |
| `scripts/seed-db.mjs` | 确定性生成众微银行、微信支付、微粒贷授信来源、信用卡、订阅和三个月流水 |
| `data/finance.sqlite` | 当前可直接运行的 SQLite 数据文件 |
| `scripts/check.mjs` | 静态 + 接口 + 工具链路检查 |
| `scripts/smoke.mjs` | 浏览器冒烟测试 |


### 行业对标与产品来源

项目以 Revolut AIR 的“单一对话入口 + 账户内动作”作为交互参考。众微银行产品目录通过 SQLite 的 `financial_products` 表和 `/api/finance/products` 提供，收益字段保留来源地址、观察日期和动态/历史说明。
