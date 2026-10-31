import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/Ebony-Vinyl/dsh-our-free-model.git';
const REPO = path.resolve(process.env.OFM_REPO || path.join(ROOT, 'vendor', 'dsh-our-free-model'));
const DATA = path.resolve(process.env.OFM_HOME || path.join(os.homedir(), '.our-free-model'));
const REQUESTED_PORT = Number(process.env.OFM_PORT || 18900);
let runtimePort = REQUESTED_PORT;
const MODEL = process.env.OFM_MODEL || 'kilo-auto/free';
const APP_PORT = Number(process.env.PORT || 4173);
const QWEN_TTS_PORT = Number(process.env.QWEN_TTS_PORT || 7861);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function ensureDatabase() {
  const database = path.join(ROOT, 'data', 'finance.sqlite');
  if (fs.existsSync(database)) return;
  const seed = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-db.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  if (seed.status !== 0) throw new Error('SQLite 数据库初始化失败');
}

function request(port, pathname, timeoutMs = 1200, headers = {}) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

async function gatewayReady() {
  const result = await request(runtimePort, '/health');
  return result.status === 200;
}

async function qwenTtsReady() {
  const result = await request(QWEN_TTS_PORT, '/v1/models');
  if (result.status !== 200) return false;
  try {
    return String(JSON.parse(result.body).engine || '').includes('Qwen3-TTS');
  } catch {
    return false;
  }
}

async function ensureQwenTts() {
  if (process.env.QWEN_TTS_AUTOSTART === '0' || await qwenTtsReady()) return;
  const launcher = path.join(ROOT, 'scripts', 'start-qwen-tts.cmd');
  if (!fs.existsSync(launcher)) return;
  const child = spawn('cmd.exe', ['/d', '/c', launcher], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  for (let i = 0; i < 60; i += 1) {
    if (await qwenTtsReady()) {
      console.log(`[qwen-tts] Qwen3-TTS-0.6B 已就绪：http://127.0.0.1:${QWEN_TTS_PORT}`);
      return;
    }
    await sleep(500);
  }
  console.log('[qwen-tts] 本地服务仍在启动，应用先行启动，语音接口会继续探测。');
}

function candidateDataDirs() {
  return [...new Set([
    process.env.OFM_HOME,
    DATA,
    path.join(os.tmpdir(), 'ofm-data'),
    path.join(os.homedir(), '.our-free-model')
  ].filter(Boolean))];
}

async function findWorkingKey(port) {
  for (const dir of candidateDataDirs()) {
    try {
      const key = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).forwardKey || '';
      if (!key) continue;
      const result = await request(port, '/v1/models', 2500, { Authorization: `Bearer ${key}` });
      if (result.status === 200) return key;
    } catch {}
  }
  return '';
}

function findCli() {
  const cli = path.join(REPO, 'packages', 'standalone', 'cli.mjs');
  return fs.existsSync(cli) ? cli : '';
}

function cloneRepo() {
  fs.mkdirSync(path.dirname(REPO), { recursive: true });
  const result = spawn('git', ['clone', '--depth', '1', REPO_URL, REPO], { stdio: 'inherit', windowsHide: true });
  return new Promise((resolve, reject) => {
    result.once('error', reject);
    result.once('exit', code => code === 0 ? resolve() : reject(new Error(`GitHub 仓库拉取失败（退出码 ${code}）`)));
  });
}

async function ensureRepo() {
  if (findCli()) return;
  await cloneRepo();
  if (!findCli()) throw new Error(`未找到独立网关入口：${path.join(REPO, 'packages', 'standalone', 'cli.mjs')}`);
}

async function ensureGateway() {
  if (await gatewayReady() && await findWorkingKey(runtimePort)) return;
  if (await gatewayReady()) {
    for (let port = REQUESTED_PORT + 1; port < REQUESTED_PORT + 20; port += 1) {
      if ((await request(port, '/health')).status === 0) { runtimePort = port; break; }
    }
  }
  await ensureRepo();
  fs.mkdirSync(DATA, { recursive: true });
  const logPath = path.join(DATA, 'service.log');
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [findCli(), '--port', String(runtimePort), '--data-dir', DATA], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true
  });
  child.unref();
  for (let i = 0; i < 120; i += 1) {
    if (await gatewayReady()) return;
    await sleep(500);
  }
  throw new Error(`免费模型网关未在 60 秒内就绪，请查看 ${logPath}`);
}

async function readKey() {
  const key = process.env.OFM_API_KEY || await findWorkingKey(runtimePort);
  if (!key) throw new Error('免费模型网关已启动，但没有找到本机 API Key');
  return key;
}

ensureDatabase();
await ensureQwenTts();
await ensureGateway();
const key = await readKey();
console.log(`[free-model] dsh-our-free-model → http://127.0.0.1:${runtimePort}/v1 · ${MODEL}`);

const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    AGGREGATOR_BASE_URL: `http://127.0.0.1:${runtimePort}/v1`,
    AGGREGATOR_API_KEY: key,
    AGGREGATOR_MODEL: MODEL
  }
});

app.once('exit', code => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.kill(signal));
