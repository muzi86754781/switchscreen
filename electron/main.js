'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const services = require('./services');
const { createPeer } = require('../src/peer');

const IS_MAC = process.platform === 'darwin';

let win = null;
let tray = null;
let peer = null;
let registeredHotkey = '';

/* ---------------- 窗口 ---------------- */

function createWindow() {
  // 适配小屏（13 寸 MacBook 工作区高度约 800）：窗口不超出可用区域
  let wa = { width: 1440, height: 900 };
  try { wa = screen.getPrimaryDisplay().workAreaSize; } catch { /* ignore */ }
  const width = Math.min(900, Math.max(780, wa.width - 80));
  const height = Math.min(880, Math.max(600, wa.height - 60));

  win = new BrowserWindow({
    width,
    height,
    minWidth: 780,
    minHeight: 600,
    show: false,
    backgroundColor: '#12151f',
    title: '电脑切换',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    trafficLightPosition: IS_MAC ? { x: 16, y: 20 } : undefined,
    ...(IS_MAC ? {} : { titleBarOverlay: { color: '#151a26', symbolColor: '#c8d2ea', height: 46 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  else { win.show(); win.focus(); }
}

/* ---------------- 托盘 ---------------- */

function trayMenu() {
  const cfg = services.cfg;
  return Menu.buildFromTemplate([
    { label: `SwitchScreen · ${cfg.peerName}`, enabled: false },
    { type: 'separator' },
    {
      label: `共用键鼠：${cfg.shareInput ? '开' : '关'}`,
      click: () => {
        services.applyInputMode(cfg.shareInput ? 'separate' : 'local');
        broadcastState();
        refreshTray();
      }
    },
    {
      label: `剪贴板同步：${cfg.clipboardSync ? '开' : '关'}`,
      click: () => {
        cfg.clipboardSync = !cfg.clipboardSync;
        services.persist();
        broadcastState();
        refreshTray();
      }
    },
    { type: 'separator' },
    { label: '切换电脑', click: () => doSwitch() },
    { label: '打开主界面', click: () => showWindow() },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(trayMenu());
}

/* ---------------- 全局快捷键 ---------------- */

function registerHotkey(key) {
  if (registeredHotkey) {
    try { globalShortcut.unregister(registeredHotkey); } catch { /* ignore */ }
    registeredHotkey = '';
  }
  if (!key || !services.cfg.ui.hotkeyEnabled) return;
  try {
    const ok = globalShortcut.register(key, () => doSwitch());
    if (ok) registeredHotkey = key;
    else services.pushStatus(`快捷键 ${key} 被系统占用，未能注册`, 'warn');
  } catch (e) {
    services.pushStatus(`快捷键 ${key} 注册失败：${e.message}`, 'warn');
  }
}

/* ---------------- 动作 ---------------- */

function doSwitch(targetRole) {
  if (!peer) return { ok: false };
  const localName = services.cfg.peerName;
  const peers = peer.listPeers();
  if (!peers.length) {
    services.pushStatus('未发现另一台电脑，请确认同一局域网且密码一致', 'warn');
    broadcastState();
    return { ok: false, reason: 'no-peer' };
  }
  const target = targetRole === 'local' ? localName : peers[0].name;
  peer.switchTo(target);
  broadcastState();
  return { ok: true, target };
}

/* ---------------- IPC ---------------- */

function broadcastState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('state:update', services.getState());
  }
  refreshTray();
}

function registerIpc() {
  ipcMain.handle('state:get', () => services.getState());
  ipcMain.handle('state:refresh', async () => {
    if (!services.getState().monitor.list.length) await services.detectMonitors();
    return services.getState();
  });

  ipcMain.handle('display:detect', async () => {
    await services.detectMonitors();
    return services.getState();
  });

  ipcMain.handle('display:select', (_e, id) => {
    const st = services.getState();
    const m = st.monitor.list.find((x) => x.id === id);
    if (m) {
      services.cfg.ui.monitorId = m.id;
      services.cfg.ui.monitorName = m.name;
      services.persist();
      services.pushStatus(`已选择显示器：${m.name}`, 'ok');
    }
    return services.getState();
  });

  ipcMain.handle('input:select', (_e, { role, value }) => {
    const preset = services.INPUT_PRESETS.find((p) => p.value === value) || { value, label: value };
    if (role === 'local') {
      services.cfg.ui.localInput = preset.value;
      services.cfg.ui.localInputLabel = preset.label;
    } else {
      services.cfg.ui.remoteInput = preset.value;
      services.cfg.ui.remoteInputLabel = preset.label;
    }
    services.syncInputMapping();
    services.pushStatus(`设置已保存 · ${preset.label}`, 'ok');
    return services.getState();
  });

  ipcMain.handle('hotkey:set', (_e, { enabled, key }) => {
    services.cfg.ui.hotkeyEnabled = !!enabled;
    if (key) services.cfg.ui.hotkeyKey = key;
    services.persist();
    registerHotkey(services.cfg.ui.hotkeyKey);
    services.pushStatus(enabled ? `已启用 ${services.cfg.ui.hotkeyKey} · 关闭窗口后仍有效` : '全局快捷键已关闭', enabled ? 'ok' : 'info');
    return services.getState();
  });

  ipcMain.handle('launch:set', (_e, open) => {
    services.cfg.ui.launchAtLogin = !!open;
    services.persist();
    try { app.setLoginItemSettings({ openAtLogin: !!open }); } catch { /* ignore */ }
    services.pushStatus(open ? '已设置登录时启动' : '已关闭登录时启动', 'info');
    return services.getState();
  });

  ipcMain.handle('switch:to', (_e, role) => {
    const r = doSwitch(role);
    return { result: r, state: services.getState() };
  });

  ipcMain.handle('clip:set', (_e, enabled) => {
    services.cfg.clipboardSync = !!enabled;
    services.persist();
    services.pushStatus(enabled ? '剪贴板同步已开启' : '剪贴板同步已关闭', enabled ? 'ok' : 'info');
    return services.getState();
  });

  ipcMain.handle('clip:password', (_e, { usePassword, password }) => {
    if (typeof usePassword === 'boolean') services.cfg.ui.usePassword = usePassword;
    if (typeof password === 'string') services.cfg.ui.password = password.replace(/\D/g, '').slice(0, 6);
    services.persist();
    return services.getState();
  });

  ipcMain.handle('clip:random', () => {
    services.cfg.ui.password = services.randomPassword();
    services.persist();
    services.pushStatus(`已生成新密码 ${services.cfg.ui.password}`, 'ok');
    return services.getState();
  });

  ipcMain.handle('clip:dir', async (_e, action) => {
    const ui = services.cfg.ui;
    if (action === 'choose') {
      const r = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: ui.receiveDir || services.defaultReceiveDir()
      });
      if (!r.canceled && r.filePaths[0]) {
        ui.receiveDir = r.filePaths[0];
        services.persist();
        services.pushStatus('接收目录已更新', 'ok');
      }
    } else if (action === 'open') {
      const dir = ui.receiveDir || services.defaultReceiveDir();
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      shell.openPath(dir);
    } else if (action === 'reset') {
      ui.receiveDir = services.defaultReceiveDir();
      services.persist();
      services.pushStatus('已恢复默认接收目录', 'ok');
    }
    return services.getState();
  });

  ipcMain.handle('clip:save-connect', () => {
    try { fs.mkdirSync(services.cfg.ui.receiveDir, { recursive: true }); } catch { /* ignore */ }
    services.persist();
    services.setClipProgress(0);
    const n = services.getState().connection.count;
    services.pushStatus(n ? '设置已保存，已重新连接' : '设置已保存，等待对端连接', n ? 'ok' : 'warn');
    return services.getState();
  });

  ipcMain.handle('clip:cancel', () => {
    services.setClipProgress(0);
    services.pushStatus('已取消传输', 'info');
    return services.getState();
  });

  ipcMain.handle('input:mode', (_e, mode) => {
    services.applyInputMode(mode);
    const map = { separate: '各用各的键鼠', local: '共用本机键鼠', remote: '共用对端键鼠' };
    services.pushStatus(`键鼠模式：${map[mode] || mode}`, 'ok');
    return services.getState();
  });

  ipcMain.handle('input:speed', (_e, v) => {
    services.cfg.ui.mouseSpeed = Math.max(0.5, Math.min(2, Number(v) || 1));
    services.persist();
    return services.getState();
  });

  ipcMain.handle('perm:open', () => {
    services.openAccessibilitySettings();
    return services.getState();
  });

  ipcMain.handle('perm:status', () => services.getState());

  ipcMain.handle('app:help', () => {
    shell.openExternal('https://github.com/muzi86754781/switchscreen#readme');
  });

  ipcMain.handle('window:minimize', () => win && win.minimize());
  ipcMain.handle('window:close', () => win && win.hide());
}

/* ---------------- 启动 ---------------- */

app.whenReady().then(() => {
  services.ensureDefaults();
  registerIpc();

  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  try {
    tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 }));
    tray.setToolTip('SwitchScreen');
    tray.setContextMenu(trayMenu());
    tray.on('click', () => showWindow());
  } catch (e) {
    console.error('[electron] 托盘创建失败:', e.message);
  }

  createWindow();
  registerHotkey(services.cfg.ui.hotkeyKey);

  // 网络/输入层单独 try，避免原生模块不可用时整个界面打不开
  try {
    peer = createPeer(services.cfg, {
      onPeers: (list) => { services.onPeers(list); broadcastState(); },
      onActive: (t) => { services.onActive(t); broadcastState(); },
      onSwitch: (info) => { services.onSwitch(info); broadcastState(); },
      onSwitchRequest: (info) => {
        Promise.resolve(services.onSwitchRequest(info)).then(broadcastState).catch(() => {});
      }
    });
    services.setPeer(peer);
  } catch (e) {
    console.error('[electron] peer 启动失败:', e.message);
    services.pushStatus(`网络层启动失败：${e.message}`, 'warn');
  }

  services.detectMonitors().then(broadcastState).catch(() => {});
  broadcastState();
});

app.on('activate', () => showWindow());
app.on('window-all-closed', () => { /* 常驻托盘 */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (peer) { try { peer.stop(); } catch { /* ignore */ } }
});
