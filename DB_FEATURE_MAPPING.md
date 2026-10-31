# 模拟银行账户数据映射

本项目的银行账户、流水、订阅扣款和产品目录全部由 `scripts/seed-db.mjs` 生成，持久化在 `data/finance.sqlite`。前端只通过服务端的只读接口读取这份数据库，因此页面上的余额、账户关系和交易明细来自同一份可复算数据源。

## 数据集

- 数据集：`fund-safety-steward-demo-v1`
- 账期：2026-08-01 至 2026-10-23，连续 3 个月
- 流水：200 笔，包含收入、支出和成对的内部转账；2026-08 至 2026-10 连续覆盖
- 主银行：众微银行
- 授信/扣款来源：微粒贷、招商银行经典白金信用卡
- 固定扣款：爱奇艺 VIP、Keep、网易云音乐、iCloud+ 历史订阅；自来水费、居民电费（2026-11 起银行代扣）
- 产品目录：微粒贷、活期+、活期+Plus、兴银添利宝

## 账户层级

`accounts` 表以父子树保存账户。平台容器只负责分组，不重复计入余额；实际资产和负债节点才进入汇总。

| 节点 | 类型 | 页面用途 |
|---|---|---|
| 众微银行 | `BANK_GROUP` | 主账户平台容器 |
| 众微银行储蓄卡·工资卡 | `BANK_DEBIT` | 主账户余额、工资代发、日常支出 |
| 众微银行储蓄账户·备用金 | `BANK_SAVINGS` | 储蓄分配项；`is_payable=0`，不作为可支付账户 |
| 微粒贷·消费备用额度 | `WEBANK_CREDIT` | 众微银行授信和扣款来源 |
| 微信支付零钱 | `WECHAT_PAY` | 绑定支付对象和小额扣款来源 |
| 招商银行经典白金信用卡 | `CREDIT_CARD` | 外部信用卡负债与可用额度 |

## 银行页面

| 页面 | 接口 | 主要字段 |
|---|---|---|
| `#/features` 功能首页 | `/api/finance/summary` | 六个功能入口（账号/资产/收支/贷款/理财/订阅与代扣），仅图标与名称 |
| `#/accounts` 账号 | `/api/finance/accounts`、`/api/finance/accounts/:id` | 只列出 `BANK_DEBIT` / `CREDIT_CARD` 银行卡；详情使用 `masked_number`、`current_balance_yuan`、`credit_limit_yuan`、`available_credit_yuan`、`opened_on`、`metadata` 与最近流水 |
| `#/accounts/:id` 账户详情 | `/api/finance/accounts/:id` | 卡片头部、人民币余额/未偿、8 个快捷动作、额度、基本账户、启用/到期日期、账户互转、卡片管理、其他服务、删除账户与按月展开流水 |
| `#/assets` 资产 | `/api/finance/summary`、`/api/finance/accounts`、`/api/finance/products` | `totals.assets_yuan`、`liabilities_yuan`、`net_yuan`、`available_credit_yuan`、`reserveFunds`、`items` |
| `#/cashflow` 收支 | `/api/finance/summary`、`/api/finance/monthly`、`/api/finance/transactions` | `income_yuan`、`expense_yuan`、`transfer_yuan`、`month`、`category`、`direction`、`merchant`、`counterparty`、`amount_yuan`、`balance_after_yuan`、`status`；月份倒序、点击展开逐笔明细 |
| `#/loans` 贷款 | `/api/finance/accounts`、`/api/finance/products` | `account_class=liability`、`credit_limit_yuan`、`available_credit_yuan`、`billing_day`、`due_day` |
| `#/wealth` 理财 | `/api/finance/summary`、`/api/finance/products` | 可配置资产、现金账户（占比文本）、定期存款与众微银行产品目录 |
| `#/payments` 服务 | `/api/finance/subscriptions`、`/api/bank/subscriptions/cancel` | 我的生活品牌宫格（缴费·影音·内容）、生活代扣与订阅服务分组 |
| `#/payments` 服务 | `/api/finance/subscriptions`、`/api/bank/subscriptions/cancel` | `monthlyActive`、生活代扣（水费/电费/话费/宽带）与订阅服务分组、扣款账户、下期扣款、取消订阅 |
| `#/settings` 设置 | 无数据接口 | 主题、使用模式、操作权限、竖屏预览、页面说明（收纳各页描述文字，默认收起）、新手指引 |

## 桌面银行服务表（v2 新增）

服务层与账期数据隔离，`ensureServiceTables` 在服务启动与 seed 时自动建表并填充初始数据：

| 表 | 用途 |
|---|---|
| `app_users` | 体验用户（林予安 `u-lin` 默认、沈知微 `u-shen`），含昵称/脱敏手机号/查询密码 |
| `account_ownership` | 账户归属：现有账户全部归属 `u-lin`；云杉银行两张卡归属 `u-shen` |
| `card_credentials` | 卡凭据：完整卡号 + 查询密码（默认 `123456`）+ 更新时间 |
| `loss_reports` | 挂失工单：active/released、原因、渠道、时间线 |
| `live_transfers` + `live_transfer_legs` | 实时转账台账：每笔转账 1（对手方）或 2（本行互转）条分录，记录转账后余额 |
| `audit_log` | 服务操作审计（凭据查看/转账/密码/挂失） |
| `notifications` | 服务通知（转账成功/挂失提醒/密码修改） |

第二、第三体验用户与主用户**同构的全量众微银行账户树**（组容器 + 储蓄卡 + 备用金储蓄账户 + 微粒贷授信 + 微信支付零钱 + 信用卡），无历史流水，`opening = current` 天然对账：

| 用户 | 账户（均挂众微银行/微信支付平台） | 资产 | 负债 |
|---|---|---|---|
| 林予安 `u-lin`（默认） | 现有全部账期数据 | ¥55,712.52 | ¥3,084.05 |
| 沈知微 `u-shen` | `ys-root` 容器、储蓄卡·知微 ¥12,000、备用金 ¥3,000、微粒贷 ¥5,000（额度 ¥20,000）、微信零钱 ¥800、信用卡·知微（额度 ¥30,000） | ¥15,800.00 | ¥5,000.00 |
| 顾清晏 `u-gu` | `gu-root` 容器、储蓄卡·清晏 ¥8,600、备用金 ¥2,000、微粒贷 ¥3,000（额度 ¥16,000）、微信零钱 ¥500、信用卡·清晏（额度 ¥20,000） | ¥11,100.00 | ¥3,000.00 |

**跨用户转账**：转账对话框的"众微银行账户"收款方列表 = 本用户其他账户 + 其他用户银行卡（`/api/bank/directory`），转账实时记入对方账户并给对方推送"收到转账"通知，回执展示收款人姓名。仅 `u-lin` 为可使用账号（前端固定进入），另两位用户为收款方数据；小安 Agent 的五个查询工具与 `/api/finance/*`、`/api/overview` 均按当前账号返回独立资金档案。

实时转账直接更新 `accounts.current_balance_cents` 并写入台账分录；`npm run db:check` 的对账公式已扩展为 `期初 + 账期流水 + 实时台账 = 当前余额`，并新增 `live_transfer_legs_consistent` 校验（对手方单分录、本行互转双分录净额为 0）。重新执行 `npm run db:seed` 可将服务数据与账期数据一并重置。

## 一致性检查

`npm run db:check` 会检查账户余额由期初余额和流水重算一致、没有未来流水、平台与账户匹配、授信不超限、转账成对、众微银行为主账户以及三个月连续覆盖。页面展示的金额均由这些字段格式化为元，不在前端另造一套余额。
