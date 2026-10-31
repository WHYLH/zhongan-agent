/* 内置 TTS 一键安装：sherpa-onnx-node + kokoro 多语中文模型（约 0.1B 参数，CPU 实时）
 * 用法: npm run tts:setup
 * 已装过会跳过；可用 TTS_MODEL_URL 覆盖模型包地址。 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TTS_DIR = path.join(ROOT, 'models', 'tts');
const PKG_DIR = path.join(TTS_DIR, 'kokoro-int8-multi-lang-v1_1');
const MODEL_URL = process.env.TTS_MODEL_URL ||
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2';
const ARCHIVE = path.join(TTS_DIR, 'kokoro.tar.bz2');

function log(msg) { process.stdout.write('[tts:setup] ' + msg + '\n'); }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      https.get(u, { headers: { 'User-Agent': 'fund-steward-tts' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects > 5) return reject(new Error('too many redirects'));
          return get(new URL(res.headers.location, u).href, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = Number(res.headers['content-length'] || 0);
        const out = fs.createWriteStream(dest);
        let done = 0;
        res.on('data', (chunk) => {
          done += chunk.length;
          if (total) {
            const pct = Math.floor((done / total) * 100);
            if (pct % 5 === 0) log('下载 ' + pct + '% (' + Math.round(done / 1048576) + 'MB)');
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url, 0);
  });
}

function downloadViaCurl(url, dest) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const r = spawnSync(curl, ['-sL', '--retry', '3', '-o', dest, url], { stdio: 'inherit', shell: false });
  if (r.status !== 0) throw new Error('curl 下载失败，请检查网络/代理');
}

async function main() {
  fs.mkdirSync(TTS_DIR, { recursive: true });
  const modelFile = path.join(PKG_DIR, 'model.int8.onnx');
  const voicesFile = path.join(PKG_DIR, 'voices.bin');
  if (fs.existsSync(modelFile) && fs.existsSync(voicesFile)) {
    log('模型已存在，跳过下载: ' + PKG_DIR);
  } else {
    log('下载模型包: ' + MODEL_URL);
    try {
      await download(MODEL_URL, ARCHIVE);
    } catch (err) {
      log('Node 直连失败（' + err.message + '），改用 curl（会走系统代理）…');
      downloadViaCurl(MODEL_URL, ARCHIVE);
    }
    log('解压中（Windows 自带 bsdtar 支持 bz2）…');
    const tar = spawnSync('tar', ['-xjf', ARCHIVE, '-C', TTS_DIR], { stdio: 'inherit', shell: false });
    if (tar.status !== 0 || !fs.existsSync(modelFile)) {
      console.error('[tts:setup] 解压失败，请手动解压 ' + ARCHIVE + ' 到 ' + TTS_DIR);
      process.exit(1);
    }
    fs.rmSync(ARCHIVE, { force: true });
    log('模型就绪: ' + PKG_DIR);
  }

  log('安装 sherpa-onnx-node（不写入 package.json）…');
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const inst = spawnSync(npmBin, ['install', 'sherpa-onnx-node', '--no-save', '--no-audit', '--no-fund'], {
    cwd: ROOT, stdio: 'inherit', shell: false,
  });
  if (inst.status !== 0) {
    console.error('[tts:setup] sherpa-onnx-node 安装失败，可手动: npm i sherpa-onnx-node --no-save');
    process.exit(1);
  }
  log('完成。重启 npm start 后 /api/tts 即生效；未安装时自动回退浏览器语音。');
}

main().catch((err) => { console.error('[tts:setup] ' + err.message); process.exit(1); });
