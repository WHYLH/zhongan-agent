# SQLite 数据模型 · 第一阶段资金数据层

状态：已实现并通过本机校验。数据库为虚构演示数据，不连接任何银行、支付平台或外部 API。

## 1. 交付边界

| 项目 | 约定 |
|---|---|
| 运行时 | Node.js 24+，使用内置 `node:sqlite` 的 `DatabaseSync` |
| 默认文件 | `data/finance.sqlite` |
| 金额 | `INTEGER` 分；不使用浮点数 |
| 币种 | CNY |
| 业务时区 | Asia/Shanghai；`occurred_at` 固定以 `+08:00` 结尾 |
| 数据性质 | 全部为 `simulated` 虚构数据 |
| 业务截止日 | `2026-10-23`（`meta.as_of`） |
| 历史范围 | `2026-08-01` → `2026-10-23`，连续 84 天，覆盖 3 个连续自然月；其中 8—9 月为完整自然月，10 月为截至 23 日的当期流水 |
| 未来记录 | 不生成未来预期消费、预期收入、待执行账单或“下次扣费”流水；数据库触发器也会拒绝 `occurred_on > as_of` 的新增和日期更新 |
| 展示边界 | 未修改 `index.html` 与现有 UI；`server.mjs` 已新增 `/api/finance/*` 查询接口，真实聚合 AI 优先读取 SQLite 快照 |
| 确定性 | 固定 seed `20261023`、固定 `as_of`、固定生成时间和固定随机序列；重建后的数据内容指纹一致 |

数据库文件所在的 `data/` 目录由种子脚本自动创建。种子先写入临时文件，校验通过后再替换目标文件，避免留下半成品数据库。

## 2. 概念模型

```text
platforms 1 ─── n accounts
                    │  parent_id（自引用，形成账户层级）
                    │
                    ├── 1 ─── n transactions（交易归属账户）
                    │
                    └── 1 ─── n subscriptions（订阅从某个支付账户扣款）
                                      │
                                      └── 1 ─── n transactions.subscription_id
```

### 2.1 平台与账户

- `platforms` 表达资金所在的平台：众微银行、微信支付、招商银行；众微银行同时承载主账户与微粒贷授信来源。
- `accounts` 是统一账户树。根节点是平台容器，叶子节点才是实际余额载体。
- `account_class` 分三类：
  - `container`：层级容器，余额恒为 0，不能记账；用于展示“众微银行 / 微信支付 / 招商银行”等分组。
  - `asset`：资产账户，`current_balance_cents` 为正数可用余额，如储蓄卡、储蓄账户、微信零钱。
  - `liability`：负债账户，`current_balance_cents` 为正数未偿金额，如微粒贷、信用卡。
- 账户树的计算口径：
  - 叶子账户余额只算一次。
  - 容器自身余额为 0，不参与资产/负债求和。
  - `v_account_rollup` 用递归 CTE 汇总每个节点整棵子树的资产、负债、净值和可用授信，供 UI 展示平台汇总，避免重复计算。
- 信用卡/微粒贷的可用额度由视图计算：
  `available_credit_cents = credit_limit_cents - current_balance_cents`。

### 2.2 余额口径

```text
资产账户：current_balance = opening_balance + Σ(balance_effect)
负债账户：current_balance = opening_balance + Σ(balance_effect)
```

- 资产账户的 `opening_balance_cents` 是历史期初余额。
- 负债账户的 `opening_balance_cents` 是历史期初未偿余额（不是负资产）。
- 每笔流水的 `balance_effect_cents` 已按账户类型换算为对“该账户余额”的有符号影响。
- 每笔流水保存 `balance_after_cents`，可用于账单式余额回放。
- 净资产 = 资产账户余额合计 − 负债账户余额合计；容器不计入。
- 可用授信不计入资产。

### 2.3 收支方向与余额影响

| `direction` | 资产账户影响 | 负债账户影响 | 统计含义 |
|---|---:|---:|---|
| `income` | `+amount` | 不使用 | 已入账收入，如工资、利息 |
| `expense` | `-amount` | `+amount` | 消费/支出；信用卡消费和微粒贷消费只在这里计一次 |
| `transfer` | 转出 `-amount`，转入 `+amount` | 还款 `-amount` | 本人账户划转、零钱充值、信用卡/微粒贷还款；不计入收支 |

- 本人账户之间的划转生成同一 `transfer_group_id` 的两条腿：资产转出、资产转入；两条腿都标记 `is_internal_transfer=1`，方向为 `transfer`。
- 信用卡/微粒贷还款同样成对：资产账户转出 + 负债账户还款；不计入消费，也不会把本金还款再算成一次支出。
- 信用卡/微粒贷消费记在负债账户上，`direction='expense'`，余额影响为正（欠款增加），消费统计计一次；后续还款不再计消费。
- `flow_kind` 用于细分场景（工资、房租、订阅、生活缴费、信用卡还款等），不替代 `direction`。

### 2.4 未来预期记录

- 交易表只保存已发生流水；`MAX(occurred_on) = 2026-10-23`。
- 订阅表只保存历史扣费事实：`last_charged_on`、`charge_count`，不保存 `next_charge_date`、预计金额或未来扣费流水。
- 触发器 `trg_transactions_no_future_insert` / `trg_transactions_no_future_update` 以 `meta.as_of` 为边界，拒绝未来交易写入。
- 例如 Keep 每月 29 日扣费，但 `as_of=2026-10-23`，所以只有 8、9 月两条 Keep 记录，不生成 10 月 29 日的预期扣费。

### 2.5 固定订阅

- 订阅不是虚假的资金账户；它是商户服务协议，绑定一个真实支付账户 `payment_account_id`。
- `service_account` 是脱敏后的订阅账号，例如 `yian***@icloud.com`、`138****6620`。
- 四项固定订阅均从“微信支付零钱”扣款，固定月费合计 **259.00 元**：
  - Apple iCloud+ 200GB：6.00 元/月，每月 5 日；
  - 网易云音乐黑胶 VIP：15.00 元/月，每月 17 日；
  - 爱奇艺黄金 VIP：39.00 元/月，每月 20 日；
  - Keep 会员：199.00 元/月，每月 29 日。
- 订阅扣费流水关联 `transactions.subscription_id`，可通过 `v_subscriptions` 查询付款账户与平台。

## 3. 当前种子数据

| 项目 | 数量/金额 |
|---|---:|
| 平台 | 4 |
| 账户 | 9（4 个容器 + 5 个余额账户） |
| 固定订阅 | 4 个生效，固定月费 259.00 元 |
| 交易流水 | 184 条 |
| 流水日期 | 2026-08-01 → 2026-10-23 |
| 连续月份 | 2026-08、2026-09、2026-10（3 个月，无断月） |
| 总资产 | 59,422.82 元 |
| 总负债 | 3,084.05 元 |
| 净资产 | 56,338.77 元 |
| 可支付资金（`is_payable=1` 的资产） | 59,422.82 元 |
| 可用授信（信用卡 + 微粒贷） | 41,915.95 元 |
| 数据内容指纹 | `90f96cb77b0277735a7ee3d84c2bd5991cb41ddbfc40d29acc1ed1d42fe7156d` |

### 3.1 账户层级与余额

| id | 平台 | 账户 | 类型 | 类别 | 父账户 | 当前余额/未偿 | 授信/可用 |
|---|---|---|---|---|---:|---:|---:|
| `webbank-root` | 众微银行 | 众微银行 | `BANK_GROUP` | container | — | 0.00 | — |
| `wb-debit` | 众微银行 | 众微银行储蓄卡 · 工资卡 | `BANK_DEBIT` | asset | `webbank-root` | 25,520.81 | — |
| `wb-savings` | 众微银行 | 众微银行储蓄账户 · 备用金 | `BANK_SAVINGS` | asset | `webbank-root` | 37,042.18 | — |
| `wechat-root` | 微信支付 | 微信支付 | `WECHAT_PAY` | container | — | 0.00 | — |
| `wechat-wallet` | 微信支付 | 微信支付零钱 | `WECHAT_PAY` | asset | `wechat-root` | 3,698.53 | — |
| `cmb-root` | 招商银行 | 招商银行 | `CREDIT_CARD` | container | — | 0.00 | — |
| `cmb-credit` | 招商银行 | 招商银行经典白金信用卡 | `CREDIT_CARD` | liability | `cmb-root` | 2,034.42 | 30,000.00 / 27,965.58 |
| `webank-credit` | 众微银行 | 微粒贷 · 消费备用额度 | `WEBANK_CREDIT` | liability | `webbank-root` | 565.31 | 15,000.00 / 14,434.69 |
| `webank-credit` | 众微银行 | 微粒贷 · 消费备用额度 | `WEBANK_CREDIT` | liability | `webbank-root` | 565.31 | 15,000.00 / 14,434.69 |

平台子树净值：

- 众微银行：55,928.86 元（工资卡 21,886.68 + 备用金 34,042.18）
- 微信支付：3,493.96 元
- 招商银行：−2,518.74 元（信用卡未偿）
- 众微银行授信来源：−565.31 元（微粒贷未偿）

### 3.2 月度流水分布

| 月份 | 流水数 | 说明 |
|---|---:|---|
| 2026-08 | 67 | 完整月 |
| 2026-09 | 64 | 完整月；含季度结息 |
| 2026-10 | 53 | 截至 10 月 23 日，不生成未来流水 |

按平台：微信支付、招商银行与众微银行三类平台，流水条数以 `v_monthly_summary` 查询结果为准。

## 4. 表结构

### 4.1 `meta`

单行键值配置，用于标记数据版本、截止日和口径。

| 列 | 类型 | 说明 |
|---|---|---|
| `key` | TEXT PK | 配置键 |
| `value` | TEXT NOT NULL | 配置值 |

库存键包括：`schema_version`、`dataset_id`、`seed`、`as_of`、`as_of_end`、`history_start`、`history_end`、`history_days`、`timezone`、`currency`、`amount_unit`、`generated_at`、`generator`、`future_records`、`source_type`、`description`、`monthly_coverage`。

### 4.2 `platforms`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 平台 id，如 `p-webbank` |
| `name` | TEXT NOT NULL UNIQUE | 众微银行、微信支付、招商银行 |
| `category` | TEXT | `bank` / `wallet` / `credit` / `subscription` |
| `code` | TEXT | 业务代码 |
| `sort_order` | INTEGER | 展示排序 |
| `created_at` | TEXT | 生成时间 |

### 4.3 `accounts`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 账户 id |
| `parent_id` | TEXT FK → `accounts.id` | 父账户；根为 NULL；禁止自引用 |
| `platform_id` | TEXT FK → `platforms.id` | 所属平台 |
| `name` | TEXT | 账户展示名 |
| `account_type` | TEXT | `BANK_GROUP` / `BANK_DEBIT` / `BANK_SAVINGS` / `WECHAT_PAY` / `WEBANK_CREDIT` / `CREDIT_CARD` |
| `account_class` | TEXT | `container` / `asset` / `liability` |
| `currency` | TEXT | CNY |
| `masked_number` | TEXT | 脱敏卡号/账户号 |
| `card_network` | TEXT | 银联等 |
| `is_primary` | INTEGER | 是否主要银行账户（0/1） |
| `is_payable` | INTEGER | 是否计入可支付资金（0/1） |
| `status` | TEXT | `active` / `frozen` / `closed` |
| `credit_limit_cents` | INTEGER | 授信额度（分） |
| `billing_day` | INTEGER | 账单日 |
| `due_day` | INTEGER | 还款日 |
| `opening_balance_cents` | INTEGER | 期初余额/期初未偿（分） |
| `current_balance_cents` | INTEGER | 当前余额/当前未偿（分） |
| `opened_on` | TEXT | 开户日期 |
| `closed_on` | TEXT | 关闭日期 |
| `sort_order` | INTEGER | 展示排序 |
| `metadata` | TEXT | JSON 扩展信息，经 `json_valid` 校验 |
| `created_at` | TEXT | 生成时间 |

关键约束：

- `parent_id <> id`。
- `account_class='container'` 时 `current_balance_cents=0`。
- 余额、授信额度均非负。
- `v_accounts` 在原始列上增加 `signed_balance_cents`（负债取负）、`available_balance_cents`、`available_credit_cents` 和子树汇总。

### 4.4 `subscriptions`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 订阅 id |
| `merchant` | TEXT | 商户，如 Apple |
| `product` | TEXT | 商品/套餐 |
| `category` | TEXT | 云服务/音乐/视频/健康 |
| `service_account` | TEXT | 脱敏订阅账号 |
| `amount_cents` | INTEGER | 固定每期金额（分） |
| `billing_cycle` | TEXT | `monthly` / `quarterly` / `yearly` |
| `billing_day` | INTEGER | 每月扣费日 |
| `payment_account_id` | TEXT FK → `accounts.id` | 实际扣款账户 |
| `autopay_authorized` | INTEGER | 是否已授权代扣（0/1） |
| `status` | TEXT | `active` / `cancelled` |
| `started_on` | TEXT | 订阅开始日 |
| `ended_on` | TEXT | 结束日 |
| `last_charged_on` | TEXT | 最后一笔已发生扣费日期；可为空 |
| `charge_count` | INTEGER | 已发生扣费次数 |
| `created_at` | TEXT | 生成时间 |

明确不包含：`next_charge_date`、预计未来扣费、未来账单。

### 4.5 `transactions`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 流水 id |
| `account_id` | TEXT FK → `accounts.id` | 归属账户 |
| `platform_id` | TEXT FK → `platforms.id` | 所属平台；校验必须与账户平台一致 |
| `occurred_at` | TEXT | 发生时间，`YYYY-MM-DDTHH:mm:ss+08:00` |
| `occurred_on` | TEXT GENERATED STORED | 由 `occurred_at` 截取日期，自动维护 |
| `direction` | TEXT | `income` / `expense` / `transfer` |
| `flow_kind` | TEXT | 工资、房租、订阅、消费、内部划转、还款等细分 |
| `amount_cents` | INTEGER | 正数金额（分） |
| `balance_effect_cents` | INTEGER | 对当前账户余额的有符号影响；不允许 0 |
| `balance_after_cents` | INTEGER | 该账户此笔后的余额/欠款 |
| `merchant` | TEXT | 商户/对手方展示名 |
| `counterparty` | TEXT | 对手方 |
| `category` | TEXT | 餐饮、购物、生活、交通、订阅、还款等 |
| `subcategory` | TEXT | 二级分类 |
| `channel` | TEXT | 微信支付、信用卡、银行代扣、手机银行等 |
| `status` | TEXT | `booked` / `reversed` |
| `subscription_id` | TEXT FK → `subscriptions.id` | 订阅扣费关联 |
| `transfer_group_id` | TEXT | 本人划转/还款配对组 |
| `is_internal_transfer` | INTEGER | 是否本人账户内部划转/还款 |
| `note` | TEXT | 备注 |
| `source_type` | TEXT | `simulated` / `imported` / `official` |
| `is_simulated` | INTEGER | 是否模拟数据 |
| `created_at` | TEXT | 生成时间 |

关键约束：

- `occurred_at` 必须匹配 `+08:00` 固定格式。
- `amount_cents > 0`；方向单独存字段。
- 每笔 `balance_effect_cents` 与账户类型、方向一致；种子生成和 `validateDatabase()` 都会复核。
- 未来日期由触发器拒绝。
- 索引覆盖：发生时间、平台+方向+日期、账户+时间、分类+日期、订阅、转账组。

### 4.6 视图

| 视图 | 用途 |
|---|---|
| `v_accounts` | 账户余额、符号余额、信用可用额、子树汇总 |
| `v_account_rollup` | 递归账户闭包，汇总每个节点的子树资产/负债/净值/可用授信 |
| `v_account_tree` | 带 `depth`、`path` 的账户树 |
| `v_transactions` | 流水明细 + 平台名/账户名 + 收入/支出/转账分列 + 资产现金流 |
| `v_monthly_summary` | 月份 × 平台的流水数、收入、支出、转账、资产现金流汇总 |
| `v_subscriptions` | 订阅 + 扣款账户 + 支付平台 |

### 4.7 触发器

| 触发器 | 行为 |
|---|---|
| `trg_transactions_no_future_insert` | 插入日期晚于 `meta.as_of` 的流水时 `RAISE(ABORT)` |
| `trg_transactions_no_future_update` | 将流水日期改晚于 `meta.as_of` 时 `RAISE(ABORT)` |

## 5. 样例查询

所有查询都默认已经执行过：

```powershell
npm run db:seed
```

### 5.1 命令行概览

```powershell
npm run db:info
node db.mjs --json
node scripts/seed-db.mjs --verify-only
```

### 5.2 JavaScript：按平台 + 方向 + 时间范围

```powershell
@'
import { openDatabase, listTransactions } from './db.mjs';

const db = openDatabase('./data/finance.sqlite', { readOnly: true });
const result = listTransactions(db, {
  platformId: 'p-wechat',
  direction: 'expense',
  from: '2026-08-01',
  to: '2026-08-31',
  limit: 10
});

console.log(result.total);       // 37
console.log(result.items[0]);    // 最近一条微信支出，含 amount_cents / amount_yuan
db.close();
'@ | node --input-type=module
```

### 5.3 JavaScript：账户、层级、订阅、月度汇总

```powershell
@'
import {
  openDatabase, listAccounts, listAccountTree,
  listSubscriptions, getMonthlySummary
} from './db.mjs';

const db = openDatabase('./data/finance.sqlite', { readOnly: true });

console.table(listAccounts(db).map(a => ({
  id: a.id,
  name: a.name,
  balance: a.current_balance_yuan,
  creditAvailable: a.available_credit_yuan,
  subtreeNet: a.subtree_net_yuan
})));

console.dir(listAccountTree(db), { depth: 4 });
console.table(listSubscriptions(db));
console.table(getMonthlySummary(db, { from: '2026-08-01', to: '2026-09-30' }));
db.close();
'@ | node --input-type=module
```

### 5.4 SQL：所有账户余额（不重复计算容器）

```sql
SELECT
  id, platform_name, name, account_type, account_class, parent_id,
  current_balance_cents, current_balance_cents / 100.0 AS current_balance_yuan,
  signed_balance_cents, available_credit_cents
FROM v_accounts
ORDER BY platform_name, sort_order, id;
```

### 5.5 SQL：账户层级与子树汇总

```sql
SELECT
  path, depth, account_type, account_class,
  current_balance_cents,
  subtree_asset_cents,
  subtree_liability_cents,
  subtree_net_cents,
  subtree_available_credit_cents
FROM v_account_tree
ORDER BY path;
```

### 5.6 SQL：平台 + 收支方向 + 时间范围

```sql
SELECT
  occurred_at, platform_name, account_name, direction, flow_kind,
  amount_cents, amount_cents / 100.0 AS amount_yuan,
  merchant, category, channel
FROM v_transactions
WHERE platform_id = 'p-wechat'
  AND direction = 'expense'
  AND occurred_on BETWEEN '2026-08-01' AND '2026-08-31'
ORDER BY occurred_at DESC;
```

支持的筛选组合：任意 `platform_id`、`direction`（`income/expense/transfer`）、`occurred_on` 范围、账户、分类、订阅；`listTransactions()` 还支持 `limit/offset/order`。

### 5.7 SQL：月度汇总

```sql
SELECT month, platform_name, transaction_count,
       income_cents / 100.0 AS income_yuan,
       expense_cents / 100.0 AS expense_yuan,
       transfer_cents / 100.0 AS transfer_yuan
FROM v_monthly_summary
ORDER BY month, platform_id;
```

### 5.8 SQL：固定订阅历史

```sql
SELECT
  merchant, product, service_account, amount_cents / 100.0 AS monthly_yuan,
  billing_day, payment_account_name, last_charged_on, charge_count, status
FROM v_subscriptions
ORDER BY billing_day, merchant;
```

### 5.9 SQL：余额对账

```sql
SELECT
  a.id,
  a.name,
  a.opening_balance_cents,
  a.current_balance_cents,
  a.opening_balance_cents + COALESCE(SUM(t.balance_effect_cents), 0) AS expected_cents
FROM accounts a
LEFT JOIN transactions t ON t.account_id = a.id
WHERE a.account_class <> 'container'
GROUP BY a.id
HAVING a.current_balance_cents <> expected_cents;
-- 应返回 0 行
```

### 5.10 SQL：确认没有未来流水

```sql
SELECT COUNT(*) AS future_rows
FROM transactions
WHERE occurred_on > (SELECT value FROM meta WHERE key = 'as_of');
-- 应为 0
```

## 6. 验收命令

在项目根目录、Node.js 24+ 下执行。

### 6.1 环境

```powershell
node --version
# 输出应以 v24. 开头
```

### 6.2 重复初始化与确定性

```powershell
$first = (npm run db:seed --silent | Select-String '内容指纹').ToString()
$second = (npm run db:seed --silent | Select-String '内容指纹').ToString()
if ($first -ne $second) { throw '确定性失败：两次内容指纹不一致' } else { 'DETERMINISTIC_OK' }
```

当前内容指纹应为：

```text
90f96cb77b0277735a7ee3d84c2bd5991cb41ddbfc40d29acc1ed1d42fe7156d
```

说明：SQLite 文件二进制可能因为页布局、统计信息等不同而字节级不同；验收使用的是表内容规范化后的 SHA-256，而不是数据库文件哈希。

### 6.3 内置完整性校验

```powershell
npm run db:check
```

期望包含：

```text
校验：OK
✓ no_future_transactions：future_rows=0
✓ account_balances_reconciled：opening + signed flows = current
✓ no_container_transactions：container_rows=0
✓ internal_transfers_are_paired：each transfer group has exactly 2 legs
✓ three_consecutive_months：2026-08,2026-09,2026-10 (continuous=true, rows=184)
```

### 6.4 总量、日期与月份覆盖

```powershell
@'
import { openDatabase } from './db.mjs';
const db = openDatabase('./data/finance.sqlite', { readOnly: true });
console.log(db.prepare(`
  SELECT COUNT(*) AS transactions,
         MIN(occurred_on) AS first_date,
         MAX(occurred_on) AS last_date,
         COUNT(DISTINCT substr(occurred_on, 1, 7)) AS month_count
  FROM transactions
`).get());
console.log(db.prepare(`
  SELECT substr(occurred_on, 1, 7) AS month, COUNT(*) AS rows
  FROM transactions GROUP BY month ORDER BY month
`).all());
db.close();
'@ | node --input-type=module
```

期望：`transactions=184`、`first_date=2026-08-01`、`last_date=2026-10-23`、`month_count=3`，月份为 8/9/10 月。

### 6.5 平台 + 方向 + 时间筛选

```powershell
@'
import { openDatabase, listTransactions } from './db.mjs';
const db = openDatabase('./data/finance.sqlite', { readOnly: true });
const result = listTransactions(db, {
  platformId: 'p-wechat',
  direction: 'expense',
  from: '2026-08-01',
  to: '2026-08-31'
});
console.log({ total: result.total, first: result.items.at(-1).occurred_on, last: result.items[0].occurred_on });
db.close();
'@ | node --input-type=module
```

期望 `total=37`，日期范围为 `2026-08-01` 到 `2026-08-31`。

### 6.6 账户层级与余额

```powershell
@'
import { openDatabase, listAccountTree } from './db.mjs';
const db = openDatabase('./data/finance.sqlite', { readOnly: true });
for (const node of listAccountTree(db).flat) {
  console.log(`${'  '.repeat(node.depth)}${node.name} | ${node.account_class} | 余额=${node.current_balance_yuan} | 子树净值=${node.subtree_net_yuan}`);
}
db.close();
'@ | node --input-type=module
```

当前种子包含 8 个账户（容器 3 个），众微银行主树净值 `55363.55`，微信支付净值 `3493.96`，招商银行净值 `-2518.74`；备用金单独列示，不计入 `is_payable=1` 的可支付余额。

### 6.7 未来流水触发器

```powershell
@'
import { rmSync, copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

copyFileSync('./data/finance.sqlite', './data/future-check.sqlite');
const db = new DatabaseSync('./data/future-check.sqlite');
try {
  db.prepare(`
    INSERT INTO transactions(
      id, account_id, platform_id, occurred_at, direction, flow_kind,
      amount_cents, balance_effect_cents, balance_after_cents,
      merchant, category, channel, status, source_type, is_simulated, created_at
    ) VALUES (
      'tx-future-check', 'wechat-wallet', 'p-wechat', '2026-10-24T09:00:00+08:00',
      'expense', 'consumption', 100, -100, 100,
      'test', 'test', 'test', 'booked', 'simulated', 1, '2026-10-23T23:59:59+08:00'
    )
  `).run();
  console.log('FAILED: future row inserted');
} catch (error) {
  console.log('FUTURE_BLOCKED_OK:', error.message);
} finally {
  db.close();
  rmSync('./data/future-check.sqlite', { force: true });
}
'@ | node --input-type=module
```

期望输出：

```text
FUTURE_BLOCKED_OK: future transaction is not allowed
```

### 6.8 既有项目检查（可选）

数据库交付没有改动 `index.html`、UI 或 `server.mjs`；如需回归既有应用：

```powershell
npm run check
```

## 7. 重置、定制与扩展

### 重置

```powershell
npm run db:seed
```

每次执行都会重建默认数据库，不依赖上一次的文件内容。

### 指定路径

```powershell
node scripts/seed-db.mjs --db data/other.sqlite
node scripts/seed-db.mjs --verify-only --db data/other.sqlite
node db.mjs --db data/other.sqlite --json
```

### 后续接入服务层

在服务端读接口中可直接复用：

```js
import {
  openDatabase, listAccounts, listTransactions,
  listSubscriptions, listAccountTree, getMonthlySummary
} from './db.mjs';

const db = openDatabase(undefined, { readOnly: true });
// 查询后将 snake_case + *_yuan 字段映射为现有 API 字段
```

现有 `/api/*` 展示协议保持兼容；新增功能优先使用 `/api/finance/*`，后续 UI 可直接消费账户树和筛选流水。

## 8. 已知限制

1. 数据全部虚构，仅用于比赛演示；没有接入众微银行、微信支付、招商银行或任何外部 API。
2. `as_of` 固定为 2026-10-23。需要更新数据日时，应同步修改 seed 脚本中的 `AS_OF`、月份列表和固定生成时间，而不是直接在库里补未来流水。
3. 当前只实现查询与数据一致性校验，不包含转账、还款、锁卡等业务写入。
4. 信用卡/微粒贷的账期、利率、分期计划未做完整计息模型；当前仅保存余额、额度、账单日和已发生的消费/还款流水。
5. 订阅表只表达历史扣费事实，不推断未来扣费；这是刻意设计，以满足“不生成未来预期消费/收入”的要求。
6. SQLite 文件本身不是跨平台字节级确定性的；确定性验收以 `contentDigest()` 的表内容指纹为准。
7. 数据库文件默认不纳入业务逻辑备份；如需分发只读样例，可在种子完成后单独复制 `data/finance.sqlite`。


## 7. financial_products 产品目录

`financial_products` 保存众微银行公开产品名称、用途、流动性、收益标签、来源地址、观察日期与说明。动态收益使用“按页面动态展示”；兴银添利宝的 3.5% 只作为公开历史页面示例，并在 `note` 标明不能视为当前报价。

接口：`GET /api/finance/products?institution=众微银行`。
