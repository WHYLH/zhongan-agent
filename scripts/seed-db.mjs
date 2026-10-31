/**
 * 众安 · 确定性 SQLite 种子
 *
 * 用法：
 *   node scripts/seed-db.mjs                 # 重建 data/finance.sqlite
 *   node scripts/seed-db.mjs --verify-only   # 只校验现有数据库
 *   node scripts/seed-db.mjs --json          # JSON 输出
 *   node scripts/seed-db.mjs --db path.sqlite
 *
 * 设计约束：
 * - 固定 seed / 固定 as_of / 固定生成时间，同一 Node 24 环境重复执行内容指纹一致。
 * - 只生成已发生的流水，任何记录都不晚于 2026-10-23。
 * - 不写未来预期消费、预期工资、账单计划或“下次扣费”流水。
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DB_PATH,
  SCHEMA_VERSION,
  centsToYuan,
  contentDigest,
  ensureServiceTables,
  getDatabaseSummary,
  initializeDatabase,
  openDatabase,
  validateDatabase
} from '../db.mjs';

const AS_OF = '2026-10-23';
const AS_OF_END = '2026-10-23T23:59:59+08:00';
const HISTORY_START = '2026-08-01';
const SEED = 20261023;
const GENERATED_AT = '2026-10-23T23:59:59+08:00';
const DATASET_ID = 'zhongan-demo-v1';
const MONTHS = ['2026-08', '2026-09', '2026-10'];

/* ── 确定性随机 ───────────────────────────────────── */

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(SEED);
const randInt = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = items => items[Math.floor(random() * items.length)];

/* ── 日期与金额工具 ───────────────────────────────── */

const pad2 = value => String(value).padStart(2, '0');

function time(hour, minute, second = 0) {
  return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

function dateIn(month, day) {
  return `${month}-${pad2(day)}`;
}

function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function money(yuan) {
  return Math.round(Number(yuan) * 100);
}

/* ── 平台、账户、订阅定义 ─────────────────────────── */

const platforms = [
  { id: 'p-webbank', name: '众微银行', category: 'bank', code: 'WEBANK', sort_order: 10 },
];

const accountDefs = [
  {
    id: 'webbank-root', parent_id: null, platform_id: 'p-webbank', name: '众微银行',
    account_type: 'BANK_GROUP', account_class: 'container', currency: 'CNY',
    masked_number: null, card_network: null, is_primary: 0, is_payable: 0,
    status: 'active', credit_limit_cents: null, billing_day: null, due_day: null,
    opening_balance_cents: 0, opened_on: null, sort_order: 10,
    metadata: { note: '账户层级容器，不代表可重复计算的余额' }
  },
  {
    id: 'wb-debit', parent_id: 'webbank-root', platform_id: 'p-webbank',
    name: '众微银行储蓄卡 · 工资卡', account_type: 'BANK_DEBIT', account_class: 'asset',
    currency: 'CNY', masked_number: '6236 36** **** 4821', card_network: '银联',
    is_primary: 1, is_payable: 1, status: 'active', credit_limit_cents: null,
    billing_day: null, due_day: null, opening_balance_cents: money(8240.50),
    opened_on: '2021-03-12', sort_order: 11,
    metadata: { card_holder: '林予安', usage: '工资代发与主要日常支出' }
  },
  {
    id: 'wb-savings', parent_id: 'webbank-root', platform_id: 'p-webbank',
    name: '众微银行 · 定期存款', account_type: 'BANK_SAVINGS', account_class: 'asset',
    currency: 'CNY', masked_number: '账户 **** 7306', card_network: null,
    is_primary: 0, is_payable: 0, status: 'active', credit_limit_cents: null,
    billing_day: null, due_day: null, opening_balance_cents: money(25000.00),
    opened_on: '2022-06-08', sort_order: 12,
    metadata: { card_holder: '林予安', usage: '储蓄目标与定期存款', role: 'reserve_fund', display_as: 'savings_goal' }
  },
      {
    id: 'webank-credit', parent_id: 'webbank-root', platform_id: 'p-webbank', name: '微粒贷 · 消费备用额度',
    account_type: 'WEBANK_CREDIT', account_class: 'liability', currency: 'CNY',
    masked_number: '微粒贷账户 ****6620', card_network: null,
    is_primary: 0, is_payable: 0, status: 'active', credit_limit_cents: money(15000),
    billing_day: 1, due_day: 9, opening_balance_cents: money(1280),
    opened_on: '2020-04-18', sort_order: 13,
    metadata: { credit_product: '微粒贷', billing_cycle: '按账单还款', usage: '众微银行授信资金来源' }
  },
  {
    id: 'wb-life', parent_id: 'webbank-root', platform_id: 'p-webbank', name: '众微银行储蓄卡 · 生活卡',
    account_type: 'BANK_DEBIT', account_class: 'asset', currency: 'CNY',
    masked_number: '6236 36** **** 9152', card_network: '银联',
    is_primary: 0, is_payable: 1, status: 'active', credit_limit_cents: null,
    billing_day: null, due_day: null, opening_balance_cents: money(2400),
    opened_on: '2023-08-06', sort_order: 12,
    metadata: { card_holder: '林予安', usage: '生活缴费与日常小额支出' }
  },
  {
    id: 'wb-platinum', parent_id: 'webbank-root', platform_id: 'p-webbank', name: '众微银行白金卡',
    account_type: 'CREDIT_CARD', account_class: 'liability', currency: 'CNY',
    masked_number: '6236 36** **** 2048', card_network: '银联',
    is_primary: 0, is_payable: 0, status: 'active', credit_limit_cents: money(80000),
    billing_day: 5, due_day: 25, opening_balance_cents: money(4120.36),
    opened_on: '2022-05-20', sort_order: 14,
    metadata: { card_holder: '林予安', usage: '大额消费与分期' }
  },  {
    id: 'cmb-credit', parent_id: 'webbank-root', platform_id: 'p-webbank',
    name: '众微银行信用卡', account_type: 'CREDIT_CARD', account_class: 'liability',
    currency: 'CNY', masked_number: '6236 36** **** 4021', card_network: '银联',
    is_primary: 0, is_payable: 0, status: 'active', credit_limit_cents: money(30000),
    billing_day: 12, due_day: 2, opening_balance_cents: money(1960),
    opened_on: '2019-11-20', sort_order: 41,
    metadata: { card_holder: '林予安', usage: '日常消费与线上支付' }
  }
];

const subscriptions = [
  {
    id: 'sub-icloud', merchant: 'Apple', product: 'iCloud+ 200GB',
    category: '云服务', service_account: 'yian***@icloud.com', amount_cents: money(6),
    billing_cycle: 'monthly', billing_day: 5, payment_account_id: 'wb-debit',
    autopay_authorized: 1, status: 'active', started_on: '2024-05-05',
    transaction_hour: 6, transaction_minute: 30
  },
  {
    id: 'sub-netease', merchant: '网易云音乐', product: '黑胶 VIP 连续包月',
    category: '音乐', service_account: '138****6620', amount_cents: money(15),
    billing_cycle: 'monthly', billing_day: 17, payment_account_id: 'wb-debit',
    autopay_authorized: 1, status: 'active', started_on: '2023-08-17',
    transaction_hour: 7, transaction_minute: 15
  },
  {
    id: 'sub-iqiyi', merchant: '爱奇艺', product: '黄金 VIP 连续包月',
    category: '视频', service_account: 'yian***@qq.com', amount_cents: money(39),
    billing_cycle: 'monthly', billing_day: 20, payment_account_id: 'wb-debit',
    autopay_authorized: 1, status: 'active', started_on: '2024-01-20',
    transaction_hour: 19, transaction_minute: 40
  },
  {
    id: 'sub-keep', merchant: 'Keep', product: '会员连续包月',
    category: '健康', service_account: 'keep_***', amount_cents: money(199),
    billing_cycle: 'monthly', billing_day: 29, payment_account_id: 'wb-debit',
    autopay_authorized: 1, status: 'active', started_on: '2023-03-29',
    transaction_hour: 18, transaction_minute: 20
  },
  {
    id: 'sub-water', merchant: '城市自来水公司', product: '自来水费 银行代扣',
    category: '生活缴费', service_account: '户号 07**', amount_cents: money(32),
    billing_cycle: 'monthly', billing_day: 8, payment_account_id: 'wb-debit',
    autopay_authorized: 1, status: 'active', started_on: '2026-11-01',
    transaction_hour: 9, transaction_minute: 10
  },
  {
    id: 'sub-tencent-video', merchant: '腾讯视频', product: 'VIP 连续包月',
    category: '视频', service_account: '13****866', amount_cents: money(25),
    billing_cycle: 'monthly', billing_day: 15, payment_account_id: 'wb-debit',
    autopay_authorized: 1, status: 'cancelled', started_on: '2026-11-05',
    ended_on: '2026-10-15',
    transaction_hour: 8, transaction_minute: 5
  },
  {
    id: 'sub-baidu-netdisk', merchant: '百度网盘', product: '超级会员 连续包月',
    category: '云服务', service_account: '13****866', amount_cents: money(30),
    billing_cycle: 'monthly', billing_day: 22, payment_account_id: 'wb-debit',
    autopay_authorized: 1, status: 'active', started_on: '2026-11-12',
    transaction_hour: 7, transaction_minute: 40
  },
  {
    id: 'sub-power', merchant: '国网四川电力', product: '居民电费 银行代扣',
    category: '生活缴费', service_account: '户号 30**21', amount_cents: money(88),
    billing_cycle: 'monthly', billing_day: 12, payment_account_id: 'wb-debit',
    autopay_authorized: 1, status: 'active', started_on: '2026-11-01',
    transaction_hour: 10, transaction_minute: 30
  }
];

/* 众微银行公开产品目录：名称来自公开页面，收益字段只保留页面明确出现的历史示例，
 * 不把动态报价伪装成当前承诺。页面地址、观察日期和说明随记录保存，供 Agent 查询。 */
const financialProducts = [
  {
    id: 'wb-huoqi-plus', institution: '众微银行', name: '活期+', product_type: '现金管理',
    risk_level: 'R1（低风险）', liquidity: '随时可取', min_amount: '0.01 元起购',
    rate_label: '七日年化约 1.8%', rate_value: 1.8, rate_unit: '七日年化',
    term: '无固定期限', product_code: 'WB-HQ-001',
    highlights: '随时存取 · 消费可直接支付 · 收益每日结算',
        history_7d: '1.812%',
    history_1m: '1.795%',
    history_3m: '1.823%',
    history_6m: '1.856%',
    history_1y: '2.034%',
    history_ytd: '1.624%',
    fee_manage: '0.15%/年（从份额中计提）',
    fee_custody: '0.05%/年',
    fee_sales: '0（众微银行代销免申购费）',
    scale_label: '约 1,842 亿元（2026-09-30）',
    manager: '工银瑞信·现金快线货币基金',
    est_annual_return: 1.82,
    max_drawdown: '无（货币基金历史无回撤）',
    invest_range: '银行存款、同业存单、央行票据、高等级短融',
    suitable_for: '零钱管理 · 日常消费 · 随时可取',
    redemption_desc: '赎回 T+0 到账（单日 ≤1 万元），超出部分 T+1',
    calc_note: '按当前七日年化估算，1 万元存 30 天约得 15 元',
    source_url: 'https://www.webank.com/landing/index.html', source_published: '2026-10-20',
    observed_at: '2026-10-25', note: '对接货币基金，收益随市场波动。', source_type: 'official'
  },
  {
    id: 'wb-huoqi-plus-plus', institution: '众微银行', name: '活期+Plus', product_type: '现金管理',
    risk_level: 'R2（中低风险）', liquidity: '持有 7 天后随时可取', min_amount: '1000 元起购',
    rate_label: '七日年化约 2.6%', rate_value: 2.6, rate_unit: '七日年化',
    term: '无固定期限', product_code: 'WB-HQ-002',
    highlights: '收益高于活期+ · 7 天持有期 · 大额闲钱优选',
        history_7d: '2.589%',
    history_1m: '2.612%',
    history_3m: '2.588%',
    history_6m: '2.641%',
    history_1y: '2.872%',
    history_ytd: '2.316%',
    fee_manage: '0.25%/年',
    fee_custody: '0.05%/年',
    fee_sales: '0',
    scale_label: '约 486 亿元（2026-09-30）',
    manager: '南方基金·天天利债券型',
    est_annual_return: 2.61,
    max_drawdown: '近一年最大回撤 0.08%',
    invest_range: '中短久期利率债、高等级信用债、同业存单',
    suitable_for: '大额闲钱 · 7 天以上不动用 · 追求高于活期+的收益',
    redemption_desc: '持有满 7 天后随时赎回，T+1 到账',
    calc_note: '按当前基准估算，1 万元存 30 天约得 21 元',
    source_url: 'https://www.webank.com/landing/index.html', source_published: '2026-10-20',
    observed_at: '2026-10-25', note: '底层为短债基金组合。', source_type: 'official'
  },
  {
    id: 'wb-deposit-3m', institution: '众微银行', name: '定期存款 · 3 个月', product_type: '定期存款',
    risk_level: 'R1（存款保险保障）', liquidity: '到期支取', min_amount: '50 元起存',
    rate_label: '年利率 1.32%', rate_value: 1.32, rate_unit: '年利率',
    term: '3 个月', product_code: 'WB-DP-3M',
    highlights: '存款保险 · 保本保息 · 到期自动转存可选',
        history_7d: '—',
    history_1m: '—',
    history_3m: '1.32%',
    history_6m: '—',
    history_1y: '—',
    history_ytd: '—',
    fee_manage: '无',
    fee_custody: '无',
    fee_sales: '无',
    scale_label: '—',
    manager: '众微银行自营存款',
    est_annual_return: 1.32,
    max_drawdown: '无（存款保本）',
    invest_range: '人民币定期存款（整存整取）',
    suitable_for: '3 个月内确定不用的资金 · 保本保息',
    redemption_desc: '到期自动回活期账户，可设自动转存',
    calc_note: '1 万元存 3 个月，到期利息约 33 元',
    source_url: 'https://www.webank.com/announcement/announcement-detail05.html', source_published: '2026-01-03',
    observed_at: '2026-10-25', note: '众微银行人民币存款利率表。', source_type: 'official'
  },
  {
    id: 'wb-deposit-1y', institution: '众微银行', name: '定期存款 · 1 年', product_type: '定期存款',
    risk_level: 'R1（存款保险保障）', liquidity: '到期支取', min_amount: '50 元起存',
    rate_label: '年利率 1.80%', rate_value: 1.8, rate_unit: '年利率',
    term: '12 个月', product_code: 'WB-DP-1Y',
    highlights: '存款保险 · 保本保息 · 利率高于活期',
        history_7d: '—',
    history_1m: '—',
    history_3m: '—',
    history_6m: '—',
    history_1y: '1.80%',
    history_ytd: '—',
    fee_manage: '无',
    fee_custody: '无',
    fee_sales: '无',
    scale_label: '—',
    manager: '众微银行自营存款',
    est_annual_return: 1.8,
    max_drawdown: '无（存款保本）',
    invest_range: '人民币定期存款（整存整取）',
    suitable_for: '1 年内不动用的闲钱 · 保本保息',
    redemption_desc: '到期自动回活期账户，可设自动转存',
    calc_note: '1 万元存 1 年，到期利息约 180 元',
    source_url: 'https://www.webank.com/announcement/announcement-detail05.html', source_published: '2026-01-03',
    observed_at: '2026-10-25', note: '众微银行人民币存款利率表。', source_type: 'official'
  },
  {
    id: 'wb-deposit-3y', institution: '众微银行', name: '定期存款 · 3 年', product_type: '定期存款',
    risk_level: 'R1（存款保险保障）', liquidity: '到期支取', min_amount: '50 元起存',
    rate_label: '年利率 3.30%', rate_value: 3.3, rate_unit: '年利率',
    term: '36 个月', product_code: 'WB-DP-3Y',
    highlights: '存款保险 · 长期锁定高利率 · 适合养老金规划',
        history_7d: '—',
    history_1m: '—',
    history_3m: '—',
    history_6m: '—',
    history_1y: '—',
    history_ytd: '—',
    fee_manage: '无',
    fee_custody: '无',
    fee_sales: '无',
    scale_label: '—',
    manager: '众微银行自营存款',
    est_annual_return: 3.3,
    max_drawdown: '无（存款保本）',
    invest_range: '人民币定期存款（整存整取）',
    suitable_for: '长期不动用资金 · 锁定高利率 · 养老金/教育金规划',
    redemption_desc: '到期自动回活期账户，可设自动转存',
    calc_note: '1 万元存 3 年，到期利息约 990 元',
    source_url: 'https://www.webank.com/announcement/announcement-detail05.html', source_published: '2026-01-03',
    observed_at: '2026-10-25', note: '众微银行人民币存款利率表。', source_type: 'official'
  },
  {
    id: 'wb-licai-xinlan', institution: '众微银行', name: '微银理财 · 新蓝球 · 90 天持有', product_type: '理财产品',
    risk_level: 'R2（中低风险）', liquidity: '持有 90 天后可赎', min_amount: '1000 元起购',
    rate_label: '业绩比较基准 2.9%', rate_value: 2.9, rate_unit: '年化',
    term: '90 天最短持有', product_code: 'WB-LC-XL-90',
    highlights: '固收+策略 · 月度分红 · 适合稳健理财',
        history_7d: '—',
    history_1m: '0.24%',
    history_3m: '0.72%',
    history_6m: '1.51%',
    history_1y: '3.01%',
    history_ytd: '2.35%',
    fee_manage: '0.30%/年',
    fee_custody: '0.05%/年',
    fee_sales: '0.40%（持有满 90 天减免）',
    scale_label: '约 126 亿元（2026-09-30）',
    manager: '招银理财·招睿日日新月蓝球 90 天持有',
    est_annual_return: 2.9,
    max_drawdown: '近一年最大回撤 0.62%',
    invest_range: '利率债 70%+ 高等级信用债 25%+ 可转债 5%',
    suitable_for: '稳健理财 · 90 天不动用 · 月度分红',
    redemption_desc: '持有满 90 天后随时赎回，T+1 确认',
    calc_note: '按业绩基准 2.9% 估算，1 万元持有 90 天约得 72 元',
    source_url: 'https://www.webank.com/landing/index.html', source_published: '2026-10-20',
    observed_at: '2026-10-25', note: '理财产品不保本，业绩比较基准不代表最终收益。', source_type: 'official'
  },
  {
    id: 'wb-licai-jinzuan', institution: '众微银行', name: '微银理财 · 金钻 · 360 天封闭', product_type: '理财产品',
    risk_level: 'R3（中风险）', liquidity: '封闭期 360 天', min_amount: '5000 元起购',
    rate_label: '业绩比较基准 3.8%', rate_value: 3.8, rate_unit: '年化',
    term: '360 天封闭', product_code: 'WB-LC-JZ-360',
    highlights: '混合策略 · 追求较高收益 · 封闭运作',
        history_7d: '—',
    history_1m: '0.31%',
    history_3m: '0.95%',
    history_6m: '1.98%',
    history_1y: '3.84%',
    history_ytd: '3.12%',
    fee_manage: '0.45%/年',
    fee_custody: '0.05%/年',
    fee_sales: '0.80%（一次性收取）',
    scale_label: '约 38 亿元（2026-09-30）',
    manager: '兴银理财·兴睿金钻混合 360 天封闭',
    est_annual_return: 3.8,
    max_drawdown: '近一年最大回撤 2.15%',
    invest_range: '权益类 30%+ 固收类 65%+ 另类 5%',
    suitable_for: '进取型 · 能承受短期波动 · 1 年不动用',
    redemption_desc: '封闭期 360 天，到期自动赎回至活期账户',
    calc_note: '按业绩基准 3.8% 估算，1 万元持有 360 天约得 375 元',
    source_url: 'https://www.webank.com/landing/index.html', source_published: '2026-10-20',
    observed_at: '2026-10-25', note: '理财产品不保本，历史业绩不代表未来。', source_type: 'official'
  },
  {
    id: 'wb-licai-yuefan', institution: '众微银行', name: '微银理财 · 悦享 30 天滚存', product_type: '理财产品',
    risk_level: 'R2（中低风险）', liquidity: '每 30 天开放赎回', min_amount: '1000 元起购',
    rate_label: '业绩比较基准 2.7%', rate_value: 2.7, rate_unit: '年化',
    term: '30 天滚动', product_code: 'WB-LC-YX-30',
    highlights: '月度开放 · 灵活滚存 · 兼顾收益与流动性',
        history_7d: '—',
    history_1m: '0.22%',
    history_3m: '0.68%',
    history_6m: '1.39%',
    history_1y: '2.73%',
    history_ytd: '2.11%',
    fee_manage: '0.25%/年',
    fee_custody: '0.05%/年',
    fee_sales: '0.30%（持有满 30 天减免）',
    scale_label: '约 82 亿元（2026-09-30）',
    manager: '光大理财·阳光金悦享 30 天滚存',
    est_annual_return: 2.7,
    max_drawdown: '近一年最大回撤 0.35%',
    invest_range: '中短债 85%+ 优质信用债 15%',
    suitable_for: '月度滚动 · 兼顾收益与流动性 · 适合工资理财',
    redemption_desc: '每 30 天开放赎回窗口，T+1 到账',
    calc_note: '按业绩基准 2.7% 估算，1 万元持有 30 天约得 22 元',
    source_url: 'https://www.webank.com/landing/index.html', source_published: '2026-10-20',
    observed_at: '2026-10-25', note: '理财产品不保本。', source_type: 'official'
  }
];

const accountById = new Map(accountDefs.map(account => [account.id, account]));
const platformById = new Map(platforms.map(platform => [platform.id, platform]));

/* ── 交易生成 ─────────────────────────────────────── */

const events = [];
const liabilityCharges = new Map(); // `${accountId}|${YYYY-MM}` -> cents
let transactionSequence = 0;
let transferSequence = 0;

function addEvent({
  date, time: clock, accountId, direction, flowKind, amountCents, merchant,
  counterparty = null, category, subcategory = null, channel, note = null,
  subscriptionId = null, transferGroupId = null, isInternalTransfer = 0,
  leg = null
}) {
  if (date > AS_OF) return null;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`无效金额：${amountCents}`);
  }
  const account = accountById.get(accountId);
  if (!account) throw new Error(`未知账户：${accountId}`);
  const occurredAt = `${date}T${clock}+08:00`;
  if (occurredAt > AS_OF_END) return null;
  const id = `tx-${date.replaceAll('-', '')}-${String(++transactionSequence).padStart(4, '0')}`;
  const event = {
    id, date, occurredAt, accountId, direction, flowKind, amountCents,
    merchant, counterparty, category, subcategory, channel, note,
    subscriptionId, transferGroupId, isInternalTransfer, leg
  };
  events.push(event);
  if (direction === 'expense' && account.account_class === 'liability') {
    const key = `${accountId}|${date.slice(0, 7)}`;
    liabilityCharges.set(key, (liabilityCharges.get(key) || 0) + amountCents);
  }
  return event;
}

function addTransfer({
  date, time: clock, fromAccountId, toAccountId, amountCents, flowKind,
  merchant, category, note = null, outChannel = '手机银行',
  inChannel = '内部转账'
}) {
  if (date > AS_OF) return;
  const from = accountById.get(fromAccountId);
  const to = accountById.get(toAccountId);
  if (!from || !to) throw new Error('转账账户不存在');
  const groupId = `tg-${date.replaceAll('-', '')}-${String(++transferSequence).padStart(3, '0')}`;
  addEvent({
    date, time: clock, accountId: fromAccountId, direction: 'transfer', flowKind,
    amountCents, merchant: merchant || to.name, counterparty: to.name,
    category, channel: outChannel, note, transferGroupId: groupId,
    isInternalTransfer: 1, leg: 'out'
  });
  addEvent({
    date, time: clock, accountId: toAccountId, direction: 'transfer', flowKind,
    amountCents, merchant: to.name, counterparty: from.name,
    category, channel: inChannel, note, transferGroupId: groupId,
    isInternalTransfer: 1, leg: 'in'
  });
}

/* 1. 工资：已发生的 8—10 月工资，不含未来预期工资。 */
for (const month of MONTHS) {
  addEvent({
    date: dateIn(month, 5), time: time(9, 12, 36), accountId: 'wb-debit',
    direction: 'income', flowKind: 'salary', amountCents: money(18600),
    merchant: '上海辰星网络科技有限公司', counterparty: '上海辰星网络科技有限公司',
    category: '收入', subcategory: '工资', channel: '银行代发',
    note: `${month} 税后工资（已入账）`
  });
}

/* 2. 储蓄账户季度结息：只记录已经发生的利息。 */
addEvent({
  date: '2026-09-21', time: time(8, 0, 12), accountId: 'wb-savings',
  direction: 'income', flowKind: 'interest', amountCents: money(42.18),
  merchant: '众微银行', counterparty: '众微银行', category: '收入',
  subcategory: '存款利息', channel: '账户结息', note: '三季度活期储蓄结息'
});

/* 3. 房租：每月 6 日从工资卡转给房东。 */
for (const month of MONTHS) {
  addEvent({
    date: dateIn(month, 6), time: time(8, 35, 18), accountId: 'wb-debit',
    direction: 'expense', flowKind: 'rent', amountCents: money(4200),
    merchant: '张明远（房东）', counterparty: '个人房东',
    category: '居住', subcategory: '房租', channel: '银行转账',
    note: `${month} 房租`
  });
}

/* 4. 本人账户划转：工资卡 → 储蓄账户、工资卡 → 生活卡（日常花销备付金）。 */
for (const month of MONTHS) {
  addTransfer({
    date: dateIn(month, 6), time: time(11, 20, 6),
    fromAccountId: 'wb-debit', toAccountId: 'wb-life',
    amountCents: money(1400), flowKind: 'card_topup',
    merchant: '众微银行储蓄卡 · 生活卡', category: '转账',
    note: `${month} 生活卡备付金`
  });
  addTransfer({
    date: dateIn(month, 21), time: time(11, 20, 6),
    fromAccountId: 'wb-debit', toAccountId: 'wb-life',
    amountCents: money(1400), flowKind: 'card_topup',
    merchant: '众微银行储蓄卡 · 生活卡', category: '转账',
    note: `${month} 生活卡备付金`
  });
}
for (const month of MONTHS) {
  addTransfer({
    date: dateIn(month, 7), time: time(10, 5, 10),
    fromAccountId: 'wb-debit', toAccountId: 'wb-savings',
    amountCents: money(3000), flowKind: 'savings_transfer',
    merchant: '众微银行 · 定期存款', category: '转账',
    note: `${month} 月度储蓄`
  });
}

/* 5. 固定生活缴费。 */
const electricityByMonth = {
  '2026-08': money(231.40),
  '2026-09': money(164.70),
  '2026-10': money(199.60)
};
for (const month of MONTHS) {
  addEvent({
    date: dateIn(month, 9), time: time(7, 50, 22), accountId: 'wb-debit',
    direction: 'expense', flowKind: 'utility', amountCents: electricityByMonth[month],
    merchant: '国家电网', counterparty: '国家电网上海电力',
    category: '生活', subcategory: '水电', channel: '银行生活缴费',
    note: `${month} 居民电费`
  });
  addEvent({
    date: dateIn(month, 12), time: time(9, 10, 4), accountId: 'wb-debit',
    direction: 'expense', flowKind: 'communication', amountCents: money(89),
    merchant: '中国移动', counterparty: '中国移动',
    category: '生活', subcategory: '通讯', channel: '银行自动扣费',
    note: `${month} 手机套餐`
  });
  addEvent({
    date: dateIn(month, 14), time: time(10, 30, 8), accountId: 'wb-debit',
    direction: 'expense', flowKind: 'utility', amountCents: money(129),
    merchant: '中国电信', counterparty: '中国电信',
    category: '生活', subcategory: '宽带', channel: '银行代扣',
    note: `${month} 家庭宽带`
  });
}

/* 6. 固定订阅：只生成已经发生的扣费；例如 Keep 10 月 29 日未到，不生成。
 * 订阅开始日之前不生成扣费（如 11 月起代扣的水电费不产生历史流水）。 */
const subscriptionCharges = new Map(subscriptions.map(subscription => [subscription.id, []]));
for (const subscription of subscriptions) {
  const startMonth = String(subscription.started_on || '').slice(0, 7);
  for (const month of MONTHS) {
    if (startMonth && month < startMonth) continue;
    const event = addEvent({
      date: dateIn(month, subscription.billing_day),
      time: time(subscription.transaction_hour, subscription.transaction_minute, 12),
      accountId: subscription.payment_account_id,
      direction: 'expense',
      flowKind: 'subscription',
      amountCents: subscription.amount_cents,
      merchant: subscription.merchant,
      counterparty: subscription.merchant,
      category: '订阅',
      subcategory: subscription.category,
      channel: '自动扣费',
      note: `${subscription.product} · ${month} 续费`,
      subscriptionId: subscription.id
    });
    if (event) subscriptionCharges.get(subscription.id).push(event);
  }
}

/* 7. 日常消费：工作日 0—1 笔，周末 0—2 笔，固定种子。 */
const weekdayMerchants = [
  { merchant: '瑞幸咖啡', category: '餐饮', subcategory: '咖啡', min: 1200, max: 2900, hour: 8, minute: 20 },
  { merchant: 'Manner Coffee', category: '餐饮', subcategory: '咖啡', min: 1500, max: 3000, hour: 8, minute: 45 },
  { merchant: '老乡鸡', category: '餐饮', subcategory: '午餐', min: 2200, max: 3800, hour: 12, minute: 10 },
  { merchant: '麦当劳', category: '餐饮', subcategory: '快餐', min: 2500, max: 5500, hour: 12, minute: 25 },
  { merchant: '和府捞面', category: '餐饮', subcategory: '午餐', min: 3500, max: 6500, hour: 12, minute: 40 },
  { merchant: '滴滴出行', category: '交通', subcategory: '网约车', min: 1800, max: 6500, hour: 18, minute: 30 },
  { merchant: '上海地铁', category: '交通', subcategory: '公共交通', min: 300, max: 800, hour: 18, minute: 10 },
  { merchant: '全家便利店', category: '生活', subcategory: '日用品', min: 800, max: 3500, hour: 20, minute: 5 }
];

const weekendMerchants = [
  { merchant: '盒马鲜生', category: '生活', subcategory: '生鲜', min: 6500, max: 22000, hour: 11, minute: 5 },
  { merchant: '叮咚买菜', category: '生活', subcategory: '生鲜', min: 4000, max: 12000, hour: 10, minute: 35 },
  { merchant: '美团外卖', category: '餐饮', subcategory: '外卖', min: 3000, max: 8500, hour: 12, minute: 20 },
  { merchant: '星巴克', category: '餐饮', subcategory: '咖啡', min: 3200, max: 4800, hour: 15, minute: 10 },
  { merchant: '海底捞', category: '餐饮', subcategory: '聚餐', min: 18000, max: 35000, hour: 18, minute: 45 },
  { merchant: '猫眼电影', category: '娱乐', subcategory: '电影', min: 4500, max: 9000, hour: 19, minute: 30 }
];

for (let date = HISTORY_START; date <= AS_OF; date = nextDate(date)) {
  const day = weekday(date);
  const isWeekend = day === 0 || day === 6;
  if (isWeekend) {
    if (random() < 0.82) {
      const merchant = pick(weekendMerchants);
      addEvent({
        date, time: time(merchant.hour, merchant.minute, 9), accountId: 'wb-debit',
        direction: 'expense', flowKind: 'consumption',
        amountCents: randInt(merchant.min, merchant.max),
        merchant: merchant.merchant, counterparty: merchant.merchant,
        category: merchant.category, subcategory: merchant.subcategory,
        channel: '银行卡', note: '银行卡消费'
      });
    }
    if (random() < 0.72) {
      const merchant = pick(weekendMerchants);
      addEvent({
        date, time: time((merchant.hour + 2) % 23, (merchant.minute + 15) % 60, 31),
        accountId: 'wb-debit', direction: 'expense', flowKind: 'consumption',
        amountCents: randInt(merchant.min, merchant.max),
        merchant: merchant.merchant, counterparty: merchant.merchant,
        category: merchant.category, subcategory: merchant.subcategory,
        channel: '银行卡', note: '银行卡消费'
      });
    }
  } else if (random() < 0.88) {
    const merchant = pick(weekdayMerchants);
    addEvent({
      date, time: time(merchant.hour, merchant.minute, 17), accountId: 'wb-debit',
      direction: 'expense', flowKind: 'consumption',
      amountCents: randInt(merchant.min, merchant.max),
      merchant: merchant.merchant, counterparty: merchant.merchant,
      category: merchant.category, subcategory: merchant.subcategory,
      channel: '银行卡', note: '银行卡消费'
    });
  }
}

/* 8. 信用卡消费：招行经典白，账单日 12 日，还款日次月 2 日。 */
const cmbPurchaseSpecs = [
  { day: 3, merchant: '京东', category: '购物', subcategory: '电商', min: 19900, max: 69900, hour: 20, minute: 12 },
  { day: 8, merchant: '山姆会员店', category: '购物', subcategory: '商超', min: 39900, max: 89900, hour: 11, minute: 25 },
  { day: 13, merchant: '优衣库', category: '购物', subcategory: '服饰', min: 19900, max: 49900, hour: 19, minute: 35 },
  { day: 19, merchant: 'Apple Store', category: '数码', subcategory: '应用与服务', min: 29900, max: 129900, hour: 21, minute: 8 },
  { day: 24, merchant: '携程旅行', category: '旅行', subcategory: '交通', min: 39900, max: 129900, hour: 10, minute: 15 },
  { day: 28, merchant: '海底捞', category: '餐饮', subcategory: '聚餐', min: 22000, max: 48000, hour: 18, minute: 50 }
];
for (const month of MONTHS) {
  for (const spec of cmbPurchaseSpecs) {
    addEvent({
      date: dateIn(month, spec.day), time: time(spec.hour, spec.minute, 33),
      accountId: 'cmb-credit', direction: 'expense', flowKind: 'consumption',
      amountCents: randInt(spec.min, spec.max),
      merchant: spec.merchant, counterparty: spec.merchant,
      category: spec.category, subcategory: spec.subcategory,
      channel: '信用卡', note: '信用卡消费'
    });
  }
}

/* 9. 微粒贷授信消费：众微银行场景，账期内归还上期借款。 */
const webankCreditPurchaseSpecs = [
  { day: 2, merchant: '淘宝', category: '购物', subcategory: '电商', min: 5900, max: 29900, hour: 21, minute: 30 },
  { day: 7, merchant: '饿了么', category: '餐饮', subcategory: '外卖', min: 2500, max: 6500, hour: 12, minute: 15 },
  { day: 11, merchant: '盒马鲜生', category: '生活', subcategory: '生鲜', min: 4500, max: 15900, hour: 18, minute: 40 },
  { day: 16, merchant: '美团团购', category: '餐饮', subcategory: '团购', min: 3900, max: 12900, hour: 19, minute: 25 },
  { day: 21, merchant: '12306', category: '交通', subcategory: '铁路', min: 5500, max: 28000, hour: 9, minute: 5 },
  { day: 25, merchant: '网易严选', category: '购物', subcategory: '家居', min: 9900, max: 39900, hour: 22, minute: 10 },
  { day: 27, merchant: '叮咚买菜', category: '生活', subcategory: '生鲜', min: 3500, max: 12000, hour: 17, minute: 55 }
];
for (const month of MONTHS) {
  for (const spec of webankCreditPurchaseSpecs) {
    addEvent({
      date: dateIn(month, spec.day), time: time(spec.hour, spec.minute, 44),
      accountId: 'webank-credit', direction: 'expense', flowKind: 'consumption',
      amountCents: randInt(spec.min, spec.max),
      merchant: spec.merchant, counterparty: spec.merchant,
      category: spec.category, subcategory: spec.subcategory,
      channel: '微粒贷', note: '众微银行授信消费'
    });
  }
}

/* 10. 信用卡 / 微粒贷还款：归还上期已出账金额；还款自身只记为 transfer。 */
for (let index = 0; index < MONTHS.length; index += 1) {
  const month = MONTHS[index];
  const previousMonth = index === 0 ? null : MONTHS[index - 1];

  const cmbRepayment = previousMonth
    ? (liabilityCharges.get(`cmb-credit|${previousMonth}`) || 0)
    : accountById.get('cmb-credit').opening_balance_cents;
  addTransfer({
    date: dateIn(month, 2), time: time(9, 20, 42),
    fromAccountId: 'wb-debit', toAccountId: 'cmb-credit',
    amountCents: cmbRepayment, flowKind: 'credit_card_repayment',
    merchant: '招商银行信用卡还款', category: '还款',
    note: previousMonth ? `归还 ${previousMonth} 信用卡账单` : '归还上期信用卡账单',
    outChannel: '手机银行', inChannel: '自动还款'
  });

  const webankCreditRepayment = previousMonth
    ? (liabilityCharges.get(`webank-credit|${previousMonth}`) || 0)
    : accountById.get('webank-credit').opening_balance_cents;
  addTransfer({
    date: dateIn(month, 9), time: time(8, 40, 26),
    fromAccountId: 'wb-debit', toAccountId: 'webank-credit',
    amountCents: webankCreditRepayment, flowKind: 'webank_credit_repayment',
    merchant: '微粒贷自动还款', category: '还款',
    note: previousMonth ? `归还 ${previousMonth} 微粒贷账单` : '归还上期微粒贷账单',
    outChannel: '众微银行账户', inChannel: '自动还款'
  });
}

/* 10b. 补充线下与生活场景消费，让 8—10 月流水达到约 200 笔。 */
const extraDailyEvents = [
  { date: '2026-08-03', clock: time(9, 26, 41), accountId: 'wb-debit', amount: 286.50, merchant: '上海瑞金医院', category: '医疗', subcategory: '门诊', channel: '银行卡', note: '门诊挂号与检查' },
  { date: '2026-08-08', clock: time(15, 12, 8), accountId: 'wb-debit', amount: 329.00, merchant: '无印良品', category: '购物', subcategory: '家居', channel: '银行卡', note: '家居用品' },
  { date: '2026-08-12', clock: time(18, 40, 22), accountId: 'wb-debit', amount: 300.00, merchant: '中国石化', category: '交通', subcategory: '加油', channel: '银行卡', note: '车辆加油' },
  { date: '2026-08-17', clock: time(20, 5, 36), accountId: 'wb-debit', amount: 480.00, merchant: '大麦网', category: '娱乐', subcategory: '演出', channel: '银行卡', note: '话剧演出票' },
  { date: '2026-08-22', clock: time(10, 48, 15), accountId: 'wb-debit', amount: 260.00, merchant: '宠物体检中心', category: '生活', subcategory: '宠物', channel: '银行卡', note: '宠物体检' },
  { date: '2026-08-30', clock: time(9, 3, 52), accountId: 'wb-debit', amount: 168.00, merchant: '平安保险', category: '保险', subcategory: '医疗险', channel: '银行代扣', note: '百万医疗险月缴' },
  { date: '2026-09-04', clock: time(11, 17, 9), accountId: 'wb-debit', amount: 156.80, merchant: '同仁堂', category: '医疗', subcategory: '药品', channel: '银行卡', note: '常备药品' },
  { date: '2026-09-10', clock: time(19, 32, 44), accountId: 'wb-debit', amount: 268.00, merchant: '迪卡侬', category: '购物', subcategory: '运动', channel: '银行卡', note: '运动装备' },
  { date: '2026-09-19', clock: time(19, 45, 6), accountId: 'wb-debit', amount: 380.00, merchant: '上海大剧院', category: '娱乐', subcategory: '演出', channel: '银行卡', note: '音乐会门票' },
  { date: '2026-09-23', clock: time(14, 8, 30), accountId: 'wb-debit', amount: 42.00, merchant: '顺丰速运', category: '生活', subcategory: '快递', channel: '银行卡', note: '寄件费用' },
  { date: '2026-09-28', clock: time(8, 52, 18), accountId: 'wb-debit', amount: 99.00, merchant: '众安保险', category: '保险', subcategory: '意外险', channel: '银行代扣', note: '综合意外险月缴' },
  { date: '2026-10-02', clock: time(7, 36, 24), accountId: 'wb-debit', amount: 553.00, merchant: '上海虹桥站', category: '旅行', subcategory: '铁路', channel: '银行卡', note: '假期往返高铁票' },
  { date: '2026-10-05', clock: time(18, 22, 11), accountId: 'wb-debit', amount: 268.00, merchant: '外婆家', category: '餐饮', subcategory: '聚餐', channel: '银行卡', note: '家庭聚餐' },
  { date: '2026-10-21', clock: time(20, 18, 5), accountId: 'wb-debit', amount: 120.00, merchant: '上海影城', category: '娱乐', subcategory: '电影', channel: '银行卡', note: '电影票两张' }
];
for (const item of extraDailyEvents) {
  addEvent({
    date: item.date, time: item.clock, accountId: item.accountId,
    direction: 'expense', flowKind: 'consumption', amountCents: money(item.amount),
    merchant: item.merchant, counterparty: item.merchant,
    category: item.category, subcategory: item.subcategory,
    channel: item.channel, note: item.note
  });
}

addTransfer({
  date: '2026-10-04', time: time(10, 15, 28),
  fromAccountId: 'wb-debit', toAccountId: 'wb-life',
  amountCents: money(2000), flowKind: 'card_topup',
  merchant: '众微银行储蓄卡 · 生活卡', category: '转账',
  note: '假期前补充生活卡备付金'
});

/* 11. 保证流水截止到 as_of 当日，而不是只到前一天。 */
if (!events.some(event => event.date === AS_OF)) {
  addEvent({
    date: AS_OF, time: time(8, 26, 17), accountId: 'wb-debit',
    direction: 'expense', flowKind: 'consumption', amountCents: money(26),
    merchant: 'Manner Coffee', counterparty: 'Manner Coffee',
    category: '餐饮', subcategory: '咖啡', channel: '银行卡',
    note: '银行卡消费'
  });
}

/* ── 余额回放：opening + 全部已发生流水 = current ─── */

events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
const balances = new Map(accountDefs.map(account => [account.id, account.opening_balance_cents]));

for (const event of events) {
  const account = accountById.get(event.accountId);
  let effect;
  if (account.account_class === 'asset') {
    if (event.direction === 'income') effect = event.amountCents;
    else if (event.direction === 'expense') effect = -event.amountCents;
    else effect = event.leg === 'in' ? event.amountCents : -event.amountCents;
  } else if (account.account_class === 'liability') {
    if (event.direction === 'expense') effect = event.amountCents;
    else if (event.direction === 'transfer') effect = -event.amountCents;
    else throw new Error(`负债账户不支持 ${event.direction}：${event.id}`);
  } else {
    throw new Error(`容器账户不能记账：${event.accountId}`);
  }
  const nextBalance = balances.get(event.accountId) + effect;
  if (nextBalance < 0) {
    throw new Error(`账户 ${event.accountId} 在 ${event.occurredAt} 出现负余额：${nextBalance}`);
  }
  event.balanceEffectCents = effect;
  event.balanceAfterCents = nextBalance;
  balances.set(event.accountId, nextBalance);
}

for (const account of accountDefs) {
  const balance = balances.get(account.id);
  if (account.account_class === 'liability' && account.credit_limit_cents !== null && balance > account.credit_limit_cents) {
    throw new Error(`账户 ${account.id} 超出授信：${balance} > ${account.credit_limit_cents}`);
  }
}

/* ── 写库 ─────────────────────────────────────────── */

const metaRows = {
  schema_version: SCHEMA_VERSION,
  dataset_id: DATASET_ID,
  seed: String(SEED),
  as_of: AS_OF,
  as_of_end: AS_OF_END,
  history_start: HISTORY_START,
  history_end: AS_OF,
  history_days: '84',
  timezone: 'Asia/Shanghai',
  currency: 'CNY',
  amount_unit: 'cent',
  generated_at: GENERATED_AT,
  generator: 'scripts/seed-db.mjs',
  future_records: 'excluded',
  source_type: 'simulated',
  description: '众微银行为主账户，含微粒贷授信来源、信用卡与固定订阅代扣的历史流水；不含未来预期流水。',
  monthly_coverage: '2026-08,2026-09,2026-10'
};

function insertMeta(db) {
  const statement = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(metaRows)) statement.run(key, value);
}

function insertPlatforms(db) {
  const statement = db.prepare(`
    INSERT INTO platforms(id, name, category, code, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const platform of platforms) {
    statement.run(platform.id, platform.name, platform.category, platform.code, platform.sort_order, GENERATED_AT);
  }
}

function insertFinancialProducts(db) {
  const statement = db.prepare(`
    INSERT INTO financial_products(
      id, institution, name, product_type, risk_level, liquidity,
      rate_label, rate_value, rate_unit, min_amount, term, product_code, highlights,
      history_7d, history_1m, history_3m, history_6m, history_1y, history_ytd,
      fee_manage, fee_custody, fee_sales, scale_label, manager,
      est_annual_return, max_drawdown, invest_range, suitable_for,
      redemption_desc, calc_note,
      source_url, source_published, observed_at, note, source_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const product of financialProducts) {
    statement.run(
      product.id, product.institution, product.name, product.product_type,
      product.risk_level, product.liquidity, product.rate_label, product.rate_value,
      product.rate_unit, product.min_amount || null, product.term || null,
      product.product_code || null, product.highlights || null,
      product.history_7d || null, product.history_1m || null, product.history_3m || null,
      product.history_6m || null, product.history_1y || null, product.history_ytd || null,
      product.fee_manage || null, product.fee_custody || null, product.fee_sales || null,
      product.scale_label || null, product.manager || null,
      product.est_annual_return || null, product.max_drawdown || null,
      product.invest_range || null, product.suitable_for || null,
      product.redemption_desc || null, product.calc_note || null,
      product.source_url, product.source_published,
      product.observed_at, product.note, product.source_type
    );
  }
}

function insertAccounts(db) {
  const statement = db.prepare(`
    INSERT INTO accounts(
      id, parent_id, platform_id, name, account_type, account_class, currency,
      masked_number, card_network, is_primary, is_payable, status,
      credit_limit_cents, billing_day, due_day,
      opening_balance_cents, current_balance_cents, opened_on, closed_on,
      sort_order, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const account of accountDefs) {
    statement.run(
      account.id,
      account.parent_id,
      account.platform_id,
      account.name,
      account.account_type,
      account.account_class,
      account.currency,
      account.masked_number,
      account.card_network,
      account.is_primary,
      account.is_payable,
      account.status,
      account.credit_limit_cents,
      account.billing_day,
      account.due_day,
      account.opening_balance_cents,
      balances.get(account.id),
      account.opened_on,
      null,
      account.sort_order,
      JSON.stringify(account.metadata),
      GENERATED_AT
    );
  }
}

function insertSubscriptions(db) {
  const statement = db.prepare(`
    INSERT INTO subscriptions(
      id, merchant, product, category, service_account, amount_cents,
      billing_cycle, billing_day, payment_account_id, autopay_authorized,
      status, started_on, ended_on, last_charged_on, charge_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const subscription of subscriptions) {
    const charges = subscriptionCharges.get(subscription.id) || [];
    const lastChargedOn = charges.length
      ? charges.map(charge => charge.date).sort().at(-1)
      : null;
    statement.run(
      subscription.id,
      subscription.merchant,
      subscription.product,
      subscription.category,
      subscription.service_account,
      subscription.amount_cents,
      subscription.billing_cycle,
      subscription.billing_day,
      subscription.payment_account_id,
      subscription.autopay_authorized,
      subscription.status,
      subscription.started_on,
      null,
      lastChargedOn,
      charges.length,
      GENERATED_AT
    );
  }
}

function insertTransactions(db) {
  const statement = db.prepare(`
    INSERT INTO transactions(
      id, account_id, platform_id, occurred_at, direction, flow_kind,
      amount_cents, balance_effect_cents, balance_after_cents,
      merchant, counterparty, category, subcategory, channel, status,
      subscription_id, transfer_group_id, is_internal_transfer, note,
      source_type, is_simulated, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of events) {
    statement.run(
      event.id,
      event.accountId,
      accountById.get(event.accountId).platform_id,
      event.occurredAt,
      event.direction,
      event.flowKind,
      event.amountCents,
      event.balanceEffectCents,
      event.balanceAfterCents,
      event.merchant,
      event.counterparty,
      event.category,
      event.subcategory,
      event.channel,
      'booked',
      event.subscriptionId,
      event.transferGroupId,
      event.isInternalTransfer,
      event.note,
      'simulated',
      1,
      GENERATED_AT
    );
  }
}

function insertWealthHoldings(db) {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO wealth_holdings(id, user_id, product_id, product_name, amount_cents, purchased_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const holdings = [
    ['wh-u-lin-anyingxiang', 'u-lin', 'wp-anyingxiang', '信银理财 · 安盈象固收稳健封闭式592号', 5000000, '2026-09-12T09:30:00+08:00'],
    ['wh-u-lin-bond', 'u-lin', 'wp-yifangda-bond', '易方达 · 稳健收益债券 A', 2000000, '2026-08-21T10:15:00+08:00'],
    ['wh-u-lin-pension', 'u-lin', 'wp-guomin-pension', '国民养老 · 共同富裕专属商业养老保险', 1200000, '2026-07-05T14:20:00+08:00'],
    ['wh-u-shen-zhaorui', 'u-shen', 'wp-zhaorui', '招银理财 · 招睿添利 90 天持有', 3000000, '2026-09-02T11:00:00+08:00'],
    ['wh-u-gu-bond', 'u-gu', 'wp-guangfa-bond', '广发基金 · 纯债债券 A', 2500000, '2026-08-18T15:40:00+08:00']
  ];
  for (const row of holdings) {
    statement.run(row[0], row[1], row[2], row[3], row[4], row[5], row[5]);
  }
}

function seed(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    insertMeta(db);
    insertPlatforms(db);
    insertFinancialProducts(db);
    insertAccounts(db);
    insertSubscriptions(db);
    insertTransactions(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  ensureServiceTables(db);
  insertWealthHoldings(db);
  db.exec('ANALYZE;');
}

function nextDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

/* ── CLI ─────────────────────────────────────────── */

function parseArgs(argv) {
  const args = { db: DEFAULT_DB_PATH, json: false, verifyOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--verify-only') args.verifyOnly = true;
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

function printSummary(summary, digest, dbPath, { json, seeded }) {
  const payload = {
    ok: summary.integrity.ok,
    seeded,
    database: path.resolve(dbPath),
    digest,
    counts: summary.counts,
    period: summary.period,
    totals: summary.totals,
    monthlyActiveSubscriptionsYuan: summary.monthlyActiveSubscriptionsYuan,
    integrity: summary.integrity
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`${seeded ? '已重建' : '现有'}数据库：${path.resolve(dbPath)}`);
  console.log(`数据版本：${summary.meta.dataset_id} | seed=${summary.meta.seed} | as_of=${summary.meta.as_of}`);
  console.log(`流水：${summary.counts.transactions} 条 | ${summary.period.first_date} → ${summary.period.last_date} | ${summary.period.month_count} 个月`);
  console.log(`账户：${summary.counts.accounts}（容器 ${summary.counts.containers}）| 生效订阅：${summary.counts.activeSubscriptions} 个，月固定 ${summary.monthlyActiveSubscriptionsYuan} 元`);
  console.log(`资产：${summary.totals.assets_yuan} 元 | 负债：${summary.totals.liabilities_yuan} 元 | 净资产：${summary.totals.net_yuan} 元`);
  console.log(`校验：${summary.integrity.ok ? 'OK' : 'FAILED'}`);
  for (const check of summary.integrity.checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}`);
  }
  console.log(`内容指纹：${digest}`);
}

function printHelp() {
  console.log(`用法：
  node scripts/seed-db.mjs                 重建默认数据库
  node scripts/seed-db.mjs --verify-only   校验现有数据库，不写入
  node scripts/seed-db.mjs --json          输出 JSON
  node scripts/seed-db.mjs --db <path>     指定数据库路径
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error(`需要 Node.js 24+（当前 ${process.versions.node}）`);

  const dbPath = path.resolve(args.db);
  if (args.verifyOnly) {
    if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}，请先运行 npm run db:seed`);
    const db = openDatabase(dbPath, { readOnly: true });
    try {
      const summary = getDatabaseSummary(db, { databasePath: dbPath });
      printSummary(summary, contentDigest(db), dbPath, { json: args.json, seeded: false });
      if (!summary.integrity.ok) process.exitCode = 1;
    } finally {
      db.close();
    }
    return;
  }

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const tempPath = `${dbPath}.seed.tmp`;
  for (const file of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) rmSync(file, { force: true });

  let db;
  try {
    db = openDatabase(tempPath);
    initializeDatabase(db);
    seed(db);
    const validation = validateDatabase(db);
    if (!validation.ok) {
      throw new Error(`种子校验失败：${validation.issues.join('; ')}`);
    }
    const summary = getDatabaseSummary(db, { databasePath: dbPath });
    const digest = contentDigest(db);
    db.close();
    db = null;

    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(file, { force: true });
    renameSync(tempPath, dbPath);

    printSummary(summary, digest, dbPath, { json: args.json, seeded: true });
  } catch (error) {
    if (db) db.close();
    for (const file of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) rmSync(file, { force: true });
    throw error;
  }
}

main().catch(error => {
  console.error(`[seed-db] ${error.stack || error.message}`);
  process.exitCode = 1;
});
