import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeWebhookSignature, encryptWecom, wecomSignature } from '../channels/im.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AES_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
const WEBHOOK_SECRET = 'demo-secret';
const WECOM_TOKEN = 'demo-token';
const CORP_ID = 'wx-demo-corp';

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
  throw new Error('服务未启动');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fund-im-demo-'));
  const tempDb = path.join(tmpDir, 'finance.sqlite');
  copyFileSync(path.join(ROOT, 'data', 'finance.sqlite'), tempDb);
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
      WEBHOOK_SECRET,
      WECOM_TOKEN,
      WECOM_CORP_ID: CORP_ID,
      WECOM_AGENT_ID: '1000002',
      WECOM_ENCODING_AES_KEY: AES_KEY,
      WECOM_DRY_RUN: '1',
      IM_ALLOW_USER_ID_FALLBACK: '1',
      PUBLIC_BASE_URL: base.replace(/\/$/, '')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  server.stdout.on('data', chunk => {
    const text = String(chunk);
    if (text.includes('wecom dry-run')) process.stdout.write('  ' + text.trim() + '\n');
  });

  try {
    await waitForServer(base + 'api/health');
    console.log('演示服务：' + base + '（临时库，结束自动关闭）\n');

    console.log('[1] 通用 Webhook：签名 + 页面导览');
    const nav = JSON.stringify({ userId: 'u-lin', text: '我想进入理财页', messageId: 'demo-nav-1' });
    const navTs = Math.floor(Date.now() / 1000);
    let response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-channel-timestamp': String(navTs),
        'x-channel-signature': computeWebhookSignature(WEBHOOK_SECRET, navTs, nav),
        'x-idempotency-key': 'demo-nav-1'
      },
      body: nav
    });
    let data = await response.json();
    console.log('  HTTP ' + response.status);
    console.log('  小安：' + data.reply + '\n');

    console.log('[2] 大额转账：生成一次性票据与确认链接');
    const ticketBody = JSON.stringify({ userId: 'u-lin', text: '转5000元给顾清晏', messageId: 'demo-ticket-1' });
    const ticketTs = Math.floor(Date.now() / 1000);
    response = await fetch(base + 'channel/message', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-channel-timestamp': String(ticketTs),
        'x-channel-signature': computeWebhookSignature(WEBHOOK_SECRET, ticketTs, ticketBody),
        'x-idempotency-key': 'demo-ticket-1'
      },
      body: ticketBody
    });
    data = await response.json();
    console.log('  HTTP ' + response.status + ' · ticket=' + data.ticketId);
    console.log('  小安：' + data.reply + '\n');

    console.log('[3] 企业微信：加密 XML 回调（dry-run，不访问外网）');
    const inner = '<xml><ToUserName><![CDATA[' + CORP_ID + ']]></ToUserName>' +
      '<FromUserName><![CDATA[u-lin]]></FromUserName>' +
      '<CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[我想进入贷款页]]></Content>' +
      '<MsgId>demo-wecom-1</MsgId><AgentID>1000002</AgentID></xml>';
    const encrypted = encryptWecom({ encodingAesKey: AES_KEY, message: inner, corpId: CORP_ID });
    const outer = '<xml><ToUserName><![CDATA[' + CORP_ID + ']]></ToUserName><Encrypt><![CDATA[' + encrypted + ']]></Encrypt><AgentID>1000002</AgentID></xml>';
    const wecomTs = Math.floor(Date.now() / 1000);
    const nonce = 'demo-nonce';
    const signature = wecomSignature({ token: WECOM_TOKEN, timestamp: String(wecomTs), nonce, encrypt: encrypted });
    response = await fetch(base + 'channel/wecom/callback?msg_signature=' + signature + '&timestamp=' + wecomTs + '&nonce=' + nonce, {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: outer
    });
    const ack = await response.text();
    console.log('  HTTP ' + response.status);
    console.log('  被动回执：' + ack.slice(0, 120) + '…');
    await sleep(1200);
    console.log('  服务端 dry-run 日志中可看到 message/send 出站包；真实发送需企业凭据。\n');

    console.log('演示完成：Webhook 验签、幂等、票据链接、企微解密与异步回执均已跑通。');
    console.log('真实企业微信联调需要：WECOM_CORP_ID / AGENT_ID / SECRET / TOKEN / EncodingAESKey + 公网 HTTPS 回调。');
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
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});