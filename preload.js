// 麦禾 VPN — preload：只暴露最小的安全 API，不暴露 Node 能力给渲染层。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maihe', {
  nodesLoad: () => ipcRenderer.invoke('nodes-load'),
  nodesSave: (nodes) => ipcRenderer.invoke('nodes-save', nodes),
  quotaLoad: () => ipcRenderer.invoke('quota-load'),
  quotaSave: (quota) => ipcRenderer.invoke('quota-save', quota),
  vpnStatus: () => ipcRenderer.invoke('vpn-status'),
  vpnConnect: (node) => ipcRenderer.invoke('vpn-connect', node),
  vpnDisconnect: () => ipcRenderer.invoke('vpn-disconnect'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showMessage: (opts) => ipcRenderer.invoke('show-message', opts),
  onVpnState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('vpn-state', listener);
    return () => ipcRenderer.removeListener('vpn-state', listener);
  },
});
