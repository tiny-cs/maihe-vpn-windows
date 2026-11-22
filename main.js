// 麦禾 VPN — Windows 11 桌面版，主进程
// Electron + sing-box 子进程。绝不伪造连接状态：
// 只有 sing-box 子进程真正启动成功，才报告“已连接”；
// sing-box 二进制缺失 / 启动失败时，明确报错，绝不显示“已连接”。
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { buildSingBoxConfig } = require('./src/singboxConfig');

// ---- 自动设置 Windows 系统代理 ----
// 点盾连接成功后，自动把系统代理设为 127.0.0.1:2080（sing-box 的 mixed 入站），
// 断开 / sing-box 崩溃 / 程序退出时自动恢复成连接前的设置。
// 只改当前用户的注册表 HKCU\...\Internet Settings，不动系统级代理，不需要管理员权限。
// 改完后用 WinINet 的 InternetSetOption 通知系统立即生效（只对新连接生效，
// 已打开的网页可能要刷新一次）。任何一步失败都不影响 VPN 本身连接，
// 只在界面上报告“系统代理自动设置失败”，用户仍可手动设置。
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 2080;
const PROXY_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
let savedProxy = null;      // 连接前用户的代理设置 { enabled, server, override }
let proxyManaged = false;   // 本次连接是否由我们改过系统代理
let systemProxyState = 'off'; // off | on | failed（供界面显示）

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr && stderr.toString()) || err.message));
      else resolve((stdout || '').toString());
    });
  });
}
async function readProxySettings() {
  try {
    const out = await execFileAsync('reg', ['query', PROXY_REG_KEY, '/v', 'ProxyEnable']);
    const m = out.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
    let server = null, override = null;
    try {
      const o2 = await execFileAsync('reg', ['query', PROXY_REG_KEY, '/v', 'ProxyServer']);
      const m2 = o2.match(/ProxyServer\s+REG_SZ\s+(.+)/);
      if (m2) server = m2[1].trim();
    } catch (_) { /* 没有 ProxyServer 就是没设过 */ }
    try {
      const o3 = await execFileAsync('reg', ['query', PROXY_REG_KEY, '/v', 'ProxyOverride']);
      const m3 = o3.match(/ProxyOverride\s+REG_SZ\s+(.+)/);
      if (m3) override = m3[1].trim();
    } catch (_) { /* 没有 ProxyOverride 就是没设过 */ }
    return { enabled: m ? parseInt(m[1], 16) === 1 : false, server, override };
  } catch (_) {
    return { enabled: false, server: null, override: null };
  }
}
async function refreshProxySettings() {
  // 通知 Windows 代理设置已变（InternetSetOption 39=SETTINGS_CHANGED, 37=REFRESH）。
  // 失败也忽略：注册表已改，新开的连接一般仍会生效。
  const ps = "$s='[DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);';" +
    " $t=Add-Type -MemberDefinition $s -Name WinINet -Namespace PInvoke -PassThru;" +
    " $t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)|Out-Null;" +
    " $t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)|Out-Null;";
  try { await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]); } catch (_) { /* 忽略 */ }
}
async function applySystemProxy() {
  if (proxyManaged) return true;
  try {
    savedProxy = await readProxySettings();
    // 如果用户本来就已经指到 127.0.0.1:2080，就不用动。
    if (savedProxy.enabled && savedProxy.server === PROXY_HOST + ':' + PROXY_PORT) {
      proxyManaged = true; systemProxyState = 'on'; return true;
    }
    await execFileAsync('reg', ['add', PROXY_REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
    await execFileAsync('reg', ['add', PROXY_REG_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', PROXY_HOST + ':' + PROXY_PORT, '/f']);
    // <local> 让本机地址（127.0.0.1）不走代理，否则 sing-box 的本机 API 会被自己绕进去。
    await execFileAsync('reg', ['add', PROXY_REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', '<local>', '/f']);
    await refreshProxySettings();
    proxyManaged = true; systemProxyState = 'on'; return true;
  } catch (e) {
    console.error('自动设置系统代理失败', e);
    systemProxyState = 'failed'; return false;
  }
}
async function restoreSystemProxy() {
  if (!proxyManaged) return;
  proxyManaged = false;
  try {
    if (savedProxy && savedProxy.enabled) {
      await execFileAsync('reg', ['add', PROXY_REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
      if (savedProxy.server) await execFileAsync('reg', ['add', PROXY_REG_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', savedProxy.server, '/f']);
      if (savedProxy.override) await execFileAsync('reg', ['add', PROXY_REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', savedProxy.override, '/f']);
      else await execFileAsync('reg', ['delete', PROXY_REG_KEY, '/v', 'ProxyOverride', '/f']);
    } else {
      // 用户原来没开代理：只关开关，不删他原来的 ProxyServer 值。
      await execFileAsync('reg', ['add', PROXY_REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
      if (savedProxy && savedProxy.override) await execFileAsync('reg', ['add', PROXY_REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', savedProxy.override, '/f']);
      else await execFileAsync('reg', ['delete', PROXY_REG_KEY, '/v', 'ProxyOverride', '/f']);
    }
    await refreshProxySettings();
  } catch (e) {
    console.error('恢复系统代理失败', e);
  } finally {
    savedProxy = null; systemProxyState = 'off';
  }
}

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

// ---- 托盘：点 X 不退出，只藏到右下角托盘，VPN 继续连着 ----
// 右键托盘图标：显示窗口 / 连接-断开 / 退出。真正退出只走托盘“退出”
// 或任务管理器结束进程；退出时断开 VPN 并恢复系统代理。
let tray = null;
let quitting = false;
let lastTrayState = '';
let lastConnectedNode = null;

function trayIcon() {
  const candidates = [
    path.join(__dirname, 'assets', 'icon.ico'),
    path.join(process.resourcesPath || '', 'assets', 'icon.ico'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return nativeImage.createFromPath(c); } catch (_) { /* 继续找 */ }
  }
  // 找不到图标文件时用一个绿色小方块兜底，托盘不能没有图标。
  return nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVR42mP8z8DwnwEKmBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgQEAAP//AwD5/QoKz7o3NQAAAABJRU5ErkJggg==');
}
function updateTrayMenu() {
  if (!tray) return;
  const stateLabel = { disconnected: '未连接', connecting: '连接中…', connected: '已连接', failed: '连接失败' }[currentState] || currentState;
  if (stateLabel === lastTrayState) return;
  lastTrayState = stateLabel;
  try { tray.setToolTip('麦禾 VPN · ' + stateLabel); } catch (_) { /* 忽略 */ }
  const connected = currentState === 'connected' || currentState === 'connecting';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: connected ? '断开连接' : '连接', click: () => {
      if (connected) { stopSingBox(); return; }
      const node = lastConnectedNode || (readJsonFile(userDataFile(NODES_FILE), [])[0] || null);
      if (node) startVpn(node);
      else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
}
function createTray() {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('麦禾 VPN');
    tray.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    });
    updateTrayMenu();
  } catch (e) {
    console.error('创建托盘失败', e);
    tray = null;
  }
}

function sendState() {
  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vpn-state', {
      state: currentState,
      node: currentNode ? { id: currentNode.id, name: currentNode.name, server: currentNode.server, type: currentNode.type } : null,
      error: lastError,
      sessionBytes,
      speed: lastSpeed,
      connectedMs: connectStartedAt ? Date.now() - connectStartedAt : 0,
      singboxPath: findSingBox(),
      systemProxy: systemProxyState,
    });
  }
}

function stopSingBox() {
  stopTrafficPolling();
  // 断开就把系统代理恢复成连接前的样子（失败也不阻塞断开）。
  restoreSystemProxy().catch(() => {});
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
  lastConnectedNode = node;
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
      // sing-box 崩溃也要把系统代理恢复，否则用户上不了网。
      restoreSystemProxy().catch(() => {});
      sendState();
    }
    singboxProc = null;
  });

  // 给 sing-box 1.5 秒启动时间：进程还在、没有立即退出，才算“已连接”。
  // 这是本地进程存活检查，不是流量验证；首页“检测出口 IP”才是真验证。
  await new Promise((r) => setTimeout(r, 1500));
  if (singboxProc && !singboxProc.killed && currentState === 'connecting') {
    currentState = 'connected';
    // sing-box 跑起来之后，自动把系统代理设到 127.0.0.1:2080。
    // 自动设置失败不算连接失败（VPN 本身已通），只在界面上提示手动设置。
    await applySystemProxy();
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
  createTray();
  // 点 X 不退出：藏到托盘，VPN 继续连着。真正退出走托盘右键“退出”。
  mainWindow.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { quitting = true; stopSingBox(); });
app.on('window-all-closed', () => {
  // 有托盘时窗口只是隐藏，不会触发这里；只有真正退出时才到这里。
  if (!quitting) return;
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
  systemProxy: systemProxyState,
}));
ipcMain.handle('vpn-connect', (_e, node) => startVpn(node));
ipcMain.handle('vpn-disconnect', () => {
  const bytes = { ...sessionBytes };
  stopSingBox();
  // 断开时结算：把本次流量记入额度（渲染层也会结算一次，这里以主进程为准返回）
  return { ok: true, sessionBytes: bytes, connectedMs: connectStartedAt ? Date.now() - connectStartedAt : 0 };
});
ipcMain.handle('open-external', (_e, url) => {
  // 注意：原来只放行 https://，ms-settings:network-proxy 被悄悄拦掉，
  // 所以首页“打开 Windows 代理设置”按钮点了没反应。只放行这一个系统设置页。
  if (typeof url === 'string' && (/^https:\/\//.test(url) || url === 'ms-settings:network-proxy')) return shell.openExternal(url);
  return Promise.resolve(false);
});
ipcMain.handle('show-message', (_e, opts) => dialog.showMessageBox(mainWindow, {
  type: (opts && opts.type) || 'info',
  title: APP_NAME,
  message: (opts && opts.message) || '',
  detail: (opts && opts.detail) || '',
  buttons: ['确定'],
}));
