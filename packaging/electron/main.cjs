const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_ONLINE_URL = 'https://administrative-consecutive-belief-martin.trycloudflare.com';
const SERVER_PORT_START = 4175;

let mainWindow = null;
let serverProcess = null;
let serverUrl = '';

function executableDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
}

function readOnlineUrl() {
  const envUrl = String(process.env.ZHONGAN_SERVER_URL || '').trim();
  if (envUrl) return envUrl.replace(/\/+$/, '');
  try {
    const file = path.join(executableDir(), 'server-url.txt');
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value.replace(/\/+$/, '');
    }
  } catch (error) { /* ignore */ }
  return DEFAULT_ONLINE_URL;
}

function findFreePort(start) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const probe = net.createServer();
      probe.once('error', () => tryPort(port + 1));
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve(port));
      });
    };
    tryPort(start);
  });
}

function waitForHealth(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      http.get(url + '/api/health', (response) => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        retry();
      }).on('error', retry);
      function retry() {
        if (Date.now() - started > timeoutMs) return reject(new Error('本地服务启动超时'));
        setTimeout(tick, 300);
      }
    };
    tick();
  });
}

async function startOfflineServer() {
  const serverDir = path.join(process.resourcesPath, 'app-server');
  const nodeBinary = path.join(process.resourcesPath, 'runtime', 'node.exe');
  if (!fs.existsSync(path.join(serverDir, 'server.mjs'))) throw new Error('离线服务文件缺失');
  if (!fs.existsSync(nodeBinary)) throw new Error('离线 Node 运行时缺失');

  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'finance.sqlite');
  if (!fs.existsSync(dbPath)) {
    fs.copyFileSync(path.join(serverDir, 'data', 'finance.sqlite'), dbPath);
  }
  const port = await findFreePort(SERVER_PORT_START);
  const logPath = path.join(dataDir, 'server.log');
  const log = fs.openSync(logPath, 'a');
  serverProcess = spawn(nodeBinary, ['server.mjs'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      FUND_DB_PATH: dbPath,
      VISITOR_MODE: '0',
      DEMO_AUTH: '',
      WECOM_DRY_RUN: '1',
      PUBLIC_BASE_URL: 'http://127.0.0.1:' + port,
      NODE_ENV: 'production'
    },
    stdio: ['ignore', log, log],
    windowsHide: true
  });
  serverProcess.on('exit', () => { serverProcess = null; });
  await waitForHealth('http://127.0.0.1:' + port, 30000);
  return 'http://127.0.0.1:' + port;
}

function buildMenu() {
  const template = [
    {
      label: '众安 Agent',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => mainWindow && mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => mainWindow && mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.5) },
        { type: 'separator' },
        { label: '服务器地址文件', click: () => openServerConfig() },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openServerConfig() {
  try {
    const file = path.join(executableDir(), 'server-url.txt');
    if (!fs.existsSync(file)) fs.writeFileSync(file, DEFAULT_ONLINE_URL + '\n', 'utf8');
    shell.openPath(file);
  } catch (error) {
    dialog.showErrorBox('无法打开配置', String(error && error.message || error));
  }
}

function showLoadFailure(detail) {
  const message = [
    '无法打开众安 Agent。',
    '',
    '如果是网页导向版：请检查网络，或在 exe 同目录创建 server-url.txt，写入可用的服务器地址后重启。',
    '如果是离线本地版：请查看用户数据目录下的 server.log。',
    '',
    detail ? String(detail).slice(0, 300) : ''
  ].join('\n');
  dialog.showMessageBox(mainWindow, { type: 'error', title: '众安 Agent', message, buttons: ['重试', '退出'] })
    .then((result) => {
      if (result.response === 0) {
        if (serverUrl) mainWindow.loadURL(serverUrl);
        else app.relaunch(), app.exit(0);
      } else {
        app.quit();
      }
    });
}

async function createWindow() {
  const offline = fs.existsSync(path.join(process.resourcesPath, 'app-server', 'server.mjs'));
  try {
    serverUrl = offline ? await startOfflineServer() : readOnlineUrl();
  } catch (error) {
    dialog.showErrorBox('众安 Agent 启动失败', String(error && error.message || error));
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#F2F0EB',
    title: '众安 Agent',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  buildMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  let failedOnce = false;
  mainWindow.webContents.on('did-fail-load', (event, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || failedOnce) return;
    failedOnce = true;
    showLoadFailure(description + ' (' + code + ')');
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(serverUrl);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = permission === 'media' || permission === 'audioCapture';
    callback(allowed);
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  app.quit();
});
app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});