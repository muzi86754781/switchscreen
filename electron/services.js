'use strict';

/**
 * 主进程服务层：把 src/ 下的能力聚合成 GUI 需要的状态与动作。
 * 所有配置修改都直接改同一个 cfg 对象（peer.js 持有同一引用），
 * 这样界面上的开关能即时生效，无需重启。
 *
 * 设备模型（v0.6.0）：
 *   - 任意多台设备（本机 + 局域网内所有运行本软件的其它机器），身份用 peerName 字符串表示；
 *   - 每块显示器维护一张「设备 → 输入源」表 ui.portMap，支持每块屏各接不同端口；
 *   - 设备按 ui.arrange 的顺序从左到右排列，无缝移动就是按这个顺序找左右邻居。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, systemPreferences, shell, screen } = require('electron');
const { loadConfig, saveConfig } = require('../src/config');
const { describeModMap } = require('../src/keymap');
const { setScreenRect } = require('../src/input');
const ddc = require('./ddc');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// 常见 DDC/CI 输入源值（因显示器而异）
const INPUT_PRESETS = [
  { value: '0x11', label: 'HDMI1' },
  { value: '0x12', label: 'HDMI2' },
  { value: '0x13', label: 'HDMI3' },
  { value: '0x0f', label: 'DP1' },
  { value: '0x10', label: 'DP2' },
  { value: '0x1b', label: 'USB-C' },
  { value: '0x1a', label: 'USB-C2' }
];

// 快捷键候选（显示器 A/B/C/D 的默认值放在前四个）
const HOTKEY_CHOICES = [
  'CommandOrControl+Alt+1', 'CommandOrControl+Alt+2',
  'CommandOrControl+Alt+3', 'CommandOrControl+Alt+4',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'CommandOrControl+Shift+F12', 'CommandOrControl+Alt+F12',
  'CommandOrControl+Shift+Space'
];

const MONITOR_HOTKEY_DEFAULTS = [
  'CommandOrControl+Alt+1',
  'CommandOrControl+Alt+2',
  'CommandOrControl+Alt+3',
  'CommandOrControl+Alt+4'
];

let cfg = loadConfig();
let peer = null;
let peersNow = [];
let activeTarget = cfg.peerName;
let monitorsCache = [];
let ddcError = '';
let fileTransfers = [];
const fileStatusSeen = new Map();
let clipProgress = 0;
let clipPercent = 0;
let statusLines = [];

function pushStatus(text, kind) {
  statusLines.unshift({ text, kind: kind || 'info', at: Date.now() });
  statusLines = statusLines.slice(0, 4);
}

function defaultReceiveDir() {
  const base = path.join(os.homedir(), 'Desktop');
  return path.join(base, 'SwitchScreen', 'clipboard', 'received');
}

/* ---------------- 配置 ---------------- */

function ensureDefaults() {
  if (!cfg.ui) cfg.ui = {};
  const ui = cfg.ui;
  if (!ui.receiveDir) ui.receiveDir = defaultReceiveDir();
  if (typeof ui.mouseSpeed !== 'number') ui.mouseSpeed = 1;
  if (!ui.inputMode) ui.inputMode = 'separate';
  if (!ui.displayName) ui.displayName = cfg.peerName;

  // 快捷键：global + 每块显示器一个
  if (!ui.hotkeys || typeof ui.hotkeys !== 'object') {
    ui.hotkeys = { global: ui.hotkeyKey || 'F12', monitor: {} };
  }
  if (!ui.hotkeys.global) ui.hotkeys.global = ui.hotkeyKey || 'F12';
  if (!ui.hotkeys.monitor || typeof ui.hotkeys.monitor !== 'object') ui.hotkeys.monitor = {};
  ui.hotkeyKey = ui.hotkeys.global;

  if (!Array.isArray(ui.arrange)) ui.arrange = [];
  if (!Array.isArray(ui.targetPeers)) ui.targetPeers = ui.targetPeer ? [ui.targetPeer] : [];
  if (typeof ui.autoAccept !== 'boolean') ui.autoAccept = false;
  if (typeof ui.edgeSwitch !== 'boolean') ui.edgeSwitch = true;
  if (!ui.modMap) ui.modMap = 'cmd-ctrl';
  if (typeof ui.keyDebug !== 'boolean') ui.keyDebug = false;
  if (!ui.portMap || typeof ui.portMap !== 'object') ui.portMap = {};
  // 记下每台设备最近一次上报的显示名，离线时也能显示正确的名字
  if (!ui.peerLabels || typeof ui.peerLabels !== 'object') ui.peerLabels = {};
  if (!ui.knownPeers || typeof ui.knownPeers !== 'object') ui.knownPeers = {};

  // 旧版 perMonitor（只有 local / remote 两栏）迁移到 portMap
  if (ui.perMonitor && typeof ui.perMonitor === 'object') {
    if (!ui.legacyRemotePorts) ui.legacyRemotePorts = {};
    for (const [mid, v] of Object.entries(ui.perMonitor)) {
      const t = ui.portMap[mid] || {};
      if (v && v.local && !Object.prototype.hasOwnProperty.call(t, cfg.peerName)) t[cfg.peerName] = v.local;
      if (v && v.localLabel) { /* 标签按值实时算，无需保存 */ }
      if (v && v.remote && !ui.legacyRemotePorts[mid]) ui.legacyRemotePorts[mid] = v.remote;
      ui.portMap[mid] = t;
    }
    delete ui.perMonitor;
  }

  // 早期版本存过连接配对密码，已不再使用
  delete ui.usePassword;
  delete ui.password;

  // shareInput / isHost 必须跟键鼠模式一致：旧配置里这两个值可能是 true，
  // 会让「各用各的」也偷偷捕获键鼠、鼠标推到边上就换电脑
  const mode = ui.inputMode || 'separate';
  cfg.shareInput = mode !== 'separate';
  cfg.isHost = mode !== 'remote';

  saveConfig(cfg);
}

function persist() {
  saveConfig(cfg);
}

/**
 * 切换键鼠模式。
 * 这个状态两端必须一致，所以改完要把模式广播出去，
 * 让对端切到镜像角色（我当主机 → 对端只接收；我共用对端 → 对端开始捕获）。
 */
function applyInputMode(mode, opts) {
  cfg.ui.inputMode = mode;
  if (mode === 'separate') {
    cfg.shareInput = false;
    cfg.isHost = true; // 捕获层存在但不转发
  } else if (mode === 'local') {
    cfg.shareInput = true;
    cfg.isHost = true;   // 本机接物理键鼠，捕获并转发
  } else if (mode === 'remote') {
    cfg.shareInput = true;
    cfg.isHost = false;  // 本机只接收注入，不捕获
  }
  persist();
  if (peer && peer.refreshInputMode) peer.refreshInputMode();
  if (!(opts && opts.silent) && peer && peer.announceInputMode) peer.announceInputMode(mode);
}

/* ---------------- 设备 ---------------- */

function kindOf(platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return 'pc';
}

/** 本机显示名（可自定义，改完会同步给其它设备） */
function localLabel() {
  return (cfg.ui && cfg.ui.displayName) || cfg.peerName;
}

function localKind() {
  return IS_MAC ? 'mac' : IS_WIN ? 'win' : 'pc';
}

/** 参与工作的所有设备身份：本机 + 在线对端 + 曾经见过但现在离线的对端 */
function deviceIds() {
  const ids = [cfg.peerName];
  for (const p of peersNow) if (!ids.includes(p.name)) ids.push(p.name);
  const known = (cfg.ui && cfg.ui.knownPeers) || {};
  for (const n of Object.keys(known)) if (!ids.includes(n)) ids.push(n);
  return ids;
}

function deviceInfo(id) {
  if (id === cfg.peerName) {
    return { id, name: localLabel(), kind: localKind(), local: true, online: true };
  }
  const p = peersNow.find((x) => x.name === id);
  const known = (cfg.ui.knownPeers && cfg.ui.knownPeers[id]) || {};
  const cached = (cfg.ui.peerLabels && cfg.ui.peerLabels[id]) || known.label || '';
  return {
    id,
    name: (p && (p.label || p.name)) || cached || id,
    kind: kindOf((p && p.platform) || known.platform),
    local: false,
    online: !!p
  };
}

/** 设备排列（含暂时离线的，位置不会丢） */
function arrangeOrder() {
  if (!Array.isArray(cfg.ui.arrange)) cfg.ui.arrange = [];
  const arr = cfg.ui.arrange.slice();
  for (const id of deviceIds()) if (!arr.includes(id)) arr.push(id);
  return arr;
}

function setArrange(list) {
  const known = new Set([...arrangeOrder(), ...deviceIds()]);
  const clean = [];
  for (const id of (Array.isArray(list) ? list : [])) {
    if (known.has(id) && !clean.includes(id)) clean.push(id);
  }
  for (const id of arrangeOrder()) if (!clean.includes(id)) clean.push(id);
  cfg.ui.arrange = clean;
  persist();
  return clean;
}

/* ---------------- 每块屏 × 每台设备的接口 ---------------- */

function labelForInput(value) {
  const p = INPUT_PRESETS.find((x) => x.value === value);
  return p ? p.label : String(value || '');
}

/** 某块显示器上，某台设备接的是哪个口；空字符串 = 不接 / 不切 */
function portFor(monitorId, deviceId) {
  const t = (cfg.ui.portMap && cfg.ui.portMap[monitorId]) || {};
  if (Object.prototype.hasOwnProperty.call(t, deviceId)) return t[deviceId] || '';
  if (deviceId === cfg.peerName) return cfg.ui.localInput || cfg.selfInput || '';
  if (peersNow[0] && peersNow[0].name === deviceId) return cfg.ui.remoteInput || '';
  return '';
}

/** 补齐默认端口（不覆盖用户已保存的值） */
function ensurePortDefaults() {
  if (!cfg.ui.portMap) cfg.ui.portMap = {};
  let changed = false;
  for (const m of monitorsCache) {
    const t = cfg.ui.portMap[m.id] || {};
    if (!Object.prototype.hasOwnProperty.call(t, cfg.peerName)) {
      t[cfg.peerName] = cfg.ui.localInput || cfg.selfInput || '';
      changed = true;
    }
    for (const p of peersNow) {
      if (!Object.prototype.hasOwnProperty.call(t, p.name)) {
        const legacy = (cfg.ui.legacyRemotePorts && cfg.ui.legacyRemotePorts[m.id]) || '';
        t[p.name] = legacy || cfg.ui.remoteInput || '';
        changed = true;
      }
    }
    cfg.ui.portMap[m.id] = t;
  }
  if (changed) persist();
}

function setPort(monitorId, deviceId, value) {
  if (!monitorId || !deviceId) return false;
  if (!cfg.ui.portMap) cfg.ui.portMap = {};
  const t = cfg.ui.portMap[monitorId] || {};
  const v = value || '';
  t[deviceId] = v;
  cfg.ui.portMap[monitorId] = t;
  // 本机 / 首个对端的值同步到全局默认，作为新显示器、新设备的兜底
  if (v) {
    if (deviceId === cfg.peerName) {
      cfg.ui.localInput = v;
      cfg.ui.localInputLabel = labelForInput(v);
      cfg.selfInput = v;
    } else if (peersNow[0] && peersNow[0].name === deviceId) {
      cfg.ui.remoteInput = v;
      cfg.ui.remoteInputLabel = labelForInput(v);
    }
  }
  persist();
  return true;
}

/** 这块屏此刻正显示哪台设备（读不到当前输入时返回空字符串） */
function ownerOf(m) {
  if (!m || !m.currentInput) return '';
  for (const id of deviceIds()) {
    const v = portFor(m.id, id);
    if (v && v === m.currentInput) return id;
  }
  return '';
}

function monitorRows() {
  return monitorsCache.map((m) => {
    const ports = {};
    for (const id of deviceIds()) {
      const v = portFor(m.id, id);
      ports[id] = { value: v, label: v ? labelForInput(v) : '未设置' };
    }
    const ownerId = ownerOf(m);
    return {
      id: m.id,
      index: typeof m.index === 'number' ? m.index : null,
      name: m.name,
      hasDdc: typeof m.index === 'number',
      currentInput: m.currentInput || '',
      currentInputLabel: m.currentInputLabel || '',
      ownerId,
      ownerLabel: ownerId ? deviceInfo(ownerId).name : '',
      ports,
      pos: m.pos || null,
      deviceCount: Object.values(ports).filter((p) => p.value).length
    };
  });
}

/* ---------------- 桌面布局（真实显示器排列） ---------------- */

let screenRects = [];

/**
 * 读系统里各显示器的真实位置（左/右/上/下）。
 * Windows 上 Electron 的 bounds 是 DIP，iohook/robotjs 用物理像素，
 * 所以换算成物理坐标；macOS 两者都是点，直接可用。
 */
function readScreenRects() {
  if (!screen || typeof screen.getAllDisplays !== 'function') return [];
  let list = [];
  try { list = screen.getAllDisplays() || []; } catch { return []; }
  let primaryId = '';
  try { primaryId = String(screen.getPrimaryDisplay().id); } catch { /* ignore */ }

  const out = [];
  for (const d of list) {
    let b = d.bounds || {};
    if (IS_WIN && typeof screen.dipToScreenRect === 'function') {
      try { b = screen.dipToScreenRect(null, b) || b; } catch { /* ignore */ }
    }
    if (!b.width || !b.height) continue;
    out.push({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
      label: d.label || '',
      id: String(d.id),
      primary: String(d.id) === primaryId
    });
  }
  return out;
}

const normName = (s) => String(s || '').toLowerCase().replace(/[\s\-_()（）]/g, '');

/**
 * 把 DDC 枚举出来的显示器按系统的真实左右/上下顺序排好。
 *
 * DDC 的 index 顺序是「枚举顺序」，跟系统设置里看到的排列常常不一致；
 * 用户要的是「显示器 A 就是我左边那块」。这里用 Electron 的显示器位置
 * 给每块屏定位，再按 (x, y) 排序；DDC index 仍然跟着各自的对象走，切换不受影响。
 */
function sortMonitorsByLayout() {
  if (!monitorsCache.length) return;
  const rects = screenRects;
  if (!rects.length) {
    monitorsCache.forEach((m) => { if (!m.pos) m.pos = null; });
    return;
  }

  const used = new Set();
  const pairs = [];
  const unpaired = [];

  // 1) 先按型号名配对（Electron 的 label 与系统友好名同源，命中率最高）
  for (const m of monitorsCache) {
    const key = normName(m.name);
    let hit = null;
    if (key) {
      hit = rects.find((r) => !used.has(r) && normName(r.label) && (
        normName(r.label).includes(key) || key.includes(normName(r.label))));
    }
    if (hit) { used.add(hit); pairs.push({ m, r: hit }); }
    else unpaired.push(m);
  }

  // 2) 剩下的按顺序补齐（数量一致时就是一一对应）
  const free = rects.filter((r) => !used.has(r));
  unpaired.forEach((m, i) => pairs.push({ m, r: free[i] || null }));

  const orderOf = new Map();
  monitorsCache.forEach((m, i) => orderOf.set(m, i));

  pairs.sort((a, b) => {
    if (!a.r && !b.r) return orderOf.get(a.m) - orderOf.get(b.m);
    if (!a.r) return 1;
    if (!b.r) return -1;
    if (a.r.x !== b.r.x) return a.r.x - b.r.x;
    return a.r.y - b.r.y;
  });

  monitorsCache = pairs.map((p) => {
    p.m.pos = p.r ? { x: p.r.x, y: p.r.y, width: p.r.width, height: p.r.height } : null;
    return p.m;
  });
}

/** 刷新显示器布局：既更新捕获端的桌面范围，也重排显示器顺序 */
function refreshScreenLayout() {
  screenRects = readScreenRects();
  try { setScreenRect(screenRects); } catch { /* 测试桩里没有这个函数 */ }
  sortMonitorsByLayout();
  return screenRects;
}

/* ---------------- 切换计划 ---------------- */

/** 所有参与切换的屏用的是同一个接口时，压成单个值：执行端就能「所有屏一起切」 */
function unifyInput(map, involved) {
  const vals = Object.values(map);
  if (involved > 1 && vals.length === involved && new Set(vals).size === 1) return vals[0];
  return map;
}

/**
 * 切到某台设备：算出每块屏该去哪个口，以及各自该由谁执行 DDC。
 * DDC 必须由「这块屏当前正在显示的那台机器」发出，所以按 owner 分组。
 */
function buildSwitchPlan(targetId) {
  if (!targetId) return { ok: false, total: 0, skipped: 0, localPlan: null, relays: [], label: '' };
  const localPlan = {};
  const groups = new Map();
  // 只有真的在线（有 WS 链路）才能替我们执行 DDC
  const online = new Set([cfg.peerName, ...peersNow.map((p) => p.name)]);
  let total = 0;
  let skipped = 0;
  let involved = 0;
  let label = '';

  for (const m of monitorsCache) {
    if (typeof m.index !== 'number') { skipped += 1; continue; }
    involved += 1;
    const value = portFor(m.id, targetId);
    if (!value) { skipped += 1; continue; }
    total += 1;
    if (!label) label = labelForInput(value);
    const owner = ownerOf(m);
    if (!owner || owner === cfg.peerName || !online.has(owner)) {
      localPlan[m.index] = value;
    } else {
      const g = groups.get(owner) || { plan: {}, monitors: [] };
      g.plan[m.index] = value;
      g.monitors.push({ name: m.name, value });
      groups.set(owner, g);
    }
  }

  return {
    ok: total > 0,
    target: targetId,
    total,
    skipped,
    // 统一接口 → 传字符串；各屏不同 → 传 { index: value }（对端还会按名字再校验一次）
    localPlan: Object.keys(localPlan).length ? unifyInput(localPlan, involved) : null,
    relays: [...groups.entries()].map(([to, g]) => ({
      to,
      plan: unifyInput(g.plan, involved),
      monitors: g.monitors
    })),
    label: label || (targetId === cfg.peerName ? cfg.ui.localInputLabel : cfg.ui.remoteInputLabel) || ''
  };
}

/** 单块屏切到某台设备的执行计划 */
function monitorSwitchPlan(monitorId, targetId) {
  const m = monitorsCache.find((x) => x.id === monitorId);
  if (!m) return { ok: false, error: '找不到这台显示器' };
  if (typeof m.index !== 'number') return { ok: false, error: '这台显示器不支持 DDC，无法单独切换' };
  const value = portFor(monitorId, targetId);
  if (!value) return { ok: false, error: '这台显示器还没给这台电脑指定接口' };
  const owner = ownerOf(m);
  return {
    ok: true,
    index: m.index,
    value,
    label: labelForInput(value),
    owner,
    ownerOnline: !owner || owner === cfg.peerName || peersNow.some((p) => p.name === owner),
    name: m.name,
    monitorId,
    target: targetId
  };
}

/** 单块屏的快捷键：在这块屏上配置过的设备之间轮换 */
function monitorCyclePlan(monitorId) {
  const m = monitorsCache.find((x) => x.id === monitorId);
  if (!m) return { ok: false, error: '找不到这台显示器' };
  const ids = deviceIds().filter((id) => portFor(monitorId, id));
  if (!ids.length) return { ok: false, error: '这台显示器还没配置任何一台电脑的接口' };
  const owner = ownerOf(m);
  const i = ids.indexOf(owner);
  const target = ids[(i + 1) % ids.length];
  return monitorSwitchPlan(monitorId, target);
}

/** 全局切换：按排列顺序切到下一台在线设备 */
function nextDevice() {
  const list = arrangeOrder().filter((id) => id === cfg.peerName || peersNow.some((p) => p.name === id));
  if (!list.length) return cfg.peerName;
  const i = list.indexOf(activeTarget);
  return list[(i + 1) % list.length];
}

/* ---------------- 显示器检测 ---------------- */

function detectMac() {
  return new Promise((resolve) => {
    execFile('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 12000 }, (err, stdout) => {
      if (err) return resolve([]);
      let data;
      try { data = JSON.parse(stdout); } catch { return resolve([]); }
      const out = [];
      const list = data.SPDisplaysDataType || [];
      for (const gpu of list) {
        for (const d of (gpu.spdisplays_ndrvs || [])) {
          const name = d._name || '显示器';
          const serial = String(d._spdisplays_displaySerialNumber || '').trim();
          out.push({ id: serial || name, name, serial, size: d._spdisplays_resolution || '' });
        }
      }
      resolve(out);
    });
  });
}

function detectWin() {
  return new Promise((resolve) => {
    const script = [
      'Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID | ForEach-Object {',
      "  $n = ($_.UserFriendlyName | Where-Object {$_ -ne 0} | ForEach-Object {[char]$_}) -join '';",
      "  $s = ($_.SerialNumberID  | Where-Object {$_ -ne 0} | ForEach-Object {[char]$_}) -join '';",
      "  \"$n|$s\" }"
    ].join('\n');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 12000 }, (err, stdout) => {
      if (err) return resolve([]);
      const out = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const t = line.trim();
        if (!t || !t.includes('|')) continue;
        const [name, serial] = t.split('|');
        if (!name) continue;
        out.push({ id: serial || name, name, serial: serial || '', size: '' });
      }
      resolve(out);
    });
  });
}

async function detectMonitors() {
  let list = [];
  let via = 'sys';
  try {
    // 优先走原生 DDC（可拿到 index 和当前输入源），再叠加系统友好名
    const r = await ddc.listDisplays();
    if (r.ok && r.displays.length) {
      via = r.via;
      const friendly = IS_MAC ? await detectMac() : IS_WIN ? await detectWin() : [];
      // ddcctl 没有可靠的列表输出，探测数量可能多于实际，用系统枚举结果裁剪
      let ddcList = r.displays;
      if (friendly.length && friendly.length < ddcList.length) ddcList = ddcList.slice(0, friendly.length);
      const aligned = friendly.length === ddcList.length;
      list = ddcList.map((d, i) => {
        const f = aligned ? friendly[i] : null;
        return {
          id: `ddc:${d.index}`,
          index: d.index,
          name: (f && f.name) || d.name || `显示器 ${d.index + 1}`,
          serial: (f && f.serial) || '',
          size: (f && f.size) || '',
          currentInput: d.currentInput || '',
          currentInputLabel: d.currentInputLabel || ''
        };
      });
    } else {
      const sys = IS_MAC ? await detectMac() : IS_WIN ? await detectWin() : [];
      list = sys.map((m, i) => ({
        ...m,
        index: null,
        id: m.id || `sys:${i}`,
        currentInput: '',
        currentInputLabel: ''
      }));
      if (r.error) ddcError = r.error;
    }
  } catch (e) {
    ddcError = e.message;
    list = [];
  }

  if (!list.length) {
    // 检测失败也让界面可用：保留已保存的名字
    list = [{
      id: cfg.ui.monitorId || 'default',
      index: null,
      name: cfg.ui.monitorName || '默认显示器',
      serial: '',
      size: '',
      currentInput: '',
      currentInputLabel: ''
    }];
  }
  monitorsCache = list;
  // 按系统里的真实排列（左/右/上/下）排好，界面上的「显示器 A/B」才是眼前看到的顺序
  refreshScreenLayout();
  if (!cfg.ui.monitorId || !list.some((m) => m.id === cfg.ui.monitorId)) {
    cfg.ui.monitorId = monitorsCache[0].id;
    cfg.ui.monitorName = monitorsCache[0].name;
    persist();
  }
  ensurePortDefaults();
  ensureMonitorHotkeys();

  pushStatus(
    via === 'dxva2' || via === 'm1ddc' || via === 'ddcctl'
      ? `已检测到 ${list.length} 台显示器（DDC 可用）`
      : `已检测到 ${list.length} 台显示器（DDC 不可用${ddcError ? '：' + ddcError : ''}）`,
    via === 'sys' ? 'warn' : 'ok'
  );
  return list;
}

/** 给还没配快捷键的显示器补一个默认键（显示器 A/B/C/D…） */
function ensureMonitorHotkeys() {
  if (!cfg.ui.hotkeys) cfg.ui.hotkeys = { global: 'F12', monitor: {} };
  if (!cfg.ui.hotkeys.monitor) cfg.ui.hotkeys.monitor = {};
  const map = cfg.ui.hotkeys.monitor;
  let changed = false;
  monitorsCache.forEach((m, i) => {
    if (map[m.id] === undefined) {
      map[m.id] = MONITOR_HOTKEY_DEFAULTS[i] || '';
      changed = true;
    }
  });
  if (changed) persist();
}

/* ---------------- DDC/CI 输入源切换 ---------------- */

function tryExec(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, err: err.code === 'ENOENT' ? 'ENOENT' : (stderr || err.message) });
      else resolve({ ok: true, stdout: String(stdout || '') });
    });
  });
}

/** index → 显示器名（macOS 切换后 index 会错位，靠它重新定位） */
function indexNames() {
  const m = {};
  for (const x of monitorsCache) if (typeof x.index === 'number') m[x.index] = x.name;
  return m;
}

/**
 * 执行一次输入源切换。
 * value 可以是统一接口值（"0x12"），也可以是按显示器 index 的 map（{ "0":"0x11" }）。
 * 1) 首选原生 DDC 层（Windows=dxva2，macOS=m1ddc/ddcctl），无需外部安装；
 * 2) 全部失败时才用外部命令行工具兜底；
 * 3) 都失败则如实返回原因，供界面提示。
 */
async function switchMonitorInput(value, label) {
  const native = await ddc.setInputAll(value, { names: indexNames() });
  if (native.ok) {
    ddcError = native.partial ? (native.error || '部分显示器不支持 DDC') : '';
    return {
      ok: true,
      partial: !!native.partial,
      via: native.via,
      label,
      success: native.success,
      total: native.total,
      error: native.partial ? native.error : ''
    };
  }
  ddcError = native.error || '';

  // 兜底：外部工具（仅 Windows）
  const flat = typeof value === 'string' ? value : Object.values(value || {})[0];
  if (IS_WIN && flat) {
    const tools = path.join(path.dirname(app.getPath('exe')), 'tools');
    const cmm = path.join(tools, 'ControlMyMonitor.exe');
    if (fs.existsSync(cmm)) {
      const r = await tryExec(cmm, ['/SetValue', 'Primary', '60', flat]);
      if (r.ok) return { ok: true, via: 'ControlMyMonitor', label, success: 1, total: 1 };
    }
    const r2 = await tryExec('ddcutil', ['setvcp', '60', flat]);
    if (r2.ok) return { ok: true, via: 'ddcutil', label, success: 1, total: 1 };
  }

  return { ok: false, label, success: 0, total: native.total || 0, error: native.error || '未找到可用的 DDC 通道' };
}

/* ---------------- 权限 ---------------- */

/**
 * macOS 辅助功能授权状态。
 *
 * 注意：未签名（ad-hoc）的 Electron 应用里，isTrustedAccessibilityClient() 经常
 * 在用户已经勾选授权后仍然返回 false，导致界面误报「未授权」。
 * 更可信的判断是「键鼠捕获到底起没起来」——真正的功能是否可用，而不是 API 的口径。
 */
function accessibilityGranted() {
  if (!IS_MAC) return true;
  if (peer && typeof peer.getCaptureError === 'function' && !peer.getCaptureError()) return true;
  try { return systemPreferences.isTrustedAccessibilityClient(false); } catch { return false; }
}

function captureError() {
  if (!peer || typeof peer.getCaptureError !== 'function') return '';
  return peer.getCaptureError() || '';
}

function openAccessibilitySettings() {
  if (!IS_MAC) return false;
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  return true;
}

/* ---------------- 状态聚合 ---------------- */

/** 当前选中的传输对象（多选）；不在线的自动剔除 */
function targetPeerNames() {
  const saved = Array.isArray(cfg.ui.targetPeers) ? cfg.ui.targetPeers : [];
  const online = saved.filter((n) => peersNow.some((p) => p.name === n));
  if (online.length) return online;
  return peersNow[0] ? [peersNow[0].name] : [];
}

function setTargetPeers(names) {
  const online = (Array.isArray(names) ? names : []).filter((n) => peersNow.some((p) => p.name === n));
  cfg.ui.targetPeers = online;
  cfg.ui.targetPeer = online[0] || '';
  persist();
  return online;
}

function getState() {
  const connected = peersNow.length > 0;
  const rows = monitorRows();
  const arrange = arrangeOrder();

  const devices = arrange.map((id) => {
    const info = deviceInfo(id);
    const monitors = rows.map((m) => ({
      id: m.id,
      name: m.name,
      port: m.ports[id] ? m.ports[id].label : '未设置',
      hasPort: !!(m.ports[id] && m.ports[id].value),
      here: m.ownerId === '' ? null : m.ownerId === id,
      ownerId: m.ownerId
    }));
    return {
      id,
      name: info.name,
      kind: info.kind,
      local: info.local,
      online: info.online,
      active: id === activeTarget,
      note: info.local ? '本机' : (info.online ? '局域网' : '离线'),
      monitors
    };
  });

  const monitors = rows.map((m, i) => ({
    id: m.id,
    index: m.index,
    name: m.name,
    hasDdc: m.hasDdc,
    ownerId: m.ownerId,
    ownerLabel: m.ownerLabel,
    ports: m.ports,
    deviceCount: m.deviceCount,
    pos: m.pos || null,
    letter: String.fromCharCode(65 + (i % 26))
  }));

  const hotkeys = (cfg.ui.hotkeys && cfg.ui.hotkeys.monitor) || {};
  const monitorKeys = {};
  for (const m of monitors) monitorKeys[m.id] = hotkeys[m.id] || '';

  return {
    version: app.getVersion(),
    platform: process.platform,
    hostname: os.hostname(),
    isMac: IS_MAC,
    me: { identity: cfg.peerName, name: localLabel(), kind: localKind() },
    connection: {
      connected,
      count: peersNow.length,
      peers: peersNow.map((p) => ({ name: p.name, label: p.label || p.name, platform: p.platform }))
    },
    devices,
    monitors,
    arrange,
    ddc: { available: monitorsCache.some((m) => typeof m.index === 'number'), error: ddcError },
    inputs: { presets: INPUT_PRESETS },
    hotkeys: {
      enabled: cfg.ui.hotkeyEnabled !== false,
      global: (cfg.ui.hotkeys && cfg.ui.hotkeys.global) || 'F12',
      monitor: monitorKeys,
      choices: HOTKEY_CHOICES
    },
    launchAtLogin: (() => { try { return app.getLoginItemSettings().openAtLogin; } catch { return false; } })(),
    clipboard: {
      enabled: !!cfg.clipboardSync,
      receiveDir: cfg.ui.receiveDir,
      askLarge: cfg.ui.askLarge !== false,
      progress: clipProgress,
      percent: clipPercent
    },
    inputMode: cfg.ui.inputMode,
    input: {
      mode: cfg.ui.inputMode,
      capturing: !!(cfg.shareInput && cfg.isHost),
      error: captureError(),
      edgeSwitch: cfg.ui.edgeSwitch !== false,
      modMap: cfg.ui.modMap || 'cmd-ctrl',
      modDesc: describeModMap(cfg.ui.modMap || 'cmd-ctrl', process.platform, (peersNow[0] && peersNow[0].platform) || process.platform),
      keyDebug: !!cfg.ui.keyDebug
    },
    files: {
      transfers: fileTransfers,
      recvDir: cfg.ui.receiveDir,
      autoAccept: !!cfg.ui.autoAccept,
      targets: targetPeerNames()
    },
    permission: { accessibility: accessibilityGranted() },
    active: activeTarget === cfg.peerName ? 'local' : 'remote',
    activeTarget,
    activeName: deviceInfo(activeTarget).name,
    statusLines
  };
}

function setPeer(p) { peer = p; }

function onPeers(list) {
  peersNow = list;
  // 记住显示名（改名会通过 meta 同步过来）
  if (!cfg.ui.peerLabels) cfg.ui.peerLabels = {};
  if (!cfg.ui.knownPeers) cfg.ui.knownPeers = {};
  for (const p of list) {
    cfg.ui.peerLabels[p.name] = p.label || p.name;
    cfg.ui.knownPeers[p.name] = { label: p.label || p.name, platform: p.platform || 'unknown', at: Date.now() };
  }
  // 只留最近见过的 8 台，配置文件别无限长
  const knownNames = Object.keys(cfg.ui.knownPeers);
  if (knownNames.length > 8) {
    knownNames
      .sort((a, b) => (cfg.ui.knownPeers[b].at || 0) - (cfg.ui.knownPeers[a].at || 0))
      .slice(8)
      .forEach((n) => { delete cfg.ui.knownPeers[n]; });
  }
  // 新设备补默认端口 + 排列位置
  ensurePortDefaults();
  arrangeOrder();
  cfg.ui.arrange = arrangeOrder();
  // 断开后清掉选择里的离线项
  cfg.ui.targetPeers = targetPeerNames();
  cfg._lastRemoteName = list[0] ? (list[0].label || list[0].name) : cfg._lastRemoteName;
  persist();
  pushStatus(
    list.length ? `已连接：${list.map((p) => p.label || p.name).join('、')}` : '设备已断开',
    list.length ? 'ok' : 'warn'
  );
}

function onActive(target) {
  activeTarget = target;
}

/** 文件传输列表更新：只在状态变化时写状态栏，避免每个分块都刷屏 */
function onFileUpdate(list) {
  fileTransfers = list || [];
  for (const t of fileTransfers) {
    const prev = fileStatusSeen.get(t.id);
    if (prev === t.status) continue;
    fileStatusSeen.set(t.id, t.status);
    if (t.status === 'done') {
      pushStatus(t.dir === 'in' ? `已接收：${t.name}` : `已发送：${t.name}`, 'ok');
    } else if (t.status === 'failed') {
      pushStatus(`传输失败：${t.name}${t.error ? '（' + t.error + '）' : ''}`, 'warn');
    }
  }
}

/** 两块屏同名时按顺序取没被占用过的那个 */
function nameMatches(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** 把对端发来的显示器名字换成本机的 DDC index（两端枚举顺序不一定一致） */
function resolveByName(list) {
  const map = {};
  const used = new Set();
  for (const it of (Array.isArray(list) ? list : [])) {
    if (!it || !it.value) continue;
    const m = monitorsCache.find((x) => typeof x.index === 'number' && !used.has(x.index) && nameMatches(x.name, it.name));
    if (m) { used.add(m.index); map[m.index] = it.value; }
  }
  return map;
}

/** peer 发起一次显示器输入源切换时调用：真正执行并如实回报结果 */
async function onSwitchRequest({ input, label, from, index, name: reqName, monitors }) {
  // 对端指定了显示器名字：优先按名字定位，避免 index 对不上切错屏
  if (Array.isArray(monitors) && monitors.length) {
    const byName = resolveByName(monitors);
    if (Object.keys(byName).length) { input = byName; index = undefined; }
  } else if (typeof index === 'number' && reqName) {
    const local = monitorsCache.find((x) => typeof x.index === 'number' && nameMatches(x.name, reqName));
    if (local) index = local.index;
  }

  // 指定了 index = 只切这一台显示器
  if (typeof index === 'number') {
    const name = label || (typeof input === 'string' ? labelForInput(input) : '目标接口');
    const r = await ddc.setInput(index, typeof input === 'string' ? input : Object.values(input || {})[0]);
    if (r.ok) {
      pushStatus(from ? `已由 ${from} 切换 1 台显示器到 ${name}` : `已把这台显示器切换到 ${name}`, 'ok');
      setTimeout(() => { detectMonitors().catch(() => {}); }, 1200);
    } else {
      pushStatus(`切换失败：${r.error || '未知原因'}`, 'warn');
    }
    return { ok: !!r.ok, error: r.error || '' };
  }

  const name = label || (typeof input === 'string' ? labelForInput(input) : '目标接口');
  const r = await switchMonitorInput(input, name);
  const scope = r.total > 1 ? `${r.success}/${r.total} 台显示器` : '显示器';
  if (r.ok) {
    pushStatus(from ? `已由 ${from} 把${scope}切换到 ${name}` : `已将${scope}切换到 ${name}`, 'ok');
    if (r.partial) pushStatus(`有显示器未响应：${r.error}`, 'warn');
    setTimeout(() => { detectMonitors().catch(() => {}); }, 1500);
  } else {
    pushStatus(`切换到 ${name} 失败`, 'warn');
    pushStatus(r.error || '未知原因', 'warn');
  }
  return r;
}

function onSwitch({ result, target, label, detail }) {
  const name = target ? deviceInfo(target).name : '';
  if (result === 'no-input') {
    pushStatus('这台电脑在显示器上还没指定接口，点显示器卡片上的齿轮设置', 'warn');
  } else if (result === 'relayed') {
    pushStatus(`已请求当前画面所在设备把显示器切到 ${name}`, 'ok');
  } else if (result === 'peers-gone') {
    pushStatus('对端连接已断开，无法切换', 'warn');
  } else if (result === 'failed') {
    pushStatus(`切换未生效${detail && detail.error ? '：' + detail.error : ''}`, 'warn');
  } else if (result === 'screen-kept') {
    pushStatus(`已切到 ${name} 的键鼠焦点（显示器都设为「不切」）`, 'info');
  } else if (result === 'sent') {
    pushStatus(`已切换到 ${name}`, 'ok');
  }
}

function setClipProgress(percent, bytes) {
  clipPercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
  if (typeof bytes === 'number') clipProgress = bytes;
}

/** 改本机显示名：会同步给其它设备显示 */
function rename(text) {
  const v = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!v) return false;
  cfg.ui.displayName = v;
  persist();
  if (peer && peer.resendMeta) peer.resendMeta();
  pushStatus(`本机名称已改为「${v}」`, 'ok');
  return true;
}

function setHotkey(kind, id, key) {
  if (!cfg.ui.hotkeys) cfg.ui.hotkeys = { global: 'F12', monitor: {} };
  if (!cfg.ui.hotkeys.monitor) cfg.ui.hotkeys.monitor = {};
  if (kind === 'global') {
    cfg.ui.hotkeys.global = key || '';
    cfg.ui.hotkeyKey = cfg.ui.hotkeys.global;
  } else if (kind === 'monitor' && id) {
    cfg.ui.hotkeys.monitor[id] = key || '';
  }
  persist();
}

/* ---------------- 导出 ---------------- */

module.exports = {
  get cfg() { return cfg; },
  get peer() { return peer; },
  get peers() { return peersNow; },
  ensureDefaults,
  persist,
  setPeer,
  applyInputMode,
  arrangeOrder,
  setArrange,
  deviceIds,
  deviceInfo,
  localLabel,
  portFor,
  setPort,
  ensurePortDefaults,
  monitorRows,
  buildSwitchPlan,
  monitorSwitchPlan,
  monitorCyclePlan,
  refreshScreenLayout,
  nextDevice,
  labelForInput,
  targetPeerNames,
  setTargetPeers,
  detectMonitors,
  switchMonitorInput,
  accessibilityGranted,
  openAccessibilitySettings,
  captureError,
  getState,
  onPeers,
  onActive,
  onFileUpdate,
  onSwitch,
  onSwitchRequest,
  pushStatus,
  rename,
  setHotkey,
  defaultReceiveDir,
  setClipProgress,
  setActiveTarget: (t) => { activeTarget = t; },
  INPUT_PRESETS,
  HOTKEY_CHOICES,
  IS_MAC,
  IS_WIN
};
