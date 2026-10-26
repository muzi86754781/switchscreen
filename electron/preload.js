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

  // 剪贴板 / 键鼠
  setClipboardSync: (enabled) => ipcRenderer.invoke('clip:set', enabled),
  clipDir: (action) => ipcRenderer.invoke('clip:dir', action),
  setInputMode: (mode) => ipcRenderer.invoke('input:mode', mode),
  setEdgeSwitch: (on) => ipcRenderer.invoke('input:edge', on),
  setModMap: (mode) => ipcRenderer.invoke('input:mod-map', mode),
  setKeyDebug: (on) => ipcRenderer.invoke('input:key-debug', on),
  // 无缝移动的方向：改左右顺序 / 只把键鼠交给某台 / 把鼠标亮出来
  setArrange: (list) => ipcRenderer.invoke('input:arrange', { list }),
  flipArrange: () => ipcRenderer.invoke('input:arrange', { flip: true }),
  handControl: (target, side) => ipcRenderer.invoke('input:hand', { target, side }),
  locateCursor: () => ipcRenderer.invoke('input:locate'),

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

  permissionStatus: () => ipcRenderer.invoke('perm:status'),
  openAccessibility: () => ipcRenderer.invoke('perm:open'),
  openInputMonitoring: () => ipcRenderer.invoke('perm:open-input-monitoring'),
  retryCapture: () => ipcRenderer.invoke('perm:retry'),

  help: () => ipcRenderer.invoke('app:help'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close')
});
