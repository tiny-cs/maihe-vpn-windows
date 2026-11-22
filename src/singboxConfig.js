// 麦禾 VPN — sing-box 配置生成（Windows）
// 默认模式 system-proxy：mixed 入站 127.0.0.1:2080（HTTP + SOCKS5），
// 程序启动 sing-box 后，用户需在 Windows 设置里把系统代理指向它，
// 或在首页按提示一键打开 Windows 代理设置页。
// TUN 模式（tun 入站）需要管理员权限 + sing-box 的 TUN 驱动，
// 默认不启用；如需启用，把 mode 改为 'tun'，并以管理员身份运行本程序。
// 出站只认当前节点，不写任何内置节点。
'use strict';

function outboundForNode(node) {
  if (!node || !node.server) throw new Error('节点缺少服务器地址');
  const server = node.server;
  const port = parseInt(node.port, 10) || 443;
  const tls = node.security === 'tls' ? {
    enabled: true,
    server_name: node.sni || node.wsHost || server,
    insecure: false,
  } : { enabled: false };

  if (node.type === 'vless') {
    if (!node.uuid) throw new Error('VLESS 节点缺少 UUID');
    const out = {
      type: 'vless', tag: 'proxy', server, server_port: port,
      uuid: node.uuid, flow: node.flow || undefined, tls,
    };
    if (node.network === 'ws') {
      out.transport = {
        type: 'ws', path: node.wsPath || '/',
        headers: node.wsHost ? { Host: node.wsHost } : {},
      };
    }
    delete out.flow;
    if (node.flow) out.flow = node.flow;
    return out;
  }
  if (node.type === 'vmess') {
    if (!node.uuid) throw new Error('VMess 节点缺少 UUID');
    const out = {
      type: 'vmess', tag: 'proxy', server, server_port: port,
      uuid: node.uuid, alter_id: node.alterId || 0,
      security: 'auto', tls,
    };
    if (node.network === 'ws') {
      out.transport = {
        type: 'ws', path: node.wsPath || '/',
        headers: node.wsHost ? { Host: node.wsHost } : {},
      };
    }
    return out;
  }
  if (node.type === 'trojan') {
    if (!node.password) throw new Error('Trojan 节点缺少密码');
    return { type: 'trojan', tag: 'proxy', server, server_port: port, password: node.password, tls };
  }
  if (node.type === 'ss') {
    if (!node.password || !node.method) throw new Error('Shadowsocks 节点缺少密码或加密方式');
    return { type: 'shadowsocks', tag: 'proxy', server, server_port: port, method: node.method, password: node.password };
  }
  throw new Error('不支持的节点类型：' + node.type);
}

function buildSingBoxConfig(node, opts) {
  const mode = (opts && opts.mode) || 'system-proxy';
  const inbound = mode === 'tun'
    ? [{ type: 'tun', tag: 'tun-in', address: '172.19.0.1/30', auto_route: true, strict_route: true, stack: 'system' }]
    : [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 }];

  return {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'dns-remote', address: 'https://1.1.1.1/dns-query', detour: 'proxy' },
        { tag: 'dns-direct', address: '223.5.5.5', detour: 'direct' },
      ],
      rules: [{ outbound: 'any', server: 'dns-direct', disable_cache: true }],
      final: 'dns-remote',
    },
    inbounds: inbound,
    outbounds: [
      outboundForNode(node),
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
      { type: 'dns', tag: 'dns-out' },
    ],
    route: {
      rules: [
        { protocol: 'dns', outbound: 'dns-out' },
        { ip_is_private: true, outbound: 'direct' },
        // 国内直连：只列最常见的国内域名后缀示例，用户可自行在
        // renderer 里改分流规则；默认其余流量全部走 proxy。
        { domain_suffix: ['.cn', '.qq.com', '.weixin.qq.com', '.baidu.com', '.aliyun.com'], outbound: 'direct' },
      ],
      final: 'proxy',
      auto_detect_interface: true,
    },
    experimental: {
      cache_file: { enabled: true },
      // Clash API：供主进程轮询实时流量（/connections 汇总 up/down）。
      // 只监听本机 127.0.0.1，不对外暴露；无 secret（本机专用）。
      clash_api: { external_controller: '127.0.0.1:9090' },
    },
  };
}

module.exports = { buildSingBoxConfig, outboundForNode };
