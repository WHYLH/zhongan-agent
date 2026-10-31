import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ensureServiceTables, openDatabase, verifyAuditChain } from '../db.mjs';
import { encryptWecom, wecomSignature } from '../channels/im.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const failures = [];
const passes = [];
const AES_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
const WEBHOOK_SECRET = 'visitor-secret';
const WECOM_TOKEN = 'visitor-token';
const CORP = 'wx-visitor-corp';

function ok(condition, label, detail = '') {
  if (condition) {
    passes.push(label);
    console.log('  ok  ' + label + (detail ? ' — ' + detail : ''));
  } else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.error('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

async function waitForServer(url) {
  for (let i = 0; i < 120; i += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch (error) { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error('server did not start');
}

async function waitFor(check, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await check(); if (value) return value; } catch (error) { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

function readOne(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout = 3000;'); return db.prepare(sql).get(...params) || null; } finally { db.close(); }
}

function cookieFrom(response) {
  const all = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const jar = {};
  for (const line of all) {
    const pair = line.split(';')[0];
    const index = pair.indexOf('=');
    if (index > 0) jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return jar;
}

const cookieHeader = jar => Object.entries(jar).map(([key, value]) => key + '=' + value).join('; ');

function wecomXml({ from, text, msgId, chatId = '' }) {
  return '<xml><ToUserName><![CDATA[' + CORP + ']]></ToUserName>' +
    '<FromUserName><![CDATA[' + from + ']]></FromUserName>' +
    '<CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[' + text + ']]></Content>' +
    '<MsgId>' + msgId + '</MsgId><AgentID>1000002</AgentID>' +
    (chatId ? '<ChatId><![CDATA[' + chatId + ']]></ChatId>' : '') + '</xml>';
}

async function main() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fund-visitor-'));
  const tempDb = path.join(tmpDir, 'finance.sqlite');
  copyFileSync(path.join(ROOT, 'data', 'finance.sqlite'), tempDb);
  {
    const db = openDatabase(tempDb);
    ensureServiceTables(db);
    db.close();
  }
  {
    const db = new DatabaseSync(tempDb);
    db.exec('PRAGMA busy_timeout = 3000;');
    db.prepare(`INSERT OR REPLACE INTO user_policies (user_id, auto_approve, threshold_cents, allow_internal, allow_subscription, allow_utility, updated_at)
      VALUES ('u-lin', 0, 100000, 1, 1, 1, '2026-10-30T10:00:00+08:00')`).run();
    db.close();
  }
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port + '/';
  const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      FUND_DB_PATH: tempDb,
      FUND_AI_CONFIG_DISABLE: '1',
      VISITOR_MODE: '1',
      VISITOR_STORAGE_LIMIT_MB: '0.4',
      VISITOR_TEMPLATE_USER: 'u-lin',
      WEBHOOK_SECRET,
      WECOM_TOKEN,
      WECOM_CORP_ID: CORP,
      WECOM_AGENT_ID: '1000002',
      WECOM_ENCODING_AES_KEY: AES_KEY,
      WECOM_DRY_RUN: '1',
      IM_ALLOW_USER_ID_FALLBACK: '0',
      PUBLIC_BASE_URL: base.replace(/\/$/, '')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', chunk => process.stderr.write('[server] ' + chunk));

  try {
    await waitForServer(base + 'api/health');

    console.log('\n[1] 访客身份与工作区创建');
    let response = await fetch(base);
    let jarA = cookieFrom(response);
    ok(response.status === 200 && jarA.zhongan_vid && jarA.zhongan_uid, '首次访问分配访客 Cookie', JSON.stringify({ vid: Boolean(jarA.zhongan_vid), uid: jarA.zhongan_uid }));
    const uidA = jarA.zhongan_uid;
    ok(uidA.startsWith('v-'), '访客用户 id 为独立前缀', uidA);

    response = await fetch(base + 'api/bank/users', { headers: { cookie: cookieHeader(jarA) } });
    let data = await response.json();
    ok(response.status === 200 && data.items.length === 1 && data.items[0].id === uidA, '用户列表只返回当前访客', JSON.stringify(data.items.map(item => item.id)));

    response = await fetch(base + 'api/finance/summary', { headers: { cookie: cookieHeader(jarA) } });
    data = await response.json();
    ok(response.status === 200 && data.user === uidA, '请求中的 userId 被服务端强制为访客', String(data.user));

    const clonedTransactions = readOne(tempDb, `SELECT COUNT(*) AS n FROM transactions WHERE account_id IN (SELECT account_id FROM account_ownership WHERE user_id = ?)`, [uidA]);
    ok(clonedTransactions && clonedTransactions.n === 200, '访客工作区克隆 200 条流水', String(clonedTransactions && clonedTransactions.n));
    const templatePolicy = readOne(tempDb, `SELECT auto_approve FROM user_policies WHERE user_id = 'u-lin'`);
    ok(templatePolicy && templatePolicy.auto_approve === 0, '模板用户策略未被改动');

    response = await fetch(base, { headers: { cookie: cookieHeader(jarA) } });
    const jarARepeat = cookieFrom(response);
    response = await fetch(base + 'api/bank/users', { headers: { cookie: cookieHeader(jarA) } });
    data = await response.json();
    ok(data.items[0].id === uidA, '同一浏览器重复访问仍是同一访客', uidA + ' / repeat=' + Object.keys(jarARepeat).length);

    console.log('\n[2] 双访客隔离');
    response = await fetch(base);
    const jarB = cookieFrom(response);
    const uidB = jarB.zhongan_uid;
    ok(uidB && uidB !== uidA, '第二个访客获得不同用户', uidA + ' vs ' + uidB);

    response = await fetch(base + 'api/bank/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(jarA) },
      body: JSON.stringify({ userId: 'u-lin', autoApprove: true, thresholdYuan: 4000 })
    });
    data = await response.json();
    ok(response.status === 200 && data.policy && data.policy.userId === uidA && data.policy.autoApprove === true, '访客 A 修改自己的策略', JSON.stringify(data.policy && { user: data.policy.userId, auto: data.policy.autoApprove }));

    response = await fetch(base + 'api/bank/policy', { headers: { cookie: cookieHeader(jarB) } });
    data = await response.json();
    ok(data.policy && data.policy.userId === uidB && data.policy.autoApprove === false, '访客 B 策略不受影响', JSON.stringify(data.policy && { user: data.policy.userId, auto: data.policy.autoApprove }));
    const templatePolicyAfter = readOne(tempDb, `SELECT auto_approve FROM user_policies WHERE user_id = 'u-lin'`);
    ok(templatePolicyAfter && templatePolicyAfter.auto_approve === 0, '模板用户策略仍未被改动');

    response = await fetch(base + 'api/bank/directory', { headers: { cookie: cookieHeader(jarA) } });
    data = await response.json();
    ok(response.status === 200 && data.items.length === 0, '访客目录不暴露其他用户', String(data.items.length));

    response = await fetch(base + 'api/bank/users/u-lin/overview', { headers: { cookie: cookieHeader(jarA) } });
    ok(response.status === 403, '访客不能查看模板用户资料', response.status);

    console.log('\n[3] 访客对话与审计归属');
    response = await fetch(base + 'api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(jarA) },
      body: JSON.stringify({ userId: 'u-lin', text: '我想进入理财页' })
    });
    data = await response.json();
    ok(response.status === 200 && /理财/.test(data.plan && data.plan.summary || ''), '访客对话使用自己的上下文', (data.plan && data.plan.summary || '').slice(0, 40));
    const visitorAudit = readOne(tempDb, `SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND channel = 'web'`, [uidA]);
    ok(visitorAudit && visitorAudit.n >= 1, '访客审计记录归属自己', String(visitorAudit && visitorAudit.n));

    console.log('\n[4] 企业微信自动开通与绑定合并');
    const autoMsg = 'visitor-wecom-auto-1';
    let ts = Math.floor(Date.now() / 1000);
    let signature = wecomSignature({ token: WECOM_TOKEN, timestamp: String(ts), nonce: 'n1', encrypt: '' });
    let wecomResponse = await fetch(base + 'channel/wecom/callback?msg_signature=' + signature + '&timestamp=' + ts + '&nonce=n1', {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: wecomXml({ from: 'visitor-user-1', text: '我想进入理财页', msgId: autoMsg })
    });
    await wecomResponse.text();
    const autoRow = await waitFor(() => {
      const row = readOne(tempDb, `SELECT * FROM channel_messages WHERE channel = 'wecom' AND message_id = ?`, [autoMsg]);
      return row && row.status !== 'processing' ? row : null;
    });
    ok(Boolean(autoRow) && String(autoRow.user_id).startsWith('w-'), '企微新用户自动开通独立工作区', autoRow ? autoRow.user_id : 'timeout');

    const autoMsg2 = 'visitor-wecom-auto-2';
    ts = Math.floor(Date.now() / 1000);
    signature = wecomSignature({ token: WECOM_TOKEN, timestamp: String(ts), nonce: 'n2', encrypt: '' });
    wecomResponse = await fetch(base + 'channel/wecom/callback?msg_signature=' + signature + '&timestamp=' + ts + '&nonce=n2', {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: wecomXml({ from: 'visitor-user-2', text: '我想进入资产页', msgId: autoMsg2 })
    });
    await wecomResponse.text();
    const autoRow2 = await waitFor(() => {
      const row = readOne(tempDb, `SELECT * FROM channel_messages WHERE channel = 'wecom' AND message_id = ?`, [autoMsg2]);
      return row && row.status !== 'processing' ? row : null;
    });
    ok(Boolean(autoRow2) && autoRow2.user_id !== autoRow.user_id, '不同企微用户得到不同工作区', autoRow2 ? autoRow2.user_id : 'timeout');

    response = await fetch(base + 'api/bank/channel/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(jarA) },
      body: JSON.stringify({ channel: 'wecom', providerUserId: 'visitor-bind-x' })
    });
    data = await response.json();
    ok(response.status === 200 && data.bindings.some(item => item.providerUserId === 'visitor-bind-x'), '访客可绑定企微 UserID');
    const bindMsg = 'visitor-wecom-bind-1';
    ts = Math.floor(Date.now() / 1000);
    signature = wecomSignature({ token: WECOM_TOKEN, timestamp: String(ts), nonce: 'n3', encrypt: '' });
    wecomResponse = await fetch(base + 'channel/wecom/callback?msg_signature=' + signature + '&timestamp=' + ts + '&nonce=n3', {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: wecomXml({ from: 'visitor-bind-x', text: '我想进入贷款页', msgId: bindMsg })
    });
    await wecomResponse.text();
    const bindRow = await waitFor(() => {
      const row = readOne(tempDb, `SELECT * FROM channel_messages WHERE channel = 'wecom' AND message_id = ?`, [bindMsg]);
      return row && row.status !== 'processing' ? row : null;
    });
    ok(Boolean(bindRow) && bindRow.user_id === uidA, '绑定后企微消息进入网页访客工作区', bindRow ? bindRow.user_id : 'timeout');

    const wecomTicketMsg = 'visitor-wecom-ticket-1';
    ts = Math.floor(Date.now() / 1000);
    signature = wecomSignature({ token: WECOM_TOKEN, timestamp: String(ts), nonce: 'n4', encrypt: '' });
    wecomResponse = await fetch(base + 'channel/wecom/callback?msg_signature=' + signature + '&timestamp=' + ts + '&nonce=n4', {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: wecomXml({ from: 'visitor-ticket-user', text: '缴电费100元', msgId: wecomTicketMsg })
    });
    await wecomResponse.text();
    const wecomTicketRow = await waitFor(() => {
      const row = readOne(tempDb, `SELECT * FROM channel_messages WHERE channel = 'wecom' AND message_id = ?`, [wecomTicketMsg]);
      return row && row.status !== 'processing' ? row : null;
    });
    ok(Boolean(wecomTicketRow) && String(wecomTicketRow.user_id).startsWith('w-'), '企微票据归属企微工作区而非随机网页访客', wecomTicketRow ? wecomTicketRow.user_id : 'timeout');
    const wecomTicket = readOne(tempDb, `SELECT user_id FROM agent_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [wecomTicketRow ? wecomTicketRow.user_id : '']);
    ok(Boolean(wecomTicket) && String(wecomTicket.user_id).startsWith('w-'), 'IM 内部调用不误建访客工作区', wecomTicket ? wecomTicket.user_id : 'none');

    console.log('\n[5] 容量淘汰');
    const beforeProfiles = readOne(tempDb, 'SELECT COUNT(*) AS n FROM visitor_profiles').n;
    let lastJar = null;
    for (let i = 0; i < 5; i += 1) {
      const created = await fetch(base);
      const jar = cookieFrom(created);
      lastJar = jar;
      await created.text();
    }
    const afterProfiles = readOne(tempDb, 'SELECT COUNT(*) AS n FROM visitor_profiles').n;
    ok(afterProfiles <= beforeProfiles + 2 && afterProfiles >= 1, '连续新建访客时按容量淘汰旧工作区', 'before=' + beforeProfiles + ' after=' + afterProfiles);
    const stillThere = lastJar && readOne(tempDb, 'SELECT COUNT(*) AS n FROM app_users WHERE id = ?', [lastJar.zhongan_uid]);
    ok(stillThere && stillThere.n === 1, '最新访客保留', lastJar ? lastJar.zhongan_uid : 'none');
    const templateAccounts = readOne(tempDb, `SELECT COUNT(*) AS n FROM accounts a JOIN account_ownership o ON o.account_id = a.id WHERE o.user_id = 'u-lin'`);
    ok(templateAccounts && templateAccounts.n === 7, '模板账户未被淘汰影响', String(templateAccounts && templateAccounts.n));
    const auditDb = openDatabase(tempDb, { readOnly: true });
    const chain = verifyAuditChain(auditDb, { limit: 200 });
    auditDb.close();
    ok(chain.valid === true, '淘汰访客后全局审计链仍完整', JSON.stringify(chain));
  } finally {
    server.kill();
    await new Promise(resolve => {
      if (server.exitCode !== null) return resolve();
      server.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { rmSync(tmpDir, { recursive: true, force: true }); break; } catch (error) {
        if (attempt === 9) console.warn('  临时目录清理失败：' + error.message);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  console.log('\n通过 ' + passes.length + ' 项，失败 ' + failures.length + ' 项。');
  if (failures.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});