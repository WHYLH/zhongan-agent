import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const serverSource = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const styleSource = ['styles/legacy-foundation.css', 'styles/obsidian.css', 'styles/flagship.css']
  .map(file => { try { return readFileSync(path.join(ROOT, file), 'utf8'); } catch { return ''; } })
  .join('\n');
const visualSource = html + '\n' + styleSource;
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

/* ── 页面骨架与脚本 ─────────────────────────────── */
check(html.includes('<html lang="zh-CN" data-theme="light" data-layout="desktop">'), '缺少中文 lang、默认浅色或桌面布局标记');
check(html.includes('<body data-mode="focus" data-view="agent">'), '默认模式不是 focus 或首页视图标记缺失');
check(html.includes('name="viewport"'), '缺少 viewport');
check(!/<script[^>]+src=/i.test(html), '出现外部 script src');
check((html.match(/<script>/g) || []).length === 2, '应包含主题预置脚本与主内联脚本');

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
for (const [index, script] of scripts.entries()) {
  try {
    new Function(script[1]);
  } catch (error) {
    failures.push('内联脚本语法错误（第 ' + (index + 1) + ' 段）：' + error.message);
  }
}

const externalUrls = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(m => m[0]);
check(externalUrls.length === 0, '发现外链：' + externalUrls.slice(0, 5).join(', '));

const staticHtml = html.slice(0, html.lastIndexOf("<script>"));
const ids = [...staticHtml.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
check(duplicates.length === 0, '重复 id：' + [...new Set(duplicates)].join(', '));

/* ── 首页：Agent、设置与银行功能入口 ─ */
for (const required of [
  'class="topbar"', 'data-settings-open',
  'id="homeFeatures"', 'class="home-hub"', '银行功能',
  'id="homeAccountsValue"', 'id="homeAssetsValue"', 'id="homeCashflowValue"',
  'id="homeLoansValue"', 'id="homeWealthValue"', 'id="homePaymentsValue"',
  'data-feature="accounts"', 'data-feature="assets"', 'data-feature="cashflow"',
  'data-feature="loans"', 'data-feature="wealth"', 'data-feature="payments"',
  'href="#/accounts"', 'href="#/assets"', 'href="#/cashflow"', 'href="#/loans"', 'href="#/wealth"', 'href="#/payments"',
  'id="agentConsole"', 'id="agentForm"', 'id="agentInput"', 'id="agentRun"',
  'id="chatTurns"', 'id="welcomeMsg"', 'class="welcome-title"',
  'data-mobile-nav="chat"', 'data-mobile-nav="features"', 'data-mobile-nav="settings"',
  'data-settings-page', 'renderSettingsPage',
  'id="onboardRoot"', 'data-ob-slide="0"', 'data-ob-slide="1"', 'data-ob-slide="2"',
  'data-ob-next', 'data-ob-prev', 'data-ob-dot', 'data-ob-skip',
  'data-help-open', '查看新手指引'
]) {
  check(html.includes(required), '缺少首页标记：' + required);
}
check(!html.includes('class="home-feature"') && !html.includes('class="home-features"'), '首页仍保留旧五入口卡片');
check(!html.includes('homeOverviewValue') && !html.includes('homeBillsValue') && !html.includes('homeSubsValue') && !html.includes('homeCardsValue') && !html.includes('homeTxValue'), '首页仍保留旧功能卡数据位');
check(html.includes('class="hub-page"') && html.includes('class="bank-entry-grid"'), '功能二级入口不完整');
check(html.includes('>快捷服务</span>') && html.includes('id="quickServices"'), '首页缺少快捷服务区');
check(html.includes('data-quick-service-add') && html.includes('renderQuickServices') && html.includes('upsertQuickService'), '快捷服务添加/渲染逻辑不完整');
check(!html.includes('服务索引'), '首页仍保留旧服务索引文案');
check(!html.includes('class="hub-ai-card"') && !html.includes('data-ai-prompt'), '功能页仍混入 AI 功能卡片');
const featureRouteMatch = html.match(/var FEATURE_ROUTES = \[([^\]]+)\]/);
const featureRoutes = featureRouteMatch ? [...featureRouteMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]) : [];
for (const route of ['features', 'accounts', 'assets', 'cashflow', 'loans', 'wealth', 'payments', 'settings', 'overview', 'bills', 'subscriptions', 'cards', 'transactions']) {
  check(featureRoutes.includes(route), 'FEATURE_ROUTES 缺少路由：' + route);
}
check(!html.includes('id="featureRail"') && !html.includes('id="railDetail"') && !html.includes('id="featureScrim"') && !html.includes('class="feature-rail"'), '仍保留右侧功能面板或功能抽屉');
check(!html.includes('id="pulse"') && !html.includes('id="pulsePayable"') && !html.includes('id="mobileStatus"'), '首页仍保留旧资金概览/状态条');
check(html.indexOf('id="homeFeatures"') < html.indexOf('id="agentConsole"'), '功能入口卡未排在 Agent 对话之前');
check(!html.slice(html.indexOf('id="agentConsole"'), html.indexOf('id="featureView"')).includes('data-feature='), '功能入口仍堆在对话内容里');
check((html.match(/data-ob-slide="/g) || []).length === 4, '新手指引不是 4 页');
check(!html.includes('data-agent-example'), '仍存在预设对话示例入口');
check(!html.includes('historyDrawer') && !html.includes('最近对话'), '仍保留最近对话/历史对话层级');

/* ── 六个独立功能页面与路由 ─────────────────────── */
for (const required of [
  'id="featureView"', 'id="featurePageTitle"',
  'id="featurePageBody"', 'data-page-back',
  'var FEATURE_META', 'var FEATURE_ROUTES', 'function loadFeaturePage', 'function navigateRoute',
  'function applyRoute', "window.addEventListener('hashchange', function () { applyRoute(); })",
  'history.replaceState', "document.body.setAttribute('data-view', 'feature')",
  "overview: {", "bills: {", "subscriptions: {", "cards: {", "transactions: {"
]) {
  check(html.includes(required), '缺少独立功能页面/路由标记：' + required);
}
check(html.indexOf('id="agentView"') !== -1 && html.indexOf('id="featureView"') > html.indexOf('id="agentView"'), '功能页面不是独立视图');
check(html.includes('id="featureView" hidden'), '功能页面初始未隐藏');
check(!html.includes('<aside'), '仍存在右侧叠加面板');
check((html.match(/data-page-back/g) || []).length >= 2, '页面返回键入口不足');

/* ── 新银行功能页：渲染函数、接口与账号快捷动作 ─── */
for (const fn of ['renderFeatureHub', 'renderAccountsPage', 'renderAssetsPage', 'renderCashflowPage', 'renderLoansPage', 'renderWealthPage', 'renderPaymentsPage']) {
  check(html.includes('function ' + fn), '缺少银行功能页渲染函数：' + fn);
}
for (const endpoint of [
  "fetchJson('/api/finance/summary')",
  "fetchJson('/api/finance/accounts')",
  "fetchJson('/api/finance/transactions?limit=",
  "fetchJson('/api/finance/monthly')",
  "fetchJson('/api/finance/products')",
  "'/api/finance/accounts/' + encodeURIComponent(accountId)"
]) {
  check(html.includes(endpoint), '银行功能页缺少接口调用：' + endpoint);
}
for (const label of ['查询明细', '转账汇款', '复制卡号', '账户挂失', '密码管理']) {
  check(html.includes(label), '账号页缺少快捷动作：' + label);
}
for (const key of ['accounts', 'assets', 'cashflow', 'loans', 'wealth', 'payments']) {
  check(html.includes("key === '" + key + "'"), '缺少银行功能页数据加载分支：' + key);
}

/* ── 设置：独立页，只保留可操作项 ───────────────── */
const settingsMarkup = html.slice(html.indexOf('function renderSettingsPage'), html.indexOf('function renderPaymentsPage'));
for (const required of ['主题', '竖屏预览', '页面说明', 'data-notes-toggle', 'data-portrait-toggle', '查看新手指引']) {
  check(settingsMarkup.includes(required), '设置缺少可操作项：' + required);
}
for (const forbidden of ['data-refresh-data', 'settingsAsOf', 'mode-desc', 'class="version"', '来自同源', '返回调用失败', '两种模式', '免责', '模拟', '离线', '边界', '存储', '风险说明']) {
  check(!settingsMarkup.includes(forbidden), '设置仍包含说明/冗余内容：' + forbidden);
}

/* ── 界面文案约束 ────────────────
   以下词汇不允许出现在界面文案中，改动界面时同步维护此清单。 */
const banned = [
  '模拟', '离线', '演示', '不接真实', '不连接真实', '仅保存在本机',
  '对话记录只保存在本机', '免责声明', '不代表品牌接入', '本地规则',
  '自动回退', '离线兜底', '统一模拟账本', '能力场景', '场景按钮',
  '个人消费完全安排', '品牌免责', '风险说明',
  '不可恢复', '确认删除', '如非本人', '体验资料', '体验环境',
  '未接入', '真实银行', '安全提示', '请谨慎', '风险提示', '仅供展示',
  '等待银行', '找回', '可解除挂失', '立即停止', '会校验支付密码',
  '用于敏感操作', '确认找回', '每位用户', '独立的资金档案'
];
for (const word of banned) {
  check(!html.includes(word), '主页仍残留冗余说明文案：' + word);
}
check(!/[?&]offline|source\s*===\s*['"]offline['"]/.test(html), '前端仍把离线作为正常来源');
check(html.includes('data-agent-retry'), 'Agent 失败态缺少重试入口');
check(html.includes('小安'), '缺少小安助手名称');
check(html.includes('直接说要查什么或要办什么。'), '对话区缺少直接操作入口');
check(html.includes('先查数据，再给计划'), '新手引导未说明查询优先');

/* ── 主题、布局、竖屏、模式与可访问性 ───────────── */
for (const required of [
  'fund-obsidian-theme-v1', 'THEME_COLORS', 'applyTheme',
  'data-theme-set="light"', 'data-theme-set="dark"',
  'fund-portrait-v1', 'data-portrait-toggle', 'body.portrait-preview .app',
  '@media (min-width:901px)', '竖屏预览',
  'data-mode-set="focus"', 'data-mode-set="daily"', "applyMode('focus')",
  'data-layout="desktop"', "setAttribute('data-layout'", 'html[data-layout="desktop"]', 'html[data-layout="mobile"]',
  'id="toast"', 'aria-live', 'role="dialog"', 'aria-modal="true"'
]) {
  check(visualSource.includes(required), '缺少主题/布局/模式标记：' + required);
}
check(!html.includes('fund-mode-v1') && !html.includes('STORE.mode'), '模式不应写入持久化存储');
check(!html.includes('data-theme-toggle') && !html.includes('toggleTheme'), '顶部仍有重复主题按钮');
check(visualSource.includes('font-size:15px'), '正文字号未达到 15px');
check(/@media\s*\(max-width:380px\)/.test(visualSource), '缺少窄屏断点');
check(/@media\s*\(prefers-reduced-motion:reduce\)/.test(visualSource), '缺少 reduced-motion 支持');

/* ── 数据接口与 Agent 工具 ──────────────────────── */
for (const required of [
  'id="agentConsole"', 'fetchJson', '/api/overview', '/api/agent',
  'window.__FUND_APP__', 'openFeature', 'query-status', 'plan-actions'
]) {
  check(html.includes(required), '缺少数据/前端实现标记：' + required);
}

for (const endpoint of ['/api/overview', '/api/profile', '/api/bills', '/api/cards', '/api/subscriptions', '/api/transactions']) {
  check(serverSource.includes("'" + endpoint + "'"), 'server.mjs 缺少接口：' + endpoint);
}
for (const endpoint of ['/api/bank/users', '/api/bank/credentials', '/api/bank/transfer', '/api/bank/password', '/api/bank/loss-report', '/api/bank/audit', '/api/bank/notifications', '/api/loans/recommend']) {
  check(serverSource.includes(endpoint), 'server.mjs 缺少桌面银行服务接口：' + endpoint);
}
for (const marker of ['LOAN_RECOMMEND_SYSTEM', 'loanTemplateRecommend', 'data-answer-group', '生成智能推荐']) {
  check(html.includes(marker) || serverSource.includes(marker), '缺少 AI 推荐模板/问题选项标记：' + marker);
}
for (const fn of ['executeTransfer', 'changeCardPassword', 'reportLoss', 'releaseLoss', 'ensureServiceTables']) {
  check(serverSource.includes(fn), 'server.mjs 缺少服务函数调用：' + fn);
}
for (const marker of ['id="welcomeRoot"', 'id="bankDialogRoot"', 'data-welcome-view', 'id="agentFab"', 'id="fabChatRoot"', 'data-speech-target', 'webkitSpeechRecognition', "setupSpeech($('#agentMic')", 'speechSynthesis', 'attachSpeech']) {
  check(html.includes(marker), '前端缺少悬浮对话/语音识别/朗读标记：' + marker);
}
for (const removed of ['id="userSelectRoot"', 'data-user-pick', 'data-user-switch', '每位用户', '独立的资金档案', '评估规则']) {
  check(!html.includes(removed), '不应出现多用户选择入口或其说明文案：' + removed);
}
for (const marker of ['loan-eval-ring', 'loanEvalNum', 'setupFabDrag', 'fund-fab-pos-v1']) {
  check(html.includes(marker), '缺少智能评估动画/悬浮球拖动标记：' + marker);
}
for (const removed of ["['branch', '网', '开户网点']", "['messenger', '信', '信使']", "['invest', '财', '投资理财']", "acctMenuRow('开户网点'", "acctMenuRow('信使'", "acctMenuRow('投资理财'"]) {
  check(!html.includes(removed), '账户详情仍残留已删除卡入口：' + removed);
}
check(html.includes('bankTransferDialog') && html.includes('bankPasswordDialog') && html.includes('bankFreezeDialog'), '前端缺少银行服务对话框实现');
check(html.includes("['transfer', '转', '转账汇款']") && html.includes("['freeze', '挂', '账户挂失']") && html.includes("['password', '密', '密码管理']") && html.includes("['copy', '复', '复制卡号']"), '快捷动作定义不完整');
for (const fn of ['TOOL_DEFS', 'get_profile', 'get_bills', 'get_cards', 'get_subscriptions', 'get_transactions', 'planWithAI', 'parsePlan']) {
  check(serverSource.includes(fn), 'server.mjs 缺少 Agent 工具实现：' + fn);
}
check(serverSource.includes("source: 'ai'"), 'server.mjs 未返回 AI 来源');
check(serverSource.includes('AI_NOT_CONFIGURED'), 'server.mjs 未区分未配置状态');
check(serverSource.includes('retryable: true'), 'server.mjs 失败响应不可重试');
for (const word of ["source: 'offline'", 'offline-fallback', 'local-rules', 'simulationOnly']) {
  check(!serverSource.includes(word), 'server.mjs 仍保留离线兜底：' + word);
}
check(!serverSource.includes('模拟') && !serverSource.includes('免责'), 'server.mjs 仍返回模拟/免责文案');

/* ── 实测 ───────────────────────────────────────── */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function request(base, pathname, options) {
  const response = await fetch(base + pathname, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { response, text, body };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 1200);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function startServer(extraEnv) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', FUND_AI_CONFIG_DISABLE: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const health = await request(base, '/api/health');
      if (health.response.ok) { ready = true; break; }
    } catch { /* 等待启动 */ }
    await delay(100);
  }
  return { child, base, ready, logs: () => ({ stdout, stderr }) };
}

async function checkDataApi() {
  const server = await startServer({ ARK_API_KEY: '', DEEPSEEK_API_KEY: '' });
  try {
    if (!server.ready) {
      failures.push('数据接口测试服务未启动');
      return;
    }
    const base = server.base;
    const financeSummary = await request(base, '/api/finance/summary');
    check(financeSummary.response.status === 200 && financeSummary.body && financeSummary.body.source === 'sqlite', 'SQLite 汇总接口未返回 source=sqlite');
    check(financeSummary.body && financeSummary.body.counts && financeSummary.body.counts.transactions >= 150, 'SQLite 流水数量不足三个月');
    check(financeSummary.body && financeSummary.body.meta && financeSummary.body.meta.as_of === '2026-10-23', 'SQLite 截止日不正确');
    const financeAccounts = await request(base, '/api/finance/accounts');
    check(financeAccounts.response.status === 200 && financeAccounts.body && Array.isArray(financeAccounts.body.roots), 'SQLite 账户树接口不可用');
    check(financeAccounts.body && financeAccounts.body.roots.some(row => row.name === '众微银行'), 'SQLite 账户树缺少众微银行');
    const financeTransactions = await request(base, '/api/finance/transactions?platform=众微银行&direction=expense&from=2026-08-01&to=2026-08-31&limit=5');
    check(financeTransactions.response.status === 200 && financeTransactions.body && financeTransactions.body.source === 'sqlite', 'SQLite 流水筛选接口不可用');
    check(financeTransactions.body && financeTransactions.body.filters.direction === 'expense', 'SQLite 流水方向筛选未生效');
    check(financeTransactions.body && financeTransactions.body.items.every(row => row.platform_name === '众微银行' && row.direction === 'expense'), 'SQLite 平台/方向筛选结果不一致');
    const financeMonthly = await request(base, '/api/finance/monthly?from=2026-07-01&to=2026-10-23');
    check(financeMonthly.response.status === 200 && financeMonthly.body && financeMonthly.body.items && financeMonthly.body.items.some(row => row.month === '2026-08'), 'SQLite 月度汇总缺少历史月份');
    const financeSubscriptions = await request(base, '/api/finance/subscriptions');
    const subItems = (financeSubscriptions.body && financeSubscriptions.body.items) || [];
    const expectedMonthly = Math.round(subItems
      .filter(row => row.status === 'active' && row.billing_cycle === 'monthly')
      .reduce((sum, row) => sum + Number(row.amount_yuan || 0), 0) * 100) / 100;
    check(financeSubscriptions.response.status === 200 && financeSubscriptions.body && financeSubscriptions.body.monthlyActive === expectedMonthly && expectedMonthly > 0, 'SQLite 固定订阅月费与生效明细不一致');
    const health = await request(base, '/api/health');
    check(health.response.status === 200 && health.body && health.body.ok === true, 'GET /api/health 未返回 200');
    check(health.body && health.body.ai && health.body.ai.configured === false, '无 Key 时 health 仍显示已配置');
    check(health.body && health.body.ai && health.body.ai.status === 'unconfigured', 'health 未标记 unconfigured');
    check(health.body && health.body.ai && Array.isArray(health.body.ai.tools) && health.body.ai.tools.length === 5, 'health 未列出 5 个 Agent 工具');
    check(health.body && health.body.endpoints && health.body.endpoints.overview === '/api/overview', 'health 未暴露 overview');
    check(health.body && health.body.endpoints && health.body.endpoints.transactions === '/api/transactions', 'health 未暴露 transactions');
    check((health.response.headers.get('cache-control') || '').includes('no-store'), 'health 缺少 no-store');

    const overviewResult = await request(base, '/api/overview');
    const overview = overviewResult.body;
    check(overviewResult.response.status === 200 && overview && overview.ok === true, 'GET /api/overview 未返回 200');
    check((overviewResult.response.headers.get('content-type') || '').includes('application/json'), 'overview 不是 JSON');
    check((overviewResult.response.headers.get('cache-control') || '').includes('no-store'), 'overview 缺少 no-store');

    const summary = overview && overview.summary ? overview.summary : {};
    const expected = {
      totalAssets: 95800,
      totalDebt: 12000,
      netWorth: 83800,
      payable: 10800,
      blocked: 0
    };
    for (const [key, value] of Object.entries(expected)) {
      check(summary[key] === value, 'overview.summary.' + key + ' 不等于 ' + value);
    }
    const accounts = Array.isArray(overview && overview.accounts) ? overview.accounts : [];
    check(accounts.length === 6, 'overview 账户数量不是 6');
    check(accounts.reduce((sum, row) => sum + Number(row.amount), 0) === 95800, '账户合计不是 95,800');
    check(accounts.filter(row => row.payable).reduce((sum, row) => sum + Number(row.amount), 0) === 10800, '可支付账户合计不是 10,800');
    check(!overview || !('disclaimer' in overview), 'overview 仍携带免责声明字段');
    check(!overview || overview.mode !== 'simulation', 'overview 仍声明 simulation');
    check(overview && overview.profile && overview.profile.window && overview.profile.window.start === '2026-08-01', 'overview 历史窗口不正确');
    check(overview && overview.counts && overview.counts.bills === 0 && overview.counts.subscriptions === 8 && overview.counts.cards === 3 && overview.counts.transactions === 10, 'overview 计数不一致');
    check(overview && overview.totals && overview.totals.bills === 0, 'overview 不应含未来账单合计');
    check(overview && overview.totals && overview.totals.subscriptionMonthly === 434, 'overview 订阅月度支出不是 434');
    check(overview && overview.totals && overview.totals.cardAvailable === 22720, 'overview 信用卡可用合计不是 22,720');

    const profile = await request(base, '/api/profile');
    check(profile.body && profile.body.profile && profile.body.profile.id === 'steady', 'GET /api/profile 档案 id 不一致');
    check(profile.body && profile.body.accounts && profile.body.accounts.length === 6, 'GET /api/profile 账户缺失');
    check(profile.body && profile.body.debts && profile.body.debts.length === 3, 'GET /api/profile 负债缺失');
    check(profile.body && profile.body.debts.reduce((sum, row) => sum + row.outstanding, 0) === 12000, '负债合计不是 12,000');

    const bills = await request(base, '/api/bills');
    check(bills.body && bills.body.kind === 'historical_bill_analysis', 'GET /api/bills 未返回历史账单分析');
    check(bills.body && bills.body.count > 0, 'GET /api/bills 历史流水不足');
    check(bills.body && Array.isArray(bills.body.monthly) && bills.body.monthly.length === 3, '账单缺少三个月汇总');
    check(bills.body && Array.isArray(bills.body.categories) && bills.body.categories.length > 0, '账单缺少分类统计');

    const cards = await request(base, '/api/cards');
    check(cards.body && cards.body.items && cards.body.items.length === 3, 'GET /api/cards 不是 3 张');
    check(cards.body && cards.body.creditAvailable === 22720, 'GET /api/cards 可用额度不是 22,720');
    check(cards.body && cards.body.items.some(row => row.kind === '信用卡' && row.tail === '4021'), '卡片缺少尾号 4021');

    const subscriptions = await request(base, '/api/subscriptions');
    check(subscriptions.body && subscriptions.body.items && subscriptions.body.items.length === 8, 'GET /api/subscriptions 不是 8 项');
    check(subscriptions.body && subscriptions.body.monthlyActive === 434, 'GET /api/subscriptions 月度支出不是 434');

    const transactions = await request(base, '/api/transactions');
    check(transactions.body && transactions.body.items && transactions.body.items.length === 10, 'GET /api/transactions 不是 10 笔');
    const food = await request(base, '/api/transactions?category=' + encodeURIComponent('餐饮'));
    check(food.body && food.body.total === 3, '餐饮交易筛选结果不是 3 笔');
    const limited = await request(base, '/api/transactions?limit=4');
    check(limited.body && limited.body.items.length === 4, '交易 limit 未生效');

    const head = await fetch(base + '/api/bills', { method: 'HEAD' });
    check(head.status === 200, 'HEAD /api/bills 不是 200');
    check((await head.text()) === '', 'HEAD /api/bills 不应返回响应体');
    const post = await fetch(base + '/api/bills', { method: 'POST' });
    check(post.status === 405, 'POST /api/bills 应返回 405');

    const missing = await request(base, '/api/not-found');
    check(missing.response.status === 404 && missing.body && missing.body.error && missing.body.error.code === 'NOT_FOUND', '未知 API 路径未返回结构化 404');

    const agentInfo = await request(base, '/api/agent');
    check(agentInfo.body && agentInfo.body.method === 'POST', 'GET /api/agent 未说明 POST 用法');
    check(agentInfo.body && Array.isArray(agentInfo.body.tools) && agentInfo.body.tools.length === 5, 'GET /api/agent 未列出 5 个查询工具');
    check(agentInfo.body && agentInfo.body.configured === false, 'GET /api/agent 未反映未配置状态');

    const noKey = await request(base, '/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '帮我看看这个月的资金安排' })
    });
    check(noKey.response.status === 503, '无 Key 时 POST /api/agent 不是 503');
    check(noKey.body && noKey.body.ok === false, '无 Key 时 Agent 未返回失败');
    check(noKey.body && noKey.body.error && noKey.body.error.code === 'AI_NOT_CONFIGURED', '无 Key 时错误码不是 AI_NOT_CONFIGURED');
    check(noKey.body && noKey.body.error && noKey.body.error.retryable === true, '无 Key 失败不可重试');
    check(!noKey.body || noKey.body.plan === undefined, '无 Key 时仍返回计划');

    const empty = await request(base, '/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' })
    });
    check(empty.response.status === 400, '空目标应返回 400');
  } catch (error) {
    failures.push('数据接口实测失败：' + error.message);
    const logs = server.logs();
    if (logs.stderr.trim()) console.error('[server stderr] ' + logs.stderr.trim());
  } finally {
    await stopChild(server.child);
  }
}

async function checkAiToolPath() {
  const mockPort = await getFreePort();
  let calls = 0;
  let toolsLength = 0;
  let toolMessageCount = 0;
  let systemPrompt = '';
  let toolText = '';
  let mode = 'ok';
  const mock = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* 忽略 */ }
      calls += 1;
      if (mode === 'fail') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('upstream unavailable');
        return;
      }
      const messages = body && Array.isArray(body.messages) ? body.messages : [];
      const toolMessages = messages.filter(message => message.role === 'tool');
      if (!toolMessages.length) {
        toolsLength = Array.isArray(body && body.tools) ? body.tools.length : 0;
        systemPrompt = messages.filter(message => message.role === 'system').map(message => String(message.content || '')).join('\n');
        const names = ['get_profile', 'get_bills', 'get_cards', 'get_subscriptions', 'get_transactions'];
        const content = {
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: names.map((name, index) => ({
                id: 'call_' + index,
                type: 'function',
                function: {
                  name,
                  arguments: name === 'get_transactions' ? '{"limit":30}' : '{}'
                }
              }))
            }
          }]
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(content));
        return;
      }
      toolMessageCount = toolMessages.length;
      toolText = toolMessages.map(message => String(message.content || '')).join('\n');
      const plan = {
        summary: '已核对档案：可支付 10,800 元，发薪前缺口 436 元。',
        risk: '11 月 1 日前有三笔自动扣款，需要优先预留。',
        actions: [
          { title: '先补足 436 元缺口', detail: '从定期存款转入工资卡 436 元，确保 11 月 1 日房租正常扣款。', amount: 436, type: 'transfer' },
          { title: '复核两笔订阅', detail: '10 月 27 日爱奇艺 39 元、10 月 29 日 Keep 199 元，如不再使用可在扣费前取消。', amount: 238, type: 'subscription' }
        ]
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }));
    });
  });
  await new Promise((resolve, reject) => {
    mock.once('error', reject);
    mock.listen(mockPort, '127.0.0.1', resolve);
  });

  const server = await startServer({
    ARK_BASE_URL: 'http://127.0.0.1:' + mockPort,
    ARK_API_KEY: 'check-key',
    ARK_MODEL: 'check-model'
  });
  try {
    if (!server.ready) {
      failures.push('AI 工具链路测试服务未启动');
      return;
    }
    const health = await request(server.base, '/api/health');
    check(health.body && health.body.ai && health.body.ai.configured === true, '配置 Key 后 health 未显示已配置');
    check(health.body && health.body.ai && health.body.ai.model === 'check-model', 'health 未显示测试模型');

    const result = await request(server.base, '/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '发薪前这 13 天，怎么安排才不会逾期？' })
    });
    check(result.response.status === 200, 'AI 模式 POST /api/agent 非 200');
    check(result.body && result.body.ok === true && result.body.source === 'ai', 'AI 模式未返回 source=ai');
    check(result.body && result.body.provider === 'check-model', 'AI 模式未显示实际模型');
    check(calls >= 2, 'Agent 没有先调用工具再生成计划');
    check(toolsLength === 5, '模型请求未携带 5 个查询工具');
    check(toolMessageCount === 5, '工具结果未全部回传模型');
    check(toolText.includes('众微银行') && toolText.includes('微粒贷') && toolText.includes('爱奇艺') && toolText.includes('盒马鲜生'), '工具结果缺少账户/账单/订阅/交易数据');
    check(systemPrompt.includes('必须调用') && systemPrompt.includes('get_profile') && systemPrompt.includes('get_transactions'), '系统提示未要求先查询数据');
    check(!systemPrompt.includes('爱奇艺') && !systemPrompt.includes('436'), '系统提示写入预设场景或答案');
    const queries = result.body && Array.isArray(result.body.queries) ? result.body.queries : [];
    check(queries.length === 5, '响应 queries 不是 5 项');
    check(['get_profile', 'get_bills', 'get_cards', 'get_subscriptions', 'get_transactions'].every(name => queries.some(query => query.tool === name)), '响应 queries 未覆盖全部工具');
    check(result.body && result.body.plan && result.body.plan.actions && result.body.plan.actions.length === 2, 'AI 计划动作数量不正确');
    check(result.body && result.body.plan.actions[0].amount === 436, 'AI 计划金额未按工具结果保留');
    check(result.body && result.body.plan.summary.includes('10,800'), 'AI 计划未基于查询结果生成');

    mode = 'fail';
    const failed = await request(server.base, '/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '再给我一个计划' })
    });
    check(failed.response.status === 502, '上游失败时 Agent 不是 502');
    check(failed.body && failed.body.ok === false && failed.body.error && failed.body.error.retryable === true, '上游失败未返回可重试错误');
    check(failed.body && failed.body.error && failed.body.error.code === 'AI_UPSTREAM_ERROR', '上游失败错误码不正确');
    check(!failed.body || failed.body.plan === undefined, '上游失败时仍返回计划');
  } catch (error) {
    failures.push('AI 工具链路实测失败：' + error.message);
    const logs = server.logs();
    if (logs.stderr.trim()) console.error('[server stderr] ' + logs.stderr.trim());
  } finally {
    await stopChild(server.child);
    mock.close();
  }
}

async function checkBankApi() {
  const { copyFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fund-bank-check-'));
  const tempDb = path.join(tmpDir, 'finance.sqlite');
  copyFileSync(path.join(ROOT, 'data', 'finance.sqlite'), tempDb);
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const setup = new DatabaseSync(tempDb);
    setup.prepare("DELETE FROM meta WHERE key IN ('ai_base_url','ai_api_key','ai_model','tts_api_key','tts_voice','tts_model')").run();
    setup.close();
  } catch (error) { /* 临时库清理失败不影响后续检查 */ }
  const server = await startServer({ FUND_DB_PATH: tempDb, ARK_API_KEY: '', DEEPSEEK_API_KEY: '' });
  try {
    if (!server.ready) {
      failures.push('银行服务测试服务未启动');
      return;
    }
    const base = server.base;
    const users = await request(base, '/api/bank/users');
    check(users.response.status === 200 && users.body && users.body.items.length === 3, '银行服务用户列表应包含 3 位用户');
    const overview = await request(base, '/api/bank/users/u-lin/overview');
    check(overview.response.status === 200 && overview.body && overview.body.user.displayName === '林予安', '用户概览返回主用户');
    check(overview.body && overview.body.cards.some(card => card.cardNumber && card.password === '123456'), '用户概览应包含卡号与默认密码');
    const summaryUShen = await request(base, '/api/finance/summary?user=u-shen');
    check(summaryUShen.response.status === 200 && summaryUShen.body && summaryUShen.body.totals.assets_yuan === '45000.00', '第二用户全量账户资产应为 45000（含持仓）');
    check(summaryUShen.body && summaryUShen.body.totals.liabilities_yuan === '5000.00', '第二用户负债应为微粒贷 5000');
    const directory = await request(base, '/api/bank/directory?user=u-lin');
    check(directory.response.status === 200 && directory.body && directory.body.items.length === 2, '转账目录应包含另外 2 位用户');
    check(directory.body && directory.body.items.every(item => item.cards.length === 2), '目录中每位用户应展示 2 张银行卡');
    const summaryULin = await request(base, '/api/finance/summary?user=u-lin');
    const beforeAssets = Number(summaryULin.body.totals.assets_yuan);
    const summaryAll = await request(base, '/api/finance/summary');
    check(summaryAll.body && Number(summaryAll.body.totals.assets_yuan) > beforeAssets, '全量汇总应大于单用户汇总');

    const badPassword = await request(base, '/api/bank/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-lin', fromAccountId: 'wb-debit', counterparty: '测试收款人', amount: 10, password: '000000' }) });
    check(badPassword.response.status === 400, '支付密码错误时转账应被拒绝');
    const overAmount = await request(base, '/api/bank/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-lin', fromAccountId: 'wb-debit', counterparty: '测试收款人', amount: 9999999, password: '123456' }) });
    check(overAmount.response.status === 400, '超过单笔上限的转账应被拒绝');
    const transfer = await request(base, '/api/bank/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-lin', fromAccountId: 'wb-debit', counterparty: '测试收款人', amount: 66.5, password: '123456', note: '检查转账' }) });
    check(transfer.response.status === 200 && transfer.body && transfer.body.transfer && transfer.body.transfer.amountYuan === '66.50', '转账应成功并返回回执');
    const afterTransfer = await request(base, '/api/finance/summary?user=u-lin');
    check(Math.abs(Number(afterTransfer.body.totals.assets_yuan) - (beforeAssets - 66.5)) < 0.001, '转账后用户总资产应同步减少');
    const invalidAmount = await request(base, '/api/bank/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-lin', fromAccountId: 'wb-debit', counterparty: '测试收款人', amount: -5, password: '123456' }) });
    check(invalidAmount.response.status === 400, '负数金额转账应被拒绝');

    const password = await request(base, '/api/bank/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-lin', accountId: 'wb-debit', oldPassword: '123456', newPassword: '654321' }) });
    check(password.response.status === 200 && password.body && password.body.password === '654321', '密码修改应成功');
    const wrongOld = await request(base, '/api/bank/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-lin', accountId: 'wb-debit', oldPassword: '123456', newPassword: '111111' }) });
    check(wrongOld.response.status === 400, '原密码错误时修改应被拒绝');
    const transferWithNew = await request(base, '/api/bank/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-lin', fromAccountId: 'wb-debit', counterparty: '测试收款人', amount: 1, password: '654321' }) });
    check(transferWithNew.response.status === 200, '新密码应立即用于转账校验');

    const loss = await request(base, '/api/bank/loss-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-lin', accountId: 'wb-debit', reason: '检查挂失' }) });
    check(loss.response.status === 200, '挂失应成功');
    const frozenAccount = await request(base, '/api/finance/accounts/wb-debit?user=u-lin');
    check(frozenAccount.body && frozenAccount.body.account.status === 'frozen', '挂失后账户状态应为 frozen');
    const transferFrozen = await request(base, '/api/bank/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-lin', fromAccountId: 'wb-debit', counterparty: '测试收款人', amount: 1, password: '654321' }) });
    check(transferFrozen.response.status === 400, '挂失账户转账应被拒绝');
    const release = await request(base, '/api/bank/loss-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-lin', accountId: 'wb-debit', action: 'release' }) });
    check(release.response.status === 200, '解除挂失应成功');
    const restoredAccount = await request(base, '/api/finance/accounts/wb-debit?user=u-lin');
    check(restoredAccount.body && restoredAccount.body.account.status === 'active', '解挂后账户状态应恢复 active');

    const shenBefore = await request(base, '/api/bank/users/u-shen/overview');
    const crossUser = await request(base, '/api/bank/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-lin', fromAccountId: 'wb-debit', toAccountId: 'ys-debit', amount: 30, password: '654321' }) });
    check(crossUser.response.status === 200 && crossUser.body && crossUser.body.transfer.to.ownerName === '沈知微', '跨用户转账回执应包含收款方用户名');
    const shenAfter = await request(base, '/api/bank/users/u-shen/overview');
    check(Math.abs(Number(shenAfter.body.totals.assets_yuan) - (Number(shenBefore.body.totals.assets_yuan) + 30)) < 0.001, '跨用户转账后收款方资产应实时增加');
    const shenNotifications = await request(base, '/api/bank/notifications?user=u-shen');
    check(shenNotifications.body && shenNotifications.body.items.some(item => item.title === '收到转账'), '收款方应收到转账通知');

    const audit = await request(base, '/api/bank/audit?user=u-lin');
    check(audit.response.status === 200 && audit.body.items.length >= 5, '审计日志应记录服务操作');
    const notifications = await request(base, '/api/bank/notifications?user=u-lin');
    check(notifications.response.status === 200 && notifications.body.items.length >= 3, '服务通知应生成');
  } finally {
    await stopChild(server.child);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不阻塞 */ }
  }
}

await checkDataApi();
await checkBankApi();
await checkAiToolPath();

if (failures.length) {
  console.error('检查失败：');
  for (const message of failures) console.error(' - ' + message);
  process.exit(1);
}

console.log('静态检查通过：默认专注与浅色、清爽 Agent 对话、六大银行功能入口、独立银行页面与 hash 路由、账号下钻快捷动作、旧路由兼容、返回 Agent、竖屏底部导航、极简设置、无离线兜底与冗余说明、AI 失败重试。');
console.log('接口实测通过：overview/profile/bills/cards/subscriptions/transactions 数据一致，HEAD/405/404/400/503 行为正确；mock 模型先调用 5 个工具再生成计划，上游失败返回可重试 502；银行服务（用户/凭据/转账/密码/挂失/审计）在临时库上全链路验证。');
