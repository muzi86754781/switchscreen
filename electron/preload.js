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

  detectMonitor: () => ipcRenderer.invoke('display:detect'),
  selectMonitor: (id) => ipcRenderer.invoke('display:select', id),
  selectInput: (role, value) => ipcRenderer.invoke('input:select', { role, value }),

  setHotkey: (enabled, key) => ipcRenderer.invoke('hotkey:set', { enabled, key }),
  setLaunchAtLogin: (open) => ipcRenderer.invoke('launch:set', open),
  switchTo: (role) => ipcRenderer.invoke('switch:to', role),

  setClipboardSync: (enabled) => ipcRenderer.invoke('clip:set', enabled),
  setClipboardPassword: (usePassword, password) => ipcRenderer.invoke('clip:password', { usePassword, password }),
  randomPassword: () => ipcRenderer.invoke('clip:random'),
  clipDir: (action) => ipcRenderer.invoke('clip:dir', action),
  clipSaveConnect: () => ipcRenderer.invoke('clip:save-connect'),
  clipCancel: () => ipcRenderer.invoke('clip:cancel'),

  setInputMode: (mode) => ipcRenderer.invoke('input:mode', mode),
  setMouseSpeed: (v) => ipcRenderer.invoke('input:speed', v),

  permissionStatus: () => ipcRenderer.invoke('perm:status'),
  openAccessibility: () => ipcRenderer.invoke('perm:open'),

  help: () => ipcRenderer.invoke('app:help'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close')
});
