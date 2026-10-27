'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, globalShortcut, screen, clipboard, powerMonitor } = require('electron');
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

  const want = (cfg.ui.hotkeys.global || '').trim();
  if (!want) {
    // 全局切换键未设置或已关闭
  } else if (tryRegister(want, () => doSwitchAll())) {
    registeredHotkey = want;
  } else {
    // 注册失败：如果是默认的 F12，尝试备用键；如果是用户自定义的快捷键，不随意乱改用户配置，明确提示冲突
    const isDefault = want === 'F12';
    if (isDefault) {
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
    } else {
      services.pushStatus(`快捷键 ${want} 注册失败（可能已被系统或其它程序占用）`, 'warn');
    }
  }

  const monitors = services.monitorRows();
  monitors.forEach((m, i) => {
    const key = ((cfg.ui.hotkeys.monitor || {})[m.id] || '').trim();
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
/**
 * 切换完成后画面会从这块屏上「消失」，系统会重排桌面、DDC 的当前输入源也变了。
 * 所以稍等一下轻量重扫一次（只更新顺序与当前输入源，不重建窗口），
 * 界面上的高亮才会跟着变成新的「谁在显示」。
 */
let rescanTimer = null;
/**
 * 切换（无论哪台发起、哪台执行）落地之后：
 * 1. 刷新界面；
 * 2. 把「每块屏现在归谁」广播出去 —— 任意一台点了切换，所有机器界面都跟着同步；
 * 3. 过一会儿重扫一次，以 DDC 实测为准。
 */
function onSwitchDone() {
  broadcastState();
  if (peer && typeof peer.sendAuthority === 'function') {
    peer.sendAuthority(services.publishAuthority());
  }
}

/**
 * 切换落地后重扫一次（DDC 需要一点时间生效），并以实测为准再广播一次归属。
 * 注意：收到对端快照触发的重扫**不能**再广播 —— 否则两台机器会你来我往无限互推。
 */
function confirmSwitchHint(delay, opts) {
  const publish = !!(opts && opts.publish);
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    services.detectMonitors().then(() => {
      broadcastState();
      if (publish && peer && typeof peer.sendAuthority === 'function') {
        peer.sendAuthority(services.publishAuthority());
      }
      if (peer && typeof peer.resendMeta === 'function') {
        peer.resendMeta();
      }
    }).catch(() => {});
  }, typeof delay === 'number' ? delay : 1800);
}

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
  const plan0 = services.buildSwitchPlan(target);
  const missing = (plan0.missing || []).slice();
  // 所有屏都已经在这台设备上了：一次 DDC 都不写 ——
  // 写一次显示器就要重新同步信号（黑屏 1~3 秒），没必要让本来就对的屏再黑一遍
  if (!plan0.ok && !missing.length && plan0.already > 0) {
    services.pushStatus(`所有显示器都已经在显示 ${name} 了`, 'ok');
    broadcastState();
    return { ok: true, result: 'kept', target };
  }
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
  if (result === 'sent' || result === 'relayed') { onSwitchDone(); confirmSwitchHint(1800, { publish: true }); }
  broadcastState();
  // 有屏还没配目标电脑的接口：切完顺手认一次口（会闪几下屏，认到就永久记住，
  // 以后再切就是一次到位；认不出来也不影响，手动点接口配一次即可）
  if ((result === 'sent' || result === 'relayed') && missing.length) autoProbePorts(target, missing);
  return { ok: result !== 'failed' && result !== 'no-input', target, result };
}

/** 切完之后自动认口：一台一台来，认到就停 */
async function autoProbePorts(target, missing) {
  for (const s of missing) {
    if (!services.portFor(s.id, target)) {
      services.pushStatus(`正在识别「${s.name}」上 ${services.deviceInfo(target).name} 接的是哪个口…`, 'info');
      broadcastState();
      const r = await services.probePort(s.id, target);
      if (r.ok) {
        services.pushStatus(`已识别：「${s.name}」上 ${services.deviceInfo(target).name} 接的是 ${r.label}`, 'ok');
        if (peer && peer.sendPorts) peer.sendPorts(services.exportPorts());
      } else {
        services.pushStatus(`「${s.name}」没认出来：${r.error}`, 'warn');
      }
      broadcastState();
    }
  }
}

/** 只切一块显示器：本机直接写这块屏的输入源（DDC 走视频线，与当前画面所属机器无关） */
async function doSwitchMonitor(monitorId, explicitTarget) {
  const plan = explicitTarget
    ? services.monitorSwitchPlan(monitorId, explicitTarget)
    : services.monitorCyclePlan(monitorId);
  if (!plan.ok) {
    services.pushStatus(plan.error, 'warn');
    broadcastState();
    return { ok: false, error: plan.error };
  }
  // 这块屏已经在该口上了：不写（每写一次都要重新同步信号 = 黑屏一下）
  if (plan.already) {
    services.pushStatus(`「${plan.name || '这台显示器'}」已经在显示 ${services.deviceInfo(plan.target).name} 了`, 'ok');
    broadcastState();
    return { ok: true, already: true };
  }
  // 只切这一块屏：本机直接写（DDC 走视频线，跟这块屏当前画面在哪台机器上无关）。
  // 以前用「当前画面在哪台就转给那台」的做法，一旦两端 index / 名字对不上就会切错屏。
  if (peer && peer.pauseAutoSwitch) peer.pauseAutoSwitch(1500);
  const r = await services.onSwitchRequest({
    input: plan.value,
    label: plan.label,
    index: plan.index
  });
  if (r && r.ok) onSwitchDone();
  confirmSwitchHint(1800, { publish: true });
  broadcastState();
  return { ok: !!(r && r.ok), error: (r && r.error) || '' };
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
    // 手动「重新检测」：本次扫描的读数就是实测定论，不再受「刚切完那几秒读数不可信」的限制
    services.clearSettle();
    await services.detectMonitors();
    registerHotkeys();
    if (peer && typeof peer.resendMeta === 'function') peer.resendMeta();
    return services.getState();
  });

  /* ---------- 设备 / 排列 / 改名 ---------- */

  ipcMain.handle('app:rename', (_e, name) => {
    services.rename(name);
    return services.getState();
  });

  /* ---------- 显示器 / 接口 ---------- */

  ipcMain.handle('monitor:port', (_e, { monitorId, deviceId, value } = {}) => {
    if (!services.setPort(monitorId, deviceId, value)) return services.getState();
    services.pushStatus(`接口已保存 · ${services.labelForInput(value)}`, 'ok');
    // 接口是这块屏上的物理事实，同步给对端，免得在另一台上点切换时提示「没设接口」
    if (peer && peer.sendPorts) peer.sendPorts(services.exportPorts());
    return services.getState();
  });

  ipcMain.handle('monitor:probe', async (_e, { monitorId, deviceId } = {}) => {
    const r = await services.probePort(monitorId, deviceId);
    if (r.ok) {
      services.pushStatus(`已识别：${services.labelForInput(r.value)} —— 这个口记住了`, 'ok');
      if (peer && peer.sendPorts) peer.sendPorts(services.exportPorts());
    } else if (r.error) {
      services.pushStatus(`自动识别没成功：${r.error}`, 'warn');
    }
    broadcastState();
    return { result: r, state: services.getState() };
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

  /* 共用键鼠（键鼠模式 / 无缝移动 / 按键映射 / macOS 键鼠权限）已整体移除，相关 IPC 不再注册 */

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

  // 笔记本合盖/锁屏时内建屏不再显示画面 —— 内建屏的「在用」状态跟着变
  try {
    const asleep = () => { if (services.setSelfAwake(false)) broadcastState(); };
    const awake = () => { if (services.setSelfAwake(true)) broadcastState(); };
    powerMonitor.on('suspend', asleep);
    powerMonitor.on('lock-screen', asleep);
    powerMonitor.on('resume', awake);
    powerMonitor.on('unlock-screen', awake);
  } catch (e) {
    console.warn('[electron] 电源事件监听失败:', e.message);
  }

  // 网络/输入层单独 try，避免原生模块不可用时整个界面打不开
  try {
    peer = createPeer(services.cfg, {
      onPeers: (list) => { services.onPeers(list); registerHotkeys(); broadcastState(); },
      onActive: (t) => { services.onActive(t); broadcastState(); },
      onSwitch: (info) => { services.onSwitch(info); broadcastState(); },
      // 每块屏的接口由服务层算，peer 只负责执行与状态同步
      getSwitchPlan: (target) => services.buildSwitchPlan(target),
      // 显示器元数据（内建屏与排列）同步给对端
      getDisplaysMeta: () => services.exportDisplaysMeta(),
      // 接口配置两端共享：在任一台配好，另一台也能直接按这个值切
      getPorts: () => services.exportPorts(),
      onPorts: (list) => {
        if (services.importPorts(list)) broadcastState();
      },
      // 对端自动识别接口时问「这块屏显示的是我吗」——按本机证据回答
      onProbe: (key, ports) => services.probeAnswer(key, ports),
      // 「每块屏现在归谁」：新开的机器对齐到局域网已有状态，切换后全局界面一致
      getAuthority: () => services.publishAuthority(),
      onAuthority: (msg) => {
        const r = services.applyAuthority(msg);
        if (!r) return;
        broadcastState();
        // 显示器刚切完，VCP 0x60 要过几秒才更新 —— 太早重扫会读到「切换前的口」，
        // 本机这份过期证据会把界面又拽回切换前的状态（Windows 点了切换、Mac 上还停在切换前）。
        // 等显示器稳定后再扫一次以实测定论；这次不广播，免得两台机器来回互推。
        confirmSwitchHint(r.stale ? 2600 : (services.settleRemain() + 900));
      },
      onSwitchRequest: (info) => {
        return Promise.resolve(services.onSwitchRequest(info)).then((r) => {
          onSwitchDone();
          return r;
        }).catch(() => ({ ok: false }));
      },
      onFileUpdate: (list) => { services.onFileUpdate(list); broadcastStateThrottled(); },
      // 收到文件前询问：接收 / 取消
      onAskIncoming: (payload) => askIncoming(payload),
      // 收到文本：直接弹窗展示并发拷贝按钮
      onText: (payload) => { showIncomingText(payload); broadcastStateThrottled(); },
      // 剪贴板同步用 Electron 原生读写（不依赖 clipboardy，打包后也一定能用）
      clipboard: {
        read: () => clipboard.readText(),
        write: (text) => clipboard.writeText(text)
      },
      onNotice: (msg) => { services.pushStatus(msg, 'warn'); broadcastState(); },
      // 对端跑的是旧版本、还在发键鼠模式同步：忽略（共用键鼠已移除，恒为「各用各的」）
      onInputMode: () => { services.persist(); broadcastState(); },
      // 鼠标穿越边界自动切换（共用键鼠已移除，正常不会再触发）
      onEdgeSwitch: ({ to }) => {
        services.pushStatus(`鼠标越过屏幕边界，已切到 ${services.deviceInfo(to).name}`, 'ok');
        broadcastState();
      },
      // 对端调了设备的左右顺序（共用键鼠已移除，仅保持配置同步）
      onArrange: () => {
        services.persist();
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
  // 兜底自愈：显示器上的按键被人手动按过、或对端的快照没送到时，本机状态会停在旧的。
  // 定期轻扫一次（只读当前输入源），界面就不会长时间停在过期的归属上。
  setInterval(() => {
    if (switching) return;
    services.detectMonitors().then(() => broadcastState()).catch(() => {});
  }, 30000);

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
