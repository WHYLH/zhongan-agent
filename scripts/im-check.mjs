import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ensureServiceTables, openDatabase } from '../db.mjs';
import {
  computeWebhookSignature,
  decryptWecom,
  encryptWecom,
  getWecomAccessToken,
  parseWecomXml,
  resetWecomTokenCache,
  sendWecomText,
  wecomSignature
} from '../channels/im.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const failures = [];
const passes = [];
let seq = 0;

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
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error('server did not start');
}

async function waitFor(check, timeout = 12000, interval = 150) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return null;
}

function readRows(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 3000;');
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function readOne(dbPath, sql, params = []) {
  const rows = readRows(dbPath, sql, params);
  return rows.length ? rows[0] : null;
}

function messageId(label) {
  seq += 1;
  return 'imtest-' + label + '-' + seq;
}

function webhookHeaders(raw, messageIdValue, timestamp = Math.floor(Date.now() / 1000), secret = 'demo-secret') {
  const signature = 'sha256=' + createHmac('sha256', secret).update(String(timestamp) + '\n' + raw).digest('hex');
  return {
    'content-type': 'application/json',
    'x-channel-timestamp': String(timestamp),
    'x-channel-signature': signature,
    'x-idempotency-key': messageIdValue
  };
}

function wecomXml({ from = 'u-lin', text = '我想进入理财页', msgId, chatId = '' }) {
  return '<xml>' +
    '<ToUserName><![CDATA[wx-demo-corp]]></ToUserName>' +
    '<FromUserName><![CDATA[' + from + ']]></FromUserName>' +
    '<CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    '<Content><![CDATA[' + text + ']]></Content>' +
    '<MsgId>' + msgId + '</MsgId>' +
    '<AgentID>1000002</AgentID>' +
    (chatId ? '<ChatId><![CDATA[' + chatId + ']]></ChatId>' : '') +
    '</xml>';
}

function signedWecomUrl({ timestamp, nonce, signature, extra = '' }) {
  return 'msg_signature=' + encodeURIComponent(signature) + '&timestamp=' + encodeURIComponent(timestamp) + '&nonce=' + encodeURIComponent(nonce) + extra;
}

async function main() {
  console.log('\n[0] 协议算法自检');
  ok(computeWebhookSignature('demo-secret', '1700000000', '{"userId":"u-lin","text":"查一下余额","messageId":"msg-001"}') === 'sha256=e717f7f25a41777b9bddfb9f156b177b2dde9d9ad2911c0291dd6d295b0b3447', 'Webhook HMAC 测试向量一致');
  ok(wecomSignature({ token: 'demo-token', timestamp: '1700000000', nonce: 'abc', encrypt: 'hello' }) === 'da3927074977408af2827d99de2d4983e92b66c3', '企业微信 SHA-1 测试向量一致');
  const aesKey = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
  const encrypted = encryptWecom({ encodingAesKey: aesKey, message: '<xml><Content><![CDATA[hello]]></Content></xml>', corpId: 'wx-demo-corp' });
  const decrypted = decryptWecom({ encodingAesKey: aesKey, encrypted, corpId: 'wx-demo-corp' });
  ok(decrypted.message.includes('hello') && decrypted.corpId === 'wx-demo-corp', '企业微信 AES 加解密往返一致');
  ok(parseWecomXml('<xml><FromUserName><![CDATA[u-lin]]></FromUserName><Content>&lt;余额&gt;</Content></xml>').Content === '<余额>', '企业微信 XML CDATA 与实体解析正确');
  let tokenCalls = 0;
  resetWecomTokenCache();
  const fakeFetch = async () => {
    tokenCalls += 1;
    return { json: async () => ({ errcode: 0, access_token: 'fake-token', expires_in: 7200 }) };
  };
  const tokenOne = await getWecomAccessToken({ corpId: 'corp', secret: 'secret', fetchImpl: fakeFetch });
  const tokenTwo = await getWecomAccessToken({ corpId: 'corp', secret: 'secret', fetchImpl: fakeFetch });
  ok(tokenOne === 'fake-token' && tokenTwo === 'fake-token' && tokenCalls === 1, 'access_token 缓存命中，未重复取 token');
  resetWecomTokenCache();

  let sendCalls = 0;
  let retryTokenCalls = 0;
  const retryFetch = async (url) => {
    if (String(url).includes('/gettoken')) {
      retryTokenCalls += 1;
      return { json: async () => ({ errcode: 0, access_token: 'token-' + retryTokenCalls, expires_in: 7200 }) };
    }
    sendCalls += 1;
    if (sendCalls === 1) return { json: async () => ({ errcode: 40014, errmsg: 'invalid token' }) };
    return { json: async () => ({ errcode: 0, msgid: 'msg-ok' }) };
  };
  const sent = await sendWecomText({ corpId: 'corp', agentId: 1, secret: 'secret', toUser: 'u-lin', text: '测试', fetchImpl: retryFetch });
  ok(sent.ok === true && sent.msgId === 'msg-ok' && sendCalls === 2 && retryTokenCalls === 2, 'token 失效时清缓存并重试一次', JSON.stringify({ sendCalls, retryTokenCalls }));
  resetWecomTokenCache();

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fund-im-'));
  const tempDb = path.join(tmpDir, 'finance.sqlite');
  copyFileSync(path.join(ROOT, 'data', 'finance.sqlite'), tempDb);
  {
    const db = openDatabase(tempDb);
    ensureServiceTables(db);
    db.exec('PRAGMA busy_timeout = 3000;');
    db.prepare(`INSERT INTO channel_bindings (channel, provider_user_id, user_id, corp_id, created_at, updated_at)
      VALUES ('wecom', 'bound-user', 'u-gu', 'wx-demo-corp', '2026-10-30T10:00:00+08:00', '2026-10-30T10:00:00+08:00')
      ON CONFLICT(channel, provider_user_id) DO UPDATE SET user_id = excluded.user_id`).run();
    db.prepare(`INSERT OR REPLACE INTO agent_tickets
      (id, user_id, session_id, channel, tool, label, args_json, digest, plan_id, status, expires_at, created_at, used_at)
      VALUES ('agt-expired-test', 'u-lin', 'wecom:u-lin', 'wecom', 'transfer_money', '过期测试', ?, NULL, NULL, 'pending', '2020-01-01T00:00:00.000Z', '2026-10-30T10:00:00+08:00', NULL)`)
      .run(JSON.stringify({ amountYuan: 100, counterparty: '顾清晏' }));
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
      WEBHOOK_SECRET: 'demo-secret',
      WECOM_TOKEN: 'demo-token',
      WECOM_CORP_ID: 'wx-demo-corp',
      WECOM_AGENT_ID: '1000002',
      WECOM_ENCODING_AES_KEY: aesKey,
      WECOM_DRY_RUN: '1',
      IM_ALLOW_USER_ID_FALLBACK: '1',
      PUBLIC_BASE_URL: base.replace(/\/$/, '')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', chunk => process.stderr.write('[server] ' + chunk));

  try {
    await waitForServer(base + 'api/health');
    console.log('\n[1] Webhook 签名、幂等与错误语义');

    const navText = '我想进入理财页，该在哪里？';
    const navBody = JSON.stringify({ userId: 'u-lin', text: navText, messageId: 'unsigned-1' });
    let response = await fetch(base + 'channel/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: navBody });
    ok(response.status === 401, '未签名 Webhook 被拒绝', response.status);

    const staleTs = Math.floor(Date.now() / 1000) - 3600;
    response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: webhookHeaders(navBody, 'stale-1', staleTs),
      body: navBody
    });
    ok(response.status === 401, '过期时间戳被拒绝', response.status);

    const wrongSecretBody = JSON.stringify({ userId: 'u-lin', text: '查余额', messageId: 'wrong-secret-1' });
    response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: webhookHeaders(wrongSecretBody, 'wrong-secret-1', Math.floor(Date.now() / 1000), 'wrong-secret'),
      body: wrongSecretBody
    });
    ok(response.status === 401, '错误密钥签名被拒绝', response.status);

    const ghostBody = JSON.stringify({ userId: 'ghost-user', text: '查余额', messageId: 'ghost-1' });
    response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: webhookHeaders(ghostBody, 'ghost-1'),
      body: ghostBody
    });
    ok(response.status === 400, '不存在的 Webhook 用户被拒绝', response.status);

    const msg1 = messageId('nav');
    response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: webhookHeaders(navBody, msg1),
      body: navBody
    });
    let payload = await response.json();
    ok(response.status === 200 && payload.ok === true, '正确签名 Webhook 返回 200', response.status);
    ok(/理财/.test(payload.reply || ''), 'Webhook 回复引用理财页导览', (payload.reply || '').slice(0, 80));
    ok(payload.planId && payload.auditSeq >= 1, 'Webhook 返回 planId 与 auditSeq', JSON.stringify({ planId: payload.planId, auditSeq: payload.auditSeq }));

    const firstReply = payload.reply;
    response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: webhookHeaders(navBody, msg1),
      body: navBody
    });
    payload = await response.json();
    const count = readOne(tempDb, 'SELECT COUNT(*) AS n FROM channel_messages WHERE channel = ? AND message_id = ?', ['webhook', msg1]);
    ok(response.status === 200 && payload.reply === firstReply && count.n === 1, '同一 messageId 重放返回缓存且只落一条', 'rows=' + count.n);

    const changedBody = JSON.stringify({ userId: 'u-lin', text: navText + '（改）', messageId: msg1 });
    response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: webhookHeaders(changedBody, msg1),
      body: changedBody
    });
    ok(response.status === 409, '同一 messageId 内容变化返回 409', response.status);

    const passwordBody = JSON.stringify({ userId: 'u-lin', text: '查一下余额', password: '123456', messageId: 'pwd-1' });
    response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: webhookHeaders(passwordBody, 'pwd-1'),
      body: passwordBody
    });
    const pwdPayload = await response.json();
    ok(response.status === 400 && pwdPayload.error && pwdPayload.error.code === 'IM_PASSWORD_NOT_ALLOWED', 'IM 渠道拒绝支付密码', response.status);

    const huge = JSON.stringify({ userId: 'u-lin', text: 'x'.repeat(40000), messageId: 'huge-1' });
    response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: webhookHeaders(huge, 'huge-1'),
      body: huge
    });
    ok(response.status === 413, '请求体超过 32KB 返回 413', response.status);

    console.log('\n[2] 企业微信 GET 验签与解密');
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'nonce-get';
    const echoSignature = wecomSignature({ token: 'demo-token', timestamp: String(ts), nonce, encrypt: 'hello' });
    let wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: ts, nonce, signature: echoSignature, extra: '&echostr=hello' }));
    let text = await wecomResponse.text();
    ok(wecomResponse.status === 200 && text === 'hello', 'GET 明文验签通过并回显 echostr', text);

    wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: ts, nonce, signature: 'bad', extra: '&echostr=hello' }));
    ok(wecomResponse.status === 401, 'GET 错误签名返回 401', wecomResponse.status);

    const encryptedEcho = encryptWecom({ encodingAesKey: aesKey, message: 'hello-encrypted', corpId: 'wx-demo-corp' });
    const encryptedEchoSignature = wecomSignature({ token: 'demo-token', timestamp: String(ts), nonce, encrypt: encryptedEcho });
    wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({
      timestamp: ts, nonce, signature: encryptedEchoSignature, extra: '&echostr=' + encodeURIComponent(encryptedEcho)
    }));
    text = await wecomResponse.text();
    ok(wecomResponse.status === 200 && text === 'hello-encrypted', 'GET 加密 echostr 解密成功', text);

    console.log('\n[3] 企业微信 POST 明文/加密、会话与幂等');
    const msg3 = messageId('wecom-plain');
    const xml = wecomXml({ from: 'u-lin', text: '我想进入理财页', msgId: msg3 });
    const postTs = Math.floor(Date.now() / 1000);
    const postNonce = 'nonce-post';
    const postSignature = wecomSignature({ token: 'demo-token', timestamp: String(postTs), nonce: postNonce, encrypt: '' });
    wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: postTs, nonce: postNonce, signature: postSignature }), {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: xml
    });
    text = await wecomResponse.text();
    ok(wecomResponse.status === 200 && text.includes('已收到'), 'POST 明文 XML 立即 ack', text.slice(0, 60));
    const plainRow = await waitFor(() => {
      const row = readOne(tempDb, 'SELECT * FROM channel_messages WHERE channel = ? AND message_id = ?', ['wecom', msg3]);
      return row && row.status !== 'processing' ? row : null;
    });
    ok(Boolean(plainRow), 'POST 明文异步处理完成', plainRow ? plainRow.status : 'timeout');
    const plainReply = plainRow && plainRow.response_json ? JSON.parse(plainRow.response_json) : {};
    ok(/理财/.test(plainReply.reply || ''), 'POST 明文异步回复内容正确', (plainReply.reply || '').slice(0, 80));

    wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: postTs, nonce: postNonce, signature: postSignature }), {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: xml
    });
    text = await wecomResponse.text();
    const duplicateCount = readOne(tempDb, 'SELECT COUNT(*) AS n FROM channel_messages WHERE channel = ? AND message_id = ?', ['wecom', msg3]);
    ok(wecomResponse.status === 200 && duplicateCount.n === 1, '企微 MsgId 重推只处理一次', 'rows=' + duplicateCount.n);

    const groupMsg = messageId('wecom-group');
    const groupChatId = 'group-2026';
    const groupXml = wecomXml({ from: 'u-lin', text: '我想进入贷款页', msgId: groupMsg, chatId: groupChatId });
    const groupSig = wecomSignature({ token: 'demo-token', timestamp: String(postTs), nonce: 'nonce-group', encrypt: '' });
    wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: postTs, nonce: 'nonce-group', signature: groupSig }), {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: groupXml
    });
    await wecomResponse.text();
    const groupRow = await waitFor(() => {
      const row = readOne(tempDb, 'SELECT * FROM channel_messages WHERE channel = ? AND message_id = ?', ['wecom', groupMsg]);
      return row && row.status !== 'processing' ? row : null;
    });
    ok(Boolean(groupRow) && groupRow.session_id === 'wecom:group:' + groupChatId + ':u-lin', '企微群聊使用独立会话格式', groupRow ? groupRow.session_id : 'timeout');

    const encryptedMsg = messageId('wecom-enc');
    const innerXml = wecomXml({ from: 'u-lin', text: '我想进入资产页', msgId: encryptedMsg });
    const encryptedXml = encryptWecom({ encodingAesKey: aesKey, message: innerXml, corpId: 'wx-demo-corp' });
    const outerXml = '<xml><ToUserName><![CDATA[wx-demo-corp]]></ToUserName><Encrypt><![CDATA[' + encryptedXml + ']]></Encrypt><AgentID>1000002</AgentID></xml>';
    const encTs = Math.floor(Date.now() / 1000);
    const encNonce = 'nonce-enc';
    const encSig = wecomSignature({ token: 'demo-token', timestamp: String(encTs), nonce: encNonce, encrypt: encryptedXml });
    wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: encTs, nonce: encNonce, signature: encSig }), {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: outerXml
    });
    await wecomResponse.text();
    const encRow = await waitFor(() => {
      const row = readOne(tempDb, 'SELECT * FROM channel_messages WHERE channel = ? AND message_id = ?', ['wecom', encryptedMsg]);
      return row && row.status !== 'processing' ? row : null;
    });
    ok(Boolean(encRow), '企微加密 XML 解密并处理完成', encRow ? encRow.status : 'timeout');
    ok(plainReply.reply === firstReply, 'Webhook 与企微对同一句导航请求返回一致计划摘要', (plainReply.reply || '').slice(0, 40));

    const badSignatureXml = wecomXml({ from: 'u-lin', text: '查余额', msgId: messageId('wecom-badsig') });
    wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: postTs, nonce: 'nonce-badsig', signature: 'bad' }), {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: badSignatureXml
    });
    ok(wecomResponse.status === 401, '企微 POST 错误签名返回 401', wecomResponse.status);

    const wrongCorpEncrypted = encryptWecom({ encodingAesKey: aesKey, message: wecomXml({ from: 'u-lin', text: '查余额', msgId: messageId('wecom-wrongcorp') }), corpId: 'other-corp' });
    const wrongCorpOuter = '<xml><ToUserName><![CDATA[wx-demo-corp]]></ToUserName><Encrypt><![CDATA[' + wrongCorpEncrypted + ']]></Encrypt></xml>';
    const wrongCorpSig = wecomSignature({ token: 'demo-token', timestamp: String(encTs), nonce: 'nonce-wrongcorp', encrypt: wrongCorpEncrypted });
    wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: encTs, nonce: 'nonce-wrongcorp', signature: wrongCorpSig }), {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: wrongCorpOuter
    });
    ok(wecomResponse.status === 400, '企微 CorpID 不匹配被拒绝', wecomResponse.status);

    const groupActionMsg = messageId('wecom-group-action');
    const groupActionXml = wecomXml({ from: 'u-lin', text: '转100元给顾清晏', msgId: groupActionMsg, chatId: groupChatId });
    const groupActionTs = Math.floor(Date.now() / 1000);
    const groupActionSig = wecomSignature({ token: 'demo-token', timestamp: String(groupActionTs), nonce: 'nonce-group-action', encrypt: '' });
    wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: groupActionTs, nonce: 'nonce-group-action', signature: groupActionSig }), {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: groupActionXml
    });
    await wecomResponse.text();
    const groupActionRow = await waitFor(() => {
      const row = readOne(tempDb, 'SELECT * FROM channel_messages WHERE channel = ? AND message_id = ?', ['wecom', groupActionMsg]);
      return row && row.status !== 'processing' ? row : null;
    });
    const groupActionReply = groupActionRow && groupActionRow.response_json ? JSON.parse(groupActionRow.response_json) : {};
    ok(/查询模式/.test(groupActionReply.reply || ''), '群聊默认只查询，资金动作被权限门阻断', (groupActionReply.reply || '').slice(0, 80));

    const boundMsg = messageId('wecom-bound');
    const boundXml = wecomXml({ from: 'bound-user', text: '我想进入设置页', msgId: boundMsg });
    const boundSig = wecomSignature({ token: 'demo-token', timestamp: String(postTs), nonce: 'nonce-bound', encrypt: '' });
    wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: postTs, nonce: 'nonce-bound', signature: boundSig }), {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: boundXml
    });
    await wecomResponse.text();
    const boundRow = await waitFor(() => {
      const row = readOne(tempDb, 'SELECT * FROM channel_messages WHERE channel = ? AND message_id = ?', ['wecom', boundMsg]);
      return row && row.status !== 'processing' ? row : null;
    });
    ok(Boolean(boundRow) && boundRow.user_id === 'u-gu', '企微 FromUserName 经绑定表映射到内部用户', boundRow ? boundRow.user_id : 'timeout');

    const outsiderMsg = messageId('wecom-outsider');
    const outsiderXml = wecomXml({ from: 'outsider-001', text: '查余额', msgId: outsiderMsg });
    const outsiderSig = wecomSignature({ token: 'demo-token', timestamp: String(postTs), nonce: 'nonce-outsider', encrypt: '' });
    wecomResponse = await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: postTs, nonce: 'nonce-outsider', signature: outsiderSig }), {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: outsiderXml
    });
    text = await wecomResponse.text();
    ok(text.includes('尚未绑定'), '未绑定企微用户被明确拒绝，不落到 u-lin', text.slice(0, 100));

    console.log('\n[4] 跨渠道票据与确认页');
    const ticketBody = JSON.stringify({ userId: 'u-lin', text: '转5000元给顾清晏', messageId: 'ticket-1' });
    response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: webhookHeaders(ticketBody, 'ticket-1'),
      body: ticketBody
    });
    payload = await response.json();
    ok(response.status === 200 && payload.needsPassword === true && Boolean(payload.ticketId), '大额转账生成待确认票据', JSON.stringify({ status: response.status, ticketId: payload.ticketId }));
    ok((payload.reply || '').includes('/confirm/' + payload.ticketId), '回复包含确认短链接', (payload.reply || '').slice(-120));

    const ticketId = payload.ticketId;
    response = await fetch(base + 'api/agent/ticket/' + encodeURIComponent(ticketId));
    const ticketInfo = await response.json();
    ok(response.status === 200 && ticketInfo.ticket && ticketInfo.ticket.status === 'pending', '票据查询返回待确认状态', JSON.stringify(ticketInfo.ticket || {}));

    response = await fetch(base + 'api/agent/ticket/agt-expired-test');
    const expiredInfo = await response.json();
    ok(response.status === 200 && expiredInfo.ticket.status === 'expired', '过期票据查询标记 expired');
    response = await fetch(base + 'api/agent/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: 'agt-expired-test', password: '123456' })
    });
    ok(response.status === 410, '过期票据确认返回 410', response.status);

    response = await fetch(base + 'confirm/' + ticketId);
    text = await response.text();
    ok(response.status === 200 && text.includes('确认本次操作') && text.includes('支付密码'), '确认页可打开并包含密码表单');

    response = await fetch(base + 'api/agent/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId, password: '123456' })
    });
    payload = await response.json();
    ok(response.status === 200 && payload.ok === true && !payload.needsPassword, '确认页密码执行票据成功', JSON.stringify(payload.plan || {}).slice(0, 80));

    response = await fetch(base + 'api/agent/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId, password: '123456' })
    });
    payload = await response.json();
    ok(response.status === 409 && payload.error && payload.error.code === 'TICKET_USED', '同一票据重复确认返回 409', response.status);

    response = await fetch(base + 'api/agent/ticket/' + encodeURIComponent(ticketId));
    const usedInfo = await response.json();
    ok(response.status === 200 && usedInfo.ticket.status === 'used', '票据状态变为 used');

    response = await fetch(base + 'confirm/' + ticketId);
    text = await response.text();
    ok(response.status === 200 && text.includes('确认信息不可用') && !text.includes('id="confirmForm"'), '已使用票据的确认页不再展示密码表单');

    console.log('\n[5] 审计链与渠道字段');
    const auditResponse = await fetch(base + 'api/bank/audit-chain?user=u-lin&limit=80');
    const audit = await auditResponse.json();
    ok(audit.verify && audit.verify.valid === true, '扩展审计字段后链校验仍然完整', JSON.stringify(audit.verify));
    const channelAudit = readOne(tempDb, "SELECT COUNT(*) AS n FROM audit_log WHERE channel = 'webhook'");
    ok(channelAudit.n >= 1, '审计记录写入 channel=webhook', 'rows=' + channelAudit.n);
    const ticketAudit = readOne(tempDb, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'agent.ticket_confirmed'");
    ok(ticketAudit.n >= 1, '票据确认写入审计', 'rows=' + ticketAudit.n);

    console.log('\n[6] 绑定管理、渠道自测、速率限制与熔断');
    response = await fetch(base + 'api/bank/channel/bindings?user=u-gu');
    const boundList = await response.json();
    ok(response.status === 200 && boundList.bindings && boundList.bindings.some(item => item.providerUserId === 'bound-user'), '绑定列表返回预置企业微信用户');

    response = await fetch(base + 'api/bank/channel/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u-lin', channel: 'wecom', providerUserId: 'wecom-lin' })
    });
    const bindResult = await response.json();
    ok(response.status === 200 && bindResult.bindings.some(item => item.providerUserId === 'wecom-lin'), '设置页绑定新企业微信用户');

    const bindMsg = messageId('wecom-bound-new');
    const bindXml = wecomXml({ from: 'wecom-lin', text: '我想进入资产页', msgId: bindMsg });
    const bindTs = Math.floor(Date.now() / 1000);
    const bindSig = wecomSignature({ token: 'demo-token', timestamp: String(bindTs), nonce: 'nonce-bind-new', encrypt: '' });
    await fetch(base + 'channel/wecom/callback?' + signedWecomUrl({ timestamp: bindTs, nonce: 'nonce-bind-new', signature: bindSig }), {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: bindXml
    }).then(result => result.text());
    const bindRow = await waitFor(() => {
      const row = readOne(tempDb, 'SELECT * FROM channel_messages WHERE channel = ? AND message_id = ?', ['wecom', bindMsg]);
      return row && row.status !== 'processing' ? row : null;
    });
    ok(Boolean(bindRow) && bindRow.user_id === 'u-lin', '新绑定用户消息映射到目标账户', bindRow ? bindRow.user_id : 'timeout');

    response = await fetch(base + 'api/bank/channel/unbind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u-lin', channel: 'wecom', providerUserId: 'wecom-lin' })
    });
    const unbindResult = await response.json();
    ok(response.status === 200 && !unbindResult.bindings.some(item => item.providerUserId === 'wecom-lin'), '解绑后列表移除该用户');

    response = await fetch(base + 'api/channel/selftest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u-lin', text: '这个月花了多少' })
    });
    const selftest = await response.json();
    ok(response.status === 200 && selftest.ok === true && selftest.signed === true, '设置页渠道自测走完整签名 Webhook', response.status);

    const guardBody = JSON.stringify({ userId: 'u-gu', text: '转5000元给沈知微', messageId: 'circuit-ticket-1' });
    response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: webhookHeaders(guardBody, 'circuit-ticket-1'),
      body: guardBody
    });
    const guardPayload = await response.json();
    ok(response.status === 200 && Boolean(guardPayload.ticketId), '熔断测试票据已创建', guardPayload.ticketId);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      response = await fetch(base + 'api/agent/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: guardPayload.ticketId, password: '000000' })
      });
      await response.json();
    }
    response = await fetch(base + 'api/agent/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: guardPayload.ticketId, password: '123456' })
    });
    const circuitPayload = await response.json();
    ok(response.status === 423 && circuitPayload.error && circuitPayload.error.code === 'CIRCUIT_OPEN', '连续 5 次密码失败后资金动作锁定', response.status);
    const circuitAudit = readOne(tempDb, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'security.channel_circuit_open'");
    ok(circuitAudit.n >= 1, '熔断写入审计链', 'rows=' + circuitAudit.n);

    let rateLimited = null;
    for (let i = 0; i < 22; i += 1) {
      const id = 'rate-' + i;
      const raw = JSON.stringify({ userId: 'u-shen', text: '我想进入理财页', messageId: id });
      const result = await fetch(base + 'channel/message', {
        method: 'POST',
        headers: webhookHeaders(raw, id),
        body: raw
      });
      if (result.status === 429) { rateLimited = await result.json(); break; }
      await result.text();
    }
    ok(rateLimited && rateLimited.error && rateLimited.error.code === 'RATE_LIMITED', '同一用户 20 条/分钟后返回 429', rateLimited ? 'retryAfterMs=' + rateLimited.error.retryAfterMs : 'not limited');

    response = await fetch(base + 'api/health');
    const health = await response.json();
    ok(response.status === 200 && health.ok === true, '服务健康检查正常', health.app && health.app.name);
  } finally {
    server.kill();
    await new Promise(resolve => {
      if (server.exitCode !== null) return resolve();
      server.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { rmSync(tmpDir, { recursive: true, force: true }); break; } catch (error) {
        if (attempt === 9) console.warn('  warn  临时目录清理失败：' + error.message);
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