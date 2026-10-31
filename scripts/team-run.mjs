/* 直接驱动 DSH headless 队友（与 team-bridge 同机制，供无 MCP 环境使用）
 * 用法: node scripts/team-run.mjs <agent> <taskFile> [waitMs]
 * 输出: 流式事件写 stdout 摘要, 最终文本写 stdout 末尾 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const TEAM_DIR = path.join(HOME, '.dsh', 'team');
const AGENT = process.argv[2] || 'kimik3';
const TASK_FILE = process.argv[3];
const WAIT_MS = Number(process.argv[4] || 900000);
const CWD = process.cwd();

const DSH_EXE = process.env.DSH_EXE || 'C:/Users/whylh/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe';
const DSH_CLI = path.join(
  path.dirname(DSH_EXE), 'resources', 'app.asar', 'dsh', 'node_modules',
  '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js',
);
if (!fs.existsSync(DSH_EXE)) {
  console.error('DSH_EXE not found:', DSH_EXE);
  process.exit(2);
}

function readCredentials() {
  const out = {};
  try {
    const raw = fs.readFileSync(path.join(HOME, '.dsh', '.credentials.yaml'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+):\s*(\S+)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch (err) { console.error('credentials unreadable:', err.message); }
  return out;
}

const CREDS = readCredentials();
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: 'danger-full-access' };
for (const name of ['HS_API_KEY', 'WB_CN_API_KEY', 'QWE_API_KEY', 'TRAE_API_KEY', 'QODER_API_KEY']) {
  if (CREDS[name]) env[name] = CREDS[name];
}

const task = fs.readFileSync(TASK_FILE, 'utf8');
const args = ['--expose-internals', DSH_CLI, '--profile', 'headless', '--patch', path.join(TEAM_DIR, AGENT + '.patch.yml'), '--json', task];

fs.mkdirSync(path.join(HOME, '.dsh', 'team', 'runs'), { recursive: true });
const logPath = path.join(HOME, '.dsh', 'team', 'runs', 'direct-' + Date.now().toString(36) + '.jsonl');
const logFd = fs.openSync(logPath, 'a');
console.error('[team-run] agent=' + AGENT + ' cwd=' + CWD + ' log=' + logPath);

const proc = spawn(DSH_EXE, args, { cwd: CWD, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let finalText = '';
const timer = setTimeout(() => { console.error('[team-run] timeout, killing'); try { proc.kill(); } catch {} }, WAIT_MS);

const out = createInterface({ input: proc.stdout });
out.on('line', (line) => {
  fs.writeSync(logFd, line + '\n');
  if (!line.trim()) return;
  let evt = null;
  try { evt = JSON.parse(line); } catch { return; }
  if (evt.type === 'text' && typeof evt.text === 'string') finalText = evt.text;
  if (evt.type === 'final' && typeof evt.text === 'string' && evt.text.trim()) finalText = evt.text;
  if (evt.type === 'status' && evt.phase === 'turn_end') {
    console.error('[team-run] turn_end reason=' + JSON.stringify(evt.reason || null));
  }
  if (evt.type === 'tool_use' && evt.name) {
    console.error('[team-run] tool: ' + evt.name + ' ' + String(JSON.stringify(evt.input || {})).slice(0, 140));
  }
});
proc.stderr.on('data', (c) => { fs.writeSync(logFd, '[stderr] ' + c); });
proc.on('exit', (code) => {
  clearTimeout(timer);
  console.error('[team-run] exit code=' + code);
  process.stdout.write('\n===== FINAL =====\n' + (finalText || '(no text)') + '\n');
  process.exit(code === 0 ? 0 : 1);
});
