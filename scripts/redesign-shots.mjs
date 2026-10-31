import { chromium } from 'playwright-core';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'fund-shot-'));
copyFileSync('data/finance.sqlite', join(tmp, 'finance.sqlite'));
process.env.FUND_DB_PATH = join(tmp, 'finance.sqlite');
const { spawn } = await import('node:child_process');
const srv = spawn('node', ['server.mjs'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));

const exe = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.addInitScript(() => {
  localStorage.setItem('fund-onboarding-v1', 'done');
  localStorage.setItem('fund-portrait-v1', '1');
  localStorage.setItem('fund-user-v1', 'u-lin');
  sessionStorage.setItem('fund-welcome-v1', '1');
});
await page.goto('http://localhost:4173/#/agent');
await page.waitForTimeout(2500);
await page.screenshot({ path: 'icbc-capture/redesign-agent.png' });

const shots = [['#/features', 'redesign-hub'], ['#/payments', 'redesign-payments'], ['#/settings', 'redesign-settings'], ['#/accounts', 'redesign-accounts'], ['#/wealth', 'redesign-wealth']];
for (const [hash, name] of shots) {
  await page.evaluate(h => { location.hash = h; }, hash);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `icbc-capture/${name}.png` });
}
await browser.close();
srv.kill();
rmSync(tmp, { recursive: true, force: true });
console.log('redesign shots done');
