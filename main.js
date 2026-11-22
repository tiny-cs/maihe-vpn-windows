// 麦禾 VPN — Windows 11 桌面版，主进程
// Electron + sing-box 子进程。绝不伪造连接状态：
// 只有 sing-box 子进程真正启动成功，才报告“已连接”；
// sing-box 二进制缺失 / 启动失败时，明确报错，绝不显示“已连接”。
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { buildSingBoxConfig } = require('./src/singboxConfig');

const APP_NAME = '麦禾 VPN';
const CONFIG_FILE = 'sing-box-config.json';
const QUOTA_FILE = 'quota.json';
const NODES_FILE = 'nodes.json';

// ---- sing-box 二进制位置 ----
// 优先用项目内 bin/ 目录（随安装包一起打包，见 package.json extraResources），
// 其次用系统 PATH 里的 sing-box。Windows 上文件名是 sing-box.exe。
function findSingBox() {
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', 'sing-box.exe'),
    path.join(__dirname, 'bin', 'sing-box.exe'),
    path.join(__dirname, 'bin', 'sing-box'),
    'sing-box.exe',
    'sing-box',
  ];
  for (const c of candidates) {
    if (!c || c === 'sing-box.exe' || c === 'sing-box') continue;
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) { /* 忽略，继续下一个 */ }
  }
  return null;
}

function userDataFile(name) {
  return path.join(app.getPath('userData'), name);
}

function readJsonFile(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { /* 损坏则用默认值 */ }
  return fallback;
}

function writeJsonFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('写入失败', file, e);
    return false;
  }
}

let mainWindow = null;
let singboxProc = null;
let currentNode = null;      // 当前正在连接的节点对象（真实状态）
let currentState = 'disconnected'; // disconnected | connecting | connected | failed
let lastError = '';
let connectStartedAt = 0;
let sessionBytes = { up: 0, down: 0 };
let lastSpeed = { upBps: 0, downBps: 0 };
let trafficTimer = null;
let lastTraffic = null; // { up, down, at }

// ---- 实时流量：轮询 sing-box Clash API（本机 127.0.0.1:9090）----
// /connections 返回各连接的 up/down（累计字节），汇总后求差值得出速率。
// 若 API 不可用（sing-box 版本差异等），速率保持 0，不伪造数字。
const http = require('http');
function fetchClashConnections() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 9090, path: '/connections', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); });
      res.on('end', () => {
        try {
          const o = JSON.parse(body);
          let up = 0, down = 0;
          for (const c of (o && o.connections) || []) { up += c.up || 0; down += c.download || 0; }
          resolve({ up, down });
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function startTrafficPolling() {
  stopTrafficPolling();
  lastTraffic = null;
  trafficTimer = setInterval(async () => {
    if (currentState !== 'connected') return;
    const t = await fetchClashConnections();
    if (!t) return; // API 不可用：不伪造速率
    const now = Date.now();
    if (lastTraffic) {
      const dt = Math.max(1, (now - lastTraffic.at) / 1000);
      lastSpeed = {
        upBps: Math.max(0, Math.round((t.up - lastTraffic.up) / dt)),
        downBps: Math.max(0, Math.round((t.down - lastTraffic.down) / dt)),
      };
      sessionBytes = { up: t.up, down: t.down };
    }
    lastTraffic = { up: t.up, down: t.down, at: now };
    sendState();
  }, 1000);
}
function stopTrafficPolling() {
  if (trafficTimer) { clearInterval(trafficTimer); trafficTimer = null; }
  lastSpeed = { upBps: 0, downBps: 0 };
}

function sendState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vpn-state', {
      state: currentState,
      node: currentNode ? { id: currentNode.id, name: currentNode.name, server: currentNode.server, type: currentNode.type } : null,
      error: lastError,
      sessionBytes,
      speed: lastSpeed,
      connectedMs: connectStartedAt ? Date.now() - connectStartedAt : 0,
      singboxPath: findSingBox(),
    });
  }
}

function stopSingBox() {
  stopTrafficPolling();
  if (singboxProc) {
    try { singboxProc.kill(); } catch (_) { /* 已退出 */ }
    singboxProc = null;
  }
  if (currentState !== 'disconnected') {
    currentState = 'disconnected';
    currentNode = null;
    lastError = '';
  }
  sendState();
}

async function startVpn(node) {
  if (!node || !node.server || !node.uuid) {
    return { ok: false, error: '节点不完整：缺少服务器地址或 UUID。请先粘贴你的 VLESS 链接，或去 cs334-site 的 /admin 后台复制 UUID。' };
  }
  if (currentState === 'connecting' || currentState === 'connected') {
    return { ok: false, error: '已经在连接或已连接，请先断开。' };
  }

  const singboxPath = findSingBox();
  if (!singboxPath) {
    lastError = '未找到 sing-box。请按 README 下载 sing-box Windows 版，放到本程序的 bin/ 目录（sing-box.exe），再重新连接。';
    currentState = 'failed';
    sendState();
    return { ok: false, error: lastError };
  }

  // 额度检查（本地执行，仅限本机，见 src/quota.js 与 README）
  const quota = readJsonFile(userDataFile(QUOTA_FILE), null);
  const { checkQuota } = require('./src/quota');
  const check = checkQuota(quota);
  if (!check.allowed) {
    lastError = check.reason;
    currentState = 'failed';
    sendState();
    return { ok: false, error: lastError };
  }

  currentState = 'connecting';
  currentNode = node;
  lastError = '';
  sessionBytes = { up: 0, down: 0 };
  connectStartedAt = Date.now();
  sendState();

  let config;
  try {
    config = buildSingBoxConfig(node, { mode: 'system-proxy' });
  } catch (e) {
    currentState = 'failed';
    lastError = '生成 sing-box 配置失败：' + (e && e.message ? e.message : String(e));
    currentNode = null;
    sendState();
    return { ok: false, error: lastError };
  }

  const configPath = userDataFile(CONFIG_FILE);
  if (!writeJsonFile(configPath, config)) {
    currentState = 'failed';
    lastError = '写入 sing-box 配置文件失败，请检查程序数据目录权限。';
    currentNode = null;
    sendState();
    return { ok: false, error: lastError };
  }

  // 先校验配置，再真正启动。校验失败 = 不连接，不伪装。
  try {
    await new Promise((resolve, reject) => {
      const check = spawn(singboxPath, ['check', '-c', configPath], { windowsHide: true });
      let stderr = '';
      check.stderr.on('data', (d) => { stderr += d.toString(); });
      check.on('error', reject);
      check.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || ('sing-box check 退出码 ' + code)));
      });
    });
  } catch (e) {
    currentState = 'failed';
    lastError = 'sing-box 配置校验失败：' + (e && e.message ? e.message : String(e));
    currentNode = null;
    sendState();
    return { ok: false, error: lastError };
  }

  // 真正启动 sing-box 子进程。注意：本工程默认用系统代理（mixed 入站，
  // 127.0.0.1:2080），程序启动后需要你在 Windows 设置里或由程序提示
  // 手动把系统代理指向它；TUN 模式见 README，需要管理员权限，默认不启用。
  singboxProc = spawn(singboxPath, ['run', '-c', configPath], { windowsHide: true });
  let stderrBuf = '';
  singboxProc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  singboxProc.on('error', (err) => {
    currentState = 'failed';
    lastError = '启动 sing-box 失败：' + err.message;
    singboxProc = null;
    currentNode = null;
    sendState();
  });
  singboxProc.on('close', (code) => {
    // 正常断开时 code 为 null（被 kill）；异常退出才报失败。
    if (currentState === 'connected' || currentState === 'connecting') {
      currentState = 'failed';
      lastError = 'sing-box 进程已退出' + (code !== null ? '（退出码 ' + code + '）' : '') +
        (stderrBuf ? '：' + stderrBuf.slice(-500) : '。请查看配置或重新下载 sing-box。');
      singboxProc = null;
      currentNode = null;
      sendState();
    }
    singboxProc = null;
  });

  // 给 sing-box 1.5 秒启动时间：进程还在、没有立即退出，才算“已连接”。
  // 这是本地进程存活检查，不是流量验证；首页“检测出口 IP”才是真验证。
  await new Promise((r) => setTimeout(r, 1500));
  if (singboxProc && !singboxProc.killed && currentState === 'connecting') {
    currentState = 'connected';
    startTrafficPolling();
    sendState();
    return { ok: true, state: 'connected' };
  }
  if (currentState === 'connecting') {
    currentState = 'failed';
    lastError = lastError || 'sing-box 启动后立即退出，请检查配置或重新下载 sing-box。';
    currentNode = null;
    sendState();
    return { ok: false, error: lastError };
  }
  return { ok: false, error: lastError || '连接失败' };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 760,
    minWidth: 360,
    minHeight: 640,
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { stopSingBox(); });
app.on('window-all-closed', () => {
  stopSingBox();
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC：节点与额度（本地文件持久化） ----
ipcMain.handle('nodes-load', () => readJsonFile(userDataFile(NODES_FILE), []));
ipcMain.handle('nodes-save', (_e, nodes) => ({ ok: writeJsonFile(userDataFile(NODES_FILE), Array.isArray(nodes) ? nodes : []) }));
ipcMain.handle('quota-load', () => readJsonFile(userDataFile(QUOTA_FILE), null));
ipcMain.handle('quota-save', (_e, quota) => ({ ok: writeJsonFile(userDataFile(QUOTA_FILE), quota || {}) }));
ipcMain.handle('vpn-status', () => ({
  state: currentState, node: currentNode, error: lastError,
  sessionBytes, speed: lastSpeed,
  connectedMs: connectStartedAt ? Date.now() - connectStartedAt : 0,
  singboxPath: findSingBox(),
}));
ipcMain.handle('vpn-connect', (_e, node) => startVpn(node));
ipcMain.handle('vpn-disconnect', () => {
  const bytes = { ...sessionBytes };
  stopSingBox();
  // 断开时结算：把本次流量记入额度（渲染层也会结算一次，这里以主进程为准返回）
  return { ok: true, sessionBytes: bytes, connectedMs: connectStartedAt ? Date.now() - connectStartedAt : 0 };
});
ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) return shell.openExternal(url);
  return Promise.resolve(false);
});
ipcMain.handle('show-message', (_e, opts) => dialog.showMessageBox(mainWindow, {
  type: (opts && opts.type) || 'info',
  title: APP_NAME,
  message: (opts && opts.message) || '',
  detail: (opts && opts.detail) || '',
  buttons: ['确定'],
}));
