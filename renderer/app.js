// 麦禾 VPN — Windows 版渲染层（纯前端 JS，不直接访问 Node）
// 节点解析、额度逻辑在渲染层各有一份小实现（与 src/ 同规则）；
// 连接/断开、sing-box 启动、持久化都走 preload 暴露的 window.maihe。
'use strict';

const DEFAULT_SERVER = 'cs334-site.pages.dev';
const MB = 1024 * 1024;
const DAILY_FREE = 500 * MB;
const MONTHLY_FREE = 10 * 1024 * MB;

const $ = (id) => document.getElementById(id);

let nodes = [];
let currentNodeId = null;
let vpnState = { state: 'disconnected', node: null, error: '', sessionBytes: { up: 0, down: 0 }, speed: { upBps: 0, downBps: 0 }, connectedMs: 0 };
let quota = null;
let ipBefore = '';
let timer = null;

// ---------- 工具 ----------
function fmtBytes(b) {
  if (!b || b <= 0) return '0 B';
  if (b < MB) return Math.round(b / 1024) + ' KB';
  if (b < 1024 * MB) return (b / MB).toFixed(1) + ' MB';
  return (b / (1024 * MB)).toFixed(2) + ' GB';
}
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '0 KB/s';
  if (bps < MB) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / MB).toFixed(2) + ' MB/s';
}
function fmtDuration(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function todayKey(d) { const t = d || new Date(); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); }
function monthKey(d) { const t = d || new Date(); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- 节点解析（与 src/nodeParser.js 同规则） ----------
function b64urlDecode(s) {
  try { let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return atob(t); }
  catch (_) { return ''; }
}
function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const part of qs.split('&')) {
    const i = part.indexOf('=');
    if (i >= 0) { try { out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1)); } catch (_) { out[part.slice(0, i)] = part.slice(i + 1); } }
  }
  return out;
}
function baseNode(type, name) {
  return { id: 'n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), name: name || '', type, server: '', port: 443, uuid: '', password: '', alterId: 0, security: 'tls', network: 'ws', wsPath: '/', wsHost: '', sni: '', flow: '', method: '', createdAt: Date.now() };
}
function parseNodeLink(link) {
  if (!link || typeof link !== 'string') return null;
  const t = link.trim();
  let m;
  if (t.startsWith('vless://')) {
    m = /^vless:\/\/([^@]+)@([^:/?#]+)(?::(\d+))?(?:\/)?(?:\?([^#]*))?(?:#(.*))?$/.exec(t);
    if (!m) return null;
    const n = baseNode('vless', m[6] ? decodeURIComponent(m[6]) : '');
    n.uuid = decodeURIComponent(m[1]); n.server = m[2]; n.port = m[3] ? parseInt(m[3], 10) : 443;
    const q = parseQuery(m[4] || '');
    n.security = q.security || 'tls'; n.network = q.type || 'ws';
    n.wsPath = q.path ? decodeURIComponent(q.path) : '/'; n.wsHost = q.host || q.sni || ''; n.sni = q.sni || n.wsHost || n.server; n.flow = q.flow || '';
    n.name = n.name || (n.server + ':' + n.port);
    return n.uuid && n.server ? n : null;
  }
  if (t.startsWith('vmess://')) {
    let o; try { o = JSON.parse(b64urlDecode(t.slice('vmess://'.length))); } catch (_) { return null; }
    if (!o || !o.add || !o.id) return null;
    const n = baseNode('vmess', o.ps || '');
    n.uuid = o.id; n.server = o.add; n.port = parseInt(o.port, 10) || 443; n.alterId = parseInt(o.aid, 10) || 0;
    n.network = o.net || 'ws'; n.security = o.tls === 'tls' ? 'tls' : 'none';
    n.wsPath = o.path || '/'; n.wsHost = o.host || ''; n.sni = o.sni || o.host || o.add;
    n.name = n.name || (n.server + ':' + n.port);
    return n;
  }
  if (t.startsWith('trojan://')) {
    m = /^trojan:\/\/([^@]+)@([^:/?#]+)(?::(\d+))?(?:\/)?(?:\?([^#]*))?(?:#(.*))?$/.exec(t);
    if (!m) return null;
    const n = baseNode('trojan', m[5] ? decodeURIComponent(m[5]) : '');
    n.password = decodeURIComponent(m[1]); n.uuid = n.password; n.server = m[2]; n.port = m[3] ? parseInt(m[3], 10) : 443;
    const q = parseQuery(m[4] || ''); n.sni = q.sni || n.server; n.security = 'tls';
    n.name = n.name || (n.server + ':' + n.port);
    return n.password && n.server ? n : null;
  }
  if (t.startsWith('ss://')) {
    const rest = t.slice('ss://'.length);
    const hi = rest.indexOf('#');
    const name = hi >= 0 ? decodeURIComponent(rest.slice(hi + 1)) : '';
    let body = hi >= 0 ? rest.slice(0, hi) : rest;
    if (!body.includes('@')) body = b64urlDecode(body);
    const at = body.lastIndexOf('@');
    if (at < 0) return null;
    const ui = b64urlDecode(body.slice(0, at)) || body.slice(0, at);
    const hp = /^([^:]+)(?::(\d+))?$/.exec(body.slice(at + 1));
    const colon = ui.indexOf(':');
    if (colon < 0 || !hp) return null;
    const n = baseNode('ss', name);
    n.method = ui.slice(0, colon); n.password = ui.slice(colon + 1); n.uuid = n.password;
    n.server = hp[1]; n.port = hp[2] ? parseInt(hp[2], 10) : 8388;
    n.name = n.name || (n.server + ':' + n.port);
    return n.password && n.server ? n : null;
  }
  return null;
}
function parseSubscriptionText(text) {
  if (!text) return [];
  let body = text.trim();
  if (!body.includes('://')) { const d = b64urlDecode(body); if (d && d.includes('://')) body = d; }
  const out = [];
  for (const line of body.split(/\r?\n/)) { const n = parseNodeLink(line.trim()); if (n) out.push(n); }
  return out;
}

// ---------- 额度（本地） ----------
function normalizeQuota(q) {
  const out = Object.assign({ day: todayKey(), dayUsed: 0, month: monthKey(), monthUsed: 0, pro: false, updatedAt: Date.now() }, q || {});
  if (out.day !== todayKey()) { out.day = todayKey(); out.dayUsed = 0; }
  if (out.month !== monthKey()) { out.month = monthKey(); out.monthUsed = 0; }
  return out;
}
async function saveQuota() { try { await window.maihe.quotaSave(quota); } catch (_) { /* 忽略 */ } }
function settleSession(bytes) {
  if (!quota) quota = normalizeQuota(null);
  const total = (bytes && (bytes.up + bytes.down)) || 0;
  if (total > 0) { quota.dayUsed += total; quota.monthUsed += total; quota.updatedAt = Date.now(); saveQuota(); renderQuota(); }
}

// ---------- 渲染 ----------
function renderStatus() {
  const pill = $('statusPill');
  const label = $('connectLabel');
  const shield = $('shieldBtn');
  const err = $('errorLine');
  const map = {
    disconnected: ['未连接', 'pill pill-off', '点盾牌连接'],
    connecting: ['连接中…', 'pill pill-ing', '正在连接…'],
    connected: ['已连接', 'pill pill-on', '已连接 · 点盾牌断开'],
    failed: ['连接失败', 'pill pill-fail', '连接失败 · 点盾牌重试'],
  };
  const item = map[vpnState.state] || map.disconnected;
  pill.textContent = item[0]; pill.className = item[1]; label.textContent = item[2];
  shield.classList.toggle('connected', vpnState.state === 'connected');
  if (vpnState.error) { err.hidden = false; err.textContent = vpnState.error; }
  else err.hidden = true;

  const cur = nodes.find((n) => n.id === currentNodeId) || vpnState.node;
  $('currentNodeName').textContent = cur ? cur.name : '未选择节点';
  $('currentNodeMeta').textContent = cur ? (cur.type.toUpperCase() + ' · ' + cur.server + ':' + cur.port) : '请先在下方添加你的节点';
  const sp = vpnState.speed || { upBps: 0, downBps: 0 };
  const sb = vpnState.sessionBytes || { up: 0, down: 0 };
  $('speedLine').textContent = vpnState.state === 'connected'
    ? '↓ ' + fmtSpeed(sp.downBps) + ' / ↑ ' + fmtSpeed(sp.upBps) + '（sing-box Clash API 实时统计；若显示 0，见 README 故障排查）'
    : '↓ -- / ↑ --';
  $('sessionLine').textContent = '本次流量：↓ ' + fmtBytes(sb.down) + ' · ↑ ' + fmtBytes(sb.up) + ' · 已连接 ' + fmtDuration(vpnState.connectedMs || 0);
}
function renderQuota() {
  if (!quota) quota = normalizeQuota(null);
  const used = quota.pro ? 0 : quota.dayUsed;
  $('quotaBar').style.width = quota.pro ? '0%' : Math.min(100, Math.round((used / DAILY_FREE) * 100)) + '%';
  $('quotaLine').textContent = quota.pro
    ? 'Pro（本地占位）：应用内不限流量 * 后端仍是单节点'
    : '今日已用 ' + fmtBytes(quota.dayUsed) + ' / 500 MB · 本月已用 ' + fmtBytes(quota.monthUsed) + ' / 10 GB';
  $('proState').textContent = quota.pro ? '当前：Pro（本地占位，未收费）' : '当前：免费版';
}
function renderNodes() {
  const box = $('nodeList');
  if (!nodes.length) { box.innerHTML = '<div class="empty">还没有节点。先粘贴你的 VLESS 链接，或导入订阅。</div>'; return; }
  box.innerHTML = nodes.map((n) => {
    const cur = n.id === currentNodeId;
    return '<div class="node-item"><div class="node-top"><div><strong>' + esc(n.name) + '</strong>' +
      (cur ? ' <span class="badge">已选中 · 未连接</span>' : '') +
      '</div><span>' + esc(n.type.toUpperCase()) + '</span></div>' +
      '<div class="latency">' + esc(n.server) + ':' + esc(n.port) + (n.latencyMs ? ' · ' + n.latencyMs + ' ms' : ' · 未测速') + '</div>' +
      '<div class="row">' +
      '<button class="btn btn-secondary" data-act="set" data-id="' + esc(n.id) + '">设为当前</button>' +
      '<button class="btn btn-secondary" data-act="test" data-id="' + esc(n.id) + '">测速</button>' +
      '<button class="btn btn-secondary" data-act="del" data-id="' + esc(n.id) + '">删除</button>' +
      '</div></div>';
  }).join('');
  box.querySelectorAll('button[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.getAttribute('data-id');
      const act = b.getAttribute('data-act');
      if (act === 'set') { currentNodeId = id; renderAll(); }
      if (act === 'del') { nodes = nodes.filter((n) => n.id !== id); if (currentNodeId === id) currentNodeId = nodes.length ? nodes[0].id : null; saveNodes(); renderAll(); }
      if (act === 'test') testLatency(id);
    });
  });
}
function renderAll() { renderStatus(); renderQuota(); renderNodes(); }
async function saveNodes() { try { await window.maihe.nodesSave(nodes); } catch (_) { /* 忽略 */ } }

// ---------- 测速 / 出口 IP ----------
async function testLatency(id) {
  const n = nodes.find((x) => x.id === id);
  if (!n) return;
  const t0 = performance.now();
  try {
    // TCP 直连测的是“能不能连上服务器端口”，不是代理延迟；真正的代理延迟
    // 以连接后测速为准。这里用 fetch 做一次可达性探测，失败只显示“不可达”。
    await fetch('https://' + n.server + '/', { mode: 'no-cors', signal: AbortSignal.timeout(5000) }).catch(() => {});
    n.latencyMs = Math.round(performance.now() - t0);
  } catch (_) { n.latencyMs = null; }
  renderNodes();
}
async function autoSelect() {
  if (!nodes.length) { await window.maihe.showMessage({ message: '还没有节点，请先添加节点。' }); return; }
  let best = null;
  for (const n of nodes) {
    const t0 = performance.now();
    try { await fetch('https://' + n.server + '/', { mode: 'no-cors', signal: AbortSignal.timeout(5000) }).catch(() => {}); n.latencyMs = Math.round(performance.now() - t0); }
    catch (_) { n.latencyMs = null; }
    if (n.latencyMs != null && (!best || n.latencyMs < best.latencyMs)) best = n;
  }
  if (best) { currentNodeId = best.id; renderAll(); await window.maihe.showMessage({ message: '已选最快节点：' + best.name + '（' + best.latencyMs + ' ms，可达性探测，仅供参考）' }); }
  else await window.maihe.showMessage({ message: '所有节点都测不到可达性，请检查网络或节点地址。' });
}
async function checkIp() {
  $('ipLine').textContent = '出口 IP：检测中…';
  try {
    const r = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(8000) });
    const t = await r.text();
    const ip = (t.match(/ip=([^\n]+)/) || [])[1] || '未知';
    const loc = (t.match(/loc=([^\n]+)/) || [])[1] || '';
    $('ipLine').textContent = '出口 IP：' + ip + (loc ? '（' + loc + '）' : '') + (ipBefore ? ' · 连接前：' + ipBefore : '');
    if (!ipBefore) ipBefore = ip;
  } catch (_) { $('ipLine').textContent = '出口 IP：检测失败，请检查网络。'; }
}

// ---------- 连接 / 断开 ----------
async function toggleConnect() {
  if (vpnState.state === 'connected' || vpnState.state === 'connecting') {
    const res = await window.maihe.vpnDisconnect();
    settleSession(res && res.sessionBytes);
    vpnState = await window.maihe.vpnStatus();
    renderAll();
    return;
  }
  const node = nodes.find((n) => n.id === currentNodeId) || nodes[0];
  if (!node) { await window.maihe.showMessage({ message: '还没有节点。请先粘贴你的 VLESS 链接，或去 cs334-site 的 /admin 后台复制 UUID 手动添加。' }); return; }
  if (!ipBefore) { try { const r = await fetch('https://www.cloudflare.com/cdn-cgi/trace'); const t = await r.text(); ipBefore = (t.match(/ip=([^\n]+)/) || [])[1] || ''; } catch (_) { /* 忽略 */ } }
  vpnState = { state: 'connecting', node, error: '', sessionBytes: { up: 0, down: 0 }, speed: { upBps: 0, downBps: 0 }, connectedMs: 0 };
  renderAll();
  const res = await window.maihe.vpnConnect(node);
  vpnState = await window.maihe.vpnStatus();
  if (!res.ok) vpnState.error = res.error || vpnState.error;
  renderAll();
  if (vpnState.state === 'connected') checkIp();
}

// ---------- 事件 ----------
function bindEvents() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      tab.classList.add('active');
      $(tab.getAttribute('data-view')).classList.add('active');
    });
  });
  $('shieldBtn').addEventListener('click', toggleConnect);
  $('btnAutoSelect').addEventListener('click', autoSelect);
  $('btnTestCurrent').addEventListener('click', () => { if (currentNodeId) testLatency(currentNodeId); });
  $('btnCheckIp').addEventListener('click', checkIp);
  $('btnProxySettings').addEventListener('click', () => window.maihe.openExternal('ms-settings:network-proxy'));
  $('btnPro').addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.querySelector('[data-view="view-pro"]').classList.add('active');
    $('view-pro').classList.add('active');
  });
  $('btnAddLink').addEventListener('click', () => {
    const n = parseNodeLink($('linkInput').value);
    if (!n) { window.maihe.showMessage({ message: '解析失败：请粘贴完整的 vless:// / vmess:// / trojan:// / ss:// 链接。' }); return; }
    nodes.push(n); currentNodeId = n.id; $('linkInput').value = ''; saveNodes(); renderAll();
  });
  $('btnImportSub').addEventListener('click', async () => {
    const url = $('subInput').value.trim();
    let text = $('subText').value.trim();
    if (url) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        text = await r.text();
      } catch (e) {
        window.maihe.showMessage({ message: '订阅下载失败：' + (e && e.message ? e.message : String(e)) + '。请检查订阅地址，或直接粘贴订阅内容。' });
        return;
      }
    }
    const imported = parseSubscriptionText(text);
    if (!imported.length) { window.maihe.showMessage({ message: '订阅里没有解析到节点，请检查订阅地址或内容。' }); return; }
    // 重复导入同一订阅：按“服务器+端口+UUID”去重替换，不无限叠加
    for (const n of imported) {
      const idx = nodes.findIndex((x) => x.server === n.server && x.port === n.port && x.uuid === n.uuid);
      if (idx >= 0) nodes[idx] = Object.assign({}, nodes[idx], n, { id: nodes[idx].id });
      else nodes.push(n);
    }
    currentNodeId = nodes.length ? nodes[nodes.length - 1].id : currentNodeId;
    $('subInput').value = ''; $('subText').value = ''; saveNodes(); renderAll();
    window.maihe.showMessage({ message: '导入成功：' + imported.length + ' 个节点。' });
  });
  $('btnAddManual').addEventListener('click', () => {
    const server = $('mServer').value.trim() || DEFAULT_SERVER;
    const uuid = $('mUuid').value.trim();
    if (!uuid) { window.maihe.showMessage({ message: '请填写 UUID：去 cs334-site 的 /admin 后台复制你的 UUID。' }); return; }
    const n = baseNode($('mType').value, $('mName').value.trim() || server);
    n.server = server; n.port = parseInt($('mPort').value, 10) || 443; n.uuid = uuid;
    n.password = uuid; n.wsPath = $('mPath').value.trim() || '/'; n.wsHost = $('mHost').value.trim() || server; n.sni = n.wsHost;
    nodes.push(n); currentNodeId = n.id; $('mUuid').value = ''; saveNodes(); renderAll();
  });
  $('btnEnableProPlaceholder').addEventListener('click', () => {
    quota = normalizeQuota(quota); quota.pro = true; saveQuota(); renderQuota();
    window.maihe.showMessage({ message: '已开启本地 Pro 占位（仅测试，不收费）。后端仍是单节点，不要对外收费宣传。' });
  });
  $('btnDisablePro').addEventListener('click', () => {
    quota = normalizeQuota(quota); quota.pro = false; saveQuota(); renderQuota();
  });
  if (window.maihe && window.maihe.onVpnState) {
    window.maihe.onVpnState((s) => { vpnState = Object.assign({}, vpnState, s); renderStatus(); });
  }
}

// ---------- 启动 ----------
async function init() {
  try { nodes = (await window.maihe.nodesLoad()) || []; } catch (_) { nodes = []; }
  try { quota = normalizeQuota(await window.maihe.quotaLoad()); } catch (_) { quota = normalizeQuota(null); }
  if (nodes.length) currentNodeId = nodes[0].id;
  try { vpnState = await window.maihe.vpnStatus(); } catch (_) { /* 保持默认 */ }
  bindEvents();
  renderAll();
  timer = setInterval(async () => {
    if (vpnState.state === 'connected') {
      try { vpnState = await window.maihe.vpnStatus(); renderStatus(); } catch (_) { /* 忽略 */ }
    }
  }, 2000);
}
document.addEventListener('DOMContentLoaded', init);
