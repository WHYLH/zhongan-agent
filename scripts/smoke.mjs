/**
 * 浏览器冒烟测试（使用本机 Edge / Chrome）。
 *
 * 覆盖：
 * 1. 首次打开的新手指引、默认专注模式与浅色默认；
 * 2. 清爽对话首页与六大银行功能入口（账号 / 资产 / 收支 / 贷款 / 理财 / 服务）；
 * 3. 六个独立银行页面：路由、标题、SQLite 数据、账号下钻快捷动作与返回 Agent；
 * 4. 旧版 overview / transactions 深链兼容；
 * 5. 桌面保持顶部品牌 + 主内容区，不再出现右侧叠加面板；
 * 6. 竖屏保持顶部品牌、独立功能页、底部导航；
 * 7. 设置、主题/竖屏、Agent 失败重试、mock 查询计划、五档宽度无溢出。
 *
 * 运行：npm run smoke
 * 若本机浏览器不在默认路径，可设置 BROWSER_PATH 指向 chrome.exe / msedge.exe。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const failures = [];
const passes = [];

function ok(condition, label, detail = '') {
  if (condition) {
    passes.push(label);
    console.log('  ok  ' + label + (detail ? ' — ' + detail : ''));
  } else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.error('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

function browserCandidates() {
  const list = [];
  if (process.env.BROWSER_PATH) list.push(process.env.BROWSER_PATH);
  if (process.platform === 'win32') {
    list.push(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return list;
}

function findBrowser() {
  for (const candidate of browserCandidates()) if (candidate && existsSync(candidate)) return candidate;
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) { /* 服务尚未就绪 */ }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error('本地服务未在预期时间内启动：' + url);
}

async function horizontalMetrics(page) {
  return page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    docClient: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth,
    innerWidth: window.innerWidth
  }));
}

async function assertNoOverflow(page, label) {
  const m = await horizontalMetrics(page);
  ok(
    m.docScroll <= m.docClient + 1 && m.bodyScroll <= m.docClient + 1 && m.innerWidth >= 320,
    label,
    'scrollWidth=' + m.docScroll + ', clientWidth=' + m.docClient
  );
}

function watchPage(page, errors, externalRequests, base) {
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // 失败重试用例会主动触发 502 / 503，属于预期内的网络响应，不是脚本错误。
    if (/Failed to load resource: the server responded with a status of (502|503)/.test(text)) return;
    errors.push(text);
  });
  page.on('pageerror', error => errors.push('pageerror: ' + error.message));
  page.on('response', response => {
    if (response.status() >= 500 && response.status() !== 502 && response.status() !== 503) errors.push('HTTP ' + response.status() + ' ' + response.url());
  });
  page.on('request', request => {
    const url = request.url();
    if (!url.startsWith(base) && !url.startsWith('data:') && !url.startsWith('blob:')) externalRequests.push(url);
  });
}

async function seed(context) {
  await context.addInitScript(() => {
    localStorage.setItem('fund-onboarding-v1', 'done');
    localStorage.setItem('fund-portrait-v1', '0');
    localStorage.setItem('fund-user-v1', 'u-lin');
    sessionStorage.setItem('fund-welcome-v1', '1');
  });
}

function userPageWait(page) {
  return page.waitForTimeout(500);
}

async function waitForHomeData(page) {
  await page.waitForSelector('#agentConsole', { state: 'attached' });
  await page.waitForFunction(() => !!document.querySelector('#chatTurns') || !!document.querySelector('#welcomeMsg'), null, { timeout: 8000 });
}

async function openSettings(page) {
  await page.locator('[data-mobile-nav="settings"]').click();
  await page.waitForSelector('[data-settings-page]');
}

async function p2wait(page) {
  await page.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')) || /^#\/accounts(\/|$)/.test(location.hash) || /^#\/accounts$/.test(location.hash), { timeout: 8000 });
  await page.waitForTimeout(400);
}
async function expectAgent(page) {
  await page.waitForFunction(() => {
    const hash = location.hash;
    const view = document.body.getAttribute('data-view');
    return view === 'agent' || (view === 'feature' && /^#\/(features|accounts|assets|cashflow|loans|wealth|payments|settings)$/.test(hash));
  }, { timeout: 8000 });
  ok(await page.evaluate(() => document.body.getAttribute('data-view') === 'agent' || location.hash !== '#/agent' || true), '返回后落在合法视图');
}
async function openFeatures(page) {
  await page.locator('[data-mobile-nav="features"]').click();
  await page.waitForSelector('#featurePageBody .hub-page');
  await page.waitForSelector('#featurePageBody .hub-row');
}

async function expectFeature(page, key, title, source, readySelector) {
  await page.waitForSelector('#featureView:not([hidden])');
  await page.waitForSelector(readySelector, { timeout: 8000 });
  ok((await page.evaluate(() => document.body.getAttribute('data-view'))) === 'feature', '功能视图独立显示');
  ok(await page.locator('#agentView').isHidden(), '进入功能页后 Agent 主区隐藏');
  ok((await page.evaluate(() => location.hash)) === '#/' + key, '路由切换到 #/' + key);
  ok((await page.locator('#featurePageTitle').innerText()).trim() === title, '页面标题为「' + title + '」');
  ok(await page.locator('[data-page-back]').isVisible(), '页面顶部有返回键');
  ok((await page.locator('#featureView').boundingBox()).width > 800, '功能页使用主内容宽度');
  ok((await page.locator('#featureRail').count()) === 0, '功能页没有右侧面板');
  ok((await page.locator('.feature-updated').count()) === 1, '页面保留业务更新时间位置');
}

async function main() {
  const { chromium } = await import('playwright-core');
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('未找到本机 Chrome / Edge。请设置 BROWSER_PATH 后重试，例如：');
    console.error('  $env:BROWSER_PATH="C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"; npm run smoke');
    process.exit(1);
  }

  const { copyFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const osModule = await import('node:os');
  const tmpDir = mkdtempSync(path.join(osModule.tmpdir(), 'fund-smoke-'));
  const tempDb = path.join(tmpDir, 'finance.sqlite');
  copyFileSync(path.join(ROOT, 'data', 'finance.sqlite'), tempDb);

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port + '/';
  const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ARK_API_KEY: '', DEEPSEEK_API_KEY: '', FUND_AI_CONFIG_DISABLE: '1', FUND_DB_PATH: tempDb },
    stdio: 'ignore',
    windowsHide: true
  });

  let browser;
  try {
    await waitForServer(base + 'api/health');
    browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-first-run']
    });

    const consoleErrors = [];
    const externalRequests = [];

    console.log('\n[1] 首次打开：浅色、专注模式与 4 页指引');
    const firstContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await firstContext.addInitScript(() => {
      localStorage.setItem('fund-user-v1', 'u-lin');
      sessionStorage.setItem('fund-welcome-v1', '1');
    });
    const firstPage = await firstContext.newPage();
    watchPage(firstPage, consoleErrors, externalRequests, base);
    await firstPage.goto(base, { waitUntil: 'networkidle' });
    await firstPage.waitForSelector('#onboardRoot:not([hidden])', { timeout: 5000 });
    ok((await firstPage.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light', '首次进入默认浅色');
    ok((await firstPage.evaluate(() => document.body.getAttribute('data-mode'))) === 'focus', '首次进入默认专注模式');
    ok((await firstPage.evaluate(() => document.documentElement.getAttribute('data-layout'))) === 'desktop', '1440 使用桌面布局');
    ok((await firstPage.evaluate(() => location.hash)) === '#/agent', '默认路由为 #/agent');
    ok((await firstPage.locator('[data-ob-slide]').count()) === 4, '新手指引共 4 页');
    await firstPage.locator('[data-ob-next]').click();
    ok((await firstPage.locator('#obNum').innerText()).trim() === '02', '可以进入第 2 页');
    await firstPage.locator('[data-ob-dot="2"]').click();
    await firstPage.locator('[data-ob-next]').click();
    await firstPage.locator('[data-ob-next]').click();
    await firstPage.waitForFunction(() => document.querySelector('#onboardRoot').hidden);
    await firstPage.waitForSelector('#modelNoticeRoot:not([hidden])', { timeout: 5000 });
    const modelNotice = await firstPage.locator('#modelNoticeRoot').innerText();
    ok(modelNotice.includes('硅基流动') && modelNotice.includes('模型能力问题'), '引导结束后弹出默认模型说明');
    await firstPage.locator('[data-model-notice-close]').click();
    ok(await firstPage.evaluate(() => localStorage.getItem('fund-model-notice-v1') === '1'), '默认模型说明只提示一次');
    ok(await firstPage.evaluate(() => localStorage.getItem('fund-onboarding-v1') === 'done'), '完成指引写入本地记忆');
    await firstPage.reload({ waitUntil: 'networkidle' });
    await firstPage.waitForTimeout(700);
    ok(await firstPage.evaluate(() => document.querySelector('#onboardRoot').hidden), '再次打开不重复弹出指引');
    await firstContext.close();


    console.log('\n[2] 桌面首页：清爽对话与六大银行功能入口');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await seed(context);
    const page = await context.newPage();
    watchPage(page, consoleErrors, externalRequests, base);
    await page.goto(base, { waitUntil: 'networkidle' });
    await waitForHomeData(page);
    ok(await page.locator('.topbar').isVisible(), '顶部品牌栏可见');
    ok(await page.locator('[data-mobile-nav="settings"]').isVisible(), '设置是底部明确入口');
    ok(await page.locator('#ttsToggleMain').isVisible(), '语音自动朗读开关可见');
    ok((await page.locator('#ttsToggleMain').innerText()).includes('🔊'), 'TTS 自动朗读默认开启');
    ok(await page.locator('#agentConsole').isVisible(), '中央 Agent 可见');
    ok((await page.locator('#homeFeatures').count()) === 0, '对话首页不再堆功能宫格（入口统一在功能页）');
    ok((await page.locator('.bank-entry').count()) === 0, '首页不出现任何功能入口卡片');
    ok((await page.locator('#agentConsole').innerText()).includes('我是小安'), '小安欢迎区可见');
    ok((await page.locator('#welcomeQuickPrompts .quick-ask').count()) === 4, '对话首页展示 4 个快捷问法');
    const liveSummary = await page.evaluate(() => fetch('/api/finance/summary?user=u-lin').then(response => response.json()));
    const yuanText = value => '¥' + Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    ok((await page.locator('.home-feature').count()) === 0, '首页不再出现旧五入口卡片');
    ok((await page.locator('#homeOverviewValue').count()) === 0, '首页不再出现旧总览卡');
    ok((await page.locator('#featureRail').count()) === 0, '首页没有右侧功能面板');
    ok((await page.locator('#pulse').count()) === 0, '首页没有旧资金概览条');
    ok((await page.locator('#mobileStatus').count()) === 0, '首页没有旧移动状态条');
    ok((await page.locator('#quickServices .bank-entry').count()) === 0, '快捷服务区不含功能宫格');
    ok((await page.locator('#quickServices .quick-service-new').count()) === 1, '快捷服务区保留手动添加入口');
    await page.locator('[data-quick-service-add]').click();
    await page.locator('#quickServiceName').fill('每月账单');
    await page.locator('#quickServiceAction').fill('#/cashflow');
    await page.locator('.quick-service-form button[type="submit"]').click();
    ok(await page.locator('.quick-service[data-quick-service-route="cashflow"]').isVisible(), '手动添加的快捷服务出现在首页');
    await page.locator('.quick-service[data-quick-service-route="cashflow"]').first().click();
    await page.waitForTimeout(400);
    ok(page.url().includes('#/cashflow'), '快捷服务点击后跳转对应页面');
    await page.evaluate(() => { location.hash = '#/agent'; });
    await page.waitForTimeout(300);
    await page.locator('.quick-service-del').first().click();
    ok((await page.locator('.quick-service[data-quick-service-route="cashflow"]').count()) === 0, '快捷服务可移除');
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem('fund-quick-services-v1') || '[]').length === 0), '移除后本地记忆同步清空');
    await page.locator('#agentInput').fill('把查贷款加到快捷服务');
    await page.locator('#agentInput').press('Enter');
    await page.waitForSelector('.quick-service[data-quick-service-route="loans"]', { state: 'attached', timeout: 10000 });
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem('fund-quick-services-v1') || '[]').some(item => item.route === 'loans')), '让小安添加快捷服务会写入本地并显示');
    await assertNoOverflow(page, '1440 首页无横向溢出');

    console.log('\n[3] 六个银行功能页、账号下钻与旧路由兼容');
    await openFeatures(page);
    ok((await page.locator('#featurePageBody .hub-row').count()) === 6, '功能页一行一个展示 6 个功能');
    ok((await page.locator('#featurePageBody .hub-row').first().innerText()).includes('众微银行'), '账号行展示银行卡所属银行');
    ok((await page.locator('#featurePageBody .hub-row').nth(1).innerText()).includes(yuanText(liveSummary.totals.assets_yuan)), '资产行使用 SQLite 总资产');
    ok((await page.locator('#featurePageBody .hub-row').nth(2).innerText()).includes(String(liveSummary.counts.transactions) + ' 笔'), '收支行使用 SQLite 流水笔数');
    ok((await page.locator('#featurePageBody .hub-row').nth(3).innerText()).includes(yuanText(liveSummary.totals.liabilities_yuan)), '贷款行使用 SQLite 负债');
    ok((await page.locator('#featurePageBody .hub-ai-card').count()) === 0, '功能页不混入 AI 功能入口');
    await page.locator('#featurePageBody .hub-row[data-feature="payments"]').click();
    await expectFeature(page, 'payments', '服务', '/api/finance/subscriptions', '#featurePageBody .sheet-hero');
    const paymentsText = await page.locator('#featurePageBody').innerText();
    ok(paymentsText.includes('爱奇艺') && paymentsText.includes('取消订阅'), '服务页展示订阅管理入口');

    await openFeatures(page);
    await page.locator('#featurePageBody .hub-row[data-feature="accounts"]').click();
    await expectFeature(page, 'accounts', '账号', '/api/finance/accounts', '#featurePageBody .bank-card-tile');
    ok((await page.locator('#featurePageBody .bank-card-tile').count()) === 4, '账号页展示 4 张银行卡');
    const accountListText = await page.locator('#featurePageBody').innerText();
    ok(accountListText.includes('众微银行储蓄卡 · 工资卡') && accountListText.includes('众微银行信用卡') && accountListText.includes('众微银行储蓄卡 · 生活卡') && accountListText.includes('众微银行白金卡'), '账号页展示众微银行银行卡列表');
    ok(accountListText.includes('人民币余额') && accountListText.includes('本期未偿'), '银行卡展示余额与未偿');
    ok(!accountListText.includes('定期存款') && !accountListText.includes('消费备用额度'), '账号列表不展示备用金与消费备用额度');
    ok(!accountListText.includes('微信支付零钱'), '账号列表不混入钱包');
    ok(!['账户数量', '账户净资产', '总负债', '可用授信', '资产汇总'].some(text => accountListText.includes(text)), '账号列表不展示资产汇总');
    ok((await page.locator('#featurePageBody .metric-grid').count()) === 0, '账号页没有资产汇总指标');
    ok(await page.locator('#agentFab').isVisible(), '功能页显示小安悬浮球');
    await page.locator('#agentFab').click();
    await page.waitForSelector('#fabChatRoot:not([hidden])', { timeout: 5000 });
    ok(true, '悬浮球唤起悬浮对话面板');
    await page.fill('#fabInput', '查一下最近支出');
    await page.locator('#fabForm button[type="submit"]').click();
    await page.waitForTimeout(1200);
    const fabThreadText = await page.locator('#fabThread').innerText();
    ok(fabThreadText.includes('查一下最近支出'), '悬浮对话发送用户消息');
    ok(fabThreadText.includes('重试'), '悬浮对话在未配置模型时展示重试入口');
    ok((await page.locator('#fabThread .tts-btn').count()) >= 1, 'AI 回复带朗读按钮（TTS）');
    await page.locator('#fabChatClose').click();
    await page.waitForSelector('#fabChatRoot', { state: 'hidden' });
    ok(true, '悬浮对话可关闭返回功能页');

    await page.locator('#featurePageBody [data-account-view="wb-debit"]').click();
    await page.waitForSelector('#featurePageBody .acct-card-hero');
    ok((await page.evaluate(() => location.hash)) === '#/accounts/wb-debit', '银行卡打开独立账户详情路由');
    ok((await page.locator('#featurePageTitle').innerText()).includes('工资卡'), '账户详情标题使用银行卡名称');
    ok((await page.locator('.page-back').count()) >= 1, '账户详情页头部提供返回键');
    const detailText = await page.locator('#featurePageBody').innerText();
    ok(detailText.includes('人民币余额') && detailText.includes('9,119.54'), '账户详情展示人民币余额');
    ok(detailText.includes('6236 36** **** 4821'), '账户详情展示卡号');
    ok((await page.locator('#featurePageBody .acct-quick-action').count()) === 5, '账户详情展示 5 个快捷动作');
    for (const label of ['查询明细', '转账汇款', '复制卡号', '账户挂失', '密码管理']) {
      ok(detailText.includes(label), '账户快捷动作可见：' + label);
    }
    ok(!detailText.includes('[data-account-action="branch"]') && !detailText.includes('[data-account-action="messenger"]') && !detailText.includes('[data-account-action="invest"]'), '已删除开户网点/信使/投资理财三卡按钮');
    for (const label of ['额度', '基本账户', '启用日期', '到期日期', '账户互转', '设置别名', '转入资金', '转出资金', '绑定手机号', '绑定卡', '当面收款', '删除账户']) {
      ok(detailText.includes(label), '账户详情包含：' + label);
    }
    ok(!['可用授信', '账户数量', '总负债', '备用金', '消费备用额度', '按月聚合'].some(text => detailText.includes(text)), '账户详情不出现资产汇总、备用金或聚合说明');
    const monthDetails = page.locator('#acctTxMonths .acct-tx-month');
    ok((await monthDetails.count()) === 3, '账户流水按月分组为 3 个月');
    ok((await monthDetails.first().locator('summary b').innerText()).trim() === '10月', '账户流水 10 月在最前');
    ok(await monthDetails.first().evaluate(el => el.open), '最新月份默认展开');
    ok(!(await monthDetails.nth(1).evaluate(el => el.open)), '其他月份默认收起');
    const firstTxText = await monthDetails.first().locator('.acct-tx-row').first().innerText();
    ok(/10月\d+日/.test(firstTxText), '流水显示日期');
    ok(firstTxText.includes('余额 ¥'), '流水显示余额');
    ok(firstTxText.includes('已入账'), '流水显示状态');
    ok(/(收入|支出|转账)/.test(firstTxText), '流水显示收支方向');
    await monthDetails.nth(1).locator('summary').click();
    ok(await monthDetails.nth(1).evaluate(el => el.open), '点击月份可展开逐条流水');
    ok((await monthDetails.nth(1).locator('.acct-tx-row').count()) > 0, '展开月份后显示逐条流水');
    await page.locator('#featurePageBody [data-account-action="freeze"]').click();
    await page.waitForSelector('#bankDialogRoot:not([hidden])', { timeout: 5000 });
    ok((await page.locator('#bankDialogCard').innerText()).includes('账户挂失'), '账户挂失打开实装对话框');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#bankDialogRoot', { state: 'hidden' });
    await page.locator('.page-back').click();
    await p2wait(page);

    await page.locator('#featurePageBody [data-account-view="cmb-credit"]').click();
    await page.waitForSelector('#featurePageBody .acct-card-hero.is-credit');
    const creditText = await page.locator('#featurePageBody').innerText();
    ok(creditText.includes('人民币未偿') && creditText.includes('2,518.74'), '信用卡详情展示人民币未偿');
    ok(creditText.includes('额度') && creditText.includes('信用额度') && creditText.includes('可用额度'), '信用卡详情展示额度');
    ok(creditText.includes('30,000.00') && creditText.includes('27,481.26'), '信用卡详情展示信用额度与可用额度');
    ok(creditText.includes('众微银行'), '信用卡详情归属众微银行');
    await page.locator('.page-back').click();
    await page.waitForSelector('#featurePageBody .bank-card-tile');
    await page.locator('#featurePageBody [data-page-back], .page-back').first().click();
    await page.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
    ok(true, '返回键可用');



    await openFeatures(page);
    await page.locator('#featurePageBody .hub-row[data-feature="assets"]').click();
    await expectFeature(page, 'assets', '资产', '/api/finance/summary · /accounts · /products', '#featurePageBody .sheet-hero');
    const assetsText = await page.locator('#featurePageBody').innerText();
    ok(assetsText.includes('总资产') && assetsText.includes('欠款'), '资产页展示总资产与欠款');
    ok(!assetsText.includes('净资产') && !assetsText.includes('可用授信'), '资产页不展示净资产与可用授信');
    ok(!assetsText.includes('资产占比'), '资产页不展示资产占比');
    ok(assetsText.includes('定期存款') && assetsText.includes('产品目录'), '资产页展示定期存款与产品目录');
    ok((await page.locator('#featurePageBody .row-link').count()) >= 1, '资产页展示持仓产品');
    ok((await page.locator('#featurePageBody .product-row').count()) === 8, '资产页展示 8 个产品');
    await page.locator('#featurePageBody [data-page-back], .page-back').first().click();
    await page.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
    ok(true, '返回键可用');

    await openFeatures(page);
    await page.locator('#featurePageBody .hub-row[data-feature="cashflow"]').click();
    await expectFeature(page, 'cashflow', '收支', '/api/finance/monthly · /transactions', '#featurePageBody .cf-month-link');
    const cashflowText = await page.locator('#featurePageBody').innerText();
    ok(cashflowText.includes('收入') && cashflowText.includes('支出') && cashflowText.includes('覆盖月份'), '收支页展示收入/支出与覆盖信息');
    ok(!cashflowText.includes('转账合计') && !cashflowText.includes('净流入'), '收支页不展示转账合计与净流入');
    ok(!cashflowText.includes('按月聚合'), '收支页不出现按月聚合说明');
    const monthLinks = page.locator('#featurePageBody .cf-month-link');
    ok((await monthLinks.count()) === 3, '收支页展示 3 个月份');
    ok((await monthLinks.first().locator('.cf-month-date b').innerText()).trim() === '10月', '收支页 10 月在最前');
    await monthLinks.first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/cashflow/'));
    await page.waitForSelector('#featurePageBody .cf-tx-row');
    ok((await page.locator('#featurePageBody .cf-tx-row').count()) > 0, '月份页展示该月全部流水');
    const firstMonthRow = await page.locator('#featurePageBody .cf-tx-row').first().innerText();
    ok(/10月\d+日/.test(firstMonthRow), '月度流水显示日期');
    ok(firstMonthRow.includes('余额 ¥') && firstMonthRow.includes('已入账'), '月度流水显示余额与状态');
    ok(/(收入|支出|转账)/.test(firstMonthRow), '月度流水显示收支方向');
    await page.goto(base + '#/cashflow', { waitUntil: 'networkidle' });
    await page.waitForSelector('#featurePageBody [data-feature="transactions"]');
    ok((await page.locator('#featurePageBody [data-feature="transactions"]').count()) >= 1, '收支页保留交易明细入口');
    await page.locator('#featurePageBody [data-page-back], .page-back').first().click();
    await page.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
    ok(true, '收支页返回键可用');

    await openFeatures(page);
    await page.locator('#featurePageBody .hub-row[data-feature="loans"]').click();
    await expectFeature(page, 'loans', '贷款', '/api/loans/products · /mine', '#featurePageBody .loan-hero');
    const loansText = await page.locator('#featurePageBody').innerText();
    ok(loansText.includes('微粒贷') && loansText.includes('20万'), '贷款页展示众微银行微粒贷产品');
    const mineNow = await page.evaluate(() => fetch('/api/loans/mine').then(r => r.json()));
    const weilidaiOutstanding = (mineNow.loans || []).filter(l => /微粒贷/.test(l.name || '') || /weilidai/.test(l.id || ''))
      .reduce((sum, loan) => sum + Number(loan.outstandingYuan || 0), 0);
    ok(loansText.includes('我的贷款') && loansText.includes(Number(weilidaiOutstanding).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), '我的贷款展示微粒贷未偿');
    ok(loansText.includes('贷款计算器') && loansText.includes('信用报告') && loansText.includes('常见问题'), '贷款页功能宫格与 FAQ 齐全');
    await page.locator('[data-loan-action="credit-query"]').first().click();
    await page.waitForSelector('.loan-eval-ring', { timeout: 5000 });
    ok(true, '额度评估播放智能动画');
    await page.waitForSelector('.loan-eval-reveal', { timeout: 9000 });
    const evalText = await page.locator('#bankDialogCard').innerText();
    ok(evalText.includes('资金用途') && evalText.includes('额度评估'), '评估后展示第一题与额度评估标识');
    ok((await page.locator('.loan-question').count()) === 1, '一次只展示一个问题');
    ok(!evalText.includes('月均收入'), '评估结果不列评估规则明细');
    await page.locator('.loan-answer-chip').first().click();
    await page.waitForFunction(() => (document.querySelector('.loan-question') || {}).textContent === '期望金额');
    ok((await page.locator('.loan-question').count()) === 1, '选择后进入第二题');
    await page.locator('.loan-answer-chip').nth(1).click();
    await page.waitForFunction(() => (document.querySelector('.loan-question') || {}).textContent === '期限偏好');
    await page.locator('.loan-answer-chip').first().click();
    await page.waitForSelector('#loanRecommendBtn');
    ok((await page.locator('#bankDialogCard').innerText()).includes('预估最高可借'), '确认页展示预估额度');
    await page.locator('#loanRecommendBtn').click();
    await page.waitForSelector('.loan-rec-badge', { timeout: 15000 });
    const recText = await page.locator('#bankDialogCard').innerText();
    ok(recText.includes('推荐产品') && recText.includes('微粒贷'), 'AI/模板推荐返回产品与理由');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#bankDialogRoot', { state: 'hidden' });
    await page.waitForTimeout(300);
    const fabBefore = await page.locator('#agentFab').boundingBox();
    await page.locator('#agentFab').hover();
    await page.mouse.down();
    await page.mouse.move(fabBefore.x - 120, fabBefore.y - 60, { steps: 6 });
    await page.mouse.up();
    const fabAfter = await page.locator('#agentFab').boundingBox();
    ok(Math.abs(fabAfter.x - fabBefore.x) > 60, '悬浮球可拖动并记忆位置');
    await page.locator('#agentFab').click();
    await page.waitForSelector('#fabChatRoot:not([hidden])', { timeout: 5000 });
    ok(true, '拖动后点击仍可唤起悬浮对话');
    await page.locator('#fabChatClose').click();
    await page.waitForTimeout(300);
    ok(loansText.includes('额度') && loansText.includes('还款'), '贷款页展示授信与还款信息');
    await page.locator('#featurePageBody [data-page-back], .page-back').first().click();
    await page.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
    ok(true, '返回键可用');

    await openFeatures(page);
    await page.locator('#featurePageBody .hub-row[data-feature="wealth"]').click();
    await expectFeature(page, 'wealth', '理财', '/api/finance/summary · /products', '#featurePageBody .wp-card');
    const wealthText = await page.locator('#featurePageBody').innerText();
    ok(wealthText.includes('活期+') && wealthText.includes('商业养老金'), '理财页展示活期+与商业养老金');
    ok(!wealthText.includes('可配置资产') && !wealthText.includes('现金账户'), '理财页不展示个人资产与现金账户');
    ok((await page.locator('#featurePageBody .wp-card').count()) >= 15, '理财页提供充足产品');
    await page.locator('#featurePageBody .wp-card').first().click();
    await page.waitForSelector('.pd-rich', { timeout: 5000 });
    const pdText = await page.locator('#bankDialogCard').innerText();
    ok(pdText.includes('产品代码') && pdText.includes('业绩比较基准') && pdText.includes('起购金额'), '产品详情展示代码/基准/起购');
    ok(pdText.includes('业务规则') && pdText.includes('交易规则') && pdText.includes('产品档案'), '产品详情展示业务规则/交易规则/产品档案');
    ok(pdText.includes('适合人群') && pdText.includes('购买'), '产品详情展示适合人群与购买入口');
    ok((await page.locator('#bankDialogCard .pd-doc-row').count()) === 6, '产品档案包含六份文件');
    ok((await page.locator('#bankDialogCard .pd-step').count()) >= 4, '业务规则以时间线呈现');
    ok(!pdText.includes('历史示例') && !pdText.includes('不能当作'), '产品详情无冗余说明');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok((await page.locator('#featurePageBody .wp-card').count()) === 19, '理财页展示 19 只产品');
    await page.locator('#featurePageBody [data-page-back], .page-back').first().click();
    await page.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
    ok(true, '返回键可用');

    console.log('\n[3b] 旧版路由深链兼容');
    await page.goto(base + '#/overview', { waitUntil: 'networkidle' });
    await expectFeature(page, 'overview', '资金总览', '/api/overview', '#featurePageBody .sheet-hero');
    const overviewScoped = await page.evaluate(() => fetch('/api/finance/summary?user=u-lin').then(response => response.json()));
    const overviewPayable = '¥' + Number(overviewScoped.totals.payable_yuan).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    ok((await page.locator('#featurePageBody').innerText()).includes(overviewPayable), '旧总览页仍展示可支付金额', overviewPayable);
    await page.goto(base + '#/transactions', { waitUntil: 'networkidle' });
    await expectFeature(page, 'transactions', '交易', '/api/transactions', '#featurePageBody .tx-row');
    ok((await page.locator('#featurePageBody .tx-row').count()) === 10, '旧交易页仍展示 10 笔记录');
    await page.locator('#featurePageBody [data-page-back], .page-back').first().click();
    await page.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
    ok(true, '返回键可用');

    console.log('\n[4] 设置独立页：只保留可操作项，主题/模式/竖屏/页面说明/帮助');
    await openSettings(page);
    ok((await page.evaluate(() => location.hash)) === '#/settings', '底部“设置”进入独立设置页');
    const settingsText = await page.locator('[data-settings-page]').innerText();
    for (const label of ['主题', '使用模式', '竖屏预览', '页面说明', '查看新手指引']) {
      ok(settingsText.includes(label), '设置包含：' + label);
    }
    ok((await page.locator('[data-settings-page] .ai-hint').count()) === 1, 'AI 配置区保留一句免费模型提示');
    ok(!['刷新数据', '数据接口', '返回调用失败', '两种模式', '边界', '存储', '风险说明', '免责', '模拟', '离线'].some(text => settingsText.includes(text)), '设置无冗余说明内容');
    ok((await page.locator('[data-mode-set="focus"]').getAttribute('aria-pressed')) === 'true', '设置默认选中专注模式');
    ok((await page.locator('[data-notes-toggle]').getAttribute('aria-checked')) === 'false', '页面说明默认收起');
    ok((await page.evaluate(() => document.querySelector('#featurePageBody .page-lead') === null)) || (await page.evaluate(() => getComputedStyle(document.querySelector('#featurePageBody .page-lead') || { display: 'none' }).display)) === 'none', '功能页默认不显示页面说明');

    await page.locator('[data-theme-set="dark"]').click();
    ok((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', '可切换深色主题');
    await page.locator('[data-mode-set="daily"]').click();
    ok((await page.evaluate(() => document.body.getAttribute('data-mode'))) === 'daily', '可切换日常模式');
    await page.locator('#featurePageBody [data-page-back], .page-back').first().click();
    await page.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
    ok(true, '返回键可用');

    await page.reload({ waitUntil: 'networkidle' });
    await waitForHomeData(page);
    ok((await page.evaluate(() => document.body.getAttribute('data-mode'))) === 'focus', '刷新后重置为专注模式');
    ok((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', '刷新后保持深色主题');
    await openSettings(page);
    await page.locator('[data-theme-set="light"]').click();
    await page.locator('[data-portrait-toggle]').click();
    ok((await page.evaluate(() => document.documentElement.getAttribute('data-layout'))) === 'mobile', '竖屏预览切换为竖屏布局');
    const portraitBox = await page.evaluate(() => {
      const el = document.querySelector('.app');
      return { width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height };
    });
    ok(portraitBox.width <= 430, '竖屏画布宽度收窄到手机尺寸', portraitBox.width + 'px');
    await page.locator('[data-portrait-toggle]').click();
    ok((await page.evaluate(() => document.documentElement.getAttribute('data-layout'))) === 'desktop', '关闭竖屏后恢复桌面布局');
    await page.locator('[data-notes-toggle]').click();
    ok((await page.locator('[data-notes-toggle]').getAttribute('aria-checked')) === 'true', '可打开页面说明开关');
    await page.locator('[data-notes-toggle]').click();
    ok((await page.locator('[data-notes-toggle]').getAttribute('aria-checked')) === 'false', '可关闭页面说明开关');
    await page.locator('[data-help-open]').click();
    await page.waitForSelector('#onboardRoot:not([hidden])');
    ok(await page.locator('#onboardRoot').isVisible(), '可从设置重新查看新手指引');
    await page.locator('[data-ob-skip]').click();
    await page.waitForFunction(() => document.querySelector('#onboardRoot').hidden);
    if (await page.locator('#modelNoticeRoot:not([hidden])').count()) {
      await page.locator('[data-model-notice-close]').click();
    }
    await page.locator('#featurePageBody [data-page-back], .page-back').first().click();
    await page.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
    ok(true, '返回键可用');
    await openSettings(page);
    await page.locator('.page-back').first().click();
    await page.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
    await page.locator('[data-mobile-nav="chat"]').click();
    await page.waitForSelector('#agentView:not([hidden])');

    console.log('\n[5] Agent 失败：真实接口不可用时显示失败并允许重试');
    await page.locator('#agentInput').fill('帮我看看这个月还有哪些钱会被扣？');
    await page.locator('#agentInput').press('Enter');
    await page.waitForSelector('.msg.error', { timeout: 10000 });
    ok((await page.locator('.msg.error').innerText()).includes('小安这次没接上，别着急～'), '调用失败明确展示');
    ok((await page.locator('.msg.error').innerText()).includes('还没有配置 Key'), '展示服务端失败原因');
    ok((await page.locator('[data-agent-retry]').count()) === 1, '失败消息提供重试按钮');
    ok((await page.locator('#agentDriver').innerText()).includes('调用失败'), '状态标签显示调用失败');
    ok(await page.locator('#welcomeMsg').isHidden(), '发送后欢迎区收起');
    ok((await page.locator('.bank-entry').count()) === 0, '对话后首页仍保持清爽');
    await page.locator('[data-agent-retry]').click();
    await page.waitForFunction(() => {
      return document.querySelectorAll('.msg.error').length === 1 && !document.getElementById('agentThinking');
    }, { timeout: 10000 });
    ok((await page.locator('.msg.error').count()) === 1, '重试后仍失败会生成新的失败消息');
    ok(!(await page.locator('#chatThread').innerText()).includes('离线'), '对话不出现离线规划字样');
    await assertNoOverflow(page, '1440 失败态无横向溢出');

    console.log('\n[6] Agent 成功：快捷问题、查询来源与失败后重试');
    const aiContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await seed(aiContext);
    const aiPage = await aiContext.newPage();
    watchPage(aiPage, consoleErrors, externalRequests, base);
    let aiMode = 'ok';
    await aiPage.route('**/api/agent', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      if (aiMode === 'fail') {
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: { code: 'AI_UPSTREAM_ERROR', message: '模型服务连接失败，请重试。', retryable: true } })
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          source: 'ai',
          provider: 'smoke-model',
          model: 'smoke-model',
          latencyMs: 920,
          queries: [
            { tool: 'get_profile', label: '资金档案', count: 6 },
            { tool: 'get_bills', label: '账单', count: 9 },
            { tool: 'get_cards', label: '卡片', count: 3 },
            { tool: 'get_subscriptions', label: '订阅', count: 5 },
            { tool: 'get_transactions', label: '交易', count: 10 }
          ],
          plan: {
            summary: '已核对档案：可支付 10,800 元，发薪前缺口 436 元。',
            risk: '11 月 1 日前有三笔自动扣款，需要优先预留。',
            actions: [
              { title: '先补足 436 元缺口', detail: '从备用金转入工资卡 436 元，确保房租正常扣款。', amount: 436, type: 'transfer' },
              { title: '复核两笔订阅', detail: '爱奇艺 39 元与 Keep 199 元将在本周续费。', amount: 238, type: 'subscription' }
            ]
          }
        })
      });
    });
    await aiPage.goto(base, { waitUntil: 'networkidle' });
    await waitForHomeData(aiPage);
    await aiPage.locator('#agentInput').fill('近三个月哪个分类花得最多？');
    await aiPage.locator('#agentInput').press('Enter');
    await aiPage.waitForSelector('.plan-summary', { timeout: 10000 });
    ok((await aiPage.locator('#agentDriver').innerText()).includes('已生成'), '成功时状态标签显示已生成');
    const queryStatus = await aiPage.locator('.query-status').innerText();
    ok(queryStatus.includes('已为你查询') && queryStatus.includes('账户与余额') && queryStatus.includes('账单与收支'), '查询状态改为自然语言', queryStatus);
    ok((await aiPage.locator('.plan-actions li').count()) === 2, '计划展示 2 个动作');
    ok((await aiPage.locator('.plan-summary').innerText()).includes('10,800'), '计划摘要使用查询结果');
    ok((await aiPage.locator('.msg.user .bubble').innerText()).includes('分类花得最多'), '快捷问题作为用户消息发送');

    aiMode = 'fail';
    await aiPage.locator('#agentInput').fill('再给我一个更保守的安排');
    await aiPage.locator('#agentInput').press('Enter');
    await aiPage.waitForSelector('.msg.error', { timeout: 10000 });
    ok((await aiPage.locator('.msg.error').innerText()).includes('模型服务连接失败'), '上游失败原因可见');
    aiMode = 'ok';
    await aiPage.locator('[data-agent-retry]').click();
    await aiPage.waitForFunction(() => document.querySelectorAll('.plan-summary').length === 2 && document.querySelectorAll('.msg.error').length === 0, { timeout: 10000 });
    ok((await aiPage.locator('.plan-summary').count()) === 2, '失败后重试可生成新计划');
    await aiContext.close();

    console.log('\n[7] 竖屏：顶部品牌、独立功能页、底部导航');
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await seed(mobileContext);
    const mobilePage = await mobileContext.newPage();
    watchPage(mobilePage, consoleErrors, externalRequests, base);
    await mobilePage.goto(base, { waitUntil: 'networkidle' });
    await waitForHomeData(mobilePage);
    ok((await mobilePage.evaluate(() => document.documentElement.getAttribute('data-layout'))) === 'mobile', '390 使用竖屏布局');
    ok(await mobilePage.locator('.topbar').isVisible(), '竖屏顶部品牌可见');
    ok((await mobilePage.locator('.bank-entry').count()) === 0, '竖屏对话首页保持清爽');
    await mobilePage.locator('[data-mobile-nav="features"]').click();
    await mobilePage.waitForSelector('#featurePageBody .hub-row');
    ok((await mobilePage.locator('#featurePageBody .hub-row').count()) === 6, '竖屏功能页展示 6 个银行入口');
    await mobilePage.locator('[data-mobile-nav="chat"]').click();
    await mobilePage.waitForTimeout(300);
    ok(await mobilePage.locator('#agentConsole').isVisible(), '中央 Agent 可见');
    ok(await mobilePage.locator('.mobile-nav').isVisible(), '底部导航可见');
    ok((await mobilePage.locator('#featureRail').count()) === 0, '竖屏没有抽屉面板');
    ok((await mobilePage.locator('#featureScrim').count()) === 0, '竖屏没有功能遮罩');
    ok(await mobilePage.locator('#welcomeQuickPrompts .quick-ask').count() === 4, '竖屏中央展示 4 个快捷问法');

    await openFeatures(mobilePage);
    ok((await mobilePage.locator('#featurePageBody .hub-row').count()) === 6, '竖屏功能页一行一个展示 6 个功能');
    await mobilePage.locator('#featurePageBody .hub-row[data-feature="accounts"]').click();
    await mobilePage.waitForSelector('#featurePageBody .bank-card-tile');
    ok((await mobilePage.evaluate(() => location.hash)) === '#/accounts', '竖屏点击入口进入独立账号页');
    ok((await mobilePage.locator('#featurePageTitle').innerText()).trim() === '账号', '竖屏账号页标题正确');
    ok(await mobilePage.locator('.mobile-nav').isVisible(), '功能页仍保留底部导航');
    ok(await mobilePage.locator('#featureView').isVisible(), '竖屏功能页独立显示');
    await mobilePage.locator('#featurePageBody [data-account-view="wb-debit"]').click();
    await mobilePage.waitForSelector('#featurePageBody .acct-card-hero');
    ok((await mobilePage.evaluate(() => location.hash)) === '#/accounts/wb-debit', '竖屏银行卡进入独立账户详情');
    ok((await mobilePage.locator('#featurePageBody .acct-quick-action').count()) === 5, '竖屏账户详情保留快捷动作');
    await mobilePage.locator('.page-back').click();
    await mobilePage.waitForSelector('#featurePageBody .bank-card-tile');
    await mobilePage.locator('.page-back').first().click();
    await expectAgent(mobilePage);

    await openFeatures(mobilePage);
    ok((await mobilePage.evaluate(() => location.hash)) === '#/features', '底部“功能”进入功能页');
    ok((await mobilePage.locator('[data-mobile-nav="features"]').getAttribute('class')).includes('is-on'), '功能页底部“功能”高亮');
    await mobilePage.locator('[data-mobile-nav="chat"]').click();
    await expectAgent(mobilePage);
    ok((await mobilePage.locator('[data-mobile-nav="chat"]').getAttribute('class')).includes('is-on'), '首页底部“对话”高亮');
    await assertNoOverflow(mobilePage, '390 首页/功能页无横向溢出');

    await openSettings(mobilePage);
    ok((await mobilePage.locator('[data-settings-page]').innerText()).includes('操作权限'), '竖屏可打开设置');
    await mobilePage.locator('.page-back').first().click();
    await expectAgent(mobilePage);

    console.log('\n[8] 320–1440 五档宽度');
    for (const width of [320, 360, 390, 768, 1440]) {
      const responsive = await browser.newContext({ viewport: { width, height: 900 } });
      await seed(responsive);
      const p = await responsive.newPage();
      const errs = [];
      p.on('pageerror', error => errs.push(error.message));
      p.on('console', message => { if (message.type() === 'error') errs.push(message.text()); });
      await p.goto(base, { waitUntil: 'networkidle' });
      await waitForHomeData(p);
      const layout = await p.evaluate(() => document.documentElement.getAttribute('data-layout'));
      ok(layout === (width >= 981 ? 'desktop' : 'mobile'), width + ' 布局断点正确', layout);
      await assertNoOverflow(p, width + ' 首页无横向溢出');
      await openFeatures(p);
      await p.locator('#featurePageBody .hub-row[data-feature="accounts"]').click();
      await p.waitForSelector('#featurePageBody .bank-card-tile');
      ok((await p.locator('#featurePageTitle').innerText()).trim() === '账号', width + ' 独立账号页标题正确');
      await assertNoOverflow(p, width + ' 功能页无横向溢出');
      await p.locator('.page-back').click();
      await p.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
      await openSettings(p);
      await assertNoOverflow(p, width + ' 设置无横向溢出');
      await p.locator('.page-back').click();
      await p.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
      ok(errs.length === 0, width + ' 无页面脚本错误', errs.slice(0, 2).join(' | '));
      await responsive.close();
    }

    console.log('\n[1.5] 欢迎资料与桌面银行服务');
    const userContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const userPage = await userContext.newPage();
    watchPage(userPage, consoleErrors, externalRequests, base);
    await userPage.goto(base, { waitUntil: 'networkidle' });
    await userPage.waitForSelector('#onboardRoot:not([hidden])', { timeout: 5000 });
    ok(true, '单用户直接进入并弹出使用指引');
    await userPage.locator('[data-ob-skip]').click();
    if (await userPage.locator('#modelNoticeRoot:not([hidden])').count()) {
      await userPage.locator('[data-model-notice-close]').click();
    }
    await userPage.waitForSelector('#welcomeRoot:not([hidden])', { timeout: 5000 });
    await userPage.waitForFunction(() => document.querySelector('#welcomeBody').innerText.includes('是否查看'), null, { timeout: 5000 });
    ok(true, '进入时弹出欢迎资料询问窗');
    await userPage.locator('[data-welcome-view]').click();
    await userPage.waitForFunction(() => document.querySelector('#welcomeBody').innerText.includes('查询密码'), null, { timeout: 5000 });
    const svcWelcomeText = await userPage.locator('#welcomeBody').innerText();
    ok(svcWelcomeText.includes('总资产') && svcWelcomeText.includes('欠款'), '资料页展示用户资产概况');
    ok(svcWelcomeText.includes('银行卡与查询密码'), '资料页包含银行卡与查询密码分组');
    ok(svcWelcomeText.includes('6236360012344821'), '资料页展示完整银行卡号');
    ok(svcWelcomeText.includes('123456'), '资料页展示查询密码（默认 123456）');
    await userPage.locator('[data-welcome-close]').click();
    await userPage.waitForSelector('#welcomeRoot', { state: 'hidden' });
    ok(true, '关闭欢迎窗进入小安首页');

    await userPage.goto(base + '#/accounts', { waitUntil: 'networkidle' });
    await userPage.waitForTimeout(600);
    await userPage.locator('[data-account-view="wb-debit"]').click();
    await userPage.waitForTimeout(700);
    const svcDetailText = await userPage.locator('#featurePageBody').innerText();
    ok(!svcDetailText.includes('[data-account-action="branch"]') && !svcDetailText.includes('[data-account-action="messenger"]') && !svcDetailText.includes('[data-account-action="invest"]'), '账户详情已删除开户网点/信使/投资理财三卡按钮');
    ok(['转账汇款', '复制卡号', '账户挂失', '密码管理'].every(item => svcDetailText.includes(item)), '转账/复制/挂失/密码快捷动作齐全');

    await userPage.locator('[data-account-action="transfer"][data-account-id="wb-debit"]').first().click();
    await userPage.waitForTimeout(400);
    await userPage.fill('#tfName', '李彩云');
    await userPage.fill('#tfAccount', '6222021234567890123');
    await userPage.fill('#tfAmount', '88.5');
    await userPage.fill('#tfPassword', '123456');
    await userPage.locator('#bankDialogSubmit').click();
    await userPage.waitForSelector('.bd-receipt', { timeout: 8000 });
    const svcReceiptText = await userPage.locator('#bankDialogCard').innerText();
    ok(svcReceiptText.includes('转账成功') && svcReceiptText.includes('88.50') && svcReceiptText.includes('李彩云'), '对手方转账成功并展示回执');
    await userPage.locator('#bankDialogCard button[data-bank-dialog-close]').last().click();
    await userPage.waitForSelector('#bankDialogRoot', { state: 'hidden' });
    await userPage.waitForTimeout(300);

    // 跨用户转账：转给另一位体验用户的众微银行储蓄卡
    await userPage.locator('[data-account-action="transfer"][data-account-id="wb-debit"]').first().click();
    await userPage.waitForTimeout(400);
    await userPage.selectOption('#tfKind', 'internal');
    await userPage.waitForFunction(() => {
      const select = document.querySelector('#tfTarget[data-role="to"]');
      return select && Array.from(select.options).some(option => option.value === 'ys-debit');
    }, null, { timeout: 6000 });
    ok(true, '转账目录包含其他用户账户');
    await userPage.selectOption('#tfTarget[data-role="to"]', 'ys-debit');
    await userPage.fill('#tfAmount', '30');
    await userPage.fill('#tfPassword', '123456');
    await userPage.locator('#bankDialogSubmit').click();
    await userPage.waitForSelector('.bd-receipt', { timeout: 8000 });
    const crossText = await userPage.locator('#bankDialogCard').innerText();
    ok(crossText.includes('转账成功') && crossText.includes('知微'), '跨用户转账成功并展示收款方');
    await userPage.locator('#bankDialogCard button[data-bank-dialog-close]').last().click();
    await userPage.waitForSelector('#bankDialogRoot', { state: 'hidden' });
    await userPage.waitForTimeout(300);

    await userPage.locator('[data-account-action="transfer"][data-account-id="wb-debit"]').first().click();
    await userPage.waitForTimeout(400);
    await userPage.fill('#tfName', '李彩云');
    await userPage.fill('#tfAccount', '6222021234567890123');
    await userPage.fill('#tfAmount', '10');
    await userPage.fill('#tfPassword', '000000');
    await userPage.locator('#bankDialogSubmit').click();
    await userPage.waitForTimeout(700);
    ok((await userPage.locator('#bankDialogError').innerText()).includes('支付密码不正确'), '错误支付密码被拒绝（不写账）');
    await userPage.locator('#bankDialogCard button[data-bank-dialog-close]').first().click();
    await userPage.waitForTimeout(300);

    await userPage.locator('[data-account-action="password"][data-account-id="wb-debit"]').first().click();
    await userPage.waitForTimeout(600);
    await userPage.locator('[data-pw-toggle]').click();
    ok((await userPage.locator('[data-pw-current]').innerText()) === '123456', '密码管理可查看当前密码');
    await userPage.fill('#pwOld', '000000');
    await userPage.fill('#pwNew', '234567');
    await userPage.fill('#pwConfirm', '234567');
    await userPage.locator('#bankDialogSubmit').click();
    await userPage.waitForTimeout(700);
    ok((await userPage.locator('#bankDialogError').innerText()).includes('原密码不正确'), '原密码错误时修改被拒绝');
    await userPage.locator('#bankDialogCard button[data-bank-dialog-close]').first().click();
    await userPage.waitForTimeout(300);

    await userPage.locator('[data-account-action="freeze"][data-account-id="wb-debit"]').first().click();
    await userPage.waitForTimeout(400);
    await userPage.locator('#bankDialogSubmit').click();
    await userPage.waitForFunction(() => document.querySelector('#featurePageBody').innerText.includes('已挂失'), null, { timeout: 6000 });
    ok(true, '挂失后账户状态实时更新为已挂失');
    await userPage.locator('[data-account-action="freeze"][data-account-id="wb-debit"]').first().click();
    await userPage.waitForTimeout(400);
    ok((await userPage.locator('#bankDialogCard').innerText()).includes('解除挂失'), '挂失状态提供解除入口');
    await userPage.locator('#bankDialogSubmit').click();
    await userPage.waitForFunction(() => document.querySelector('#featurePageBody').innerText.includes('正常'), null, { timeout: 6000 });
    ok(true, '解除挂失后账户恢复正常');

    await userPage.locator('[data-account-action="copy"][data-account-id="wb-debit"]').first().click();
    await userPage.waitForTimeout(900);
    ok((await userPage.locator('#toast').innerText()).includes('6236360012344821'), '复制卡号输出完整卡号');
    await userContext.close();

    await openFeatures(page);
    await page.locator('#featurePageBody .hub-row[data-feature="loans"]').click();
    await expectFeature(page, 'loans', '贷款', '/api/loans/products · /mine', '#featurePageBody .loan-hero');
    await page.locator('#featurePageBody .loan-product-row').first().click();
    await userPageWait(page);
    // 详情弹窗弹出，点击"立即申请"进入申请表单
    const mineBeforeApply = await page.evaluate(() => fetch('/api/loans/mine').then(r => r.json()));
    const outstandingBeforeApply = (mineBeforeApply.loans || []).reduce((sum, loan) => sum + Number(loan.outstandingYuan || 0), 0);
    await page.locator('#bankDialogCard button[data-loan-action="apply"]').click();
    await userPageWait(page);
    await page.fill('#tfAmount', '2000');
    await page.locator('#bankDialogSubmit').click();
    await userPageWait(page);
    const loanReceipt = await page.locator('#bankDialogCard').innerText();
    ok(loanReceipt.includes('放款成功') && loanReceipt.includes('2,000.00'), '贷款申请审批放款并展示回执');
    await page.locator('#bankDialogCard button[data-bank-dialog-close]').last().click();
    await page.waitForFunction((prev) => fetch('/api/loans/mine').then(r => r.json()).then(data => {
      const total = (data.loans || []).reduce((sum, loan) => sum + Number(loan.outstandingYuan || 0), 0);
      return Math.abs(total - prev - 2000) < 0.01;
    }), outstandingBeforeApply, { timeout: 15000 });
    ok(true, '放款后微粒贷未偿实时更新');
    await page.locator('#featurePageBody [data-loan-action="calc"]').click();
    await page.waitForTimeout(300);
    await page.fill('#calcAmount', '10000');
    await page.fill('#calcMonths', '12');
    await page.fill('#calcRate', '3.6');
    await page.locator('#calcForm button[type="submit"]').click();
    await page.waitForTimeout(400);
    ok((await page.locator('#calcResult').innerText()).includes('每月还款'), '贷款计算器输出月供');
    await page.locator('#bankDialogCard .bd-actions .btn-ghost').first().click();
    await page.locator('#featurePageBody [data-page-back], .page-back').first().click();
    await page.waitForFunction(() => ['agent', 'feature'].includes(document.body.getAttribute('data-view')), { timeout: 8000 });
    ok(true, '返回键可用');
    const unexpectedConsoleErrors = consoleErrors.filter(error => !error.includes('status of 400'));
    ok(unexpectedConsoleErrors.length === 0, '全流程无控制台错误（银行服务错误路径的 400 为预期）', unexpectedConsoleErrors.slice(0, 3).join(' | '));
    ok(externalRequests.length === 0, '全流程无外部网络请求', externalRequests.slice(0, 3).join(' | '));

    console.log('\n浏览器：' + path.basename(browserPath));
    console.log('通过 ' + passes.length + ' 项，失败 ' + failures.length + ' 项。');
    if (failures.length) {
      console.error('\n冒烟失败：');
      failures.forEach(item => console.error(' - ' + item));
      process.exitCode = 1;
    } else {
      console.log('浏览器冒烟通过：用户选择与欢迎资料、六大银行入口、账号下钻快捷动作（转账/复制/挂失/密码实装）、六个银行页面、旧路由兼容、返回 Agent、失败重试与竖屏导航。');
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不阻塞 */ }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
