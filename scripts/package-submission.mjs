import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'submission-output');
const STAGE = path.join(OUT_DIR, 'zhongan-bank-agent');
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const archive = path.join(OUT_DIR, `zhongan-bank-agent-${stamp}.zip`);
const excluded = new Set(['.git', 'node_modules', 'models', 'tmp', 'submission-output', 'redesign-obsidian', 'icbc-capture', '.zip-inspect', 'server-mjs-恢复存档', 'vendor', 'torchinductor_whylh', '.mimosa', '.zcode', '.zcode-probe-data', '.zcode-proxy-data',
  '.index-backup-pre-kimi.html', '.recovered-lines.json', '.original-server-recovered-v2.mjs', '.dispatch-task.txt', 'SERVER_OPS.md',
  'dist', 'output', 'node-runtime', '.gradle', 'build', 'github-ready',
  // 内部开发过程稿：只保留技术/规划/测试/部署文档，过程叙事不进入评委可见材料
  '01_后端执行目标与验收.md', '02_前端设计AI文稿.md', '03_设计说明.md', '03_前端设计稿.html', 'QA_NOTES.md',
  'AI_AGENT_UPDATE_REPORT.md', 'FLASH_FINAL_REWORK.md', 'HOME_REDESIGN_REPORT.md', 'LONG_WORK_LOG.md',
  'PROMPT_ARCH_RESEARCH_20261028.md', 'THEME_UPDATE_REPORT.md', 'ZCODE_LOG_AUDIT_20261027.md',
  'ICBC_DESIGN_NOTES.md', 'RESEARCH_REVOLUT_WEBANK_GITHUB.md', 'adversarial-review-zhongan.md', 'flash-adversarial-review.md']);
const excludedFile = /(?:\.log$|\.(?:png|jpe?g|webp)$|^\.shot-|ai-config\.local\.json$|^local\.properties$|^gradle\.properties$)/i;

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    if (entry.isFile() && excludedFile.test(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
copyTree(ROOT, STAGE);
fs.mkdirSync(path.join(STAGE, 'output', 'pdf'), { recursive: true });
for (const pdf of fs.readdirSync(path.join(ROOT, 'output', 'pdf')).filter(name => name.endsWith('.pdf'))) {
  fs.copyFileSync(path.join(ROOT, 'output', 'pdf', pdf), path.join(STAGE, 'output', 'pdf', pdf));
}
fs.writeFileSync(path.join(STAGE, 'SUBMISSION_MANIFEST.txt'), [
  '众安 Agent 提交包（源代码与部署材料）',
  `生成时间：${new Date().toISOString()}`,
  '已排除：node_modules、本地模型权重、EXE/APK 构建产物、.git、tmp、日志、截图和本机密钥',
  '包含：源码、SQLite 演示数据、README、技术文档（output/pdf）、部署与打包配置、测试脚本',
  '启动：npm install && npm run db:check && npm start',
  '测试：npm run check && npm run smoke（333 条）&& npm run im:check（55 条）&& npm run visitor:check（25 条）',
  'GitHub 仓库：见 参赛材料/03-源代码与部署材料/README.md 第 8 节'
].join('\n') + '\n', 'utf8');

const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";
const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', [
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  'if (Test-Path -LiteralPath ' + psQuote(archive) + ') { Remove-Item -LiteralPath ' + psQuote(archive) + ' -Force }',
  '[System.IO.Compression.ZipFile]::CreateFromDirectory(' + psQuote(STAGE) + ', ' + psQuote(archive) + ')'
].join('; ')], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) throw new Error(`提交包生成失败：${result.status}`);
console.log(archive);
