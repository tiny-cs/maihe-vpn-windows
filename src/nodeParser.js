// 麦禾 VPN — 节点链接解析（vless / vmess / trojan / ss）
// 与 Android 版 core/NodeParser.kt 保持同一规则：
// - 不编造 UUID、服务器、订阅地址；解析不到就返回 null，让调用方提示用户重粘。
// - 服务器预填 cs334-site.pages.dev 只是界面默认值，不写进解析结果。
'use strict';

function decodeBase64Url(s) {
  try {
    let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return Buffer.from(t, 'base64').toString('utf8');
  } catch (_) { return ''; }
}

function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const part of qs.split('&')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1)); }
    catch (_) { out[part.slice(0, i)] = part.slice(i + 1); }
  }
  return out;
}

function baseNode(type, name) {
  return {
    id: 'n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    name: name || '',
    type,
    server: '',
    port: 443,
    uuid: '',
    password: '',
    alterId: 0,
    security: 'tls',
    network: 'ws',
    wsPath: '/',
    wsHost: '',
    sni: '',
    alpn: '',
    flow: '',
    method: '',
    createdAt: Date.now(),
  };
}

// vless://UUID@server:port?encryption=none&security=tls&type=ws&path=%2F&host=xxx#名称
function parseVless(link) {
  const m = /^vless:\/\/([^@]+)@([^:/?#]+)(?::(\d+))?(?:\/)?(?:\?([^#]*))?(?:#(.*))?$/.exec(link.trim());
  if (!m) return null;
  const node = baseNode('vless', m[6] ? decodeURIComponent(m[6]) : '');
  node.uuid = decodeURIComponent(m[1]);
  node.server = m[2];
  node.port = m[3] ? parseInt(m[3], 10) : 443;
  const q = parseQuery(m[4] || '');
  node.security = q.security || 'tls';
  node.network = q.type || 'ws';
  node.wsPath = q.path ? decodeURIComponent(q.path) : '/';
  node.wsHost = q.host || q.sni || '';
  node.sni = q.sni || node.wsHost || node.server;
  node.flow = q.flow || '';
  node.name = node.name || (node.server + ':' + node.port);
  return node.uuid && node.server ? node : null;
}

// vmess://base64(json)
function parseVmess(link) {
  const raw = link.trim().slice('vmess://'.length);
  const json = decodeBase64Url(raw);
  if (!json) return null;
  let o;
  try { o = JSON.parse(json); } catch (_) { return null; }
  if (!o || !o.add || !o.id) return null;
  const node = baseNode('vmess', o.ps || '');
  node.uuid = o.id;
  node.server = o.add;
  node.port = parseInt(o.port, 10) || 443;
  node.alterId = parseInt(o.aid, 10) || 0;
  node.network = o.net || 'ws';
  node.security = o.tls === 'tls' ? 'tls' : 'none';
  node.wsPath = o.path || '/';
  node.wsHost = o.host || '';
  node.sni = o.sni || o.host || o.add;
  node.name = node.name || (node.server + ':' + node.port);
  return node;
}

// trojan://password@server:port?sni=xxx#名称
function parseTrojan(link) {
  const m = /^trojan:\/\/([^@]+)@([^:/?#]+)(?::(\d+))?(?:\/)?(?:\?([^#]*))?(?:#(.*))?$/.exec(link.trim());
  if (!m) return null;
  const node = baseNode('trojan', m[5] ? decodeURIComponent(m[5]) : '');
  node.password = decodeURIComponent(m[1]);
  node.uuid = node.password; // sing-box 配置里 trojan 用 password 字段，uuid 仅作占位标识
  node.server = m[2];
  node.port = m[3] ? parseInt(m[3], 10) : 443;
  const q = parseQuery(m[4] || '');
  node.sni = q.sni || node.server;
  node.security = 'tls';
  node.name = node.name || (node.server + ':' + node.port);
  return node.password && node.server ? node : null;
}

// ss://base64(method:password@server:port)#名称 或 ss://base64(method:password)@server:port
function parseSs(link) {
  const rest = link.trim().slice('ss://'.length);
  const hashIdx = rest.indexOf('#');
  const name = hashIdx >= 0 ? decodeURIComponent(rest.slice(hashIdx + 1)) : '';
  const body = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  let decoded = body;
  if (!body.includes('@')) decoded = decodeBase64Url(body);
  const at = decoded.lastIndexOf('@');
  if (at < 0) return null;
  const userinfo = decodeBase64Url(decoded.slice(0, at)) || decoded.slice(0, at);
  const hostport = decoded.slice(at + 1);
  const colon = userinfo.indexOf(':');
  const hp = /^([^:]+)(?::(\d+))?$/.exec(hostport);
  if (colon < 0 || !hp) return null;
  const node = baseNode('ss', name);
  node.method = userinfo.slice(0, colon);
  node.password = userinfo.slice(colon + 1);
  node.uuid = node.password;
  node.server = hp[1];
  node.port = hp[2] ? parseInt(hp[2], 10) : 8388;
  node.name = node.name || (node.server + ':' + node.port);
  return node.password && node.server ? node : null;
}

function parseNodeLink(link) {
  if (!link || typeof link !== 'string') return null;
  const t = link.trim();
  if (t.startsWith('vless://')) return parseVless(t);
  if (t.startsWith('vmess://')) return parseVmess(t);
  if (t.startsWith('trojan://')) return parseTrojan(t);
  if (t.startsWith('ss://')) return parseSs(t);
  return null;
}

// 订阅：base64 文本，每行一个节点链接；非 base64 时按行直接解析。
function parseSubscriptionText(text) {
  if (!text || typeof text !== 'string') return [];
  let body = text.trim();
  if (!body.includes('://')) {
    const decoded = decodeBase64Url(body);
    if (decoded && decoded.includes('://')) body = decoded;
  }
  const nodes = [];
  for (const line of body.split(/\r?\n/)) {
    const n = parseNodeLink(line.trim());
    if (n) nodes.push(n);
  }
  return nodes;
}

module.exports = { parseNodeLink, parseSubscriptionText, parseVless, parseVmess, parseTrojan, parseSs };
