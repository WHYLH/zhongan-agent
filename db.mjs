/**
 * 众安 · 第一阶段 SQLite 数据层
 *
 * 仅使用 Node.js 24 内置 node:sqlite（DatabaseSync），无外部数据库依赖。
 * 数据库默认位置：data/finance.sqlite
 * 金额单位：分（INTEGER），避免浮点误差。
 * 业务时区：Asia/Shanghai，occurred_at 固定使用 +08:00 偏移。
 */

import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.join(ROOT, 'data', 'finance.sqlite');
export const SCHEMA_VERSION = '3';
export const DIRECTIONS = Object.freeze(['income', 'expense', 'transfer']);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS platforms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL CHECK (category IN ('bank', 'wallet', 'credit', 'subscription')),
  code        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS accounts (
  id                    TEXT PRIMARY KEY,
  parent_id             TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  platform_id           TEXT NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
  name                  TEXT NOT NULL,
  account_type          TEXT NOT NULL CHECK (account_type IN (
                          'BANK_GROUP', 'BANK_DEBIT', 'BANK_SAVINGS',
                          'WECHAT_PAY', 'WEBANK_CREDIT', 'CREDIT_CARD'
                        )),
  account_class         TEXT NOT NULL CHECK (account_class IN ('container', 'asset', 'liability')),
  currency              TEXT NOT NULL DEFAULT 'CNY' CHECK (length(currency) = 3),
  masked_number         TEXT,
  card_network          TEXT,
  is_primary            INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  is_payable            INTEGER NOT NULL DEFAULT 0 CHECK (is_payable IN (0, 1)),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  credit_limit_cents    INTEGER CHECK (credit_limit_cents IS NULL OR credit_limit_cents >= 0),
  billing_day           INTEGER CHECK (billing_day IS NULL OR billing_day BETWEEN 1 AND 31),
  due_day               INTEGER CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
  opening_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_balance_cents >= 0),
  current_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (current_balance_cents >= 0),
  opened_on             TEXT,
  closed_on             TEXT,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  metadata              TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  created_at            TEXT NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (account_class <> 'container' OR current_balance_cents = 0)
) STRICT;

CREATE TABLE IF NOT EXISTS financial_products (
  id                TEXT PRIMARY KEY,
  institution       TEXT NOT NULL,
  name              TEXT NOT NULL,
  product_type      TEXT NOT NULL,
  risk_level        TEXT,
  liquidity         TEXT,
  rate_label        TEXT,
  rate_value        REAL,
  rate_unit         TEXT,
  min_amount        TEXT,
  term              TEXT,
  product_code      TEXT,
  highlights        TEXT,
  history_7d        TEXT,
  history_1m        TEXT,
  history_3m        TEXT,
  history_6m        TEXT,
  history_1y        TEXT,
  history_ytd       TEXT,
  fee_manage        TEXT,
  fee_custody       TEXT,
  fee_sales         TEXT,
  scale_label       TEXT,
  manager           TEXT,
  est_annual_return REAL,
  max_drawdown      TEXT,
  invest_range      TEXT,
  suitable_for      TEXT,
  redemption_desc   TEXT,
  calc_note         TEXT,
  source_url        TEXT NOT NULL,
  source_published  TEXT,
  observed_at       TEXT NOT NULL,
  note              TEXT,
  source_type       TEXT NOT NULL DEFAULT 'official' CHECK (source_type IN ('official', 'reported'))
) STRICT;

CREATE TABLE IF NOT EXISTS subscriptions (
  id                   TEXT PRIMARY KEY,
  merchant             TEXT NOT NULL,
  product              TEXT NOT NULL,
  category             TEXT NOT NULL,
  service_account      TEXT,
  amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
  billing_cycle        TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly')),
  billing_day          INTEGER NOT NULL CHECK (billing_day BETWEEN 1 AND 31),
  payment_account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  autopay_authorized   INTEGER NOT NULL DEFAULT 1 CHECK (autopay_authorized IN (0, 1)),
  status               TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  started_on           TEXT NOT NULL,
  ended_on             TEXT,
  last_charged_on      TEXT,
  charge_count         INTEGER NOT NULL DEFAULT 0 CHECK (charge_count >= 0),
  created_at           TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS transactions (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  platform_id           TEXT NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
  occurred_at           TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??+08:00'),
  occurred_on           TEXT GENERATED ALWAYS AS (substr(occurred_at, 1, 10)) STORED,
  direction             TEXT NOT NULL CHECK (direction IN ('income', 'expense', 'transfer')),
  flow_kind             TEXT NOT NULL,
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  balance_effect_cents  INTEGER NOT NULL CHECK (balance_effect_cents <> 0),
  balance_after_cents   INTEGER NOT NULL CHECK (balance_after_cents >= 0),
  merchant              TEXT NOT NULL,
  counterparty          TEXT,
  category              TEXT NOT NULL,
  subcategory           TEXT,
  channel               TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'reversed')),
  subscription_id       TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  transfer_group_id     TEXT,
  is_internal_transfer  INTEGER NOT NULL DEFAULT 0 CHECK (is_internal_transfer IN (0, 1)),
  note                  TEXT,
  source_type           TEXT NOT NULL DEFAULT 'simulated' CHECK (source_type IN ('simulated', 'imported', 'official')),
  is_simulated          INTEGER NOT NULL DEFAULT 1 CHECK (is_simulated IN (0, 1)),
  created_at            TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tx_occurred_at ON transactions(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_platform_direction_time
  ON transactions(platform_id, direction, occurred_on);
CREATE INDEX IF NOT EXISTS idx_tx_account_time ON transactions(account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_tx_category_time ON transactions(category, occurred_on);
CREATE INDEX IF NOT EXISTS idx_tx_subscription ON transactions(subscription_id);
CREATE INDEX IF NOT EXISTS idx_tx_transfer_group ON transactions(transfer_group_id);
CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts(parent_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account ON subscriptions(payment_account_id);

CREATE VIEW IF NOT EXISTS v_account_rollup AS
WITH RECURSIVE closure(ancestor_id, descendant_id) AS (
  SELECT id, id FROM accounts
  UNION ALL
  SELECT closure.ancestor_id, child.id
    FROM closure
    JOIN accounts child ON child.parent_id = closure.descendant_id
)
SELECT
  closure.ancestor_id AS account_id,
  COUNT(*) AS subtree_node_count,
  SUM(CASE WHEN a.account_class = 'asset' THEN a.current_balance_cents ELSE 0 END) AS subtree_asset_cents,
  SUM(CASE WHEN a.account_class = 'liability' THEN a.current_balance_cents ELSE 0 END) AS subtree_liability_cents,
  SUM(CASE a.account_class
        WHEN 'asset' THEN a.current_balance_cents
        WHEN 'liability' THEN -a.current_balance_cents
        ELSE 0
      END) AS subtree_net_cents,
  SUM(CASE
        WHEN a.account_class = 'liability' AND a.credit_limit_cents IS NOT NULL
          THEN a.credit_limit_cents - a.current_balance_cents
        ELSE 0
      END) AS subtree_available_credit_cents
FROM closure
JOIN accounts a ON a.id = closure.descendant_id
GROUP BY closure.ancestor_id;

CREATE VIEW IF NOT EXISTS v_accounts AS
SELECT
  a.*,
  p.name AS platform_name,
  p.category AS platform_category,
  p.code AS platform_code,
  CASE a.account_class
    WHEN 'asset' THEN a.current_balance_cents
    WHEN 'liability' THEN -a.current_balance_cents
    ELSE 0
  END AS signed_balance_cents,
  CASE
    WHEN a.account_class = 'asset' THEN a.current_balance_cents
    WHEN a.account_class = 'liability' AND a.credit_limit_cents IS NOT NULL
      THEN a.credit_limit_cents - a.current_balance_cents
    ELSE NULL
  END AS available_balance_cents,
  CASE
    WHEN a.account_class = 'liability' AND a.credit_limit_cents IS NOT NULL
      THEN a.credit_limit_cents - a.current_balance_cents
    ELSE NULL
  END AS available_credit_cents,
  r.subtree_node_count,
  r.subtree_asset_cents,
  r.subtree_liability_cents,
  r.subtree_net_cents,
  r.subtree_available_credit_cents
FROM accounts a
JOIN platforms p ON p.id = a.platform_id
JOIN v_account_rollup r ON r.account_id = a.id;

CREATE VIEW IF NOT EXISTS v_transactions AS
SELECT
  t.id,
  t.occurred_at,
  t.occurred_on,
  t.platform_id,
  p.name AS platform_name,
  t.account_id,
  a.name AS account_name,
  a.account_type,
  a.account_class,
  t.direction,
  t.flow_kind,
  t.amount_cents,
  t.balance_effect_cents,
  t.balance_after_cents,
  CASE WHEN t.direction = 'income' THEN t.amount_cents ELSE 0 END AS income_cents,
  CASE WHEN t.direction = 'expense' THEN t.amount_cents ELSE 0 END AS expense_cents,
  CASE WHEN t.direction = 'transfer' THEN t.amount_cents ELSE 0 END AS transfer_cents,
  CASE WHEN a.account_class = 'asset' THEN t.balance_effect_cents ELSE 0 END AS cash_flow_cents,
  t.merchant,
  t.counterparty,
  t.category,
  t.subcategory,
  t.channel,
  t.status,
  t.subscription_id,
  s.product AS subscription_product,
  t.transfer_group_id,
  t.is_internal_transfer,
  t.note,
  t.source_type,
  t.is_simulated,
  t.created_at
FROM transactions t
JOIN platforms p ON p.id = t.platform_id
JOIN accounts a ON a.id = t.account_id
LEFT JOIN subscriptions s ON s.id = t.subscription_id;

CREATE VIEW IF NOT EXISTS v_monthly_summary AS
SELECT
  substr(occurred_on, 1, 7) AS month,
  platform_id,
  platform_name,
  COUNT(*) AS transaction_count,
  SUM(income_cents) AS income_cents,
  SUM(expense_cents) AS expense_cents,
  SUM(transfer_cents) AS transfer_cents,
  SUM(cash_flow_cents) AS cash_flow_cents
FROM v_transactions
GROUP BY month, platform_id, platform_name;

CREATE VIEW IF NOT EXISTS v_subscriptions AS
SELECT
  s.*,
  a.name AS payment_account_name,
  a.masked_number AS payment_account_masked_number,
  p.id AS payment_platform_id,
  p.name AS payment_platform_name
FROM subscriptions s
JOIN accounts a ON a.id = s.payment_account_id
JOIN platforms p ON p.id = a.platform_id;

CREATE VIEW IF NOT EXISTS v_account_tree AS
WITH RECURSIVE tree(id, parent_id, platform_id, name, account_type, account_class,
                    current_balance_cents, depth, path) AS (
  SELECT a.id, a.parent_id, a.platform_id, a.name, a.account_type, a.account_class,
         a.current_balance_cents, 0, a.name
    FROM accounts a
   WHERE a.parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, c.platform_id, c.name, c.account_type, c.account_class,
         c.current_balance_cents, t.depth + 1, t.path || ' / ' || c.name
    FROM accounts c
    JOIN tree t ON c.parent_id = t.id
)
SELECT
  tree.*,
  p.name AS platform_name,
  r.subtree_asset_cents,
  r.subtree_liability_cents,
  r.subtree_net_cents,
  r.subtree_available_credit_cents
FROM tree
JOIN platforms p ON p.id = tree.platform_id
JOIN v_account_rollup r ON r.account_id = tree.id;

CREATE TRIGGER IF NOT EXISTS trg_transactions_no_future_insert
BEFORE INSERT ON transactions
WHEN NEW.occurred_on > (SELECT value FROM meta WHERE key = 'as_of')
BEGIN
  SELECT RAISE(ABORT, 'future transaction is not allowed');
END;

CREATE TRIGGER IF NOT EXISTS trg_transactions_no_future_update
BEFORE UPDATE OF occurred_at ON transactions
WHEN NEW.occurred_on > (SELECT value FROM meta WHERE key = 'as_of')
BEGIN
  SELECT RAISE(ABORT, 'future transaction is not allowed');
END;

CREATE TABLE IF NOT EXISTS app_users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  phone_masked  TEXT,
  avatar_emoji  TEXT,
  pin           TEXT NOT NULL DEFAULT '123456',
  risk_level    TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  intro         TEXT,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS account_ownership (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS card_credentials (
  account_id           TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  card_number          TEXT NOT NULL CHECK (length(card_number) BETWEEN 15 AND 19),
  password             TEXT NOT NULL CHECK (length(password) = 6),
  password_updated_at  TEXT NOT NULL,
  failed_attempts      INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  trade_locked         INTEGER NOT NULL DEFAULT 0 CHECK (trade_locked IN (0, 1)),
  updated_at           TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS loss_reports (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('active', 'released')),
  reason       TEXT,
  channel      TEXT NOT NULL DEFAULT 'app',
  reported_at  TEXT NOT NULL,
  released_at  TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS live_transfers (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  from_account_id        TEXT REFERENCES accounts(id),
  to_account_id          TEXT REFERENCES accounts(id),
  counterparty           TEXT,
  counterparty_account   TEXT,
  amount_cents           INTEGER NOT NULL CHECK (amount_cents > 0),
  kind                   TEXT NOT NULL CHECK (kind IN ('internal', 'external', 'loan')),
  status                 TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  note                   TEXT,
  channel                TEXT NOT NULL DEFAULT 'app',
  created_at             TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS live_transfer_legs (
  transfer_id         TEXT NOT NULL REFERENCES live_transfers(id) ON DELETE CASCADE,
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  effect_cents        INTEGER NOT NULL CHECK (effect_cents <> 0),
  balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents >= 0),
  PRIMARY KEY (transfer_id, account_id)
) STRICT;

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT,
  level       TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'success', 'warn')),
  created_at  TEXT NOT NULL,
  read        INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS loan_applications (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  product_id            TEXT NOT NULL,
  product_name          TEXT NOT NULL,
  category              TEXT,
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  term_months           INTEGER,
  rate_label            TEXT,
  disbursed_account_id  TEXT NOT NULL REFERENCES accounts(id),
  credit_account_id     TEXT NOT NULL REFERENCES accounts(id),
  status                TEXT NOT NULL DEFAULT 'disbursed' CHECK (status IN ('submitted', 'approved', 'disbursed', 'rejected')),
  transfer_id           TEXT,
  created_at            TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS scheduled_transfers (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  from_account_id       TEXT REFERENCES accounts(id),
  to_account_id         TEXT REFERENCES accounts(id),
  counterparty          TEXT,
  counterparty_account  TEXT,
  counterparty_phone    TEXT,
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  note                  TEXT,
  execute_on            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'failed', 'cancelled')),
  created_at            TEXT NOT NULL,
  executed_at           TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS aa_bills (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  total_cents      INTEGER NOT NULL CHECK (total_cents > 0),
  member_count     INTEGER NOT NULL CHECK (member_count > 0),
  from_account_id  TEXT NOT NULL REFERENCES accounts(id),
  participants     TEXT NOT NULL CHECK (json_valid(participants)),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  note             TEXT,
  created_at       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS wealth_holdings (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL,
  product_name  TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  purchased_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_transfers(user_id, execute_on);
CREATE INDEX IF NOT EXISTS idx_aa_user ON aa_bills(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_holdings_user ON wealth_holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_live_legs_account ON live_transfer_legs(account_id);
CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
`;

/* ── 基础连接与建表 ───────────────────────────────── */

export function openDatabase(dbPath = DEFAULT_DB_PATH, { readOnly = false } = {}) {
  if (!readOnly) mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath, readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (!readOnly) {
    try { db.exec('PRAGMA journal_mode = DELETE;'); } catch { /* 只读文件系统不阻塞读 */ }
  }
  return db;
}

export function initializeDatabase(db) {
  db.exec(SCHEMA_SQL);
  const current = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!current) {
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  } else if (current.value !== SCHEMA_VERSION) {
    throw new Error(`SCHEMA_VERSION_MISMATCH: db=${current.value}, expected=${SCHEMA_VERSION}；请运行 npm run db:seed 重建`);
  }
}

/* ── 格式化工具 ───────────────────────────────────── */

export function centsToYuan(cents) {
  if (cents === null || cents === undefined) return null;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Number(cents));
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function moneyFields(row, prefix, field = 'cents') {
  const key = `${prefix}_${field}`;
  if (row[key] === undefined || row[key] === null) return null;
  return centsToYuan(row[key]);
}

function enrichAccount(row) {
  let metadata = null;
  try { metadata = row.metadata ? JSON.parse(row.metadata) : null; } catch { metadata = null; }
  const isReserveFund = row.id === 'wb-savings' || metadata?.role === 'reserve_fund';
  return {
    ...row,
    is_reserve_fund: isReserveFund ? 1 : 0,
    display_role: isReserveFund ? 'savings_goal' : (row.account_class === 'liability' ? 'funding_source' : 'bank_account'),
    opening_balance_yuan: moneyFields(row, 'opening_balance'),
    current_balance_yuan: moneyFields(row, 'current_balance'),
    signed_balance_yuan: moneyFields(row, 'signed_balance'),
    available_balance_yuan: moneyFields(row, 'available_balance'),
    credit_limit_yuan: moneyFields(row, 'credit_limit'),
    available_credit_yuan: moneyFields(row, 'available_credit'),
    subtree_asset_yuan: moneyFields(row, 'subtree_asset'),
    subtree_liability_yuan: moneyFields(row, 'subtree_liability'),
    subtree_net_yuan: moneyFields(row, 'subtree_net'),
    subtree_available_credit_yuan: moneyFields(row, 'subtree_available_credit')
  };
}

function enrichTransaction(row) {
  return {
    ...row,
    amount_yuan: centsToYuan(row.amount_cents),
    balance_effect_yuan: centsToYuan(row.balance_effect_cents),
    balance_after_yuan: centsToYuan(row.balance_after_cents),
    income_yuan: centsToYuan(row.income_cents),
    expense_yuan: centsToYuan(row.expense_cents),
    transfer_yuan: centsToYuan(row.transfer_cents),
    cash_flow_yuan: centsToYuan(row.cash_flow_cents),
    direction_label: row.direction === 'income' ? '收入' : row.direction === 'expense' ? '支出' : '转账'
  };
}

function validateDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${field} 必须是 YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} 不是有效日期：${value}`);
  }
  return value;
}

function assertDirection(direction) {
  if (direction === undefined || direction === null || direction === '') return null;
  if (!DIRECTIONS.includes(direction)) {
    throw new TypeError(`direction 必须是 ${DIRECTIONS.join(' / ')}`);
  }
  return direction;
}

/* ── 查询接口 ─────────────────────────────────────── */

export function getMeta(db) {
  const rows = db.prepare('SELECT key, value FROM meta ORDER BY key').all();
  return Object.fromEntries(rows.map(row => [row.key, row.value]));
}

export function listPlatforms(db) {
  return db.prepare('SELECT * FROM platforms ORDER BY sort_order, id').all();
}

export function listAccounts(db, { platformId, userId, includeContainers = true } = {}) {
  const where = [];
  const params = [];
  if (platformId) {
    where.push('platform_id = ?');
    params.push(platformId);
  }
  if (userId) {
    where.push('id IN (SELECT account_id FROM account_ownership WHERE user_id = ?)');
    params.push(userId);
  }
  if (!includeContainers) where.push("account_class <> 'container'");
  const sql = `
    SELECT * FROM v_accounts
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY platform_name, sort_order, id
  `;
  const rows = db.prepare(sql).all(...params);
  return rows.map(enrichAccount);
}

export function getAccount(db, accountId, { userId } = {}) {
  const row = db.prepare('SELECT * FROM v_accounts WHERE id = ?').get(accountId);
  if (!row) return null;
  if (userId) {
    const owned = db.prepare('SELECT 1 AS ok FROM account_ownership WHERE account_id = ? AND user_id = ?').get(accountId, userId);
    if (!owned) return null;
  }
  return enrichAccount(row);
}

export function listAccountTree(db, { userId } = {}) {
  const flat = listAccounts(db, { userId });
  const byId = new Map();
  for (const row of flat) byId.set(row.id, { ...row, children: [], depth: 0 });
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id).children.push(node);
    else roots.push(node);
  }
  const assignDepth = (nodes, depth) => {
    for (const node of nodes) {
      node.depth = depth;
      assignDepth(node.children, depth + 1);
    }
  };
  assignDepth(roots, 0);
  return { roots, flat };
}

export function listTransactions(db, {
  platformId,
  accountId,
  userId,
  direction,
  from,
  to,
  category,
  subscriptionId,
  limit = 100,
  offset = 0,
  order = 'desc'
} = {}) {
  const normalizedDirection = assertDirection(direction);
  if (from !== undefined && from !== null && from !== '') validateDate(from, 'from');
  if (to !== undefined && to !== null && to !== '') validateDate(to, 'to');
  if (from && to && from > to) throw new TypeError('from 不能晚于 to');
  const normalizedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const normalizedOffset = Math.max(0, Number(offset) || 0);
  if (order !== 'asc' && order !== 'desc') throw new TypeError("order 必须是 'asc' 或 'desc'");

  const where = [];
  const params = [];
  if (platformId) { where.push('platform_id = ?'); params.push(platformId); }
  if (accountId) { where.push('account_id = ?'); params.push(accountId); }
  if (userId) { where.push('account_id IN (SELECT account_id FROM account_ownership WHERE user_id = ?)'); params.push(userId); }
  if (normalizedDirection) { where.push('direction = ?'); params.push(normalizedDirection); }
  if (from) { where.push('occurred_on >= ?'); params.push(from); }
  if (to) { where.push('occurred_on <= ?'); params.push(to); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (subscriptionId) { where.push('subscription_id = ?'); params.push(subscriptionId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM v_transactions ${whereSql}`).get(...params).n;
  const rows = db.prepare(`
    SELECT * FROM v_transactions
    ${whereSql}
    ORDER BY occurred_at ${order.toUpperCase()}, id ${order.toUpperCase()}
    LIMIT ? OFFSET ?
  `).all(...params, normalizedLimit, normalizedOffset);

  return {
    total,
    limit: normalizedLimit,
    offset: normalizedOffset,
    filters: {
      platformId: platformId || null,
      accountId: accountId || null,
      direction: normalizedDirection,
      from: from || null,
      to: to || null,
      category: category || null,
      subscriptionId: subscriptionId || null
    },
    items: rows.map(enrichTransaction)
  };
}

export function getMonthlySummary(db, { from, to, platformId, userId } = {}) {
  if (from) validateDate(from, 'from');
  if (to) validateDate(to, 'to');
  if (from && to && from > to) throw new TypeError('from 不能晚于 to');
  const where = [];
  const params = [];
  if (from) { where.push('occurred_on >= ?'); params.push(from); }
  if (to) { where.push('occurred_on <= ?'); params.push(to); }
  if (platformId) { where.push('platform_id = ?'); params.push(platformId); }
  if (userId) { where.push('account_id IN (SELECT account_id FROM account_ownership WHERE user_id = ?)'); params.push(userId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT substr(occurred_on, 1, 7) AS month, platform_id, platform_name,
           COUNT(*) AS transaction_count,
           SUM(income_cents) AS income_cents,
           SUM(expense_cents) AS expense_cents,
           SUM(transfer_cents) AS transfer_cents,
           SUM(cash_flow_cents) AS cash_flow_cents
      FROM v_transactions
      ${whereSql}
     GROUP BY month, platform_id, platform_name
     ORDER BY month, platform_id
  `).all(...params).map(row => ({
    ...row,
    income_yuan: centsToYuan(row.income_cents),
    expense_yuan: centsToYuan(row.expense_cents),
    transfer_yuan: centsToYuan(row.transfer_cents),
    cash_flow_yuan: centsToYuan(row.cash_flow_cents)
  }));
}

export function listSubscriptions(db, { status, platformId, userId } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (platformId) { where.push('payment_platform_id = ?'); params.push(platformId); }
  if (userId) { where.push('payment_account_id IN (SELECT account_id FROM account_ownership WHERE user_id = ?)'); params.push(userId); }
  return db.prepare(`
    SELECT * FROM v_subscriptions
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY status, billing_day, id
  `).all(...params).map(row => ({
    ...row,
    amount_yuan: centsToYuan(row.amount_cents)
  }));
}

export function listFinancialProducts(db, { institution } = {}) {
  const where = [];
  const params = [];
  if (institution) { where.push('institution = ?'); params.push(institution); }
  return db.prepare(`
    SELECT * FROM financial_products
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY institution, product_type, id
  `).all(...params);
}

/* ── 校验、摘要与内容指纹 ─────────────────────────── */

function monthRange(first, last) {
  const months = [];
  let cursor = new Date(`${first}-01T00:00:00Z`);
  const end = new Date(`${last}-01T00:00:00Z`);
  while (cursor <= end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export function validateDatabase(db) {
  const meta = getMeta(db);
  const asOf = meta.as_of;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  add('schema_version', meta.schema_version === SCHEMA_VERSION,
    meta.schema_version ? `schema_version=${meta.schema_version}` : 'meta 中缺少 schema_version');
  add('as_of', Boolean(asOf), asOf ? `as_of=${asOf}` : 'meta 中缺少 as_of');

  const txCount = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
  add('transactions_present', txCount > 0, `transactions=${txCount}`);

  const future = db.prepare(`
    SELECT COUNT(*) AS n FROM transactions
     WHERE occurred_on > ? OR substr(occurred_at, 1, 10) > ?
  `).get(asOf, asOf).n;
  add('no_future_transactions', future === 0, `future_rows=${future}`);

  const futureSubs = db.prepare(`
    SELECT COUNT(*) AS n FROM subscriptions
     WHERE last_charged_on IS NOT NULL AND last_charged_on > ?
  `).get(asOf).n;
  add('no_future_subscription_charges', futureSubs === 0, `future_subscription_rows=${futureSubs}`);

  const balanceMismatch = db.prepare(`
    SELECT a.id, a.name,
           a.opening_balance_cents,
           a.current_balance_cents,
           a.opening_balance_cents + COALESCE(SUM(t.balance_effect_cents), 0)
             + COALESCE((SELECT SUM(l.effect_cents) FROM live_transfer_legs l WHERE l.account_id = a.id), 0) AS expected_cents
      FROM accounts a
      LEFT JOIN transactions t ON t.account_id = a.id
     WHERE a.account_class <> 'container'
     GROUP BY a.id
    HAVING a.current_balance_cents <> expected_cents
  `).all();
  add('account_balances_reconciled', balanceMismatch.length === 0,
    balanceMismatch.length ? `mismatches=${balanceMismatch.length}` : 'opening + signed flows + live ledger = current');

  const brokenLiveGroups = db.prepare(`
    SELECT l.transfer_id, t.kind, COUNT(*) AS leg_count, SUM(l.effect_cents) AS net
      FROM live_transfer_legs l
      JOIN live_transfers t ON t.id = l.transfer_id
     GROUP BY l.transfer_id
    HAVING (t.kind = 'external' AND leg_count <> 1)
        OR (t.kind = 'internal' AND (leg_count <> 2 OR net <> 0))
        OR (t.kind = 'loan' AND (leg_count <> 2 OR net <= 0))
  `).all();
  add('live_transfer_legs_consistent', brokenLiveGroups.length === 0,
    brokenLiveGroups.length ? `broken_transfers=${brokenLiveGroups.length}` : 'each live transfer has consistent legs');

  const loanApps = db.prepare('SELECT COUNT(*) AS n FROM loan_applications').get().n;
  add('loan_applications_tracked', loanApps >= 0, `applications=${loanApps}`);

  const platformMismatch = db.prepare(`
    SELECT COUNT(*) AS n
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
     WHERE t.platform_id <> a.platform_id
  `).get().n;
  add('transaction_platform_matches_account', platformMismatch === 0, `mismatches=${platformMismatch}`);

  const containerTx = db.prepare(`
    SELECT COUNT(*) AS n
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
     WHERE a.account_class = 'container'
  `).get().n;
  add('no_container_transactions', containerTx === 0, `container_rows=${containerTx}`);

  const overLimit = db.prepare(`
    SELECT COUNT(*) AS n FROM accounts
     WHERE account_class = 'liability' AND credit_limit_cents IS NOT NULL
       AND current_balance_cents > credit_limit_cents
  `).get().n;
  add('within_credit_limits', overLimit === 0, `over_limit_accounts=${overLimit}`);

  const negative = db.prepare(`
    SELECT COUNT(*) AS n FROM accounts
     WHERE account_class <> 'container' AND current_balance_cents < 0
  `).get().n;
  add('no_negative_balances', negative === 0, `negative_accounts=${negative}`);

  const brokenGroups = db.prepare(`
    SELECT transfer_group_id, COUNT(*) AS n
      FROM transactions
     WHERE is_internal_transfer = 1 AND transfer_group_id IS NOT NULL
     GROUP BY transfer_group_id
    HAVING n <> 2
  `).all();
  add('internal_transfers_are_paired', brokenGroups.length === 0,
    brokenGroups.length ? `broken_groups=${brokenGroups.length}` : 'each transfer group has exactly 2 legs');

  const requiredTypes = ['BANK_DEBIT', 'BANK_SAVINGS', 'WEBANK_CREDIT', 'CREDIT_CARD'];
  const presentTypes = new Set(db.prepare('SELECT DISTINCT account_type FROM accounts').all().map(row => row.account_type));
  add('required_account_types', requiredTypes.every(type => presentTypes.has(type)),
    `present=${[...presentTypes].sort().join(',')}`);

  const primaryBank = db.prepare(`
    SELECT COUNT(*) AS n
      FROM accounts a
      JOIN platforms p ON p.id = a.platform_id
     WHERE a.is_primary = 1 AND p.name = '众微银行'
  `).get().n;
  add('webbank_is_primary', primaryBank >= 1, `webbank_primary_accounts=${primaryBank}`);

  const bounds = db.prepare(`
    SELECT MIN(occurred_on) AS min_day, MAX(occurred_on) AS max_day,
           COUNT(DISTINCT substr(occurred_on, 1, 7)) AS month_count
      FROM transactions
  `).get();
  const months = db.prepare(`
    SELECT DISTINCT substr(occurred_on, 1, 7) AS month
      FROM transactions ORDER BY month
  `).all().map(row => row.month);
  const expected = months.length ? monthRange(months[0], months.at(-1)) : [];
  const continuous = months.length === expected.length;
  add('three_consecutive_months',
    months.length >= 3 && continuous && bounds.min_day <= asOf && bounds.max_day <= asOf,
    `${months.join(',')} (continuous=${continuous}, rows=${txCount})`);

  const invalid = checks.filter(check => !check.ok);
  return {
    ok: invalid.length === 0,
    asOf: asOf || null,
    checks,
    issues: invalid.map(check => `${check.name}: ${check.detail}`),
    stats: {
      transactions: txCount,
      firstDate: bounds.min_day,
      lastDate: bounds.max_day,
      months,
      monthCount: months.length
    }
  };
}

export function getDatabaseSummary(db, { databasePath = null, userId = null } = {}) {
  const meta = getMeta(db);
  const ownedIds = userId ? `(SELECT account_id FROM account_ownership WHERE user_id = '${String(userId).replaceAll("'", "''")}')` : '';
  const accountsOwnershipFilter = userId ? `id IN ${ownedIds}` : null;
  const ownershipFilter = userId ? `account_id IN ${ownedIds}` : null;
  const subscriptionOwnershipFilter = userId ? `payment_account_id IN ${ownedIds}` : null;
  const accountsWhere = (extra) => {
    const parts = [];
    if (extra) parts.push(extra);
    if (accountsOwnershipFilter) parts.push(accountsOwnershipFilter);
    return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  };
  const counts = {
    platforms: userId ? db.prepare(`SELECT COUNT(DISTINCT platform_id) AS n FROM accounts ${accountsWhere()}`).get().n : db.prepare('SELECT COUNT(*) AS n FROM platforms').get().n,
    accounts: db.prepare(`SELECT COUNT(*) AS n FROM accounts ${accountsWhere()}`).get().n,
    containers: db.prepare(`SELECT COUNT(*) AS n FROM accounts ${accountsWhere("account_class = 'container'")}`).get().n,
    subscriptions: db.prepare(`SELECT COUNT(*) AS n FROM subscriptions ${subscriptionOwnershipFilter ? 'WHERE ' + subscriptionOwnershipFilter : ''}`).get().n,
    activeSubscriptions: db.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' ${subscriptionOwnershipFilter ? 'AND ' + subscriptionOwnershipFilter : ''}`).get().n,
    transactions: db.prepare(`SELECT COUNT(*) AS n FROM transactions ${ownershipFilter ? 'WHERE ' + ownershipFilter : ''}`).get().n,
    financialProducts: db.prepare('SELECT COUNT(*) AS n FROM financial_products').get().n
  };
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN account_class = 'asset' THEN current_balance_cents ELSE 0 END), 0) AS assets_cents,
      COALESCE(SUM(CASE WHEN account_class = 'liability' THEN current_balance_cents ELSE 0 END), 0) AS liabilities_cents,
      COALESCE(SUM(CASE WHEN account_class = 'asset' AND is_payable = 1 THEN current_balance_cents ELSE 0 END), 0) AS payable_cents,
      COALESCE(SUM(CASE WHEN account_class = 'liability' AND credit_limit_cents IS NOT NULL
                        THEN credit_limit_cents - current_balance_cents ELSE 0 END), 0) AS available_credit_cents
    FROM accounts
    ${accountsWhere()}
  `).get();
  const bounds = db.prepare(`
    SELECT MIN(occurred_on) AS first_date, MAX(occurred_on) AS last_date,
           COUNT(DISTINCT substr(occurred_on, 1, 7)) AS month_count
      FROM transactions
  `).get();
  const monthlyActive = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS n
      FROM subscriptions WHERE status = 'active' AND billing_cycle = 'monthly'
  `).get().n;
  const holdingsCents = Number(db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM wealth_holdings${userId ? ' WHERE user_id = ?' : ''}`
  ).get(...(userId ? [userId] : [])).n) || 0;
  const totalAssetsCents = Number(totals.assets_cents) + holdingsCents;

  return {
    database: databasePath,
    meta,
    counts,
    totals: {
      ...totals,
      holdings_cents: holdingsCents,
      assets_cents: totalAssetsCents,
      net_cents: totalAssetsCents - totals.liabilities_cents,
      assets_yuan: centsToYuan(totalAssetsCents),
      liabilities_yuan: centsToYuan(totals.liabilities_cents),
      net_yuan: centsToYuan(totalAssetsCents - totals.liabilities_cents),
      payable_yuan: centsToYuan(totals.payable_cents),
      available_credit_yuan: centsToYuan(totals.available_credit_cents),
      holdings_yuan: centsToYuan(holdingsCents)
    },
    monthlyActiveSubscriptionsCents: monthlyActive,
    monthlyActiveSubscriptionsYuan: centsToYuan(monthlyActive),
    period: bounds,
    integrity: validateDatabase(db)
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = stableValue(value[key]);
    return sorted;
  }
  return value;
}

export function contentDigest(db) {
  const tables = ['meta', 'platforms', 'accounts', 'subscriptions', 'transactions'];
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    tables: tables.map(table => ({
      table,
      rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(stableValue)
    }))
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/* ── 桌面银行服务层：用户 / 卡凭据 / 挂失 / 实时转账 / 审计 / 通知 ── */

export const SERVICE_USERS = Object.freeze([
  {
    id: 'u-lin',
    display_name: '林予安',
    phone_masked: '138****6800',
    avatar_emoji: '林',
    pin: '123456',
    is_default: 1,
    intro: '主用户：众微银行工资卡 + 微信支付 + 招行信用卡，含 8-10 月完整账期流水。'
  },
  {
    id: 'u-shen',
    display_name: '沈知微',
    phone_masked: '139****2613',
    avatar_emoji: '沈',
    pin: '123456',
    is_default: 0,
    intro: '第二体验用户：众微银行储蓄卡、定期存款、微粒贷与信用卡，全量账户结构。'
  },
  {
    id: 'u-gu',
    display_name: '顾清晏',
    phone_masked: '137****4508',
    avatar_emoji: '顾',
    pin: '123456',
    is_default: 0,
    intro: '第三体验用户：众微银行全量账户，可作为转账收款方。'
  }
]);

const SERVICE_CARD_SEEDS = Object.freeze([
  { account_id: 'wb-debit', user_id: 'u-lin', card_number: '6236360012344821' },
  { account_id: 'cmb-credit', user_id: 'u-lin', card_number: '6225880012344021' }
]);

function nowStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}+08:00`;
}

function runInTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const AUDIT_HASH_LEVELS = ['green', 'yellow', 'red'];

export function resolveChannelUser(db, { channel, providerUserId, allowUserIdFallback = false }) {
  const provider = String(providerUserId || '').trim();
  const name = String(channel || '').trim();
  if (!provider || !name) return null;
  const bound = db.prepare('SELECT user_id FROM channel_bindings WHERE channel = ? AND provider_user_id = ?').get(name, provider);
  if (bound && bound.user_id) return bound.user_id;
  if (allowUserIdFallback) {
    const user = getAppUser(db, provider);
    if (user) return user.id;
  }
  return null;
}

export function bindChannelUser(db, { channel, providerUserId, userId, corpId = null }) {
  const stamp = nowStamp();
  db.prepare(`INSERT INTO channel_bindings (channel, provider_user_id, user_id, corp_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel, provider_user_id) DO UPDATE SET user_id = excluded.user_id, corp_id = excluded.corp_id, updated_at = excluded.updated_at`)
    .run(channel, providerUserId, userId, corpId, stamp, stamp);
}

export function listChannelBindings(db, { userId }) {
  return db.prepare(`SELECT channel, provider_user_id, corp_id, created_at
      FROM channel_bindings WHERE user_id = ? ORDER BY channel, provider_user_id`).all(userId)
    .map(row => ({ channel: row.channel, providerUserId: row.provider_user_id, corpId: row.corp_id, createdAt: row.created_at }));
}

export function unbindChannelUser(db, { channel, providerUserId, userId }) {
  const result = db.prepare('DELETE FROM channel_bindings WHERE channel = ? AND provider_user_id = ? AND user_id = ?')
    .run(channel, providerUserId, userId);
  return result.changes > 0;
}

export function visitorUserIdFor(visitorId, channel = 'web') {
  const prefix = channel === 'wecom' ? 'w-' : 'v-';
  return prefix + createHash('sha256').update(String(visitorId)).digest('hex').slice(0, 12);
}

function accountIdList(db, userId) {
  return db.prepare('SELECT account_id FROM account_ownership WHERE user_id = ?').all(userId).map(row => row.account_id);
}

function sqlPlaceholders(count) {
  return new Array(count).fill('?').join(', ');
}

const writableColumnCache = new Map();
function writableColumns(db, table) {
  if (!writableColumnCache.has(table)) {
    const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all();
    writableColumnCache.set(table, rows.filter(row => !row.hidden).map(row => row.name));
  }
  return writableColumnCache.get(table);
}

function insertMappedRow(db, table, row, transform) {
  const columns = writableColumns(db, table).filter(column => Object.prototype.hasOwnProperty.call(row, column));
  const values = columns.map(column => (transform ? transform(column, row[column]) : row[column]));
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${sqlPlaceholders(columns.length)})`).run(...values);
}

/* 把模板用户的完整工作区复制成一个独立用户：账户、卡凭据、流水、订阅、账单、持仓、策略。 */
export function cloneUserWorkspace(db, { sourceUserId, newUserId, displayName = null }) {
  if (getAppUser(db, newUserId)) return { created: false, userId: newUserId };
  const source = db.prepare('SELECT * FROM app_users WHERE id = ?').get(sourceUserId);
  if (!source) throw new Error('模板用户不存在：' + sourceUserId);
  const stamp = nowStamp();
  runInTransaction(db, () => {
    insertMappedRow(db, 'app_users', source, (column, value) => {
      if (column === 'id') return newUserId;
      if (column === 'display_name') return displayName || ('访客 ' + newUserId.slice(-4));
      if (column === 'pin') return '123456';
      if (column === 'is_default') return 0;
      if (column === 'created_at') return stamp;
      return value;
    });
    const accounts = db.prepare(`SELECT a.* FROM accounts a
        JOIN account_ownership o ON o.account_id = a.id WHERE o.user_id = ?`).all(sourceUserId);
    const accountMap = new Map(accounts.map(account => [account.id, newUserId + '-' + account.id]));
    const accountById = new Map(accounts.map(account => [account.id, account]));
    const orderedAccounts = [];
    const visited = new Set();
    const visit = (accountId) => {
      if (!accountId || visited.has(accountId) || !accountById.has(accountId)) return;
      visited.add(accountId);
      const account = accountById.get(accountId);
      if (account.parent_id) visit(account.parent_id);
      orderedAccounts.push(account);
    };
    for (const account of accounts) visit(account.id);
    for (const account of orderedAccounts) {
      insertMappedRow(db, 'accounts', account, (column, value) => {
        if (column === 'id') return accountMap.get(account.id);
        if (column === 'parent_id') return value ? (accountMap.get(value) || null) : null;
        return value;
      });
      db.prepare('INSERT INTO account_ownership (account_id, user_id, created_at) VALUES (?, ?, ?)')
        .run(accountMap.get(account.id), newUserId, stamp);
    }
    for (const row of db.prepare('SELECT * FROM card_credentials WHERE user_id = ?').all(sourceUserId)) {
      if (!accountMap.get(row.account_id)) continue;
      insertMappedRow(db, 'card_credentials', row, (column, value) => {
        if (column === 'account_id') return accountMap.get(row.account_id);
        if (column === 'user_id') return newUserId;
        if (column === 'password') return '123456';
        if (column === 'failed_attempts') return 0;
        if (column === 'trade_locked') return 0;
        if (column === 'password_updated_at' || column === 'updated_at') return stamp;
        return value;
      });
    }
    const accountIds = accounts.map(account => account.id);
    const subscriptionMap = new Map();
    if (accountIds.length) {
      const subscriptionRows = db.prepare(`SELECT * FROM subscriptions
          WHERE payment_account_id IN (${sqlPlaceholders(accountIds.length)})`).all(...accountIds);
      for (const row of subscriptionRows) {
        const newId = newUserId + '-' + row.id;
        subscriptionMap.set(row.id, newId);
        insertMappedRow(db, 'subscriptions', row, (column, value) => {
          if (column === 'id') return newId;
          if (column === 'payment_account_id') return accountMap.get(value) || null;
          return value;
        });
      }
      const transactionRows = db.prepare(`SELECT * FROM transactions
          WHERE account_id IN (${sqlPlaceholders(accountIds.length)})`).all(...accountIds);
      for (const row of transactionRows) {
        insertMappedRow(db, 'transactions', row, (column, value) => {
          if (column === 'id') return newUserId + '-' + row.id;
          if (column === 'account_id') return accountMap.get(row.account_id) || null;
          if (column === 'subscription_id') return value ? (subscriptionMap.get(value) || null) : null;
          if (column === 'transfer_group_id') return value ? newUserId + '-' + value : null;
          return value;
        });
      }
    }
    for (const row of db.prepare('SELECT * FROM aa_bills WHERE user_id = ?').all(sourceUserId)) {
      insertMappedRow(db, 'aa_bills', row, (column, value) => {
        if (column === 'id') return newUserId + '-' + row.id;
        if (column === 'user_id') return newUserId;
        if (column === 'from_account_id') return accountMap.get(value) || null;
        return value;
      });
    }
    for (const row of db.prepare('SELECT * FROM loan_applications WHERE user_id = ?').all(sourceUserId)) {
      insertMappedRow(db, 'loan_applications', row, (column, value) => {
        if (column === 'id') return newUserId + '-' + row.id;
        if (column === 'user_id') return newUserId;
        if (column === 'disbursed_account_id' || column === 'credit_account_id') return value ? (accountMap.get(value) || null) : null;
        if (column === 'transfer_id') return null;
        return value;
      });
    }
    for (const row of db.prepare('SELECT * FROM wealth_holdings WHERE user_id = ?').all(sourceUserId)) {
      insertMappedRow(db, 'wealth_holdings', row, (column, value) => {
        if (column === 'id') return newUserId + '-' + row.id;
        if (column === 'user_id') return newUserId;
        return value;
      });
    }
    for (const row of db.prepare('SELECT * FROM scheduled_transfers WHERE user_id = ?').all(sourceUserId)) {
      const fromId = accountMap.get(row.from_account_id);
      const toId = accountMap.get(row.to_account_id);
      if (!fromId || !toId) continue;
      insertMappedRow(db, 'scheduled_transfers', row, (column, value) => {
        if (column === 'id') return newUserId + '-' + row.id;
        if (column === 'user_id') return newUserId;
        if (column === 'from_account_id') return fromId;
        if (column === 'to_account_id') return toId;
        return value;
      });
    }
    const policy = db.prepare('SELECT * FROM user_policies WHERE user_id = ?').get(sourceUserId);
    if (policy) {
      insertMappedRow(db, 'user_policies', policy, (column, value) => {
        if (column === 'user_id') return newUserId;
        if (column === 'updated_at') return stamp;
        return value;
      });
    }
  });
  return { created: true, userId: newUserId };
}

export function getVisitorProfile(db, visitorId) {
  return db.prepare('SELECT * FROM visitor_profiles WHERE visitor_id = ?').get(visitorId) || null;
}

export function touchVisitorProfile(db, visitorId) {
  db.prepare('UPDATE visitor_profiles SET last_seen_at = ? WHERE visitor_id = ?').run(nowStamp(), visitorId);
}

export function createVisitorWorkspace(db, { visitorId, channel = 'web', templateUserId = 'u-lin', displayName = null }) {
  const existing = getVisitorProfile(db, visitorId);
  if (existing) {
    touchVisitorProfile(db, visitorId);
    if (getAppUser(db, existing.user_id)) return { created: false, userId: existing.user_id, visitorId };
    db.prepare('DELETE FROM visitor_profiles WHERE visitor_id = ?').run(visitorId);
  }
  const baseUserId = visitorUserIdFor(visitorId, channel);
  let userId = baseUserId;
  let suffix = 0;
  while (getAppUser(db, userId)) {
    suffix += 1;
    userId = baseUserId + '-' + suffix;
  }
  cloneUserWorkspace(db, { sourceUserId: templateUserId, newUserId: userId, displayName });
  const stamp = nowStamp();
  db.prepare(`INSERT INTO visitor_profiles (visitor_id, user_id, channel, display_name, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(visitor_id) DO UPDATE SET user_id = excluded.user_id, channel = excluded.channel,
        display_name = excluded.display_name, last_seen_at = excluded.last_seen_at`)
    .run(visitorId, userId, channel, displayName, stamp, stamp);
  return { created: true, userId, visitorId };
}

export function listVisitorProfiles(db) {
  return db.prepare('SELECT * FROM visitor_profiles ORDER BY last_seen_at ASC').all();
}

export function estimateVisitorBytes(db, userId) {
  const accountIds = accountIdList(db, userId);
  const countFor = (sql, params) => {
    try { return Number(db.prepare(sql).get(...params).n) || 0; } catch { return 0; }
  };
  const accountCount = accountIds.length;
  const transactionCount = accountCount
    ? countFor(`SELECT COUNT(*) AS n FROM transactions WHERE account_id IN (${sqlPlaceholders(accountCount)})`, accountIds)
    : 0;
  const subscriptionCount = accountCount
    ? countFor(`SELECT COUNT(*) AS n FROM subscriptions WHERE payment_account_id IN (${sqlPlaceholders(accountCount)})`, accountIds)
    : 0;
  const auditCount = countFor('SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ?', [userId]);
  // 实测 SQLite 实际磁盘增长约为行级估算的 1.6-1.7 倍（索引、页开销、回滚日志）。
  return Math.round((16384 + accountCount * 512 + transactionCount * 260 + subscriptionCount * 220 + auditCount * 180) * 1.7);
}

export function visitorStorageBytes(db) {
  return listVisitorProfiles(db).reduce((sum, profile) => sum + estimateVisitorBytes(db, profile.user_id), 0);
}

export function deleteUserWorkspace(db, userId) {
  const accountIds = accountIdList(db, userId);
  runInTransaction(db, () => {
    db.prepare('DELETE FROM agent_tickets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM channel_bindings WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM visitor_profiles WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
    // 审计链是全局前向哈希链，不能物理删除中间行，否则链校验永久断裂；访客行保留。
    db.prepare('DELETE FROM scheduled_transfers WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM wealth_holdings WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM loan_applications WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM aa_bills WHERE user_id = ?').run(userId);
    if (accountIds.length) {
      const placeholders = sqlPlaceholders(accountIds.length);
      db.prepare(`DELETE FROM transactions WHERE account_id IN (${placeholders})`).run(...accountIds);
      db.prepare(`DELETE FROM subscriptions WHERE payment_account_id IN (${placeholders})`).run(...accountIds);
      db.prepare(`DELETE FROM card_credentials WHERE account_id IN (${placeholders})`).run(...accountIds);
      try { db.prepare(`DELETE FROM loss_reports WHERE account_id IN (${placeholders})`).run(...accountIds); } catch { /* 表或列不在 */ }
      db.prepare(`DELETE FROM account_ownership WHERE account_id IN (${placeholders})`).run(...accountIds);
      const transferIds = db.prepare('SELECT id FROM live_transfers WHERE user_id = ?').all(userId).map(row => row.id);
      if (transferIds.length) {
        db.prepare(`DELETE FROM live_transfer_legs WHERE transfer_id IN (${sqlPlaceholders(transferIds.length)})`).run(...transferIds);
      }
      db.prepare(`DELETE FROM live_transfer_legs WHERE account_id IN (${placeholders})`).run(...accountIds);
      db.prepare('DELETE FROM live_transfers WHERE user_id = ?').run(userId);
      const accountRows = db.prepare(`SELECT id, parent_id FROM accounts WHERE id IN (${placeholders})`).all(...accountIds);
      const depth = new Map();
      const accountById = new Map(accountRows.map(row => [row.id, row]));
      const depthOf = (id) => {
        if (depth.has(id)) return depth.get(id);
        const row = accountById.get(id);
        const value = row && row.parent_id && accountById.has(row.parent_id) ? depthOf(row.parent_id) + 1 : 0;
        depth.set(id, value);
        return value;
      };
      for (const row of accountRows) depthOf(row.id);
      for (const row of [...accountRows].sort((a, b) => depth.get(b.id) - depth.get(a.id))) {
        db.prepare('DELETE FROM accounts WHERE id = ?').run(row.id);
      }
    }
    db.prepare('DELETE FROM user_policies WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM app_users WHERE id = ?').run(userId);
  });
}

export function pruneVisitors(db, { limitBytes, keepUserId = null }) {
  let total = visitorStorageBytes(db);
  const removed = [];
  if (total <= limitBytes) return { removed, totalBytes: total };
  for (const profile of listVisitorProfiles(db)) {
    if (total <= limitBytes) break;
    if (keepUserId && profile.user_id === keepUserId) continue;
    const size = estimateVisitorBytes(db, profile.user_id);
    deleteUserWorkspace(db, profile.user_id);
    total = Math.max(0, total - size);
    removed.push(profile.visitor_id);
  }
  return { removed, totalBytes: total };
}

export function getChannelMessage(db, channel, messageId) {
  return db.prepare('SELECT * FROM channel_messages WHERE channel = ? AND message_id = ?').get(channel, messageId) || null;
}

export function startChannelMessage(db, { channel, messageId, userId, sessionId, requestDigest }) {
  const stamp = nowStamp();
  const result = db.prepare(`INSERT OR IGNORE INTO channel_messages
      (channel, message_id, user_id, session_id, request_digest, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)`)
    .run(channel, messageId, userId, sessionId, requestDigest, stamp, stamp);
  return { inserted: result.changes > 0, row: getChannelMessage(db, channel, messageId) };
}

export function finishChannelMessage(db, channel, messageId, { status = 'done', responseJson = null } = {}) {
  db.prepare('UPDATE channel_messages SET status = ?, response_json = ?, updated_at = ? WHERE channel = ? AND message_id = ?')
    .run(status, responseJson, nowStamp(), channel, messageId);
}

export function persistAgentTicket(db, { id, userId, sessionId = null, channel = null, tool, label = null, args = {}, digest = null, planId = null, expiresAt }) {
  db.prepare(`INSERT OR REPLACE INTO agent_tickets
      (id, user_id, session_id, channel, tool, label, args_json, digest, plan_id, status, expires_at, created_at, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`)
    .run(id, userId, sessionId, channel, tool, label, JSON.stringify(args || {}), digest, planId, expiresAt, nowStamp());
}

export function getAgentTicketRow(db, id) {
  return db.prepare('SELECT * FROM agent_tickets WHERE id = ?').get(id) || null;
}

export function markAgentTicketUsed(db, id, userId) {
  const result = db.prepare(`UPDATE agent_tickets SET status = 'used', used_at = ?
      WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?`)
    .run(nowStamp(), id, userId, nowStamp());
  return result.changes > 0;
}

function auditPayload(row) {
  const base = [row.prev_hash, row.id, row.user_id || '', row.action, row.target || '', row.detail || '', row.created_at].join('|');
  const extras = [row.channel, row.session_id, row.message_id, row.plan_id, row.node_id, row.input_digest, row.result_ref]
    .map(value => (value == null ? '' : String(value)));
  return extras.some(Boolean) ? base + '|' + extras.join('|') : base;
}

export function writeAudit(db, {
  userId = null, action, target = null, detail = null, level = null,
  channel = null, sessionId = null, messageId = null, planId = null,
  nodeId = null, inputDigest = null, resultRef = null
}) {
  const stamp = nowStamp();
  const row = {
    id: `audit-${randomUUID()}`, user_id: userId, action, target, detail, created_at: stamp,
    channel, session_id: sessionId, message_id: messageId, plan_id: planId,
    node_id: nodeId, input_digest: inputDigest, result_ref: resultRef
  };
  for (const ddl of [
    'ALTER TABLE audit_log ADD COLUMN prev_hash TEXT',
    'ALTER TABLE audit_log ADD COLUMN hash TEXT',
    'ALTER TABLE audit_log ADD COLUMN level TEXT',
    'ALTER TABLE audit_log ADD COLUMN channel TEXT',
    'ALTER TABLE audit_log ADD COLUMN session_id TEXT',
    'ALTER TABLE audit_log ADD COLUMN message_id TEXT',
    'ALTER TABLE audit_log ADD COLUMN plan_id TEXT',
    'ALTER TABLE audit_log ADD COLUMN node_id TEXT',
    'ALTER TABLE audit_log ADD COLUMN input_digest TEXT',
    'ALTER TABLE audit_log ADD COLUMN result_ref TEXT'
  ]) {
    try { db.exec(ddl); } catch (error) { /* 列已存在 */ }
  }
  const last = db.prepare('SELECT hash FROM audit_log WHERE hash IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1').get();
  const prevHash = last ? last.hash : 'GENESIS';
  row.prev_hash = prevHash;
  row.hash = createHash('sha256').update(auditPayload({ ...row, prev_hash: prevHash })).digest('hex');
  row.level = AUDIT_HASH_LEVELS.includes(level) ? level : null;
  db.prepare(`INSERT INTO audit_log
      (id, user_id, action, target, detail, created_at, prev_hash, hash, level,
       channel, session_id, message_id, plan_id, node_id, input_digest, result_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.user_id, row.action, row.target, row.detail, row.created_at, row.prev_hash, row.hash, row.level,
      row.channel, row.session_id, row.message_id, row.plan_id, row.node_id, row.input_digest, row.result_ref);
  return row;
}

export function verifyAuditChain(db, { limit = 50 } = {}) {
  const rows = db.prepare('SELECT * FROM audit_log WHERE hash IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(Math.min(200, Math.max(1, Number(limit) || 50))).reverse();
  let brokenAt = null;
  let expected = rows.length ? rows[0].prev_hash : 'GENESIS';
  for (const row of rows) {
    const actual = createHash('sha256').update(auditPayload(row)).digest('hex');
    if (row.prev_hash !== expected || actual !== row.hash) { brokenAt = row.id; break; }
    expected = row.hash;
  }
  return { valid: brokenAt === null, brokenAt, count: rows.length };
}

export function auditStats(db, { userId = null } = {}) {
  const today = nowStamp().slice(0, 10);
  const where = userId ? 'WHERE user_id = ? AND substr(created_at, 1, 10) = ?' : "WHERE substr(created_at, 1, 10) = ?";
  const params = userId ? [userId, today] : [today];
  const byLevel = {};
  for (const lv of AUDIT_HASH_LEVELS) byLevel[lv] = 0;
  for (const row of db.prepare(`SELECT level, COUNT(*) AS n FROM audit_log ${where} GROUP BY level`).all(...params)) {
    if (row.level && row.level in byLevel) byLevel[row.level] = row.n;
  }
  const blocked = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where} AND action = 'security.injection_blocked'`).get(...params).n;
  return { date: today, byLevel, blocked, total: byLevel.green + byLevel.yellow + byLevel.red + blocked };
}

export function pushNotification(db, { userId, title, body = null, level = 'info' }) {
  const row = { id: `ntf-${randomUUID()}`, user_id: userId, title, body, level, created_at: nowStamp(), read: 0 };
  db.prepare('INSERT INTO notifications (id, user_id, title, body, level, created_at, read) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.user_id, row.title, row.body, row.level, row.created_at, 0);
  return row;
}

export function listNotifications(db, { userId, limit = 10 } = {}) {
  if (!userId) return [];
  return db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(userId, Math.min(50, Math.max(1, Number(limit) || 10)));
}

export function listAudit(db, { userId = null, limit = 20 } = {}) {
  const where = userId ? 'WHERE user_id = ?' : '';
  const params = userId ? [userId, Math.min(100, Math.max(1, Number(limit) || 20))] : [Math.min(100, Math.max(1, Number(limit) || 20))];
  return db.prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params);
}

export function listAppUsers(db) {
  return db.prepare('SELECT id, display_name, phone_masked, avatar_emoji, pin, is_default, intro FROM app_users ORDER BY is_default DESC, id').all();
}

export function getAppUser(db, userId) {
  return db.prepare('SELECT id, display_name, phone_masked, avatar_emoji, pin, is_default, intro FROM app_users WHERE id = ?').get(userId) || null;
}

export function listUserAccountIds(db, userId) {
  return db.prepare('SELECT account_id FROM account_ownership WHERE user_id = ? ORDER BY account_id').all(userId).map(row => row.account_id);
}

export function ownsAccount(db, userId, accountId) {
  return Boolean(db.prepare('SELECT 1 AS ok FROM account_ownership WHERE user_id = ? AND account_id = ?').get(userId, accountId));
}

export function listUserCards(db, userId) {
  const rows = db.prepare(`
    SELECT a.*, c.card_number, c.password, c.password_updated_at, c.failed_attempts
      FROM account_ownership o
      JOIN v_accounts a ON a.id = o.account_id
      LEFT JOIN card_credentials c ON c.account_id = a.id
     WHERE o.user_id = ? AND a.account_class <> 'container' AND a.account_type IN ('BANK_DEBIT', 'CREDIT_CARD')
     ORDER BY a.sort_order, a.id
  `).all(userId);
  return rows.map(row => ({
    ...enrichAccount(row),
    card_number: row.card_number || null,
    password: row.password || null,
    password_updated_at: row.password_updated_at || null
  }));
}

export function getCardCredential(db, { accountId, userId = null }) {
  let row;
  if (userId) {
    row = db.prepare(`
      SELECT c.*, a.name AS account_name, a.masked_number, a.platform_name, a.status, a.account_type
        FROM card_credentials c
        JOIN v_accounts a ON a.id = c.account_id
       WHERE c.account_id = ? AND c.user_id = ?
    `).get(accountId, userId);
  } else {
    row = db.prepare(`
      SELECT c.*, a.name AS account_name, a.masked_number, a.platform_name, a.status, a.account_type
        FROM card_credentials c
        JOIN v_accounts a ON a.id = c.account_id
       WHERE c.account_id = ?
    `).get(accountId);
  }
  return row || null;
}

export function changeCardPassword(db, { userId, accountId, oldPassword, newPassword }) {
  if (typeof newPassword !== 'string' || !/^\d{6}$/.test(newPassword)) {
    throw new TypeError('新密码必须是 6 位数字');
  }
  if (newPassword === oldPassword) {
    throw new TypeError('新密码不能与原密码相同');
  }
  const credential = getCardCredential(db, { accountId, userId });
  if (!credential) throw new TypeError('未找到该账户的卡凭据');
  if (String(oldPassword) !== String(credential.password)) {
    db.prepare('UPDATE card_credentials SET failed_attempts = failed_attempts + 1 WHERE account_id = ?').run(accountId);
    writeAudit(db, { userId, action: 'password.change_failed', target: accountId, detail: '原密码校验失败' });
    throw new TypeError('原密码不正确');
  }
  const stamp = nowStamp();
  db.prepare('UPDATE card_credentials SET password = ?, password_updated_at = ?, failed_attempts = 0, updated_at = ? WHERE account_id = ?')
    .run(newPassword, stamp, stamp, accountId);
  writeAudit(db, { userId, action: 'password.change', target: accountId, detail: '查询密码已更新' });
  pushNotification(db, {
    userId,
    title: '密码修改成功',
    body: `账户「${credential.account_name}」的查询密码已更新，后续转账与敏感操作将使用新密码。`,
    level: 'success'
  });
  return { accountId, password: newPassword, passwordUpdatedAt: stamp };
}

export function getActiveLossReport(db, accountId) {
  return db.prepare("SELECT * FROM loss_reports WHERE account_id = ? AND status = 'active' ORDER BY reported_at DESC LIMIT 1").get(accountId) || null;
}

export function reportLoss(db, { userId, accountId, reason = null, channel = 'app' }) {
  const account = getAccount(db, accountId, { userId });
  if (!account) throw new TypeError('账户不存在或不属于当前用户');
  if (account.status === 'frozen') throw new TypeError('该账户已处于挂失状态');
  if (account.status === 'closed') throw new TypeError('该账户已销户，无法挂失');
  const stamp = nowStamp();
  const row = { id: `loss-${randomUUID()}`, user_id: userId, account_id: accountId, status: 'active', reason, channel, reported_at: stamp, released_at: null };
  runInTransaction(db, () => {
    db.prepare("UPDATE accounts SET status = 'frozen' WHERE id = ?").run(accountId);
    db.prepare('INSERT INTO loss_reports (id, user_id, account_id, status, reason, channel, reported_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.account_id, row.status, row.reason, row.channel, row.reported_at, row.released_at);
    writeAudit(db, { userId, action: 'loss.report', target: accountId, detail: `挂失原因：${reason || '未填写'}` });
    pushNotification(db, {
      userId,
      title: '账户已挂失',
      body: `账户「${account.name}」已实时挂失。`,
      level: 'warn'
    });
  });
  return { ...row, account_name: account.name };
}

export function releaseLoss(db, { userId, accountId }) {
  const account = getAccount(db, accountId, { userId });
  if (!account) throw new TypeError('账户不存在或不属于当前用户');
  const active = getActiveLossReport(db, accountId);
  if (!active || account.status !== 'frozen') throw new TypeError('该账户当前不在挂失状态');
  const stamp = nowStamp();
  runInTransaction(db, () => {
    db.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").run(accountId);
    db.prepare("UPDATE loss_reports SET status = 'released', released_at = ? WHERE id = ?").run(stamp, active.id);
    writeAudit(db, { userId, action: 'loss.release', target: accountId, detail: `解除挂失（工单 ${active.id}）` });
    pushNotification(db, {
      userId,
      title: '挂失已解除',
      body: `账户「${account.name}」已恢复为正常状态。`,
      level: 'success'
    });
  });
  return { accountId, releasedAt: stamp, reportId: active.id };
}

export function closeAccount(db, { userId, accountId }) {
  const account = getAccount(db, accountId, { userId });
  if (!account) throw new TypeError('账户不存在或不属于当前用户');
  if (account.account_type === 'BANK_GROUP' || account.account_type === 'BANK_SAVINGS') {
    throw new TypeError('该账户类型不支持在线删除');
  }
  if (account.status === 'closed') throw new TypeError('该账户已销户');
  if (Number(account.current_balance_cents) > 0) throw new TypeError('账户仍有余额，请先转出或取出后再删除');
  const activeSubs = db.prepare(`
    SELECT COUNT(*) AS n FROM subscriptions s
      JOIN account_ownership o ON o.account_id = s.payment_account_id
     WHERE s.id IS NOT NULL AND s.status = 'active' AND s.payment_account_id = ? AND o.user_id = ?`).get(accountId, userId).n;
  if (activeSubs > 0) throw new TypeError('该账户仍在绑定自动扣款，请先在服务页取消');
  const stamp = nowStamp();
  runInTransaction(db, () => {
    db.prepare("UPDATE accounts SET status = 'closed', closed_on = ? WHERE id = ?").run(stamp.slice(0, 10), accountId);
    writeAudit(db, { userId, action: 'account.closed', target: accountId, detail: `账户「${account.name}」已删除（销户）` });
    pushNotification(db, {
      userId,
      title: '账户已删除',
      body: `账户「${account.name}」已销户，卡号即时失效。`,
      level: 'success'
    });
  });
  return { accountId, closedOn: stamp.slice(0, 10) };
}

export function listLiveTransfers(db, { userId = null, accountId = null, limit = 20 } = {}) {
  const where = [];
  const params = [];
  if (userId) { where.push('t.user_id = ?'); params.push(userId); }
  if (accountId) { where.push('(t.from_account_id = ? OR t.to_account_id = ?)'); params.push(accountId, accountId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT t.*,
           fa.name AS from_account_name, fa.masked_number AS from_masked_number,
           ta.name AS to_account_name, ta.masked_number AS to_masked_number
      FROM live_transfers t
      LEFT JOIN v_accounts fa ON fa.id = t.from_account_id
      LEFT JOIN v_accounts ta ON ta.id = t.to_account_id
      ${whereSql}
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT ?
  `).all(...params, Math.min(100, Math.max(1, Number(limit) || 20)));
  return rows.map(row => ({ ...row, amount_yuan: centsToYuan(row.amount_cents) }));
}

function insertBookedTransaction(db, {
  accountId,
  platformId,
  stamp,
  direction,
  flowKind,
  amountCents,
  effectCents,
  balanceAfterCents,
  merchant,
  counterparty = null,
  category,
  subcategory = null,
  channel = 'app',
  transferGroupId = null,
  isInternal = 0,
  note = null
}) {
  const asOfRow = db.prepare("SELECT value FROM meta WHERE key = 'as_of'").get();
  const occurredAt = asOfRow && asOfRow.value ? String(asOfRow.value) + String(stamp).slice(10) : stamp;
  db.prepare(`INSERT INTO transactions
      (id, account_id, platform_id, occurred_at, direction, flow_kind,
       amount_cents, balance_effect_cents, balance_after_cents,
       merchant, counterparty, category, subcategory, channel, status,
       subscription_id, transfer_group_id, is_internal_transfer, note,
       source_type, is_simulated, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', NULL, ?, ?, ?, 'simulated', 1, ?)`)
    .run(`tx-${randomUUID()}`, accountId, platformId, occurredAt, direction, flowKind,
      amountCents, effectCents, balanceAfterCents, merchant, counterparty, category, subcategory,
      channel, transferGroupId, isInternal, note, stamp);
}

export function executeTransfer(db, {
  userId,
  fromAccountId,
  toAccountId = null,
  counterparty = null,
  counterpartyAccount = null,
  amountYuan,
  note = null,
  channel = 'app',
  password = null
} = {}) {
  const amountCents = Math.round(Number(amountYuan) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new TypeError('转账金额必须大于 0');
  if (amountCents > 50000000) throw new TypeError('单笔转账不能超过 500,000 元');
  const internal = Boolean(toAccountId);
  if (!internal && (!counterparty || !String(counterparty).trim())) {
    throw new TypeError('对方收款人不能为空');
  }
  if (toAccountId && toAccountId === fromAccountId) {
    throw new TypeError('转出与转入不能是同一账户');
  }
  const fromAccount = getAccount(db, fromAccountId, { userId });
  if (!fromAccount) throw new TypeError('转出账户不存在或不属于当前用户');
  if (fromAccount.status === 'frozen') throw new TypeError('转出账户已挂失，暂时无法转账');
  if (fromAccount.status === 'closed') throw new TypeError('转出账户已销户');
  if (fromAccount.account_class !== 'asset' || fromAccount.is_payable !== 1) {
    throw new TypeError('转出账户必须是可支付的资金账户');
  }
  let toAccount = null;
  let toOwnerName = null;
  let toOwnerId = null;
  if (internal) {
    toAccount = getAccount(db, toAccountId);
    if (!toAccount) throw new TypeError('转入账户不存在');
    if (toAccount.status === 'frozen') throw new TypeError('转入账户已挂失，暂时无法收款');
    if (toAccount.account_class === 'container') throw new TypeError('转入账户不能是平台容器');
    const toOwnerRow = db.prepare('SELECT user_id FROM account_ownership WHERE account_id = ?').get(toAccountId);
    toOwnerId = toOwnerRow ? toOwnerRow.user_id : null;
    if (toOwnerId && toOwnerId !== userId && /^[vw]-/.test(String(userId))) {
      throw new TypeError('访客工作区不能向其他用户账户转账');
    }
    if (toOwnerId && toOwnerId !== userId) {
      const owner = getAppUser(db, toOwnerId);
      if (owner) toOwnerName = owner.display_name;
    }
  }
  const credential = getCardCredential(db, { accountId: fromAccountId, userId });
  if (!credential) throw new TypeError('转出账户缺少卡凭据，无法验证支付密码');
  if (Number(credential.trade_locked) === 1) throw new TypeError('该卡已开启交易限制，暂时无法转出');
  if (String(password) !== String(credential.password)) {
    db.prepare('UPDATE card_credentials SET failed_attempts = failed_attempts + 1 WHERE account_id = ?').run(fromAccountId);
    writeAudit(db, { userId, action: 'transfer.password_failed', target: fromAccountId, detail: '支付密码校验失败' });
    throw new TypeError('支付密码不正确');
  }
  const balanceAfter = Number(fromAccount.current_balance_cents) - amountCents;
  if (balanceAfter < 0) throw new TypeError('转出账户余额不足');

  const stamp = nowStamp();
  const transferId = `tf-${randomUUID()}`;
  const kind = internal ? 'internal' : 'external';
  runInTransaction(db, () => {
    db.prepare('UPDATE accounts SET current_balance_cents = current_balance_cents - ? WHERE id = ?').run(amountCents, fromAccountId);
    db.prepare(`INSERT INTO live_transfers
        (id, user_id, from_account_id, to_account_id, counterparty, counterparty_account, amount_cents, kind, status, note, channel, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`)
      .run(transferId, userId, fromAccountId, internal ? toAccountId : null, counterparty, counterpartyAccount, amountCents, kind, note, channel, stamp);
    db.prepare('INSERT INTO live_transfer_legs (transfer_id, account_id, effect_cents, balance_after_cents) VALUES (?, ?, ?, ?)')
      .run(transferId, fromAccountId, -amountCents, balanceAfter);
    insertBookedTransaction(db, {
      accountId: fromAccountId,
      platformId: fromAccount.platform_id,
      stamp,
      direction: internal ? 'transfer' : 'expense',
      flowKind: 'transfer',
      amountCents,
      effectCents: -amountCents,
      balanceAfterCents: balanceAfter,
      merchant: internal ? toAccount.name : (counterparty || '转账'),
      counterparty: internal ? (toOwnerName || toAccount.name) : (counterparty || null),
      category: '转账',
      channel,
      transferGroupId: transferId,
      isInternal: internal ? 1 : 0,
      note
    });
    if (internal) {
      const isLiability = toAccount.account_class === 'liability';
      const toEffect = isLiability ? -amountCents : amountCents;
      const toBalanceAfter = Number(toAccount.current_balance_cents) + toEffect;
      if (toBalanceAfter < 0) throw new TypeError('转入账户余额不能为负');
      db.prepare('UPDATE accounts SET current_balance_cents = current_balance_cents + ? WHERE id = ?').run(toEffect, toAccountId);
      db.prepare('INSERT INTO live_transfer_legs (transfer_id, account_id, effect_cents, balance_after_cents) VALUES (?, ?, ?, ?)')
        .run(transferId, toAccountId, toEffect, toBalanceAfter);
      insertBookedTransaction(db, {
        accountId: toAccountId,
        platformId: toAccount.platform_id,
        stamp,
        direction: 'transfer',
        flowKind: 'transfer',
        amountCents,
        effectCents: toEffect,
        balanceAfterCents: toBalanceAfter,
        merchant: fromAccount.name,
        counterparty: fromAccount.masked_number || fromAccount.name,
        category: '转账',
        channel,
        transferGroupId: transferId,
        isInternal: 1,
        note
      });
    }
    writeAudit(db, {
      userId,
      action: 'transfer.completed',
      target: transferId,
      detail: internal
        ? `${fromAccount.name} → ${toAccount.name} ¥${centsToYuan(amountCents)}`
        : `${fromAccount.name} → ${counterparty} ¥${centsToYuan(amountCents)}`
    });
    pushNotification(db, {
      userId,
      title: internal ? '本行转账成功' : '转账汇款成功',
      body: internal
        ? `${fromAccount.name} → ${toAccount.name}，金额 ¥${centsToYuan(amountCents)}，回执单号 ${transferId.slice(0, 18)}。`
        : `${fromAccount.name} → ${counterparty}，金额 ¥${centsToYuan(amountCents)}，回执单号 ${transferId.slice(0, 18)}。`,
      level: 'success'
    });
    if (toOwnerId && toOwnerId !== userId) {
      const sender = getAppUser(db, userId);
      pushNotification(db, {
        userId: toOwnerId,
        title: '收到转账',
        body: `${sender ? sender.display_name : '众微银行用户'} → 你的账户「${toAccount.name}」，金额 ¥${centsToYuan(amountCents)}，已实时入账。`,
        level: 'success'
      });
    }
  });
  const fromAfter = getAccount(db, fromAccountId);
  return {
    id: transferId,
    kind,
    amountYuan: centsToYuan(amountCents),
    createdAt: stamp,
    from: { id: fromAccountId, name: fromAccount.name, balanceAfterYuan: fromAfter ? fromAfter.current_balance_yuan : null },
    to: internal
      ? { id: toAccountId, name: toAccount.name, ownerName: toOwnerName }
      : { name: counterparty, account: counterpartyAccount || null },
    note: note || null
  };
}

const USER_POLICY_SQL = `
CREATE TABLE IF NOT EXISTS user_policies (
  user_id             TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  auto_approve        INTEGER NOT NULL DEFAULT 0 CHECK (auto_approve IN (0, 1)),
  threshold_cents     INTEGER NOT NULL DEFAULT 100000 CHECK (threshold_cents >= 0),
  allow_internal      INTEGER NOT NULL DEFAULT 1 CHECK (allow_internal IN (0, 1)),
  allow_subscription  INTEGER NOT NULL DEFAULT 1 CHECK (allow_subscription IN (0, 1)),
  allow_utility       INTEGER NOT NULL DEFAULT 1 CHECK (allow_utility IN (0, 1)),
  updated_at          TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_user_policies_auto ON user_policies(auto_approve);
`;

const CHANNEL_SQL = `
CREATE TABLE IF NOT EXISTS channel_bindings (
  channel          TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  corp_id          TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (channel, provider_user_id)
) STRICT;

CREATE TABLE IF NOT EXISTS channel_messages (
  channel        TEXT NOT NULL,
  message_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json  TEXT,
  status         TEXT NOT NULL DEFAULT 'processing'
                 CHECK (status IN ('processing', 'done', 'failed')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (channel, message_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_channel_messages_user ON channel_messages(user_id, created_at);

CREATE TABLE IF NOT EXISTS agent_tickets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  session_id  TEXT,
  channel     TEXT,
  tool        TEXT NOT NULL,
  label       TEXT,
  args_json   TEXT NOT NULL,
  digest      TEXT,
  plan_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'used', 'expired', 'cancelled')),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  used_at     TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_agent_tickets_pending ON agent_tickets(user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS visitor_profiles (
  visitor_id   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  channel      TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_visitor_profiles_seen ON visitor_profiles(last_seen_at);
`;

/* 确保服务层表结构与初始数据存在（既有库自迁移，新库由 seed 调用）。 */
export function ensureServiceTables(db) {
  db.exec(SERVICE_SCHEMA_SQL);
  db.exec(USER_POLICY_SQL);
  db.exec(CHANNEL_SQL);
  for (const alteration of [
    'ALTER TABLE app_users ADD COLUMN risk_level TEXT',
    'ALTER TABLE card_credentials ADD COLUMN trade_locked INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE app_users ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE app_users ADD COLUMN auto_threshold_cents INTEGER NOT NULL DEFAULT 100000',
    'ALTER TABLE app_users ADD COLUMN allow_internal INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE app_users ADD COLUMN allow_subscription INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE app_users ADD COLUMN allow_utility INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE app_users ADD COLUMN elder_mode INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE audit_log ADD COLUMN channel TEXT',
    'ALTER TABLE audit_log ADD COLUMN session_id TEXT',
    'ALTER TABLE audit_log ADD COLUMN message_id TEXT',
    'ALTER TABLE audit_log ADD COLUMN plan_id TEXT',
    'ALTER TABLE audit_log ADD COLUMN node_id TEXT',
    'ALTER TABLE audit_log ADD COLUMN input_digest TEXT',
    'ALTER TABLE audit_log ADD COLUMN result_ref TEXT'
  ]) {
    try { db.exec(alteration); } catch (error) { /* 列已存在 */ }
  }
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM app_users').get().n;
  if (userCount === 0) {
    const insertUser = db.prepare(`INSERT INTO app_users (id, display_name, phone_masked, avatar_emoji, pin, is_default, intro, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const stamp = nowStamp();
    runInTransaction(db, () => {
      for (const user of SERVICE_USERS) {
        insertUser.run(user.id, user.display_name, user.phone_masked, user.avatar_emoji, user.pin, user.is_default, user.intro, stamp);
      }
      const defaults = SERVICE_USERS.find(user => user.is_default === 1);
      if (defaults) {
        db.prepare(`INSERT INTO account_ownership (account_id, user_id, created_at)
          SELECT id, ?, ? FROM accounts WHERE id NOT LIKE 'ys-%' AND id NOT LIKE 'gu-%'`).run(defaults.id, stamp);
      }
    });
  }
  /* 第二、第三体验用户：与主用户同构的全量众微银行账户树（转账收款方），按账户存在性幂等创建。 */
  const extraUsers = [
    {
      user: SERVICE_USERS.find(user => user.id === 'u-shen'),
      accounts: [
        { id: 'ys-root', name: '众微银行', type: 'BANK_GROUP', class: 'container', platform: 'p-webbank', masked: null, network: null, payable: 0, limit: null, billing: null, due: null, opening: 0, opened_on: null, sort: 0, meta: { note: '账户层级容器，不代表可重复计算的余额' } },
        { id: 'ys-debit', name: '众微银行储蓄卡 · 知微', type: 'BANK_DEBIT', class: 'asset', platform: 'p-webbank', masked: '6226 9020 **** 4321', network: '银联', card_number: '6226902012344321', payable: 1, limit: null, billing: null, due: null, opening: 1200000, opened_on: '2025-03-18', sort: 1, meta: { card_holder: '沈知微', usage: '主要日常支出' } },
        { id: 'ys-savings', name: '众微银行 · 定期存款', type: 'BANK_SAVINGS', class: 'asset', platform: 'p-webbank', masked: null, network: null, payable: 0, limit: null, billing: null, due: null, opening: 300000, opened_on: '2025-03-18', sort: 2, meta: { role: 'reserve_fund' } },
        { id: 'ys-dai', name: '微粒贷 · 消费备用额度', type: 'WEBANK_CREDIT', class: 'liability', platform: 'p-webbank', masked: '微粒贷账户 ****4321', network: null, payable: 0, limit: 2000000, billing: null, due: null, opening: 500000, opened_on: '2025-04-02', sort: 3, meta: { card_holder: '沈知微' } },
        { id: 'ys-credit', name: '众微银行信用卡 · 知微', type: 'CREDIT_CARD', class: 'liability', platform: 'p-webbank', masked: '6226 9058 **** 8642', network: '银联', card_number: '6226905812348642', payable: 0, limit: 3000000, billing: 5, due: 23, opening: 0, opened_on: '2024-11-06', sort: 5, meta: { card_holder: '沈知微' } }
      ]
    },
    {
      user: SERVICE_USERS.find(user => user.id === 'u-gu'),
      accounts: [
        { id: 'gu-root', name: '众微银行', type: 'BANK_GROUP', class: 'container', platform: 'p-webbank', masked: null, network: null, payable: 0, limit: null, billing: null, due: null, opening: 0, opened_on: null, sort: 0, meta: { note: '账户层级容器，不代表可重复计算的余额' } },
        { id: 'gu-debit', name: '众微银行储蓄卡 · 清晏', type: 'BANK_DEBIT', class: 'asset', platform: 'p-webbank', masked: '6226 9020 **** 7788', network: '银联', card_number: '6226902012347788', payable: 1, limit: null, billing: null, due: null, opening: 860000, opened_on: '2025-06-02', sort: 1, meta: { card_holder: '顾清晏', usage: '日常支出与转账收付' } },
        { id: 'gu-savings', name: '众微银行 · 定期存款', type: 'BANK_SAVINGS', class: 'asset', platform: 'p-webbank', masked: null, network: null, payable: 0, limit: null, billing: null, due: null, opening: 200000, opened_on: '2025-06-02', sort: 2, meta: { role: 'reserve_fund' } },
        { id: 'gu-dai', name: '微粒贷 · 消费备用额度', type: 'WEBANK_CREDIT', class: 'liability', platform: 'p-webbank', masked: '微粒贷账户 ****7788', network: null, payable: 0, limit: 1600000, billing: null, due: null, opening: 300000, opened_on: '2025-07-11', sort: 3, meta: { card_holder: '顾清晏' } },
        { id: 'gu-credit', name: '众微银行信用卡 · 清晏', type: 'CREDIT_CARD', class: 'liability', platform: 'p-webbank', masked: '6226 9058 **** 7789', network: '银联', card_number: '6226905812347789', payable: 0, limit: 2000000, billing: 12, due: 30, opening: 0, opened_on: '2025-01-15', sort: 5, meta: { card_holder: '顾清晏' } }
      ]
    }
  ];
  for (const extra of extraUsers) {
    if (!extra.user) continue;
    const stamp = nowStamp();
    runInTransaction(db, () => {
      const insertAccount = db.prepare(`INSERT INTO accounts
          (id, parent_id, platform_id, name, account_type, account_class, currency, masked_number, card_network,
           is_primary, is_payable, status, credit_limit_cents, billing_day, due_day,
           opening_balance_cents, current_balance_cents, opened_on, sort_order, metadata, created_at)
          VALUES (?, NULL, ?, ?, ?, ?, 'CNY', ?, ?, 0, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const account of extra.accounts) {
        if (db.prepare('SELECT 1 AS ok FROM accounts WHERE id = ?').get(account.id)) continue;
        insertAccount.run(
          account.id, account.platform, account.name, account.type, account.class, account.masked, account.network,
          account.payable, account.limit, account.billing, account.due, account.opening, account.opening,
          account.opened_on, account.sort, JSON.stringify(account.meta), stamp
        );
        db.prepare('INSERT INTO account_ownership (account_id, user_id, created_at) VALUES (?, ?, ?)')
          .run(account.id, extra.user.id, stamp);
        if (account.type === 'BANK_DEBIT' || account.type === 'CREDIT_CARD') {
          db.prepare(`INSERT INTO card_credentials (account_id, user_id, card_number, password, password_updated_at, failed_attempts, updated_at)
            VALUES (?, ?, ?, '123456', ?, 0, ?)`).run(account.id, extra.user.id, account.card_number, stamp, stamp);
        }
      }
    });
  }
  const stamp = nowStamp();
  const seedNumbers = Object.fromEntries(SERVICE_CARD_SEEDS.map(row => [row.account_id, row.card_number]));
  for (const card of db.prepare(`SELECT a.id, a.name, o.user_id FROM accounts a
      JOIN account_ownership o ON o.account_id = a.id
      LEFT JOIN card_credentials c ON c.account_id = a.id
     WHERE a.account_type IN ('BANK_DEBIT', 'CREDIT_CARD') AND c.account_id IS NULL`).all()) {
    const number = seedNumbers[card.id] || ('62363600' + String(Math.abs(Array.from(card.id).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7))).padStart(8, '0').slice(0, 8));
    db.prepare(`INSERT INTO card_credentials (account_id, user_id, card_number, password, password_updated_at, failed_attempts, updated_at)
      VALUES (?, ?, ?, '123456', ?, 0, ?)`).run(card.id, card.user_id, number, stamp, stamp);
  }
  for (const user of db.prepare('SELECT id FROM app_users').all()) {
    db.prepare(`INSERT OR IGNORE INTO user_policies
        (user_id, auto_approve, threshold_cents, allow_internal, allow_subscription, allow_utility, updated_at)
        VALUES (?, 0, 100000, 1, 1, 1, ?)`).run(user.id, stamp);
  }
}

const SERVICE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  phone_masked  TEXT,
  avatar_emoji  TEXT,
  pin           TEXT NOT NULL DEFAULT '123456',
  risk_level    TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  intro         TEXT,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS account_ownership (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS card_credentials (
  account_id           TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  card_number          TEXT NOT NULL CHECK (length(card_number) BETWEEN 15 AND 19),
  password             TEXT NOT NULL CHECK (length(password) = 6),
  password_updated_at  TEXT NOT NULL,
  failed_attempts      INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  trade_locked         INTEGER NOT NULL DEFAULT 0 CHECK (trade_locked IN (0, 1)),
  updated_at           TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS loss_reports (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('active', 'released')),
  reason       TEXT,
  channel      TEXT NOT NULL DEFAULT 'app',
  reported_at  TEXT NOT NULL,
  released_at  TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS live_transfers (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  from_account_id        TEXT NOT NULL REFERENCES accounts(id),
  to_account_id          TEXT REFERENCES accounts(id),
  counterparty           TEXT,
  counterparty_account   TEXT,
  amount_cents           INTEGER NOT NULL CHECK (amount_cents > 0),
  kind                   TEXT NOT NULL CHECK (kind IN ('internal', 'external', 'loan')),
  status                 TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  note                   TEXT,
  channel                TEXT NOT NULL DEFAULT 'app',
  created_at             TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS live_transfer_legs (
  transfer_id         TEXT NOT NULL REFERENCES live_transfers(id) ON DELETE CASCADE,
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  effect_cents        INTEGER NOT NULL CHECK (effect_cents <> 0),
  balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents >= 0),
  PRIMARY KEY (transfer_id, account_id)
) STRICT;

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT,
  level       TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'success', 'warn')),
  created_at  TEXT NOT NULL,
  read        INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS loan_applications (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  product_id            TEXT NOT NULL,
  product_name          TEXT NOT NULL,
  category              TEXT,
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  term_months           INTEGER,
  rate_label            TEXT,
  disbursed_account_id  TEXT NOT NULL REFERENCES accounts(id),
  credit_account_id     TEXT NOT NULL REFERENCES accounts(id),
  status                TEXT NOT NULL DEFAULT 'disbursed' CHECK (status IN ('submitted', 'approved', 'disbursed', 'rejected')),
  transfer_id           TEXT,
  created_at            TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS scheduled_transfers (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  from_account_id       TEXT REFERENCES accounts(id),
  to_account_id         TEXT REFERENCES accounts(id),
  counterparty          TEXT,
  counterparty_account  TEXT,
  counterparty_phone    TEXT,
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  note                  TEXT,
  execute_on            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'failed', 'cancelled')),
  created_at            TEXT NOT NULL,
  executed_at           TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS aa_bills (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  total_cents      INTEGER NOT NULL CHECK (total_cents > 0),
  member_count     INTEGER NOT NULL CHECK (member_count > 0),
  from_account_id  TEXT NOT NULL REFERENCES accounts(id),
  participants     TEXT NOT NULL CHECK (json_valid(participants)),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  note             TEXT,
  created_at       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS wealth_holdings (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL,
  product_name  TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  purchased_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_transfers(user_id, execute_on);
CREATE INDEX IF NOT EXISTS idx_aa_user ON aa_bills(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_holdings_user ON wealth_holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_live_legs_account ON live_transfer_legs(account_id);
CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
`;

export function listLoanApplications(db, { userId, limit = 20 } = {}) {
  return db.prepare(`
    SELECT la.*, da.name AS disbursed_account_name, ca.name AS credit_account_name
      FROM loan_applications la
      LEFT JOIN v_accounts da ON da.id = la.disbursed_account_id
      LEFT JOIN v_accounts ca ON ca.id = la.credit_account_id
     WHERE la.user_id = ?
     ORDER BY la.created_at DESC, la.id DESC
     LIMIT ?
  `).all(userId, Math.min(100, Math.max(1, Number(limit) || 20))).map(row => ({
    ...row,
    amount_yuan: centsToYuan(row.amount_cents)
  }));
}

export function applyForLoan(db, {
  userId,
  productId,
  productName,
  category = null,
  amountYuan,
  termMonths = null,
  rateLabel = null,
  disbursedAccountId,
  creditAccountId,
  channel = 'app'
} = {}) {
  const amountCents = Math.round(Number(amountYuan) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new TypeError('申请金额必须大于 0');
  if (amountCents > 20000000) throw new TypeError('申请金额超出产品上限');
  const disbursed = getAccount(db, disbursedAccountId, { userId });
  if (!disbursed) throw new TypeError('放款账户不存在或不属于当前用户');
  if (disbursed.account_class !== 'asset' || disbursed.is_payable !== 1) throw new TypeError('放款账户必须是可支付的资金账户');
  if (disbursed.status !== 'active') throw new TypeError('放款账户当前不可用');
  const credit = getAccount(db, creditAccountId, { userId });
  if (!credit) throw new TypeError('授信账户不存在或不属于当前用户');
  if (credit.account_class !== 'liability') throw new TypeError('授信账户类型不正确');
  if (credit.status !== 'active') throw new TypeError('授信账户当前不可用');
  const limitCents = credit.credit_limit_cents;
  if (limitCents !== null && Number(credit.current_balance_cents) + amountCents > Number(limitCents)) {
    throw new TypeError('申请金额超出该授信账户可用额度');
  }
  const stamp = nowStamp();
  const applicationId = `loan-${randomUUID()}`;
  const transferId = `draw-${randomUUID()}`;
  runInTransaction(db, () => {
    const debitAfter = Number(disbursed.current_balance_cents) + amountCents;
    const creditAfter = Number(credit.current_balance_cents) + amountCents;
    db.prepare('UPDATE accounts SET current_balance_cents = current_balance_cents + ? WHERE id = ?').run(amountCents, disbursedAccountId);
    db.prepare('UPDATE accounts SET current_balance_cents = current_balance_cents + ? WHERE id = ?').run(amountCents, creditAccountId);
    db.prepare(`INSERT INTO live_transfers
        (id, user_id, from_account_id, to_account_id, counterparty, counterparty_account, amount_cents, kind, status, note, channel, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'loan', 'completed', ?, ?, ?)`)
      .run(transferId, userId, creditAccountId, disbursedAccountId, productName, null, amountCents, `贷款放款：${productName}`, channel, stamp);
    db.prepare('INSERT INTO live_transfer_legs (transfer_id, account_id, effect_cents, balance_after_cents) VALUES (?, ?, ?, ?)')
      .run(transferId, creditAccountId, amountCents, creditAfter);
    db.prepare('INSERT INTO live_transfer_legs (transfer_id, account_id, effect_cents, balance_after_cents) VALUES (?, ?, ?, ?)')
      .run(transferId, disbursedAccountId, amountCents, debitAfter);
    insertBookedTransaction(db, {
      accountId: disbursedAccountId,
      platformId: disbursed.platform_id,
      stamp,
      direction: 'transfer',
      flowKind: 'loan_disbursement',
      amountCents,
      effectCents: amountCents,
      balanceAfterCents: debitAfter,
      merchant: productName,
      category: '贷款',
      channel,
      transferGroupId: transferId,
      note: '贷款放款'
    });
    db.prepare(`INSERT INTO loan_applications
        (id, user_id, product_id, product_name, category, amount_cents, term_months, rate_label,
         disbursed_account_id, credit_account_id, status, transfer_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'disbursed', ?, ?)`)
      .run(applicationId, userId, productId, productName, category, amountCents,
        termMonths ? Math.min(600, Math.max(1, Math.round(Number(termMonths)))) : null, rateLabel,
        disbursedAccountId, creditAccountId, transferId, stamp);
    writeAudit(db, {
      userId,
      action: 'loan.disbursed',
      target: applicationId,
      detail: `${productName} ¥${centsToYuan(amountCents)} 放款至 ${disbursed.name}`
    });
    pushNotification(db, {
      userId,
      title: '贷款放款成功',
      body: `${productName} ¥${centsToYuan(amountCents)} 已放款至「${disbursed.name}」，借款记录已计入「${credit.name}」。`,
      level: 'success'
    });
  });
  const debitAfter = getAccount(db, disbursedAccountId);
  return {
    applicationId,
    transferId: `draw-…${transferId.slice(-8)}`,
    product: productName,
    amountYuan: centsToYuan(amountCents),
    createdAt: stamp,
    disbursedTo: { id: disbursedAccountId, name: disbursed.name, balanceAfterYuan: debitAfter ? debitAfter.current_balance_yuan : null },
    creditAccount: { id: creditAccountId, name: credit.name }
  };
}

export function listScheduledTransfers(db, { userId, limit = 10 } = {}) {
  return db.prepare(`
    SELECT s.*, fa.name AS from_account_name, ta.name AS to_account_name
      FROM scheduled_transfers s
      LEFT JOIN v_accounts fa ON fa.id = s.from_account_id
      LEFT JOIN v_accounts ta ON ta.id = s.to_account_id
     WHERE s.user_id = ? AND s.status = 'pending'
     ORDER BY s.execute_on, s.created_at DESC LIMIT ?
  `).all(userId, Math.min(50, Math.max(1, Number(limit) || 10))).map(row => ({ ...row, amount_yuan: centsToYuan(row.amount_cents) }));
}

export function createScheduledTransfer(db, job) {
  const stamp = nowStamp();
  const row = {
    id: 'sch-' + randomUUID(), user_id: job.userId,
    from_account_id: job.fromAccountId, to_account_id: job.toAccountId || null,
    counterparty: job.counterparty || null, counterparty_account: job.counterpartyAccount || null,
    counterparty_phone: job.counterpartyPhone || null,
    amount_cents: job.amountCents, note: job.note || null,
    execute_on: job.executeOn, status: 'pending', created_at: stamp, executed_at: null
  };
  db.prepare(`INSERT INTO scheduled_transfers
      (id, user_id, from_account_id, to_account_id, counterparty, counterparty_account, counterparty_phone,
       amount_cents, note, execute_on, status, created_at, executed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`)
    .run(row.id, row.user_id, row.from_account_id, row.to_account_id, row.counterparty,
      row.counterparty_account, row.counterparty_phone, row.amount_cents, row.note, row.execute_on, row.created_at);
  writeAudit(db, { userId: job.userId, action: 'transfer.scheduled', target: row.id, detail: `预约 ${row.execute_on} 转账 ¥${centsToYuan(row.amount_cents)}` });
  return row;
}

export function cancelScheduledTransfer(db, { userId, id }) {
  const row = db.prepare("SELECT * FROM scheduled_transfers WHERE id = ? AND user_id = ? AND status = 'pending'").get(id, userId);
  if (!row) throw new TypeError('定时转账不存在或已执行');
  db.prepare("UPDATE scheduled_transfers SET status = 'cancelled' WHERE id = ?").run(id);
  writeAudit(db, { userId, action: 'transfer.scheduled_cancel', target: id, detail: '取消定时转账' });
  return { id, status: 'cancelled' };
}

export function runDueScheduledTransfers(db, today) {
  const due = db.prepare("SELECT * FROM scheduled_transfers WHERE status = 'pending' AND execute_on <= ?").all(today);
  const results = [];
  for (const job of due) {
    try {
      const credential = getCardCredential(db, { accountId: job.from_account_id, userId: job.user_id });
      executeTransfer(db, {
        userId: job.user_id,
        fromAccountId: job.from_account_id,
        toAccountId: job.to_account_id,
        counterparty: job.counterparty,
        counterpartyAccount: job.counterparty_account || job.counterparty_phone,
        amountYuan: Number(job.amount_cents) / 100,
        note: '定时转账 · ' + (job.note || ''),
        password: credential ? credential.password : null
      });
      db.prepare("UPDATE scheduled_transfers SET status = 'executed', executed_at = ? WHERE id = ?").run(nowStamp(), job.id);
      results.push({ id: job.id, status: 'executed' });
    } catch (error) {
      db.prepare("UPDATE scheduled_transfers SET status = 'failed', executed_at = ? WHERE id = ?").run(nowStamp(), job.id);
      pushNotification(db, { userId: job.user_id, title: '定时转账执行失败', body: String(error.message || error), level: 'warn' });
      results.push({ id: job.id, status: 'failed' });
    }
  }
  return results;
}

export function createAaBill(db, { userId, title, totalYuan, memberCount, fromAccountId, note }) {
  const totalCents = Math.round(Number(totalYuan) * 100);
  if (!Number.isFinite(totalCents) || totalCents <= 0) throw new TypeError('AA 总金额必须大于 0');
  const members = Math.round(Number(memberCount));
  if (!Number.isInteger(members) || members < 2 || members > 50) throw new TypeError('参与人数须为 2-50 人');
  const perHead = Math.round(totalCents / members);
  const account = getAccount(db, fromAccountId, { userId });
  if (!account) throw new TypeError('收款账户不存在');
  const names = [];
  for (let i = 1; i < members; i += 1) names.push('成员 ' + i);
  const lastCents = totalCents - perHead * names.length;
  const participants = names.map(function (name, index) {
    return { name, status: 'pending', amount: centsToYuan(index === names.length - 1 ? lastCents : perHead) };
  });
  const row = {
    id: 'aa-' + randomUUID(), user_id: userId, title: title || 'AA 收款',
    total_cents: totalCents, member_count: members, from_account_id: fromAccountId,
    participants: JSON.stringify(participants), status: 'open', created_at: nowStamp(), note: note || null
  };
  db.prepare(`INSERT INTO aa_bills (id, user_id, title, total_cents, member_count, from_account_id, participants, status, created_at, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
    .run(row.id, row.user_id, row.title, row.total_cents, row.member_count, row.from_account_id, row.participants, row.created_at, row.note);
  writeAudit(db, { userId, action: 'aa.create', target: row.id, detail: `${row.title} ¥${centsToYuan(totalCents)} ÷ ${members} 人` });
  return { ...row, per_head_yuan: centsToYuan(perHead) };
}

export function aaPayMember(db, { userId, id, memberName }) {
  const bill = db.prepare('SELECT * FROM aa_bills WHERE id = ? AND user_id = ?').get(id, userId);
  if (!bill) throw new TypeError('AA 收款单不存在');
  if (bill.status !== 'open') throw new TypeError('收款单已结束');
  const participants = JSON.parse(bill.participants);
  const member = participants.find(row => row.name === memberName);
  if (!member) throw new TypeError('成员不存在');
  if (member.status === 'paid') throw new TypeError('该成员已收款');
  member.status = 'paid';
  const payCents = Math.round(Number(member.amount) * 100);
  const account = getAccount(db, bill.from_account_id);
  const after = Number(account.current_balance_cents) + payCents;
  const paymentId = 'aapay-' + randomUUID();
  runInTransaction(db, () => {
    db.prepare('UPDATE accounts SET current_balance_cents = current_balance_cents + ? WHERE id = ?').run(payCents, bill.from_account_id);
    db.prepare(`INSERT INTO live_transfers
        (id, user_id, from_account_id, to_account_id, counterparty, counterparty_account, amount_cents, kind, status, note, channel, created_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, 'external', 'completed', ?, ?, ?)`)
      .run(paymentId, userId, bill.from_account_id, memberName, 'AA收款', payCents, 'AA 收款到账 · ' + bill.title, 'app', nowStamp());
    db.prepare('INSERT INTO live_transfer_legs (transfer_id, account_id, effect_cents, balance_after_cents) VALUES (?, ?, ?, ?)')
      .run(paymentId, bill.from_account_id, payCents, after);
    if (participants.every(row => row.status === 'paid')) {
      db.prepare("UPDATE aa_bills SET status = 'settled', participants = ? WHERE id = ?").run(JSON.stringify(participants), id);
    } else {
      db.prepare('UPDATE aa_bills SET participants = ? WHERE id = ?').run(JSON.stringify(participants), id);
    }
    writeAudit(db, { userId, action: 'aa.payment', target: id, detail: `${memberName} 已支付 ¥${centsToYuan(payCents)}` });
    pushNotification(db, { userId, title: 'AA 收款到账', body: `${bill.title}：${memberName} 已支付 ¥${centsToYuan(payCents)}。`, level: 'success' });
  });
  return { id, memberName, paid: true };
}

export function listAaBills(db, { userId, limit = 10 } = {}) {
  return db.prepare('SELECT * FROM aa_bills WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, Math.min(50, Math.max(1, Number(limit) || 10))).map(row => ({
      ...row,
      total_yuan: centsToYuan(row.total_cents),
      participants: JSON.parse(row.participants)
    }));
}

export function listWealthHoldings(db, userId) {
  return db.prepare('SELECT * FROM wealth_holdings WHERE user_id = ? ORDER BY updated_at DESC').all(userId)
    .map(row => ({ ...row, amount_yuan: centsToYuan(row.amount_cents) }));
}

export function purchaseWealth(db, { userId, productId, productName, amountYuan, fromAccountId }) {
  const amountCents = Math.round(Number(amountYuan) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new TypeError('申购金额必须大于 0');
  const account = getAccount(db, fromAccountId, { userId });
  if (!account || account.account_class !== 'asset' || account.is_payable !== 1) throw new TypeError('付款账户不可用');
  if (account.status !== 'active') throw new TypeError('付款账户当前不可用');
  if (Number(account.current_balance_cents) < amountCents) throw new TypeError('账户余额不足');
  const stamp = nowStamp();
  const purchaseId = 'buy-' + randomUUID();
  runInTransaction(db, () => {
    const after = Number(account.current_balance_cents) - amountCents;
    db.prepare('UPDATE accounts SET current_balance_cents = current_balance_cents - ? WHERE id = ?').run(amountCents, fromAccountId);
    db.prepare(`INSERT INTO live_transfers
        (id, user_id, from_account_id, to_account_id, counterparty, counterparty_account, amount_cents, kind, status, note, channel, created_at)
        VALUES (?, ?, NULL, NULL, ?, NULL, ?, 'external', 'completed', ?, 'app', ?)`)
      .run(purchaseId, userId, productName, amountCents, '理财申购 · ' + productName, stamp);
    db.prepare('INSERT INTO live_transfer_legs (transfer_id, account_id, effect_cents, balance_after_cents) VALUES (?, ?, ?, ?)')
      .run(purchaseId, fromAccountId, -amountCents, after);
    insertBookedTransaction(db, {
      accountId: fromAccountId,
      platformId: account.platform_id,
      stamp,
      direction: 'transfer',
      flowKind: 'investment',
      amountCents,
      effectCents: -amountCents,
      balanceAfterCents: after,
      merchant: productName,
      category: '理财',
      channel: 'app',
      transferGroupId: purchaseId,
      note: '理财申购'
    });
    const existing = db.prepare('SELECT * FROM wealth_holdings WHERE user_id = ? AND product_id = ?').get(userId, productId);
    if (existing) {
      db.prepare('UPDATE wealth_holdings SET amount_cents = amount_cents + ?, updated_at = ? WHERE id = ?')
        .run(amountCents, stamp, existing.id);
    } else {
      db.prepare(`INSERT INTO wealth_holdings (id, user_id, product_id, product_name, amount_cents, purchased_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('wh-' + randomUUID(), userId, productId, productName, amountCents, stamp, stamp);
    }
    writeAudit(db, { userId, action: 'wealth.purchase', target: productId, detail: `${productName} 申购 ¥${centsToYuan(amountCents)}` });
    pushNotification(db, { userId, title: '申购成功', body: `${productName} ¥${centsToYuan(amountCents)} 已从「${account.name}」扣款并确认份额。`, level: 'success' });
  });
  return { productId, productName, amountYuan: centsToYuan(amountCents), balanceAfterYuan: getAccount(db, fromAccountId).current_balance_yuan };
}

export function redeemWealth(db, { userId, holdingId, amountYuan, toAccountId }) {
  const holding = db.prepare('SELECT * FROM wealth_holdings WHERE id = ? AND user_id = ?').get(holdingId, userId);
  if (!holding) throw new TypeError('持仓不存在');
  const amountCents = Math.round(Number(amountYuan) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new TypeError('赎回金额必须大于 0');
  if (amountCents > Number(holding.amount_cents)) throw new TypeError('赎回金额超出持仓');
  const account = getAccount(db, toAccountId, { userId });
  if (!account || account.status !== 'active') throw new TypeError('回款账户不可用');
  const stamp = nowStamp();
  const redeemId = 'red-' + randomUUID();
  runInTransaction(db, () => {
    const after = Number(account.current_balance_cents) + amountCents;
    db.prepare('UPDATE accounts SET current_balance_cents = current_balance_cents + ? WHERE id = ?').run(amountCents, toAccountId);
    const rest = Number(holding.amount_cents) - amountCents;
    if (rest === 0) db.prepare('DELETE FROM wealth_holdings WHERE id = ?').run(holding.id);
    else db.prepare('UPDATE wealth_holdings SET amount_cents = ?, updated_at = ? WHERE id = ?').run(rest, stamp, holding.id);
    db.prepare(`INSERT INTO live_transfers
        (id, user_id, from_account_id, to_account_id, counterparty, counterparty_account, amount_cents, kind, status, note, channel, created_at)
        VALUES (?, ?, NULL, ?, ?, NULL, ?, 'external', 'completed', ?, 'app', ?)`)
      .run(redeemId, userId, toAccountId, holding.product_name, amountCents, '理财赎回 · ' + holding.product_name, stamp);
    db.prepare('INSERT INTO live_transfer_legs (transfer_id, account_id, effect_cents, balance_after_cents) VALUES (?, ?, ?, ?)')
      .run(redeemId, toAccountId, amountCents, after);
    writeAudit(db, { userId, action: 'wealth.redeem', target: holding.id, detail: `${holding.product_name} 赎回 ¥${centsToYuan(amountCents)}` });
    pushNotification(db, { userId, title: '赎回成功', body: `${holding.product_name} ¥${centsToYuan(amountCents)} 已回款至「${account.name}」。`, level: 'success' });
  });
  return { holdingId, amountYuan: centsToYuan(amountCents), toAccountId };
}

export function applyForCard(db, { userId, cardKind, holderName }) {
  const stamp = nowStamp();
  const id = (cardKind === 'credit' ? 'newcc-' : 'newdc-') + randomUUID().slice(0, 8);
  const platformRow = db.prepare("SELECT id FROM platforms WHERE id = 'p-webbank'").get();
  if (!platformRow) throw new TypeError('平台不存在');
  const root = db.prepare("SELECT id FROM accounts WHERE account_type = 'BANK_GROUP' AND platform_id = 'p-webbank' LIMIT 1").get();
  const number = '62363600' + String(Math.floor(Math.abs(Math.sin(Date.now()) * 1e8))).padStart(8, '0').slice(0, 8);
  const masked = '6236 36** **** ' + number.slice(-4);
  const name = cardKind === 'credit' ? '众微银行信用卡 · ' + holderName.slice(-2) : '众微银行储蓄卡 · ' + holderName.slice(-2);
  runInTransaction(db, () => {
    db.prepare(`INSERT INTO accounts
        (id, parent_id, platform_id, name, account_type, account_class, currency, masked_number, card_network,
         is_primary, is_payable, status, credit_limit_cents, billing_day, due_day,
         opening_balance_cents, current_balance_cents, opened_on, sort_order, metadata, created_at)
        VALUES (?, ?, 'p-webbank', ?, ?, ?, 'CNY', ?, '银联', 0, ?, 'active', ?, ?, ?, 0, 0, ?, 90, ?, ?)`)
      .run(id, root ? root.id : null, name,
        cardKind === 'credit' ? 'CREDIT_CARD' : 'BANK_DEBIT',
        cardKind === 'credit' ? 'liability' : 'asset',
        masked, cardKind === 'credit' ? 1 : 0,
        cardKind === 'credit' ? 2000000 : null,
        cardKind === 'credit' ? 10 : null,
        cardKind === 'credit' ? 28 : null,
        stamp, JSON.stringify({ card_holder: holderName, usage: '自助申请开卡' }), stamp);
    db.prepare('INSERT INTO account_ownership (account_id, user_id, created_at) VALUES (?, ?, ?)').run(id, userId, stamp);
    db.prepare(`INSERT INTO card_credentials (account_id, user_id, card_number, password, password_updated_at, failed_attempts, updated_at)
        VALUES (?, ?, ?, '123456', ?, 0, ?)`).run(id, userId, number, stamp, stamp);
    writeAudit(db, { userId, action: 'card.issued', target: id, detail: `${name} 开卡成功，额度以审批为准` });
    pushNotification(db, { userId, title: '开卡成功', body: `${name} 已开通，查询密码默认 123456，可在「密码管理」修改。`, level: 'success' });
  });
  return { accountId: id, name, masked, cardNumber: number };
}

export function adjustCardLimit(db, { userId, accountId, newLimitYuan }) {
  const account = getAccount(db, accountId, { userId });
  if (!account || account.account_type !== 'CREDIT_CARD') throw new TypeError('仅信用卡支持额度调整');
  const newLimit = Math.round(Number(newLimitYuan) * 100);
  if (!Number.isFinite(newLimit) || newLimit <= 0) throw new TypeError('额度必须大于 0');
  if (newLimit < Number(account.current_balance_cents)) throw new TypeError('额度不能低于当前未偿金额');
  const old = account.credit_limit_yuan;
  db.prepare('UPDATE accounts SET credit_limit_cents = ? WHERE id = ?').run(newLimit, accountId);
  writeAudit(db, { userId, action: 'card.limit_adjusted', target: accountId, detail: `额度 ${old} → ${centsToYuan(newLimit)}` });
  pushNotification(db, { userId, title: '额度调整成功', body: `${account.name} 信用额度调整为 ¥${centsToYuan(newLimit)}。`, level: 'success' });
  return { accountId, newLimitYuan: centsToYuan(newLimit) };
}

export function setTradeLock(db, { userId, accountId, locked }) {
  const credential = getCardCredential(db, { accountId, userId });
  if (!credential) throw new TypeError('该账户没有卡凭据');
  db.prepare('UPDATE card_credentials SET trade_locked = ? WHERE account_id = ?').run(locked ? 1 : 0, accountId);
  writeAudit(db, { userId, action: locked ? 'card.trade_locked' : 'card.trade_unlocked', target: accountId });
  pushNotification(db, {
    userId, title: locked ? '交易限制已开启' : '交易限制已关闭',
    body: `${accountName(credential)} ${locked ? '已限制转出交易' : '已恢复转出交易'}。`, level: 'info'
  });
  return { accountId, locked: Boolean(locked) };
}

function accountName(credential) { return credential.account_name || credential.masked_number || '账户'; }

export function cancelSubscriptionById(db, { userId, subscriptionId }) {
  const owned = db.prepare(`
    SELECT s.* FROM subscriptions s
      JOIN account_ownership o ON o.account_id = s.payment_account_id
     WHERE s.id = ? AND o.user_id = ?`).get(subscriptionId, userId);
  if (!owned) throw new TypeError('订阅不存在或不属于当前用户');
  if (owned.status !== 'active') throw new TypeError('该订阅已取消');
  const stamp = nowStamp();
  runInTransaction(db, () => {
    db.prepare("UPDATE subscriptions SET status = 'cancelled', ended_on = ? WHERE id = ?").run(stamp.slice(0, 10), subscriptionId);
    writeAudit(db, { userId, action: 'subscription.cancelled', target: subscriptionId, detail: `${owned.merchant} · ${owned.product} 取消续费` });
    pushNotification(db, { userId, title: '订阅已取消', body: `${owned.merchant}「${owned.product}」已取消自动续费。`, level: 'success' });
  });
  return { subscriptionId, status: 'cancelled' };
}

/* ── 自动批准策略 / 订阅开通 / 生活缴费 ─────────────── */

function policyFromRow(row) {
  return {
    userId: row.user_id,
    autoApprove: Number(row.auto_approve) === 1,
    thresholdCents: Number(row.threshold_cents),
    thresholdYuan: centsToYuan(row.threshold_cents),
    allowInternal: Number(row.allow_internal) === 1,
    allowSubscription: Number(row.allow_subscription) === 1,
    allowUtility: Number(row.allow_utility) === 1,
    updatedAt: row.updated_at
  };
}

export function getUserPolicy(db, userId) {
  if (!userId) throw new TypeError('用户不能为空');
  let row = db.prepare('SELECT * FROM user_policies WHERE user_id = ?').get(userId);
  if (!row) {
    if (!getAppUser(db, userId)) throw new TypeError('用户不存在');
    db.prepare(`INSERT OR IGNORE INTO user_policies
        (user_id, auto_approve, threshold_cents, allow_internal, allow_subscription, allow_utility, updated_at)
        VALUES (?, 0, 100000, 1, 1, 1, ?)`).run(userId, nowStamp());
    row = db.prepare('SELECT * FROM user_policies WHERE user_id = ?').get(userId);
  }
  return policyFromRow(row);
}

export function setUserPolicy(db, {
  userId,
  autoApprove,
  thresholdYuan,
  allowInternal,
  allowSubscription,
  allowUtility
} = {}) {
  if (!getAppUser(db, userId)) throw new TypeError('用户不存在');
  const current = getUserPolicy(db, userId);
  const nextAuto = autoApprove === undefined ? current.autoApprove : Boolean(autoApprove);
  const nextThreshold = thresholdYuan === undefined
    ? current.thresholdCents
    : Math.round(Number(thresholdYuan) * 100);
  if (!Number.isFinite(nextThreshold) || nextThreshold < 0 || nextThreshold > 50000000) {
    throw new TypeError('免密额度须在 0 - 500,000 元之间');
  }
  const nextInternal = allowInternal === undefined ? current.allowInternal : Boolean(allowInternal);
  const nextSubscription = allowSubscription === undefined ? current.allowSubscription : Boolean(allowSubscription);
  const nextUtility = allowUtility === undefined ? current.allowUtility : Boolean(allowUtility);
  const stamp = nowStamp();
  runInTransaction(db, () => {
    db.prepare(`UPDATE user_policies
        SET auto_approve = ?, threshold_cents = ?, allow_internal = ?, allow_subscription = ?, allow_utility = ?, updated_at = ?
      WHERE user_id = ?`).run(
      nextAuto ? 1 : 0, nextThreshold, nextInternal ? 1 : 0, nextSubscription ? 1 : 0, nextUtility ? 1 : 0,
      stamp, userId
    );
    if (nextAuto !== current.autoApprove) {
      writeAudit(db, {
        userId,
        action: nextAuto ? 'policy.auto_approve_on' : 'policy.auto_approve_off',
        target: userId,
        detail: nextAuto ? `自动批准开启 · 免密额度 ¥${centsToYuan(nextThreshold)}` : '切换为安全模式'
      });
      pushNotification(db, {
        userId,
        title: nextAuto ? '自动批准已开启' : '已切换为安全模式',
        body: nextAuto
          ? `单笔 ¥${centsToYuan(nextThreshold)} 以内免密，本人账户互转、订阅续费与生活缴费直接完成。`
          : '转账、缴费与订阅开通都需要支付密码确认。',
        level: nextAuto ? 'success' : 'info'
      });
    }
  });
  return getUserPolicy(db, userId);
}

const SUBSCRIPTION_DEFAULTS = Object.freeze({
  腾讯视频: { product: 'VIP 连续包月', category: '视频', amountYuan: 25, billingDay: 15 },
  百度网盘: { product: '超级会员 连续包月', category: '云服务', amountYuan: 30, billingDay: 22 },
  爱奇艺: { product: '黄金 VIP 连续包月', category: '视频', amountYuan: 39, billingDay: 20 },
  网易云音乐: { product: '黑胶 VIP 连续包月', category: '音乐', amountYuan: 15, billingDay: 17 },
  Keep: { product: '会员连续包月', category: '健康', amountYuan: 199, billingDay: 29 },
  iCloud: { product: 'iCloud+ 200GB', category: '云服务', amountYuan: 6, billingDay: 5 },
  Apple: { product: 'iCloud+ 200GB', category: '云服务', amountYuan: 6, billingDay: 5 }
});

export function subscriptionDefaults(merchant) {
  return SUBSCRIPTION_DEFAULTS[String(merchant || '').trim()] || null;
}

export function subscribeService(db, {
  userId,
  merchant,
  product,
  category,
  amountYuan,
  billingDay,
  paymentAccountId = null
} = {}) {
  if (!getAppUser(db, userId)) throw new TypeError('用户不存在');
  const name = String(merchant || '').trim();
  if (!name) throw new TypeError('订阅商户不能为空');
  const defaults = subscriptionDefaults(name) || {};
  const resolvedProduct = String(product || defaults.product || name + ' 会员').trim();
  const resolvedCategory = String(category || defaults.category || '订阅').trim();
  const amountCents = Math.round(Number(amountYuan === undefined ? defaults.amountYuan : amountYuan) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new TypeError('订阅金额必须大于 0');
  if (amountCents > 5000000) throw new TypeError('订阅金额不能超过 50,000 元');
  const day = Math.round(Number(billingDay === undefined ? defaults.billingDay : billingDay));
  const billingDayValue = Number.isFinite(day) ? Math.min(31, Math.max(1, day)) : new Date().getDate();

  let account = null;
  if (paymentAccountId) {
    account = getAccount(db, paymentAccountId, { userId });
  } else {
    account = listAccounts(db, { userId, includeContainers: false })
      .filter(row => row.account_class === 'asset' && row.is_payable === 1 && row.account_type === 'BANK_DEBIT')[0] || null;
  }
  if (!account) throw new TypeError('没有可用的扣款账户');
  if (account.status !== 'active') throw new TypeError('扣款账户当前不可用');

  const stamp = nowStamp();
  const dayKey = stamp.slice(0, 10);
  const existing = db.prepare(`
    SELECT s.* FROM subscriptions s
      JOIN account_ownership o ON o.account_id = s.payment_account_id
     WHERE o.user_id = ? AND s.merchant = ? AND s.status = 'active'
     ORDER BY s.id LIMIT 1`).get(userId, name);

  let subscriptionId = null;
  let alreadyActive = false;
  runInTransaction(db, () => {
    if (existing) {
      alreadyActive = true;
      subscriptionId = existing.id;
      db.prepare(`UPDATE subscriptions
          SET autopay_authorized = 1, amount_cents = ?, billing_day = ?, product = ?, category = ?
        WHERE id = ?`).run(amountCents, billingDayValue, resolvedProduct, resolvedCategory, existing.id);
      writeAudit(db, {
        userId,
        action: 'subscription.autopay_on',
        target: existing.id,
        detail: `${name} · ${resolvedProduct} 自动续费已开启 ¥${centsToYuan(amountCents)}/月`
      });
      pushNotification(db, {
        userId,
        title: '自动续费已开启',
        body: `${name}「${resolvedProduct}」每月 ¥${centsToYuan(amountCents)}，扣款日为每月 ${billingDayValue} 日。`,
        level: 'success'
      });
      return;
    }
    const cancelled = db.prepare(`
      SELECT s.* FROM subscriptions s
        JOIN account_ownership o ON o.account_id = s.payment_account_id
       WHERE o.user_id = ? AND s.merchant = ? AND s.status = 'cancelled'
       ORDER BY s.id LIMIT 1`).get(userId, name);
    if (cancelled) {
      subscriptionId = cancelled.id;
      db.prepare(`UPDATE subscriptions
          SET status = 'active', ended_on = NULL, autopay_authorized = 1, amount_cents = ?, billing_day = ?,
              product = ?, category = ?, started_on = ?
        WHERE id = ?`).run(amountCents, billingDayValue, resolvedProduct, resolvedCategory, dayKey, cancelled.id);
    } else {
      subscriptionId = `sub-${randomUUID()}`;
      db.prepare(`INSERT INTO subscriptions
          (id, merchant, product, category, service_account, amount_cents, billing_cycle, billing_day,
           payment_account_id, autopay_authorized, status, started_on, ended_on, last_charged_on, charge_count, created_at)
          VALUES (?, ?, ?, ?, NULL, ?, 'monthly', ?, ?, 1, 'active', ?, NULL, NULL, 0, ?)`)
        .run(subscriptionId, name, resolvedProduct, resolvedCategory, amountCents, billingDayValue, account.id, dayKey, stamp);
    }
    writeAudit(db, {
      userId,
      action: 'subscription.subscribed',
      target: subscriptionId,
      detail: `${name} · ${resolvedProduct} 自动续费 ¥${centsToYuan(amountCents)}/月 · 每月 ${billingDayValue} 日`
    });
    pushNotification(db, {
      userId,
      title: '订阅已开通',
      body: `${name}「${resolvedProduct}」每月 ¥${centsToYuan(amountCents)}，扣款日为每月 ${billingDayValue} 日。`,
      level: 'success'
    });
  });

  return {
    id: subscriptionId,
    merchant: name,
    product: resolvedProduct,
    category: resolvedCategory,
    amountYuan: centsToYuan(amountCents),
    billingDay: billingDayValue,
    billingCycle: 'monthly',
    status: 'active',
    autopayAuthorized: true,
    startedOn: existing ? existing.started_on : dayKey,
    alreadyActive,
    paymentAccount: { id: account.id, name: account.name }
  };
}

const UTILITY_MERCHANTS = Object.freeze({
  水费: '城市自来水公司',
  电费: '国网四川电力',
  话费: '中国移动',
  燃气费: '绵阳燃气',
  宽带费: '中国电信'
});

export function utilityDefaults(kind) {
  return UTILITY_MERCHANTS[String(kind || '').trim()] || null;
}

export function payUtilityBill(db, { userId, kind, amountYuan, accountId = null } = {}) {
  if (!getAppUser(db, userId)) throw new TypeError('用户不存在');
  const service = String(kind || '').trim();
  const merchant = utilityDefaults(service);
  if (!merchant) throw new TypeError('暂不支持该缴费项目');
  const amountCents = Math.round(Number(amountYuan) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new TypeError('缴费金额必须大于 0');
  if (amountCents > 5000000) throw new TypeError('单笔缴费不能超过 50,000 元');

  const account = accountId
    ? getAccount(db, accountId, { userId })
    : listAccounts(db, { userId, includeContainers: false })
      .filter(row => row.account_class === 'asset' && row.is_payable === 1 && row.account_type === 'BANK_DEBIT')[0] || null;
  if (!account) throw new TypeError('没有可用的扣款账户');
  if (account.status !== 'active') throw new TypeError('扣款账户当前不可用');
  const balanceAfter = Number(account.current_balance_cents) - amountCents;
  if (balanceAfter < 0) throw new TypeError('扣款账户余额不足');

  const meta = getMeta(db);
  const asOf = meta.as_of || nowStamp().slice(0, 10);
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const occurredAt = `${asOf}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}+08:00`;
  const stamp = nowStamp();
  const paymentId = `pmt-${randomUUID()}`;
  runInTransaction(db, () => {
    db.prepare('UPDATE accounts SET current_balance_cents = current_balance_cents - ? WHERE id = ?').run(amountCents, account.id);
    db.prepare(`INSERT INTO transactions
        (id, account_id, platform_id, occurred_at, direction, flow_kind, amount_cents, balance_effect_cents,
         balance_after_cents, merchant, counterparty, category, subcategory, channel, status, subscription_id,
         transfer_group_id, is_internal_transfer, note, source_type, is_simulated, created_at)
        VALUES (?, ?, ?, ?, 'expense', 'utility', ?, ?, ?, ?, NULL, '生活缴费', ?, 'app', 'booked', NULL,
         NULL, 0, ?, 'simulated', 1, ?)`)
      .run(paymentId, account.id, account.platform_id, occurredAt, amountCents, -amountCents, balanceAfter,
        merchant, service, `${service} · 小安代缴`, stamp);
    writeAudit(db, {
      userId,
      action: 'payment.utility',
      target: paymentId,
      detail: `${service} ¥${centsToYuan(amountCents)} · ${account.name}`
    });
    pushNotification(db, {
      userId,
      title: '缴费成功',
      body: `${service} ¥${centsToYuan(amountCents)} 已从「${account.name}」缴清，收款方 ${merchant}。`,
      level: 'success'
    });
  });
  return {
    id: paymentId,
    kind: service,
    merchant,
    amountYuan: centsToYuan(amountCents),
    accountId: account.id,
    accountName: account.name,
    balanceAfterYuan: centsToYuan(balanceAfter),
    createdAt: occurredAt
  };
}

/* ── CLI：node db.mjs [--db path] [--json] ────────── */

function parseArgs(argv) {
  const args = { db: DEFAULT_DB_PATH, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--db') {
      args.db = argv[i + 1];
      i += 1;
      if (!args.db) throw new Error('--db 需要路径');
    } else if (arg.startsWith('--db=')) args.db = arg.slice('--db='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('用法：node db.mjs [--db data/finance.sqlite] [--json]');
      process.exit(0);
    }
    const db = openDatabase(args.db, { readOnly: true });
    try {
      const summary = getDatabaseSummary(db, { databasePath: path.resolve(args.db) });
      if (args.json) {
        console.log(JSON.stringify({ ...summary, digest: contentDigest(db) }, null, 2));
      } else {
        console.log(`数据库：${path.resolve(args.db)}`);
        console.log(`数据版本：${summary.meta.dataset_id || '—'} | seed=${summary.meta.seed || '—'} | as_of=${summary.meta.as_of || '—'}`);
        console.log(`流水：${summary.counts.transactions} 条 | ${summary.period.first_date} → ${summary.period.last_date} | ${summary.period.month_count} 个月`);
        console.log(`账户：${summary.counts.accounts}（容器 ${summary.counts.containers}）| 订阅：${summary.counts.activeSubscriptions} 个生效`);
        console.log(`资产：¥${summary.totals.assets_yuan} | 负债：¥${summary.totals.liabilities_yuan} | 净资产：¥${summary.totals.net_yuan}`);
        console.log(`校验：${summary.integrity.ok ? 'OK' : 'FAILED'}`);
        if (!summary.integrity.ok) {
          for (const issue of summary.integrity.issues) console.log(`  - ${issue}`);
          process.exitCode = 1;
        }
      }
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(`[db] ${error.message}`);
    process.exitCode = 1;
  }
}
