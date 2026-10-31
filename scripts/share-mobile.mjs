import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 4173);
const command = process.env.CLOUDFLARED_BIN || 'cloudflared';
const tunnel = spawn(command, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
  stdio: 'inherit',
  shell: false
});

tunnel.on('error', error => {
  console.error(`无法启动 cloudflared：${error.message}`);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => tunnel.kill(signal));
}

tunnel.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
