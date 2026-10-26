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
  const width = Math.min(940, Math.max(800, wa.width - 80));
  const height = Math.min(920, Math.max(620, wa.height - 60));

  win = new BrowserWindow({
    width,
    height,
    minWidth: 800,
    minHeight: 620,
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
    const hk = services.cfg.ui.hotkeys || {};
    if (services.cfg.ui.hotkeyEnabled === false) return;

    if (matchAccel(hk.global, input) && registeredHotkey !== hk.global) {
      e.preventDefault();
      doSwitchAll();
      return;
    }
    const monitors = services.monitorRows();
    for (const m of monitors) {
      const key = (hk.monitor || {})[m.id];
      if (key && matchAccel(key, input)) {
        e.preventDefault();
        doSwitchMonitor(m.id);
        return;
      }
    }
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
  const devices = services.getState().devices || [];
  const monitorItems = (services.monitorRows() || []).map((m, i) => ({
    label: `显示器 ${String.fromCharCode(65 + i)}（${m.name}）`,
    click: () => doSwitchMonitor(m.id)
  }));
  return Menu.buildFromTemplate([
    { label: `SwitchScreen · ${services.localLabel()}`, enabled: false },
    { type: 'separator' },
    ...[...devices].map((d) => ({
      label: `${d.active ? '● ' : '   '}${d.name}${d.local ? '（本机）' : (d.online ? '' : '（离线）')}`,
      enabled: !d.active && d.online,
      click: () => doSwitchAll(d.id)
    })),
    { type: 'separator' },
    ...(monitorItems.length ? monitorItems : [{ label: '未检测到显示器', enabled: false }]),
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
    { label: '打开主界面', click: () => showWindow() },
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

function tryRegister(key, fn) {
  if (!key) return false;
  try { return globalShortcut.register(key, fn); } catch { return false; }
}

/**
 * 注册全部快捷键：全局切换 + 每块显示器各自一个。
 * 注册失败不会静默：要么回退到可用的键并写回配置，要么在状态栏说明。
 */
function registerHotkeys() {
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  registeredHotkey = '';
  const cfg = services.cfg;
  if (cfg.ui.hotkeyEnabled === false) return;
  if (!cfg.ui.hotkeys) cfg.ui.hotkeys = { global: 'F12', monitor: {} };

  const want = cfg.ui.hotkeys.global || '';
  if (!want) {
    services.pushStatus('全局切换键已关闭，只能用界面上的按钮切换', 'info');
  } else if (tryRegister(want, () => doSwitchAll())) {
    registeredHotkey = want;
  } else {
    let picked = '';
    for (const alt of HOTKEY_FALLBACKS) {
      if (alt === want) continue;
      if (tryRegister(alt, () => doSwitchAll())) { picked = alt; break; }
    }
    if (picked) {
      cfg.ui.hotkeys.global = picked;
      cfg.ui.hotkeyKey = picked;
      registeredHotkey = picked;
      services.persist();
      services.pushStatus(`${want} 被系统占用，全局切换已改用 ${picked}`, 'warn');
    } else {
      services.pushStatus(`全局切换键 ${want} 注册失败（可能被其它程序占用）`, 'warn');
    }
  }

  const monitors = services.monitorRows();
  monitors.forEach((m, i) => {
    const key = (cfg.ui.hotkeys.monitor || {})[m.id];
    if (!key) return;
    const letter = String.fromCharCode(65 + i);
    if (key === registeredHotkey) {
      services.pushStatus(`显示器 ${letter} 的快捷键与全局切换重复，已忽略`, 'warn');
      return;
    }
    if (!tryRegister(key, () => doSwitchMonitor(m.id))) {
      services.pushStatus(`显示器 ${letter} 的快捷键 ${key} 注册失败（可能被占用）`, 'warn');
    }
  });
}

function matchAccel(accel, input) {
  if (!accel) return false;
  const parts = accel.split('+');
  const key = parts[parts.length - 1];
  const cmd = parts.includes('CommandOrControl');
  const ctrl = parts.includes('Control');
  const alt = parts.includes('Alt');
  const shift = parts.includes('Shift');
  const wantCmd = cmd && IS_MAC;
  const wantCtrl = (cmd && !IS_MAC) || ctrl;
  if (!!input.meta !== wantCmd) return false;
  if (!!input.control !== wantCtrl) return false;
  if (!!input.alt !== alt) return false;
  if (!!input.shift !== shift) return false;
  return String(input.key || '').toUpperCase() === key.toUpperCase();
}

/* ---------------- 动作 ---------------- */

/** 切到某台设备（所有在它上面配置了接口的显示器一起切） */
async function doSwitchAll(explicitTarget) {
  if (!peer) return { ok: false, reason: 'no-peer' };
  if (switching) return { ok: false, reason: 'busy' };
  if (!peer.listPeers().length) {
    services.pushStatus('还没发现其它设备，请确认在同一局域网并都打开了本软件', 'warn');
    broadcastState();
    return { ok: false, reason: 'no-peer' };
  }
  const target = explicitTarget || services.nextDevice();
  const name = services.deviceInfo(target).name;
  switching = true;
  services.pushStatus(`正在切换到 ${name}…`, 'info');
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

/** 只切一块显示器：按这块屏当前显示的是谁来决定由哪台设备下发 DDC */
async function doSwitchMonitor(monitorId, explicitTarget) {
  const plan = explicitTarget
    ? services.monitorSwitchPlan(monitorId, explicitTarget)
    : services.monitorCyclePlan(monitorId);
  if (!plan.ok) {
    services.pushStatus(plan.error, 'warn');
    broadcastState();
    return { ok: false, error: plan.error };
  }
  if (plan.owner && plan.owner !== services.cfg.peerName && plan.ownerOnline && peer) {
    peer.relayDdc(plan.owner, { input: plan.value, label: plan.label, index: plan.index, name: plan.name });
    services.pushStatus(`已请求 ${services.deviceInfo(plan.owner).name} 把「${plan.name}」切到 ${plan.label}`, 'ok');
  } else {
    await services.onSwitchRequest({ input: plan.value, label: plan.label, index: plan.index });
  }
  broadcastState();
  return { ok: true };
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
    const from = services.deviceInfo(payload.from).name || payload.from;
    const opts = {
      type: 'question',
      buttons: ['接收', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: '收到文件',
      message: `${from} 想发送 ${name}`,
      detail: `${payload.count || 1} 项 · 共 ${fmtSize(payload.total || 0)}\n保存到：${services.cfg.ui.receiveDir || services.defaultReceiveDir()}`
    };
    const p = win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    p.then((r) => {
      const accept = r.response === 0;
      services.pushStatus(accept ? `正在接收 ${name}` : `已拒绝来自 ${from} 的 ${name}`, accept ? 'ok' : 'info');
      broadcastState();
      resolve(accept);
    }).catch(() => resolve(false));
  });
}

/** 收到文本：直接弹窗展示全文 + 一键拷贝 */
function showIncomingText(payload) {
  const text = String(payload.text || '');
  const from = payload.from ? (services.deviceInfo(payload.from).name || payload.from) : '';
  const long = text.length > 400;
  const opts = {
    type: 'info',
    buttons: ['拷贝到剪贴板', '关闭'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: payload.title || (from ? `来自 ${from} 的文本` : '传输记录'),
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
    if (!services.getState().monitors.length) await services.detectMonitors();
    return services.getState();
  });

  ipcMain.handle('display:detect', async () => {
    await services.detectMonitors();
    registerHotkeys();
    return services.getState();
  });

  /* ---------- 设备 / 排列 / 改名 ---------- */

  ipcMain.handle('app:rename', (_e, name) => {
    services.rename(name);
    return services.getState();
  });

  ipcMain.handle('arrange:set', (_e, list) => {
    services.setArrange(list);
    services.pushStatus('排列已保存，鼠标会按这个顺序穿越', 'ok');
    return services.getState();
  });

  /* ---------- 显示器 / 接口 ---------- */

  ipcMain.handle('monitor:port', (_e, { monitorId, deviceId, value } = {}) => {
    if (!services.setPort(monitorId, deviceId, value)) return services.getState();
    services.pushStatus(`接口已保存 · ${services.labelForInput(value)}`, 'ok');
    return services.getState();
  });

  ipcMain.handle('switch:device', async (_e, deviceId) => {
    const r = await doSwitchAll(deviceId);
    return { result: r, state: services.getState() };
  });

  ipcMain.handle('switch:monitor', async (_e, { monitorId, deviceId } = {}) => {
    await doSwitchMonitor(monitorId, deviceId || '');
    return services.getState();
  });

  /* ---------- 快捷键 ---------- */

  ipcMain.handle('hotkey:set', (_e, { enabled, kind, id, key } = {}) => {
    if (typeof enabled === 'boolean') services.cfg.ui.hotkeyEnabled = enabled;
    if (kind) services.setHotkey(kind, id, key);
    services.persist();
    registerHotkeys();
    services.pushStatus(
      services.cfg.ui.hotkeyEnabled === false
        ? '全局快捷键已关闭'
        : `快捷键已更新 · 关闭窗口后仍有效`,
      'ok'
    );
    return services.getState();
  });

  ipcMain.handle('launch:set', (_e, open) => {
    services.cfg.ui.launchAtLogin = !!open;
    services.persist();
    try { app.setLoginItemSettings({ openAtLogin: !!open }); } catch { /* ignore */ }
    services.pushStatus(open ? '已设置登录时启动' : '已关闭登录时启动', 'info');
    return services.getState();
  });

  /* ---------- 剪贴板 / 键鼠 ---------- */

  ipcMain.handle('clip:set', (_e, enabled) => {
    services.cfg.clipboardSync = !!enabled;
    services.persist();
    services.pushStatus(enabled ? '剪贴板同步已开启' : '剪贴板同步已关闭', enabled ? 'ok' : 'info');
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

  ipcMain.handle('input:mode', (_e, mode) => {
    services.applyInputMode(mode);
    const map = { separate: '各用各的键鼠', local: '共用本机键鼠', remote: '共用对端键鼠' };
    services.pushStatus(`键鼠模式：${map[mode] || mode}`, 'ok');
    if (mode !== 'separate' && !services.peers.length) {
      services.pushStatus('还没有其它设备在线，鼠标暂时没有可以流动的目标', 'warn');
    } else if (mode === 'local') {
      const err = services.captureError();
      if (err) services.pushStatus(`键鼠捕获未启动：${err}`, 'warn');
      else services.pushStatus('鼠标推到屏幕左右边缘就会流到相邻设备', 'info');
    }
    return services.getState();
  });

  ipcMain.handle('input:edge', (_e, on) => {
    services.cfg.ui.edgeSwitch = !!on;
    services.persist();
    services.pushStatus(on ? '已开启无缝移动：鼠标推到边上就换电脑' : '已关闭无缝移动', on ? 'ok' : 'info');
    return services.getState();
  });

  ipcMain.handle('input:mod-map', (_e, mode) => {
    const ok = ['cmd-ctrl', 'swap', 'off'];
    services.cfg.ui.modMap = ok.includes(mode) ? mode : 'cmd-ctrl';
    services.persist();
    services.pushStatus(`按键映射：${services.getState().input.modDesc}`, 'ok');
    return services.getState();
  });

  ipcMain.handle('input:key-debug', (_e, on) => {
    services.cfg.ui.keyDebug = !!on;
    services.persist();
    services.pushStatus(on ? '已开启按键诊断：按任意键会在下方显示原始键码' : '已关闭按键诊断', 'info');
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

  /** 发送对象：可以多台；显式指定的优先，否则用界面勾选的，再否则第一台在线设备 */
  function resolveTargets(explicit) {
    const online = services.peers.map((p) => p.name);
    if (!online.length) return [];
    const want = Array.isArray(explicit) ? explicit : (explicit ? [explicit] : []);
    const ok = want.filter((n) => online.includes(n));
    if (ok.length) return ok;
    const saved = services.targetPeerNames();
    if (saved.length) return saved;
    return [online[0]];
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

  async function sendPaths(paths, explicitTargets) {
    if (!peer) { services.pushStatus('网络层未启动', 'warn'); return services.getState(); }
    const targets = resolveTargets(explicitTargets);
    if (!targets.length) { services.pushStatus('未连接其它设备，无法发送', 'warn'); return services.getState(); }
    if (!paths || !paths.length) return services.getState();

    // 超过 1GB 且开启了询问：先确认
    if (services.cfg.ui.askLarge !== false) {
      const total = await totalBytes(paths);
      if (total > 1024 * 1024 * 1024) {
        const names = targets.map((n) => services.deviceInfo(n).name).join('、');
        const r = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['继续发送', '取消'],
          defaultId: 1,
          cancelId: 1,
          title: '确认发送大文件',
          message: `将向 ${names} 发送 ${fmtSize(total)}`,
          detail: `${paths.length} 项内容，超过 1GB，发送会占用较多网络带宽。`
        });
        if (r.response !== 0) {
          services.pushStatus('已取消发送', 'info');
          return services.getState();
        }
      }
    }

    for (const target of targets) {
      const res = await peer.offerFiles(paths, target);
      if (!res || !res.ok) services.pushStatus((res && res.error) || '发送失败', 'warn');
      else services.pushStatus(`已发送 ${paths.length} 项到 ${services.deviceInfo(target).name}`, 'ok');
    }
    return services.getState();
  }

  ipcMain.handle('files:pick', async (_e, targets) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections', 'openDirectory'],
      title: '选择要发送的文件或文件夹'
    });
    if (r.canceled || !r.filePaths.length) return services.getState();
    return sendPaths(r.filePaths, targets);
  });

  ipcMain.handle('files:send-paths', (_e, { paths, targets } = {}) => sendPaths(paths || [], targets));

  ipcMain.handle('files:cancel', (_e, id) => {
    if (peer) peer.cancelTransfer(id);
    services.pushStatus('已取消传输', 'info');
    return services.getState();
  });

  // 删除一条传输记录（正在传的会先取消）
  ipcMain.handle('files:remove', (_e, id) => {
    if (peer) peer.removeTransfer(id);
    return services.getState();
  });

  // 清空已结束的记录
  ipcMain.handle('files:clear', () => {
    if (peer) peer.clearTransfers();
    return services.getState();
  });

  // 传输记录里的文本：拷贝 / 另存查看
  ipcMain.handle('clip:write', (_e, text) => {
    try { clipboard.writeText(String(text || '')); } catch { /* ignore */ }
    services.pushStatus('已拷贝到剪贴板', 'ok');
    return services.getState();
  });

  // 查看一段记录里的完整文本（系统弹窗，可选中复制）
  ipcMain.handle('text:show', (_e, { text, from, title } = {}) => {
    showIncomingText({ text: text || '', from: from || '', title });
    return true;
  });

  ipcMain.handle('files:text', (_e, { text, targets } = {}) => {
    if (!peer || !text) return services.getState();
    const list = resolveTargets(targets);
    if (!list.length) { services.pushStatus('未连接其它设备，无法发送', 'warn'); return services.getState(); }
    for (const to of list) {
      peer.sendText(text, to);
      services.pushStatus(`已发送文本到 ${services.deviceInfo(to).name}`, 'ok');
    }
    return services.getState();
  });

  // 选择发送对象（可多选）
  ipcMain.handle('files:targets', (_e, names) => {
    services.setTargetPeers(names || []);
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

/**
 * 原生模块自检。
 * 缺文件时在界面第一屏就说清楚，而不是等用户第一次推鼠标才发现「什么都没发生」。
 */
function checkNativeModules() {
  let input;
  try { input = require('../src/input'); } catch { return; }
  try {
    input.ensureIoHook();
  } catch (e) {
    services.pushStatus(`键鼠捕获模块不可用：${e.message}`, 'warn');
  }
  try {
    input.ensureRobot();
  } catch (e) {
    services.pushStatus(`键鼠注入模块不可用：${e.message}`, 'warn');
  }
}

app.whenReady().then(() => {
  services.ensureDefaults();
  registerIpc();
  checkNativeModules();

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

  // 网络/输入层单独 try，避免原生模块不可用时整个界面打不开
  try {
    peer = createPeer(services.cfg, {
      onPeers: (list) => { services.onPeers(list); registerHotkeys(); broadcastState(); },
      onActive: (t) => { services.onActive(t); broadcastState(); },
      onSwitch: (info) => { services.onSwitch(info); broadcastState(); },
      // 每块屏的接口由服务层算，peer 只负责执行与状态同步
      getSwitchPlan: (target) => services.buildSwitchPlan(target),
      onSwitchRequest: (info) => {
        return Promise.resolve(services.onSwitchRequest(info)).then((r) => { broadcastState(); return r; }).catch(() => ({ ok: false }));
      },
      onFileUpdate: (list) => { services.onFileUpdate(list); broadcastStateThrottled(); },
      // 收到文件前询问：接收 / 取消
      onAskIncoming: (payload) => askIncoming(payload),
      // 收到文本：直接弹窗展示并发拷贝按钮
      onText: (payload) => { showIncomingText(payload); broadcastStateThrottled(); },
      // 对端改了键鼠模式，本机跟着切到镜像角色
      onInputMode: (mode) => {
        services.persist();
        const map = { separate: '各用各的键鼠', local: '共用本机键鼠', remote: '共用对端键鼠' };
        services.pushStatus(`已跟随对端切换键鼠模式：${map[mode] || mode}`, 'ok');
        if (mode === 'local') {
          const err = services.captureError();
          if (err) services.pushStatus(`键鼠捕获未启动：${err}`, 'warn');
        }
        broadcastState();
      },
      // 鼠标穿越边界自动切换
      onEdgeSwitch: ({ to }) => {
        services.pushStatus(`鼠标越过屏幕边界，已切到 ${services.deviceInfo(to).name}`, 'ok');
        broadcastState();
      },
      // 按键诊断（排查跨平台键位时用）
      onInputDebug: (line) => {
        services.pushStatus(line, 'info');
        broadcastStateThrottled();
      }
    });
    services.setPeer(peer);
  } catch (e) {
    console.error('[electron] peer 启动失败:', e.message);
    services.pushStatus(`网络层启动失败：${e.message}`, 'warn');
  }

  services.detectMonitors()
    .then(() => { registerHotkeys(); broadcastState(); })
    .catch(() => { registerHotkeys(); broadcastState(); });

  // 显示器插拔 / 改分辨率 / 换排列：重新算桌面范围与显示器顺序
  const onDisplayChange = () => {
    try {
      services.refreshScreenLayout();
    } catch (e) {
      console.error('[electron] 刷新显示器布局失败:', e.message);
    }
    broadcastState();
  };
  try {
    screen.on('display-added', onDisplayChange);
    screen.on('display-removed', onDisplayChange);
    screen.on('display-metrics-changed', onDisplayChange);
  } catch { /* ignore */ }

  broadcastState();
});

app.on('activate', () => showWindow());
app.on('window-all-closed', () => { /* 常驻托盘 */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (peer) { try { peer.stop(); } catch { /* ignore */ } }
});
