'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, globalShortcut, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const services = require('./services');
const { createPeer } = require('../src/peer');

const IS_MAC = process.platform === 'darwin';

let win = null;
let tray = null;
let peer = null;
let registeredHotkey = '';
let switching = false;

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

  // 窗口聚焦时也响应切换键：全局快捷键被系统占用时（F12 常被开发者工具抢占）
  // 至少还能在窗口里按键生效。全局已注册的情况下不重复触发。
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.control || input.alt || input.meta || input.shift) return;
    const want = services.cfg.ui.hotkeyKey || 'F12';
    if (input.key !== want) return;
    if (registeredHotkey === want) return;
    e.preventDefault();
    doSwitch();
  });

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

// 单按功能键（F1~F12）在不少系统上会被占用，注册失败时按这个顺序回退
const HOTKEY_FALLBACKS = [
  'F11', 'F10', 'F9', 'F8',
  'CommandOrControl+Shift+F12',
  'CommandOrControl+Alt+F12',
  'CommandOrControl+Shift+Space'
];

function tryRegister(key) {
  try {
    if (globalShortcut.register(key, () => { doSwitch(); })) return true;
  } catch { /* ignore */ }
  return false;
}

function registerHotkey(key) {
  if (registeredHotkey) {
    try { globalShortcut.unregister(registeredHotkey); } catch { /* ignore */ }
    registeredHotkey = '';
  }
  if (!key || !services.cfg.ui.hotkeyEnabled) return '';
  if (tryRegister(key)) {
    registeredHotkey = key;
    return key;
  }
  // 被系统占用：自动换一个可用的，并把实际生效的键回写到配置与界面
  for (const alt of HOTKEY_FALLBACKS) {
    if (alt === key) continue;
    if (tryRegister(alt)) {
      registeredHotkey = alt;
      services.cfg.ui.hotkeyKey = alt;
      services.persist();
      services.pushStatus(`${key} 被系统占用，已改用 ${alt}`, 'warn');
      return alt;
    }
  }
  services.pushStatus(`快捷键 ${key} 注册失败（可能被其它程序占用）`, 'warn');
  return '';
}

/* ---------------- 动作 ---------------- */

async function doSwitch(targetRole) {
  if (!peer) return { ok: false, reason: 'no-peer' };
  if (switching) return { ok: false, reason: 'busy' };
  const localName = services.cfg.peerName;
  const peers = peer.listPeers();
  if (!peers.length) {
    services.pushStatus('未发现另一台电脑，请确认同一局域网且密码一致', 'warn');
    broadcastState();
    return { ok: false, reason: 'no-peer' };
  }
  const target = targetRole === 'local' ? localName : peers[0].name;
  // 等 DDC 真正执行完再刷新界面，这样成败都能立刻看到
  switching = true;
  services.pushStatus(`正在切换到 ${targetRole === 'local' ? '本机' : target}…`, 'info');
  broadcastState();
  let result = 'failed';
  try {
    result = await peer.switchTo(target);
  } catch (e) {
    services.pushStatus(`切换出错：${e.message}`, 'warn');
  } finally {
    switching = false;
  }
  broadcastState();
  return { ok: result !== 'failed' && result !== 'no-input', target, result };
}

/* ---------------- IPC ---------------- */

function broadcastState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('state:update', services.getState());
  }
  refreshTray();
}

// 文件传输期间分块很密，界面刷新做个节流（~10fps）
let stateTimer = null;
function broadcastStateThrottled() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    broadcastState();
  }, 100);
}

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let x = v;
  do { x /= 1024; i += 1; } while (x >= 1024 && i < u.length - 1);
  return `${x >= 10 || i === 0 ? x.toFixed(0) : x.toFixed(1)} ${u[i]}`;
}

/** 接收方弹窗：接收 / 取消（默认不自动接收，除非用户开了免确认） */
function askIncoming(payload) {
  return new Promise((resolve) => {
    const name = payload.name || '文件';
    const opts = {
      type: 'question',
      buttons: ['接收', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: '收到文件',
      message: `${payload.from || '另一台电脑'} 想发送 ${name}`,
      detail: `${payload.count || 1} 项 · 共 ${fmtSize(payload.total || 0)}\n保存到：${services.cfg.ui.receiveDir || services.defaultReceiveDir()}`
    };
    const p = win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    p.then((r) => {
      const accept = r.response === 0;
      services.pushStatus(
        accept ? `正在接收 ${name}` : `已拒绝来自 ${payload.from || '对端'} 的 ${name}`,
        accept ? 'ok' : 'info'
      );
      broadcastState();
      resolve(accept);
    }).catch(() => resolve(false));
  });
}

/** 收到文本：直接弹窗展示全文 + 一键拷贝 */
function showIncomingText(payload) {
  const text = String(payload.text || '');
  const long = text.length > 400;
  const opts = {
    type: 'info',
    buttons: ['拷贝到剪贴板', '关闭'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: `来自 ${payload.from || '另一台电脑'} 的文本`,
    message: long ? `${text.slice(0, 400)}…` : text,
    detail: long ? `共 ${text.length} 字，点「拷贝到剪贴板」复制全文` : '点「拷贝到剪贴板」直接粘贴到当前应用'
  };
  const p = win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  p.then((r) => {
    if (r.response === 0) {
      try { clipboard.writeText(text); } catch { /* ignore */ }
      services.pushStatus('已拷贝到剪贴板', 'ok');
      broadcastState();
    }
  }).catch(() => {});
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

  // 单台显示器指定接口（多显示器各接不同端口时用）
  ipcMain.handle('input:monitor', (_e, { monitorId, role, value }) => {
    if (!monitorId) return services.getState();
    services.setMonitorInput(monitorId, role === 'local' ? 'local' : 'remote', value);
    services.pushStatus(`接口已保存 · ${services.labelForInput(value)}`, 'ok');
    return services.getState();
  });

  ipcMain.handle('hotkey:set', (_e, { enabled, key }) => {
    services.cfg.ui.hotkeyEnabled = !!enabled;
    if (key) services.cfg.ui.hotkeyKey = key;
    services.persist();
    const actual = registerHotkey(services.cfg.ui.hotkeyKey) || services.cfg.ui.hotkeyKey;
    services.pushStatus(enabled ? `已启用 ${actual} · 关闭窗口后仍有效` : '全局快捷键已关闭', enabled ? 'ok' : 'info');
    return services.getState();
  });

  ipcMain.handle('launch:set', (_e, open) => {
    services.cfg.ui.launchAtLogin = !!open;
    services.persist();
    try { app.setLoginItemSettings({ openAtLogin: !!open }); } catch { /* ignore */ }
    services.pushStatus(open ? '已设置登录时启动' : '已关闭登录时启动', 'info');
    return services.getState();
  });

  ipcMain.handle('switch:to', async (_e, role) => {
    const r = await doSwitch(role);
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

  /* ---------- 文件 / 文本传输 ---------- */

  /** 目标机：显式指定的优先，否则用界面上选中的，再否则第一台在线对端 */
  function resolveTarget(explicit) {
    const conn = services.getState().connection;
    if (!conn.count) return '';
    if (explicit && conn.peers.some((p) => p.name === explicit)) return explicit;
    const saved = services.targetPeerName();
    return saved || conn.peers[0].name;
  }

  /** 统计待发送的总字节（用于「超过 1GB 发送前询问」） */
  async function totalBytes(paths) {
    const fsp = require('fs/promises');
    let sum = 0;
    const walk = async (p) => {
      let st;
      try { st = await fsp.stat(p); } catch { return; }
      if (st.isFile()) { sum += st.size; return; }
      if (!st.isDirectory()) return;
      let entries = [];
      try { entries = await fsp.readdir(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) await walk(path.join(p, e.name));
    };
    for (const p of paths) await walk(p);
    return sum;
  }

  async function sendPaths(paths, explicitTarget) {
    if (!peer) { services.pushStatus('网络层未启动', 'warn'); return services.getState(); }
    const target = resolveTarget(explicitTarget);
    if (!target) { services.pushStatus('未连接另一台电脑，无法发送', 'warn'); return services.getState(); }
    if (!paths || !paths.length) return services.getState();

    // 超过 1GB 且开启了询问：先确认
    if (services.cfg.ui.askLarge !== false) {
      const total = await totalBytes(paths);
      if (total > 1024 * 1024 * 1024) {
        const r = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['继续发送', '取消'],
          defaultId: 1,
          cancelId: 1,
          title: '确认发送大文件',
          message: `将向 ${target} 发送 ${fmtSize(total)}`,
          detail: `${paths.length} 项内容，超过 1GB，发送会占用较多网络带宽。`
        });
        if (r.response !== 0) {
          services.pushStatus('已取消发送', 'info');
          return services.getState();
        }
      }
    }

    const res = await peer.offerFiles(paths, target);
    if (!res || !res.ok) services.pushStatus((res && res.error) || '发送失败', 'warn');
    else services.pushStatus(`已发送 ${paths.length} 项到 ${target}`, 'ok');
    return services.getState();
  }

  ipcMain.handle('files:pick', async (_e, explicitTarget) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections', 'openDirectory'],
      title: '选择要发送的文件或文件夹'
    });
    if (r.canceled || !r.filePaths.length) return services.getState();
    return sendPaths(r.filePaths, explicitTarget);
  });

  ipcMain.handle('files:send-paths', (_e, { paths, target } = {}) => sendPaths(paths || [], target));

  ipcMain.handle('files:cancel', (_e, id) => {
    if (peer) peer.cancelTransfer(id);
    services.pushStatus('已取消传输', 'info');
    return services.getState();
  });

  ipcMain.handle('files:text', (_e, { text, target } = {}) => {
    if (!peer || !text) return services.getState();
    const to = resolveTarget(target);
    if (!to) { services.pushStatus('未连接另一台电脑，无法发送', 'warn'); return services.getState(); }
    peer.sendText(text, to);
    services.pushStatus(`已发送文本到 ${to}`, 'ok');
    return services.getState();
  });

  // 选择接收对象（多对端时可切换）
  ipcMain.handle('files:target', (_e, name) => {
    services.cfg.ui.targetPeer = name || '';
    services.persist();
    return services.getState();
  });

  // 免确认自动接收（默认关闭 = 每次都要手动点接收）
  ipcMain.handle('files:auto-accept', (_e, on) => {
    services.cfg.ui.autoAccept = !!on;
    services.persist();
    services.pushStatus(on ? '已开启免确认自动接收' : '接收文件前会先询问', on ? 'ok' : 'info');
    return services.getState();
  });

  // 「超过 1GB 发送前询问」开关
  ipcMain.handle('files:ask-large', (_e, on) => {
    services.cfg.ui.askLarge = !!on;
    services.persist();
    return services.getState();
  });

  ipcMain.handle('files:open-dir', async () => {
    const dir = services.cfg.ui.receiveDir || services.defaultReceiveDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    shell.openPath(dir);
    return services.getState();
  });

  ipcMain.handle('files:set-dir', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: services.cfg.ui.receiveDir || services.defaultReceiveDir()
    });
    if (!r.canceled && r.filePaths[0]) {
      services.cfg.ui.receiveDir = r.filePaths[0];
      services.persist();
      services.pushStatus('接收目录已更新', 'ok');
    }
    return services.getState();
  });

  ipcMain.handle('files:reveal', (_e, p) => {
    if (p) shell.showItemInFolder(p);
    return services.getState();
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
      },
      onFileUpdate: (list) => { services.onFileUpdate(list); broadcastStateThrottled(); },
      // 收到文件前询问：接收 / 取消
      onAskIncoming: (payload) => askIncoming(payload),
      // 收到文本：直接弹窗展示并发拷贝按钮
      onText: (payload) => { showIncomingText(payload); broadcastStateThrottled(); }
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
