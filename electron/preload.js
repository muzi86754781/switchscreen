'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  refreshState: () => ipcRenderer.invoke('state:refresh'),
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('state:update', handler);
    return () => ipcRenderer.removeListener('state:update', handler);
  },

  // 设备 / 排列 / 改名
  rename: (name) => ipcRenderer.invoke('app:rename', name),

  // 显示器
  detectMonitor: () => ipcRenderer.invoke('display:detect'),
  setPort: (monitorId, deviceId, value) => ipcRenderer.invoke('monitor:port', { monitorId, deviceId, value }),
  probePort: (monitorId, deviceId) => ipcRenderer.invoke('monitor:probe', { monitorId, deviceId }),
  switchDevice: (deviceId) => ipcRenderer.invoke('switch:device', deviceId),
  switchMonitor: (monitorId, deviceId) => ipcRenderer.invoke('switch:monitor', { monitorId, deviceId }),

  // 快捷键 / 启动
  setHotkey: (enabled, kind, id, key) => ipcRenderer.invoke('hotkey:set', { enabled, kind, id, key }),
  setLaunchAtLogin: (open) => ipcRenderer.invoke('launch:set', open),

  // 共用键鼠
  setInputMaster: (masterId, edgeSwitch, mouseSpeed) => ipcRenderer.invoke('input:set-master', { masterId, edgeSwitch, mouseSpeed }),
  cycleInput: () => ipcRenderer.invoke('hotkey:cycle-input'),

  // 剪贴板
  setClipboardSync: (enabled) => ipcRenderer.invoke('clip:set', enabled),
  clipDir: (action) => ipcRenderer.invoke('clip:dir', action),

  // 文件 / 文本：targets 是设备身份数组，支持一次发给多台
  pickFiles: (targets) => ipcRenderer.invoke('files:pick', targets),
  sendPaths: (paths, targets) => ipcRenderer.invoke('files:send-paths', { paths, targets }),
  cancelTransfer: (id) => ipcRenderer.invoke('files:cancel', id),
  removeTransfer: (id) => ipcRenderer.invoke('files:remove', id),
  clearTransfers: () => ipcRenderer.invoke('files:clear'),
  sendText: (text, targets) => ipcRenderer.invoke('files:text', { text, targets }),
  setTargets: (names) => ipcRenderer.invoke('files:targets', names),
  setAutoAccept: (on) => ipcRenderer.invoke('files:auto-accept', on),
  setAskLarge: (on) => ipcRenderer.invoke('files:ask-large', on),
  openRecvDir: () => ipcRenderer.invoke('files:open-dir'),
  setRecvDir: () => ipcRenderer.invoke('files:set-dir'),
  revealFile: (p) => ipcRenderer.invoke('files:reveal', p),
  copyText: (text) => ipcRenderer.invoke('clip:write', text),
  showText: (payload) => ipcRenderer.invoke('text:show', payload),

  help: () => ipcRenderer.invoke('app:help'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close')
});
