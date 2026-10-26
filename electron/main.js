'use strict';

const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { createPeer } = require('../src/peer');
const { loadConfig, saveConfig } = require('../src/config');

let tray = null;
let peer = null;
let cfg = loadConfig();

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: `SwitchScreen · ${cfg.peerName}`, enabled: false },
    { type: 'separator' },
    {
      label: `共用键鼠：${cfg.shareInput ? '开' : '关'}`,
      click: () => { cfg.shareInput = !cfg.shareInput; saveConfig(cfg); refresh(); }
    },
    {
      label: `剪贴板同步：${cfg.clipboardSync ? '开' : '关'}`,
      click: () => { cfg.clipboardSync = !cfg.clipboardSync; saveConfig(cfg); refresh(); }
    },
    { type: 'separator' },
    { label: '切换电脑', click: () => peer && peer.triggerSwitch() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
}

function refresh() {
  if (tray) tray.setContextMenu(buildMenu());
}

app.whenReady().then(() => {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('SwitchScreen');
  tray.setContextMenu(buildMenu());
  peer = createPeer(cfg); // 同一 cfg 对象引用，托盘开关即时生效
  console.log('[electron] SwitchScreen 托盘已启动');
});

// 托盘应用：关闭所有窗口不退出
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => peer && peer.stop());
