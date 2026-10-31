import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function computeWebhookSignature(secret, timestamp, rawBody) {
  return 'sha256=' + createHmac('sha256', String(secret)).update(String(timestamp) + '\n' + rawBody).digest('hex');
}

export function verifyWebhookSignature({ secret, timestamp, signature, rawBody, maxSkewSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!secret) return { ok: false, reason: 'missing_secret' };
  if (!timestamp || !signature) return { ok: false, reason: 'missing_signature' };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(nowSeconds - seconds) > maxSkewSeconds) return { ok: false, reason: 'timestamp_out_of_window' };
  const expected = computeWebhookSignature(secret, timestamp, rawBody);
  const actual = String(signature);
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, reason: 'signature_invalid' };
  return { ok: true, reason: '' };
}

export function wecomSignature({ token, timestamp, nonce, encrypt = '' }) {
  const parts = [String(token), String(timestamp), String(nonce), String(encrypt || '')].sort();
  return createHash('sha1').update(parts.join('')).digest('hex');
}

export function verifyWecomSignature({ token, timestamp, nonce, signature, encrypt = '' }) {
  if (!token) return { ok: false, reason: 'missing_token' };
  if (!timestamp || !nonce || !signature) return { ok: false, reason: 'missing_signature' };
  const expected = wecomSignature({ token, timestamp, nonce, encrypt });
  const left = Buffer.from(expected);
  const right = Buffer.from(String(signature));
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, reason: 'signature_invalid' };
  return { ok: true, reason: '' };
}

function wecomKey(encodingAesKey) {
  const key = Buffer.from(String(encodingAesKey || '') + '=', 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 必须是 43 位 Base64 字符');
  return key;
}

function unpad(buffer) {
  const pad = buffer[buffer.length - 1];
  if (!pad || pad > 32 || pad > buffer.length) throw new Error('AES 填充无效');
  for (let i = buffer.length - pad; i < buffer.length; i += 1) {
    if (buffer[i] !== pad) throw new Error('AES 填充无效');
  }
  return buffer.subarray(0, buffer.length - pad);
}

export function decryptWecom({ encodingAesKey, encrypted, corpId = '' }) {
  const key = wecomKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const ciphertext = Buffer.from(String(encrypted || ''), 'base64');
  if (!ciphertext.length || ciphertext.length % 16 !== 0) throw new Error('AES 密文长度无效');
  const plain = unpad(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  if (plain.length < 20) throw new Error('AES 明文长度无效');
  const messageLength = plain.readUInt32BE(16);
  if (20 + messageLength > plain.length) throw new Error('AES 消息长度无效');
  const message = plain.subarray(20, 20 + messageLength).toString('utf8');
  const actualCorpId = plain.subarray(20 + messageLength).toString('utf8');
  if (corpId && actualCorpId !== corpId) throw new Error('CorpID 不匹配');
  return { message, corpId: actualCorpId };
}

export function encryptWecom({ encodingAesKey, message, corpId = '' }) {
  const key = wecomKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const random = randomBytes(16);
  const messageBuffer = Buffer.from(String(message), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(messageBuffer.length, 0);
  const raw = Buffer.concat([random, length, messageBuffer, Buffer.from(String(corpId), 'utf8')]);
  const pad = 32 - (raw.length % 32);
  const padded = Buffer.concat([raw, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseWecomXml(xml) {
  const text = String(xml || '').replace(/<\/?xml>/gi, '');
  const fields = {};
  const pattern = /<([A-Za-z0-9_]+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\1>/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const key = match[1];
    fields[key] = decodeEntities(match[2] !== undefined ? match[2] : match[3]).trim();
  }
  return fields;
}

function cdata(value) {
  return String(value == null ? '' : value).replace(/]]>/g, ']]]]><![CDATA[>');
}

export function buildWecomTextXml(toUser, content, fromUser = '众安') {
  return '<xml>' +
    '<ToUserName><![CDATA[' + cdata(toUser) + ']]></ToUserName>' +
    '<FromUserName><![CDATA[' + cdata(fromUser) + ']]></FromUserName>' +
    '<CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    '<Content><![CDATA[' + cdata(content) + ']]></Content>' +
    '</xml>';
}

export function channelSessionId({ channel, userId, chatId = '' }) {
  if (channel === 'wecom' && chatId) return 'wecom:group:' + chatId + ':' + userId;
  return channel + ':' + userId;
}

let tokenCache = { value: '', expiresAt: 0 };

export function resetWecomTokenCache() {
  tokenCache = { value: '', expiresAt: 0 };
}

export async function getWecomAccessToken({ corpId, secret, fetchImpl = fetch, force = false }) {
  if (!corpId || !secret) throw new Error('缺少 WECOM_CORP_ID 或 WECOM_SECRET');
  if (!force && tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const url = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=' + encodeURIComponent(corpId) + '&corpsecret=' + encodeURIComponent(secret);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (data.errcode !== 0 || typeof data.access_token !== 'string') {
    throw new Error('获取企业微信 token 失败：' + (data.errmsg || '未知原因'));
  }
  const expiresIn = Number(data.expires_in) || 7200;
  tokenCache = { value: data.access_token, expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000 };
  return tokenCache.value;
}

export async function sendWecomText({
  corpId, agentId, secret, toUser = '', chatId = '', text,
  dryRun = false, fetchImpl = fetch
}) {
  const body = {
    msgtype: 'text',
    agentid: Number(agentId || 0),
    text: { content: String(text || '').slice(0, 2048) }
  };
  if (chatId) body.chatid = chatId;
  else body.touser = toUser;
  if (dryRun) {
    console.log('[wecom dry-run] ' + JSON.stringify(body));
    return { ok: true, dryRun: true, body };
  }
  let token = await getWecomAccessToken({ corpId, secret, fetchImpl });
  let response = await fetchImpl('https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  let data = await response.json();
  if (data.errcode === 40014 || data.errcode === 42001) {
    resetWecomTokenCache();
    token = await getWecomAccessToken({ corpId, secret, fetchImpl, force: true });
    response = await fetchImpl('https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    data = await response.json();
  }
  if (data.errcode !== 0) throw new Error('企业微信发送失败：' + (data.errmsg || '未知原因'));
  return { ok: true, msgId: data.msgid || null };
}