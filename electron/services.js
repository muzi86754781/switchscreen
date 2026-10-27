'use strict';

/**
 * 主进程服务层：把 src/ 下的能力聚合成 GUI 需要的状态与动作。
 * 所有配置修改都直接改同一个 cfg 对象（peer.js 持有同一引用），
 * 这样界面上的开关能即时生效，无需重启。
 *
 * 设备模型（v0.6.0）：
 *   - 任意多台设备（本机 + 局域网内所有运行本软件的其它机器），身份用 peerName 字符串表示；
 *   - 每块显示器维护一张「设备 → 输入源」表 ui.portMap，支持每块屏各接不同端口；
 *   - 无缝移动按「设备发现顺序」找相邻设备（两台机器即互相穿越），界面不再提供手动排列。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, systemPreferences, shell, screen } = require('electron');
const { loadConfig, saveConfig } = require('../src/config');
const { setScreenRect } = require('../src/input');
const ddc = require('./ddc');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// 常见 DDC/CI 输入源值（因显示器而异）。
// VGA / DVI 一定要有：不少 Dell 之类读回来是 0x03，旧版没这个预设时
// 界面上就会显示成一个「0x3」的对不上号的值，怎么配都判不出归属。
const INPUT_PRESETS = [
  { value: '0x01', label: 'VGA' },
  { value: '0x03', label: 'DVI' },
  { value: '0x04', label: 'DVI2' },
  { value: '0x11', label: 'HDMI1' },
  { value: '0x12', label: 'HDMI2' },
  { value: '0x13', label: 'HDMI3' },
  { value: '0x0f', label: 'DP1' },
  { value: '0x10', label: 'DP2' },
  { value: '0x1a', label: 'USB-C' },
  { value: '0x1b', label: 'USB-C2' }
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
let selfAwake = true;

// 远端设备上报的内建屏信息：peerName -> { name, pos }
const remoteInternals = new Map();
// 跨机器 key 别名映射：foreignKey -> local monitorId
const keyAliases = new Map();

function recordAlias(m, foreignKey) {
  if (!m || !foreignKey) return;
  keyAliases.set(foreignKey, m.id);
  const mk = portKey(m);
  if (mk && mk !== foreignKey) {
    if (!cfg.ui.portAlias) cfg.ui.portAlias = {};
    cfg.ui.portAlias[foreignKey] = mk;
  }
}

/** 主进程获取当前显示器简要拓扑，用于同步给局域网对端 */
function exportDisplaysMeta() {
  return monitorsCache.map((m) => ({
    name: m.name,
    internal: !!m.internal,
    pos: m.pos || null,
    serial: m.serial || ''
  }));
}

/** 主进程监听 powerMonitor 的锁屏/休眠事件后调用 */
function setSelfAwake(v) {
  const next = !!v;
  if (next === selfAwake) return false;
  selfAwake = next;
  return true;
}
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
  if (typeof ui.inputMaster !== 'string') ui.inputMaster = '';
  cfg.shareInput = !!ui.inputMaster;
  cfg.isHost = ui.inputMaster === cfg.peerName;
  ui.inputMode = ui.inputMaster ? (ui.inputMaster === cfg.peerName ? 'local' : 'remote') : 'separate';
  if (!ui.displayName) ui.displayName = cfg.peerName;

  // 快捷键：global + inputCycle + 每块显示器一个
  if (!ui.hotkeys || typeof ui.hotkeys !== 'object') {
    ui.hotkeys = { global: ui.hotkeyKey || 'F12', inputCycle: 'Alt+Q', monitor: {} };
  }
  if (!ui.hotkeys.global) ui.hotkeys.global = ui.hotkeyKey || 'F12';
  if (!ui.hotkeys.inputCycle && ui.hotkeys.inputCycle !== '') ui.hotkeys.inputCycle = 'Alt+Q';
  if (!ui.hotkeys.monitor || typeof ui.hotkeys.monitor !== 'object') ui.hotkeys.monitor = {};
  ui.hotkeyKey = ui.hotkeys.global;

  if (!Array.isArray(ui.arrange)) ui.arrange = [];
  if (!Array.isArray(ui.targetPeers)) ui.targetPeers = ui.targetPeer ? [ui.targetPeer] : [];
  if (typeof ui.autoAccept !== 'boolean') ui.autoAccept = false;
  if (typeof ui.edgeSwitch !== 'boolean') ui.edgeSwitch = false;
  if (!ui.modMap) ui.modMap = 'cmd-ctrl';
  if (typeof ui.keyDebug !== 'boolean') ui.keyDebug = false;
  if (!ui.portMap || typeof ui.portMap !== 'object') ui.portMap = {};
  // 老配置的「ddc:index → 屏幕稳定键」对照表（迁移用）
  if (!ui.portAlias || typeof ui.portAlias !== 'object') ui.portAlias = {};
  // 归属快照的版本号（逻辑计数，不依赖两台机器的时钟）
  if (typeof ui.authSeq !== 'number') ui.authSeq = 0;
  // 每条接口的来源：manual=用户手配（永远不被自动清理）/ learn=本机 DDC 实测学的 /
  // sync=从对端同步来的。清理遗留错值时只动后两种。
  if (!ui.portSrc || typeof ui.portSrc !== 'object') ui.portSrc = {};
  // 每块屏「上次确认过归谁」——DDC 读不到当前输入源时靠它着色（很多显示器/Mac 读不到）
  if (!ui.ownerMap || typeof ui.ownerMap !== 'object') ui.ownerMap = {};
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

  // 清理历史残留的 generic 占位名（显示器 1/2）与幽灵记录
  if (cfg.ui.screenMemo && typeof cfg.ui.screenMemo === 'object') {
    for (const k of Object.keys(cfg.ui.screenMemo)) {
      const memo = cfg.ui.screenMemo[k];
      if (isGenericName(memo && memo.name) || /^nm:(显示器\s*\d*|generic.*)$/i.test(k)) {
        delete cfg.ui.screenMemo[k];
      }
    }
  }
  if (cfg.ui.authority && Array.isArray(cfg.ui.authority.screens)) {
    cfg.ui.authority.screens = cfg.ui.authority.screens.filter((s) => !isGenericName(s && s.name));
  }

  // 早期版本存过连接配对密码，已不再使用
  delete ui.usePassword;
  delete ui.password;

  saveConfig(cfg);
}

function persist() {
  saveConfig(cfg);
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

/** 本机的启动时刻（由进程 uptime 推出来，跨机器可比） */
function selfBootAt() {
  const up = (typeof process !== 'undefined' && process.uptime) ? process.uptime() : 0;
  return Date.now() - Math.round(up * 1000);
}

/**
 * 第一个打开本软件的那台 = 主控。
 * 它的状态是初始权威：后开的机器一进局域网就按它的状态对齐。
 * 之后任意一台点了切换，都以「最后一次切换」为准（见 authority 的 rev）。
 */
function primaryDevice() {
  let best = cfg.peerName;
  let bestAt = selfBootAt();
  for (const p of peersNow) {
    const at = Number(p.bootAt) || 0;
    if (at && at < bestAt) { best = p.name; bestAt = at; }
  }
  return best;
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
  // 没排过队的按 id 字典序补在后面：两台机器各算各的也是同一个顺序，
  // 界面上下顺序 = 无缝移动左右顺序，且不会因谁先上线而变
  const extra = deviceIds().filter((id) => !arr.includes(id));
  extra.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return arr.concat(extra);
}

/** 手动排顺序 / 左右翻转（用户试出方向反了时用），会同步给对端 */
function setArrange(list) {
  const next = peer && typeof peer.setArrange === 'function'
    ? peer.setArrange(list)
    : (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : []);
  if (next && next.length) {
    cfg.ui.arrange = next;
    cfg.ui.arrangeTouched = true;
    persist();
  }
  return arrangeOrder();
}

/* ---------------- 每块屏 × 每台设备的接口 ---------------- */

/** 把各种写法的接口值归一成 0x11 这种形式（macOS 侧读到的是十进制 17） */
function normInput(value) {
  const s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!s) return '';
  const n = s.startsWith('0x') ? parseInt(s.slice(2), 16) : parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  return '0x' + n.toString(16).padStart(2, '0');
}

/** 两个接口值是不是同一个口（17 / 0x11 / 0X011 都算同一个） */
function sameInput(a, b) {
  const x = normInput(a);
  return !!x && x === normInput(b);
}

function labelForInput(value) {
  const v = normInput(value) || String(value || '');
  const p = INPUT_PRESETS.find((x) => x.value === v);
  return p ? p.label : v;
}

/** 某块显示器上，某台设备接的是哪个口；空字符串 = 不接 / 不切 */
/**
 * 接口 / 归属配置的**存储键**。
 *
 * 早期版本直接拿 `ddc:index` 当键：显示器被切到别的电脑后，系统就不再枚举它，
 * 剩下的屏会重新编号（原来 ddc:1 的屏可能变成 ddc:0），
 * 于是「这块屏上接的是 VGA」这种配置会张冠李戴、甚至整个丢掉 ——
 * 手配完看着存住了，下一次切回来又变回「未设置」。
 * 现在统一按屏幕的稳定身份存：有 EDID 序列号就用序列号，没有就用型号名。
 */
function portKey(m) {
  if (!m) return '';
  const k = screenKey(m);
  if (k === 'nm:' || k === 'sn:') return m.id || '';
  return k;
}

/** 界面传来的 monitorId（可能是 ddc:N）→ 稳定键；离线行就沿用原值 */
function portKeyOf(monitorId) {
  const m = monitorsCache.find((x) => x.id === monitorId);
  return m ? portKey(m) : monitorId;
}

/** 记下「ddc:N 当时对应哪块屏」——老配置迁移时靠它认人，避免编号错位后错搬 */
function markPortAlias(monitorId, key) {
  if (!monitorId || !key || monitorId === key) return;
  if (!cfg.ui.portAlias || typeof cfg.ui.portAlias !== 'object') cfg.ui.portAlias = {};
  cfg.ui.portAlias[monitorId] = key;
}

/** 取（必要时建）这块屏的接口表，顺手登记编号别名 */
function portTableOf(m, create) {
  const k = portKey(m) || m.id;
  markPortAlias(m.id, k);
  if (!cfg.ui.portMap) cfg.ui.portMap = {};
  if (!cfg.ui.portMap[k]) {
    if (!create) return null;
    cfg.ui.portMap[k] = {};
  }
  return cfg.ui.portMap[k];
}

/**
 * 把老版本按 ddc:index 存的配置搬到稳定键上（每次扫描后跑一次）。
 * 只有「这个编号当时确实对应这块屏」时才搬，避免显示器重新编号后错搬。
 */
function migratePortKeys() {
  const alias = cfg.ui.portAlias || {};
  let n = 0;

  const moveMap = (table) => {
    if (!table || typeof table !== 'object') return;
    for (const m of monitorsCache) {
      if (m.internal) continue;
      const legacy = m.id;
      const k = portKey(m);
      if (!k || k === legacy) continue;
      const old = table[legacy];
      if (!old || typeof old !== 'object' || !Object.keys(old).length) continue;
      // 记过别名、且别名指向别的屏 → 这个编号现在不属于它，不搬也不删
      if (alias[legacy] && alias[legacy] !== k) continue;
      const t = table[k] || {};
      for (const d of Object.keys(old)) if (old[d] && t[d] === undefined) t[d] = old[d];
      table[k] = t;
      delete table[legacy];
      n += 1;
    }
  };

  const moveOwner = () => {
    const table = cfg.ui.ownerMap;
    if (!table) return;
    for (const m of monitorsCache) {
      if (m.internal) continue;
      const legacy = m.id;
      const k = portKey(m);
      if (!k || k === legacy) continue;
      const old = table[legacy];
      if (!old) continue;
      if (alias[legacy] && alias[legacy] !== k) continue;
      if (!table[k]) { table[k] = old; n += 1; }
      delete table[legacy];
    }
  };

  moveMap(cfg.ui.portMap);
  moveMap(cfg.ui.portSrc);
  moveOwner();

  // 占位键升级：以前 DDC 层给不出名字，屏被记成「显示器 1」这类占位键；
  // 现在拿到了真实型号名 / 序列号，同一条编号登记过的旧配置跟着搬过去，
  // 用户手配的接口和归属不丢（别名记录的是「这个编号当时是那块屏」）
  const isPlaceholderKey = (k) => /^nm:(显示器\d*|genericpnpmonitor.*)$/.test(String(k || ''));
  const upgradeKey = (table, isObj) => {
    if (!table || typeof table !== 'object') return;
    for (const m of monitorsCache) {
      if (m.internal) continue;
      const legacy = m.id;
      const k = portKey(m);
      if (!k || k === legacy) continue;
      const prev = alias[legacy];
      if (!prev || prev === k || !isPlaceholderKey(prev)) continue;
      const old = table[prev];
      if (old === undefined) continue;
      if (isObj) {
        const t = table[k] || {};
        for (const d of Object.keys(old)) if (old[d] !== undefined && t[d] === undefined) t[d] = old[d];
        table[k] = t;
      } else if (!table[k]) {
        table[k] = old;
      }
      delete table[prev];
      n += 1;
    }
  };
  upgradeKey(cfg.ui.portMap, true);
  upgradeKey(cfg.ui.portSrc, true);
  upgradeKey(cfg.ui.ownerMap, false);

  if (n) persist();
  return n;
}

function portFor(monitorId, deviceId) {
  const t = (cfg.ui.portMap && cfg.ui.portMap[portKeyOf(monitorId)]) || {};
  // 只认「这块屏上这台设备」自己的配置。曾经退回全局 localInput / remoteInput，
  // 结果没配过的屏也显示 HDMI1/HDMI2 —— 界面上看着配好了、实际一直切错、判归属也全错。
  return Object.prototype.hasOwnProperty.call(t, deviceId) ? normInput(t[deviceId]) : '';
}

/**
 * 补齐接口表的容器（不预填具体值）。
 * 以前这里用「全局默认接口」预填每块屏，结果一个全局值会盖掉每块屏的真实情况，
 * 也让自动学习失去机会 —— 现在没配过就是空，界面显示「设置接口」。
 */
function ensurePortDefaults() {
  if (!cfg.ui.portMap) cfg.ui.portMap = {};
  let changed = false;
  for (const m of monitorsCache) {
    if (m.internal) continue; // 内建屏没有接口可配
    const t = portTableOf(m, true);
    for (const p of peersNow) {
      if (Object.prototype.hasOwnProperty.call(t, p.name)) continue;
      // 老版本按「对端默认接口」存过，迁移过来（有值才写）
      const legacy = (cfg.ui.legacyRemotePorts && cfg.ui.legacyRemotePorts[m.id]) || '';
      if (legacy) { t[p.name] = legacy; changed = true; }
    }
  }
  if (changed) persist();
}

/** 接口条目的来源标记：manual（手配，永不自动清理）/ learn（本机实测）/ sync（对端同步） */
function portSrcOf(monitorId, deviceId) {
  const s = cfg.ui.portSrc && cfg.ui.portSrc[portKeyOf(monitorId)];
  return (s && s[deviceId]) || '';
}

function markPortSrc(monitorId, deviceId, src) {
  const k = portKeyOf(monitorId);
  if (!cfg.ui.portSrc) cfg.ui.portSrc = {};
  const t = cfg.ui.portSrc[k] || {};
  if (src) t[deviceId] = src;
  else delete t[deviceId];
  // 必须写回稳定键：写成 monitorId 会让来源标记在键迁移后丢失，
  // 手配（manual）的条目就可能被自动清理误删
  cfg.ui.portSrc[k] = t;
}

function setPort(monitorId, deviceId, value) {
  if (!monitorId || !deviceId) return false;
  if (!cfg.ui.portMap) cfg.ui.portMap = {};
  if (!cfg.ui.ownerMap) cfg.ui.ownerMap = {};
  const key = portKeyOf(monitorId);
  const t = cfg.ui.portMap[key] || {};
  const v = normInput(value);
  if (!v) {
    // 清空 = 删掉这条配置（界面上的「清除」）
    delete t[deviceId];
    markPortSrc(monitorId, deviceId, '');
    cfg.ui.portMap[key] = t;
    persist();
    return true;
  }
  t[deviceId] = v;
  markPortSrc(monitorId, deviceId, 'manual');
  cfg.ui.portMap[key] = t;
  // 手配完顺手校准归属：如果这块屏此刻的输入源正好就是这个口，那现在就是这台在用
  const m = monitorsCache.find((x) => x.id === monitorId);
  if (v && m && sameInput(m.currentInput, v)) cfg.ui.ownerMap[key] = deviceId;
  // 本机 / 首个对端的值同步到全局默认，仅用于「新显示器」的初始提示，不再覆盖每块屏
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

/**
 * 导出本机每块屏的接口配置（按显示器名字），供对端合并。
 * 接口值是这块屏上的物理事实，配一次两台机器都该知道 —— 否则在 A 上配好，
 * 到 B 上点切换就会因为「没设接口」切不动。
 */
function exportPorts() {
  const out = [];
  for (const m of monitorsCache) {
    if (m.internal) continue;
    const key = portKey(m);
    const t = (cfg.ui.portMap && cfg.ui.portMap[key]) || {};
    const ports = {};
    const src = {};
    for (const k of Object.keys(t)) {
      const v = normInput(t[k]);
      if (!v) continue;
      ports[k] = v;
      const s = portSrcOf(key, k);
      if (s) src[k] = s; // 对端手配过的（manual）同步过去后也要当手配，不许被自动清理
    }
    if (Object.keys(ports).length) out.push({ name: m.name, serial: m.serial || '', ports, src });
  }
  return out;
}

/** 合并对端发来的接口配置：按显示器名字配对，只补本机还没设的（本机手改优先） */
function importPorts(list) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  const hasAny = list.length > 0;
  const extMonitors = monitorsCache.filter((x) => !x.internal);
  const extList = list.filter((x) => x && !INTERNAL_LABEL.test(x.name || ''));

  for (const it of list) {
    const key = normName(it && it.name);
    if (!key || !it.ports) continue;
    let m = extMonitors.find((x) => modelNameHit(x.name, it.name));
    if (!m) {
      m = extMonitors.find((x) => normName(x.name) && (
        normName(x.name) === key || normName(x.name).includes(key) || key.includes(normName(x.name))));
    }
    if (!m && extMonitors.length === extList.length) {
      const idx = extList.indexOf(it);
      if (idx >= 0 && extMonitors[idx]) m = extMonitors[idx];
    }
    if (!m) continue;
    if (!cfg.ui.portMap) cfg.ui.portMap = {};
    const mk = portKey(m);
    const t = cfg.ui.portMap[mk] || {};
    const live = normInput(m.currentInput);
    const rsrc = (it.src && typeof it.src === 'object') ? it.src : {};
    for (const dev of Object.keys(it.ports)) {
      const v = normInput(it.ports[dev]);
      // sync 条目允许被对端的最新值覆盖（对端改了口要能追平）；manual / learn 不动
      if (!v || (t[dev] && portSrcOf(mk, dev) !== 'sync')) continue;
      // 本机此刻正用着这个口（DDC 实测）：一块屏的一个口只接一根线，
      // 说明对端这条记错了 —— 本机实测是唯一能自证的方向，拒收。
      if (dev !== cfg.peerName && live && sameInput(v, live)) continue;
      // 冲突保护：同一个口不可能同时属于两台设备。
      // 如果本地那条是本次「猜」的，就让位给对端（对端的配置是它自己屏幕上的事实）；
      // 不是猜的就保持本地优先，谁也不覆盖谁 —— 否则两端会互相「确认」着错下去。
      const clash = Object.keys(t).find((k) => k !== dev && sameInput(t[k], v));
      if (clash) {
        if (!guessedPorts.has(`${mk}|${clash}`)) continue;
        delete t[clash];
        if (cfg.ui.ownerMap && cfg.ui.ownerMap[mk] === clash) delete cfg.ui.ownerMap[mk];
        guessedPorts.delete(`${mk}|${clash}`);
      }
      t[dev] = v;
      // 对端手配的（manual）同步过来还是 manual —— 用户在另一台上亲手确认过的事实，
      // 不能因为这一台读不到输入源就被清掉
      markPortSrc(mk, dev, rsrc[dev] === 'manual' ? 'manual' : 'sync');
      n += 1;
    }
    cfg.ui.portMap[mk] = t;
  }

  // 对端发来的是它那边的**全量**配置：本机「从对端同步来」的条目若已不在里面，
  // 说明对端把它删掉了（比如清掉了历史遗留的错值）—— 本机跟着删，两端才能对齐。
  // 只删 sync（含 v0.8.8 及之前没有 portSrc 标记的旧条目）：
  // 手配（manual）永远不动；learn 是本机实测 / 自动识别出来的事实，
  // 对端读不到它自己的口（VGA 一类）不代表这条是错的，也必须留着。
  if (hasAny) {
    const remote = new Map();
    for (const it of list) {
      const k = normName(it && it.name);
      if (!k || !it.ports) continue;
      remote.set(k, new Set(Object.keys(it.ports)));
    }
    for (const m of monitorsCache) {
      if (m.internal) continue;
      const key = normName(m.name);
      if (!key) continue;
      const devs = new Set();
      for (const [k, set] of remote) {
        if (k === key || k.includes(key) || key.includes(k) || modelNameHit(k, key)) for (const d of set) devs.add(d);
      }
      const mk = portKey(m);
      const t = cfg.ui.portMap[mk] || {};
      let dirty = false;
      for (const dev of Object.keys(t)) {
        if (!t[dev] || dev === cfg.peerName) continue;
        const src = portSrcOf(mk, dev);
        if (src === 'manual' || src === 'learn') continue;
        if (!devs.has(dev)) {
          delete t[dev];
          markPortSrc(mk, dev, '');
          dirty = true;
          n += 1;
        }
      }
      if (dirty) cfg.ui.portMap[mk] = t;
    }
  }
  if (n) persist();
  return n;
}

/**
 * 本次启动里「猜」出来的接口（`显示器id|设备名`）。
 * 猜的东西不许固执：对端把真实配置同步过来、且跟猜测冲突时，直接撤掉猜测。
 */
const guessedPorts = new Set();

/**
 * 自动补齐接口。
 *
 * 铁证只有一条，但它是决定性的：
 *
 *   **本机的 DDC 能枚举到这块屏，就说明这块屏此刻正在显示本机的画面。**
 *
 * 显示器切到别的机器后，本机系统会认为这块屏「已断开」，压根枚举不到
 * （Windows 的 dxva2 走 EnumDisplayMonitors，macOS 的 m1ddc 也只列活动显示器）。
 * 既然它正在显示本机，那它**当前的输入源就是本机在这块屏上的口** ——
 * 配置里存了别的值，就是存错了（v0.8.2 遗留的假配置），直接纠正。
 *
 * 这条规则不会让两台机器互相打架：屏幕显示谁，就只有谁枚举得到它，
 * 也只有那一方能读到这个口，同一个口不可能被两台同时读成「自己的」。
 *
 * 读不到当前输入源（不少显示器不支持读 VCP 0x60）时不动配置，
 * 归属退回 ownerMap（上次亲手切成功的记录）。
 */
function learnPorts() {
  if (!monitorsCache.length) return 0;
  if (!cfg.ui.portMap) cfg.ui.portMap = {};
  if (!cfg.ui.ownerMap) cfg.ui.ownerMap = {};
  const me = cfg.peerName;
  const ids = deviceIds();
  let n = 0;
  let changed = false;
  for (const m of monitorsCache) {
    if (m.internal) continue;
    const mk = portKey(m);

    const cur = normInput(m.currentInput);

    // 刚切完、显示器还没稳定时读到的口可能是切换前的旧值 ——
    // 拿它去学接口 / 定归属，会把刚同步好的状态又拽回切换前（而且可能很久不再扫）。
    // 这段时间里，与公认归属矛盾的读数一律不学、不判，等稳定后重扫再说。
    if (cur && settling(mk)) {
      const pinned = settleOwner.get(mk);
      const byInput = ids.find((id) => sameInput(portFor(m.id, id), cur));
      if (pinned && byInput && byInput !== pinned) continue;
    }

    // Mac 的系统枚举（system_profiler）会把「正显示别的电脑」的屏也列出来 —— 线还插着，EDID 就在。
    // 所以在 Mac 上「枚举到」不是归属证据，唯一可信的是 DDC 读回的输入源：
    // 它等于某台设备已配的口 → 自证归它；对不上任何已配口 → 这根线可能根本是另一台电脑的，绝不写。
    if (IS_MAC) {
      const t = cfg.ui.portMap[mk] || {};
      if (!cur) {
        // 读不到输入源（VGA 一类不支持 DDC/CI 的口，Mac 上永远拿不到证据）：
        // 历史遗留的「学来 / 同步来」的本机口清掉，免得切换时往错误的口上写；
        // 用户手配（manual）的保留 —— 那是他自己确认过的事实。
        if (t[me] && portSrcOf(mk, me) !== 'manual') {
          delete t[me];
          markPortSrc(mk, me, '');
          n += 1;
        }
        continue;
      }
      const claimed = ids.find((id) => t[id] && sameInput(t[id], cur));
      if (claimed && cfg.ui.ownerMap[mk] !== claimed) {
        cfg.ui.ownerMap[mk] = claimed;
        n += 1;
      }
      continue;
    }

    // Windows：dxva2 只枚举活动屏，切走的屏会从系统里消失。
    // 枚举得到这块屏 = 它此刻正在显示本机 → 归属一定是本机（不管读不读得到输入源）
    // （刚切完的那一下系统还没把它摘掉，这时别急着认领 —— 见上面的 settle 说明）
    const pinnedNow = settling(mk) ? settleOwner.get(mk) : '';
    if (cfg.ui.ownerMap[mk] !== me && (!pinnedNow || pinnedNow === me)) {
      cfg.ui.ownerMap[mk] = me;
      n += 1;
    }
    // 公认归属是别的机器（刚切走，系统还没把它摘掉）：这块屏此刻不是本机的，
    // 别拿它的读数去改本机的接口配置
    if (pinnedNow && pinnedNow !== me) continue;

    if (!cur) continue; // 读不到就别碰接口配置，免得把对的改错
    const t = cfg.ui.portMap[mk] || {};

    // 铁证：这块屏正在显示本机 → 当前输入源就是本机的口（存错了就纠正）
    if (!sameInput(t[me], cur)) {
      t[me] = cur;
      markPortSrc(mk, me, 'learn');
      guessedPorts.delete(`${mk}|${me}`);
      n += 1;
      changed = true;
    }

    // 一个口只能接一根线、属于一台机器：别的设备也记着这个口，那条一定是错的。
    // 手配的不删 —— 用户可能就是这么接的（比如两台共用同一个口的分线器），
    // 让事实去纠正事实，不拿推测覆盖手配。
    for (const id of ids) {
      if (id === me || !t[id] || !sameInput(t[id], cur)) continue;
      if (portSrcOf(mk, id) === 'manual') continue;
      delete t[id];
      markPortSrc(mk, id, '');
      if (cfg.ui.ownerMap[mk] === id) cfg.ui.ownerMap[mk] = me;
      guessedPorts.delete(`${mk}|${id}`);
      n += 1;
      changed = true;
    }
    if (changed) { cfg.ui.portMap[mk] = t; changed = false; }
  }
  if (n) persist();
  return n;
}

/**
 * 这块屏此刻正显示哪台设备。
 * 先看 DDC 读回来的当前输入源（最真实），读不到再退回「上次确认过的归属」——
 * 很多显示器读 0x60 会失败，Mac 上尤其常见，不能因此就整块屏不着色。
 */
function ownerOf(m) {
  if (!m) return '';
  // 内建屏只能显示笔记本自己（合盖休眠时不算）
  if (m.internal) return selfAwake ? cfg.peerName : '';

  // 1) 本机自证：读得到当前输入源，并且它等于某台设备配过的口
  //    （刚切完那几秒里，与公认归属矛盾的读数不算数，见 trustedInput）
  const cur = trustedInput(m);
  if (cur) {
    for (const id of deviceIds()) {
      if (sameInput(portFor(m.id, id), cur)) return id;
    }
    // 读到了但对不上任何已配口 —— 这块屏正显示「某个还没配过的口」。
    // 在 Mac 上它很可能是另一台电脑的线（Mac 的系统枚举把切走的屏也列出来），不能判本机。
  } else if (!m.currentInput && m.present !== false && IS_WIN) {
    // 2) 只在 Windows 上「枚举得到它 = 它就在显示本机」：
    //    dxva2 只枚举活动屏，切到别的电脑后系统里就看不到它了。
    //    Mac 的 system_profiler 会把切走的屏一起列出来，绝不能这么判。
    //    刚切完的那一下系统还没把它摘掉 —— 这时别抢回来，按公认归属走
    const pin = settling(portKey(m)) ? settleOwner.get(portKey(m)) : '';
    if (!pin || pin === cfg.peerName) return cfg.peerName;
  }

  // 3) 本机看不到这块屏（或读到的口谁都对不上）→ 用局域网公认的归属
  //    （键的口径可能和对端不一样，按键找不到再按接口指纹找）
  const hit = authorityEntryFor(m);
  if (hit && hit.owner && deviceIds().includes(hit.owner)) return hit.owner;

  // 4) 本机上一次确认过的归属
  const saved = (cfg.ui.ownerMap && cfg.ui.ownerMap[portKey(m)]) || '';
  if (saved && deviceIds().includes(saved)) return saved;
  return '';
}

// 防重复切换锁：记录每块屏最近切换的目标设备与时间戳，防止短时间连续下发相同指令引起显示器二次黑屏
const recentSwitchLock = new Map();

/**
 * 刚切成功：直接把缓存里的「当前输入源」改成写进去的值。
 * 不用等下一次重扫（1~1.5 秒），界面立刻就是对的；重扫时再以 DDC 实测为准。
 */
function applySwitched(targetId, m, value) {
  const v = normInput(value);
  if (!m || !v) return;
  m.currentInput = v;
  m.currentInputLabel = labelForInput(v);
  if (targetId) {
    if (!cfg.ui.ownerMap) cfg.ui.ownerMap = {};
    cfg.ui.ownerMap[portKey(m)] = targetId;
    recentSwitchLock.set(portKey(m), { target: targetId, at: Date.now() });
    // 本机亲手切成功的，同样钉一会儿：这次写完之后显示器要重新同步信号，
    // 马上回读会拿到切换前的旧值，不能让它推翻刚确认的归属
    pinSettle([{ key: portKey(m), owner: targetId }]);
  }
}

/** 记下「这块屏现在归谁」——只该在真的切成功、或自证匹配之后调用 */
function markOwners(targetId, inputValue) {
  if (!targetId) return 0;
  if (!cfg.ui.ownerMap) cfg.ui.ownerMap = {};
  let n = 0;
  for (const m of monitorsCache) {
    if (m.internal) continue;
    const mk = portKey(m);
    if (inputValue !== undefined && inputValue !== '' && !sameInput(portFor(m.id, targetId), inputValue)) continue;
    if (cfg.ui.ownerMap[mk] !== targetId) { cfg.ui.ownerMap[mk] = targetId; n += 1; }
  }
  if (n) persist();
  return n;
}

/* ---------------- 跨机器的全局归属（authority） ---------------- */

/**
 * 一块屏跨机器的稳定标识。
 * 优先用 EDID 序列号 —— 同一块屏两台机器读到的序列号完全一样，
 * 型号名却可能这台叫「DELL U2414H」那台叫「DELL U2414H(DP)」。
 */
function screenKey(m) {
  const sn = String((m && m.serial) || '').trim();
  if (sn.length > 2) return 'sn:' + sn.toLowerCase();
  return 'nm:' + normName(m && m.name);
}

/** 这块屏（按稳定键）的接口表快照：{ 设备: 口 } —— 跨机器认领同一块屏的「指纹」 */
function portsOfKey(k) {
  const t = (cfg.ui.portMap && cfg.ui.portMap[k]) || {};
  const out = {};
  for (const d of Object.keys(t)) {
    const v = normInput(t[d]);
    if (v) out[d] = v;
  }
  return out;
}

/**
 * 两份接口指纹的吻合度：一致的条目数；有任何一条冲突（同一台设备记了两个口）就是 0。
 * 「哪台电脑接这块屏的哪个口」是物理事实，两台机器各配各的也不会互相矛盾。
 */
function portsMatch(a, b) {
  if (!a || !b) return 0;
  let agree = 0;
  for (const d of Object.keys(a)) {
    if (!b[d]) continue;
    if (sameInput(a[d], b[d])) agree += 1;
    else return 0;
  }
  return agree;
}

/**
 * 按型号名认领：两边都得有真实型号名（「显示器 1」这种占位名不认），
 * 提取型号核心词匹配（如 u2414h / s2316m）。
 */
function nameClaimMonitor(s) {
  if (!s || !s.name || isGenericName(s.name)) return null;
  if (!normName(s.name)) return null;
  let best = null;
  for (const m of monitorsCache) {
    if (m.internal) continue;
    if (!m.name || isGenericName(m.name) || !normName(m.name)) continue;
    if (modelNameHit(s.name, m.name)) {
      if (best) return null;
      best = m;
    }
  }
  return best;
}

/**
 * 快照里的一块屏 → 本机的哪块屏。先按别名/稳定键；键对不上就按接口指纹认领，
 * 认领不上再按型号特征词认领，绝不让同一台物理外接显示器重复变成两块。
 */
function localMonitorForEntry(s) {
  if (!s) return null;
  // 1) 别名映射命中
  if (s.key && keyAliases.has(s.key)) {
    const aid = keyAliases.get(s.key);
    const hit = monitorsCache.find((x) => !x.internal && x.id === aid);
    if (hit) return hit;
  }
  // 2) 稳定键直接精确匹配
  const byKey = monitorsCache.find((x) => !x.internal && screenKey(x) === s.key);
  if (byKey) return byKey;

  // 3) 接口指纹匹配
  const fp = s.ports;
  if (fp && Object.keys(fp).length) {
    let best = null, bestScore = 0, tie = false;
    for (const m of monitorsCache) {
      if (m.internal) continue;
      const score = portsMatch(fp, portsOfKey(portKey(m)));
      if (score > bestScore) { best = m; bestScore = score; tie = false; }
      else if (score > 0 && score === bestScore) tie = true;
    }
    if (best && !tie) {
      recordAlias(best, s.key);
      return best;
    }
  }

  // 4) 型号名认领（提取型号核心词）
  const byName = nameClaimMonitor(s);
  if (byName) {
    recordAlias(byName, s.key);
    return byName;
  }

  // 5) 数量匹配兜底（两端都连接同样数量的外接显示器，且数量>=1）：
  const ext = monitorsCache.filter((m) => !m.internal);
  const a = cfg.ui.authority;
  if (ext.length > 0 && a && Array.isArray(a.screens)) {
    const extScreens = a.screens.filter((x) => x && !x.internal && !isGenericName(x.name));
    if (extScreens.length === ext.length) {
      const idx = extScreens.findIndex((x) => x.key === s.key);
      if (idx >= 0 && idx < ext.length) {
        recordAlias(ext[idx], s.key);
        return ext[idx];
      }
    }
  }

  return null;
}

/** 本机这块屏在公认快照里的条目：先按稳定键，再按接口指纹反查，最后按型号名兜底 */
function authorityEntryFor(m) {
  const a = cfg.ui.authority;
  if (!a || !Array.isArray(a.screens) || !m) return null;
  const k = m.key || screenKey(m);
  const byKey = a.screens.find((s) => s && (s.key === k || (keyAliases.get(s.key) === m.id)));
  if (byKey) return byKey;
  const mine = portsOfKey(portKey(m));
  if (Object.keys(mine).length) {
    let best = null, bestScore = 0, tie = false;
    for (const s of a.screens) {
      if (!s || !s.ports) continue;
      const score = portsMatch(mine, s.ports);
      if (score > bestScore) { best = s; bestScore = score; tie = false; }
      else if (score > 0 && score === bestScore) tie = true;
    }
    if (best && !tie) return best;
  }
  // 键、指纹都对不上：按型号名反查快照条目（对端旧版快照没带指纹时的兜底）
  if (!m.name || isGenericName(m.name) || !normName(m.name)) return null;
  let best = null;
  for (const s of a.screens) {
    if (!s || !s.name || isGenericName(s.name) || !normName(s.name)) continue;
    if (modelNameHit(m.name, s.name)) {
      if (best) return null; // 两条快照都对得上这块屏：不敢认
      best = s;
    }
  }
  // 这条快照的名字本机有两块屏都对得上（同型号双屏）：分不清谁是谁，不认
  if (best) {
    let hits = 0;
    for (const x of monitorsCache) {
      if (x.internal || !x.name || isGenericName(x.name) || !normName(x.name)) continue;
      if (modelNameHit(best.name, x.name)) { hits += 1; if (hits > 1) return null; }
    }
  }
  return best;
}

/** 记住见过的每块屏（含排列位置）：被切到别的电脑后，界面上还得画得出来 */
function rememberScreens() {
  if (!cfg.ui.screenMemo || typeof cfg.ui.screenMemo !== 'object') cfg.ui.screenMemo = {};
  let n = 0;
  for (const m of monitorsCache) {
    if (m.internal) continue;
    const k = screenKey(m);
    const old = cfg.ui.screenMemo[k] || {};
    const pos = m.pos || old.pos || null;
    if (old.name === m.name && old.serial === (m.serial || '') &&
        JSON.stringify(old.pos) === JSON.stringify(pos)) continue;
    cfg.ui.screenMemo[k] = { name: m.name || '', serial: m.serial || '', pos, lastSeen: Date.now() };
    n += 1;
  }
  if (n) persist();
  return n;
}

/**
 * 切换刚落地后显示器还没稳定的那几秒。
 *
 * 写进 VCP 0x60 之后，显示器要重新同步信号（就是那 1~3 秒黑屏），这期间再去读
 * 「当前输入源」往往拿到的还是**切换前的旧值**。软件如果拿这个旧值当证据，
 * 界面就会从「刚切好的状态」又弹回「切换前谁在显示」——而且本机之后未必再扫一次，
 * 于是就一直停在切换前（Windows 点了切换、Mac 上还显示 Windows）。
 *
 * 所以：切换成功后（本机切的 / 收到对端快照的）先把公认归属「钉」一小段时间，
 * 这段时间内与它矛盾的 DDC 读数一律不采信，等显示器稳定了再重扫一次以实测定论。
 */
const SETTLE_MS = 6000;
const settleOwner = new Map(); // 屏稳定键 -> 公认归属
let settleUntil = 0;

function pinSettle(pairs) {
  if (!pairs || !pairs.length) return;
  let n = 0;
  for (const p of pairs) {
    const k = p && p.key;
    const o = p && p.owner;
    if (!k || !o) continue;
    settleOwner.set(k, o);
    n += 1;
  }
  if (n) settleUntil = Date.now() + SETTLE_MS;
}

/** 这块屏此刻是不是处在「刚切完、读数还不可信」的窗口里 */
function settling(key) {
  if (!key) return false;
  if (Date.now() >= settleUntil) return false;
  return settleOwner.has(key);
}

/** 距离「显示器稳定」还有多久（毫秒）——主进程拿它安排下一次重扫 */
function settleRemain() {
  return Math.max(0, settleUntil - Date.now());
}

/**
 * 放弃钉住的归属（用户点了「重新检测」时用）。
 * 下一次扫描的读数就是实测定论，不再被「刚切完、读数不可信」的窗口挡住。
 */
function clearSettle() {
  settleOwner.clear();
  staleStrike.clear();
  settleUntil = 0;
}

/**
 * 与公认归属矛盾的读数要「连着两次」才采信。
 * 只认一次的话，一次误读（显示器还没更新完 / m1ddc 偶尔读错）就能把刚同步好的界面
 * 拽回切换前；连着两次都这么说，才是真的变了（比如有人手动按了显示器上的按键）。
 */
const staleStrike = new Map(); // 屏稳定键 -> { scan, n }
let scanSeq = 0;

function nextScan() { scanSeq += 1; }

/**
 * 这块屏此刻可信的「当前输入源」。
 * 刚切完的那几秒里，与公认归属矛盾的读数视为显示器还没更新，返回空（不采信）。
 */
function trustedInput(m) {
  const cur = m.currentInput || '';
  if (!cur) return '';
  const k = portKey(m);
  const pinned = settleOwner.get(k);
  if (!pinned) return cur;
  const byInput = deviceIds().find((id) => sameInput(portFor(m.id, id), cur));
  if (!byInput || byInput === pinned) { staleStrike.delete(k); return cur; }

  // 与公认归属矛盾：先看显示器稳没稳定
  if (Date.now() < settleUntil) return '';

  const rec = staleStrike.get(k) || { scan: 0, n: 0 };
  const n = rec.scan === scanSeq ? rec.n : rec.n + 1;
  staleStrike.set(k, { scan: scanSeq, n });
  if (n < 2) return ''; // 头一次不采信，等下一次扫描再确认
  settleOwner.delete(k); // 连续两次都指向别的设备 → 认了
  staleStrike.delete(k);
  return cur;
}

/** 本机视角的归属：只认本机能自证的证据，不看别的机器怎么说 */
function ownViewOf(m) {
  if (!m) return '';
  const cur = trustedInput(m);
  if (cur) {
    for (const id of deviceIds()) {
      if (sameInput(portFor(m.id, id), cur)) return id;
    }
    return '';
  }
  // 本机没有证据（读不到 / 读数刚被判为不可信）→ 用局域网公认的归属，
  // 否则会把过期结论广播出去，把对端刚同步好的界面又带回去
  const hit = authorityEntryFor(m);
  if (hit && hit.owner && deviceIds().includes(hit.owner)) return hit.owner;
  const saved = (cfg.ui.ownerMap && cfg.ui.ownerMap[portKey(m)]) || '';
  return saved && deviceIds().includes(saved) ? saved : '';
}

/** 汇总一份「每块屏归谁」的快照：本机知道的覆盖，本机看不到的保留原样 */
function buildAuthority() {
  const prev = (cfg.ui.authority && cfg.ui.authority.screens) || [];
  const byKey = new Map(prev.filter((s) => s && s.key).map((s) => [s.key, { ...s }]));
  for (const m of monitorsCache) {
    if (m.internal) continue;
    const k = screenKey(m);
    const old = byKey.get(k) || {};
    const ps = portsOfKey(portKey(m));
    byKey.set(k, {
      key: k,
      name: m.name || old.name || '',
      owner: ownViewOf(m) || old.owner || '',
      // 接口指纹：对端键的口径跟本机不一样时，靠它认领同一块屏
      ports: Object.keys(ps).length ? ps : (old.ports || {})
    });
  }
  return { rev: Date.now(), at: cfg.peerName, screens: [...byKey.values()] };
}

/**
 * 「每块屏现在归谁」的版本号。
 *
 * 早先用 Date.now() 当版本号 —— 两台机器的时钟只要差上几秒，时钟偏快的那台
 * 就会把对方发来的快照全部判为「旧的」直接丢弃，界面于是永远停在切换前的状态
 * （Windows 点切换、Mac 上却还显示 Windows）。
 * 现在改成逻辑计数：每次事件 +1，收到别人的版本就抬到它之上，跟时钟无关。
 */
let authSeq = Number((cfg.ui && cfg.ui.authSeq) || 0);

/** 本机状态变了（切换成功 / 检测刷新）→ 生成新一版快照，由主进程广播出去 */
function publishAuthority() {
  const a = buildAuthority();
  authSeq += 1;
  a.rev = authSeq;
  cfg.ui.authSeq = authSeq;
  cfg.ui.authority = a;
  persist();
  return a;
}

/**
 * 收到别的机器发来的快照。
 *
 * 版本号是**每台机器各自的**逻辑计数（每次事件 +1），所以两台机器的号不能直接比大小：
 * 只跟「这台机器上次发给我的号」比 —— 同一个来源自己的号是单调的，更新的那份永远不会被丢掉。
 * 早先拿全局最大号当门槛，结果谁发的次数多谁就「号大」，对端真正的新快照反而被当成旧的丢弃
 * （Windows 点完切换，Mac 上还停在切换前的状态）。
 */
function applyAuthority(a) {
  if (!a || !Array.isArray(a.screens) || !a.rev) return null;
  const rev = Number(a.rev);
  if (!Number.isFinite(rev) || rev <= 0) return null;
  const origin = String(a.at || '').trim() || 'peer';
  // 自己名下的快照不收（防止重名设备互相覆盖）
  if (origin === cfg.peerName) return null;
  if (!cfg.ui.authSeen || typeof cfg.ui.authSeen !== 'object') cfg.ui.authSeen = {};
  if (rev <= Number(cfg.ui.authSeen[origin] || 0)) return null;
  cfg.ui.authSeen[origin] = rev;
  // 本机下一版要压在「见过的最大号」之上，否则别人会拿它自己的号把我们的新快照挡回去
  authSeq = Math.max(authSeq, rev);
  cfg.ui.authSeq = authSeq;
  cfg.ui.authority = { rev, at: origin, screens: a.screens };

  // 本机此刻的读数如果和公认归属矛盾，说明这份读数是切换之前留下的，已经过期。
  // 清掉它，归属就退回快照（下一步重扫会以 DDC 实测为准）。
  let stale = 0;
  const pinned = [];
  for (const s of a.screens) {
    if (!s || !s.owner) continue;
    pinned.push({ key: s.key, owner: s.owner });
    // 键的口径跟对端不一样时按接口指纹认领本机的屏；认领到了连本机的键一起钉
    const m = localMonitorForEntry(s);
    if (m) {
      const lk = portKey(m);
      if (lk) {
        pinned.push({ key: lk, owner: s.owner });
        if (!cfg.ui.ownerMap) cfg.ui.ownerMap = {};
        cfg.ui.ownerMap[lk] = s.owner;
      }
    }
    if (!m || !m.currentInput) continue;
    const byInput = deviceIds().find((id) => sameInput(portFor(m.id, id), m.currentInput));
    if (byInput && byInput !== s.owner) {
      m.currentInput = '';
      m.currentInputLabel = '';
      stale += 1;
    }
  }
  // 钉住公认归属：接下来几秒里显示器的读数还不稳定，别让它把界面又带回去
  pinSettle(pinned);
  persist();
  return { rev, stale, settle: pinned.length > 0 };
}

/**
 * 局域网里存在、但本机此刻枚举不到的屏 —— 它正显示着别的电脑。
 * 不补出来的话，一切走这行屏就从界面上凭空消失了，用户会以为软件丢了屏。
 */
function offlineRows() {
  const a = cfg.ui.authority;
  if (!a || !Array.isArray(a.screens)) return [];
  const have = new Set(monitorsCache.map(screenKey));
  const out = [];
  for (const s of a.screens) {
    if (!s || !s.key) continue;
    // 忽略通用占位名（显示器 1/2、Generic 等幽灵屏）
    if (isGenericName(s.name)) continue;
    if (have.has(s.key)) continue;

    // 键对不上、但能认领到本机的屏：不是离线屏，绝不补成重复的一行
    if (localMonitorForEntry(s)) continue;

    // 只补「本机真的见过、且有真实型号名的屏」
    const memo = (cfg.ui.screenMemo && cfg.ui.screenMemo[s.key]) || {};
    if (!memo.name && !memo.pos) continue;
    if (isGenericName(memo.name)) continue;

    // 如果这块屏的名字与本地已有某块外接屏型号一致，说明只是稳定键口径不同，绝不重复生成
    if (monitorsCache.some((m) => !m.internal && modelNameHit(m.name, memo.name || s.name))) {
      continue;
    }

    out.push({
      key: s.key,
      id: 'mem:' + String(s.key).replace(/[^a-zA-Z0-9]+/g, '_'),
      index: null,
      displayId: null,
      name: memo.name || s.name || '显示器',
      serial: memo.serial || '',
      size: '',
      currentInput: '',
      currentInputLabel: '',
      internal: false,
      present: false,
      pos: memo.pos || null,
      ownerId: s.owner || '',
      ownerLabel: s.owner ? deviceInfo(s.owner).name : '',
      ports: {},
      deviceCount: 0
    });
  }
  return out;
}

function monitorRows() {
  return monitorsCache.map((m) => {
    const ports = {};
    if (!m.internal) {
      for (const id of deviceIds()) {
        const pv = portFor(m.id, id);
        ports[id] = { value: pv, label: pv ? labelForInput(pv) : '未设置', src: portSrcOf(m.id, id) };
      }
    }
    // 内建屏只能显示本机自己（休眠时不算）
    const ownerId = m.internal ? (selfAwake ? cfg.peerName : '') : ownerOf(m);
    return {
      id: m.id,
      key: screenKey(m),
      index: typeof m.index === 'number' ? m.index : null,
      name: m.name,
      serial: m.serial || '',
      internal: !!m.internal,
      hasDdc: typeof m.index === 'number',
      present: true,
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

/** 最近一次系统枚举（system_profiler / WMI）拿到的友好信息，扫描后给通用名补型号/序列号用 */
let lastFriendly = [];

const INTERNAL_LABEL = /built-?in|内建|内置|internal display|colou?r lcd/i;

/** 「显示器 1」「Generic PnP Monitor」这类占位名：不含任何能认屏的信息 */
const GENERIC_LABEL = /^(显示器\s*\d*|monitor\s*\d*|display\s*\d*|generic\b.*)?$/i;
const isGenericName = (s) => GENERIC_LABEL.test(String(s || '').trim());

/** 内建屏（笔记本自带）的伪显示器 id —— 不参与切换，只用来画排列图 */
const INTERNAL_ID = (rid) => `int:${rid}`;

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
    const label = d.label || '';
    out.push({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
      label,
      id: String(d.id),
      primary: String(d.id) === primaryId,
      // 笔记本自带的屏没有 DDC，也不参与切换；但要显示在排列图里，
      // 否则「显示器 A/B」在图上会和系统设置里的位置对不上
      internal: d.internal === true || INTERNAL_LABEL.test(label)
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
  const real = monitorsCache.filter((m) => !m.internal);
  const all = screenRects || [];
  if (!all.length) {
    monitorsCache = real;
    real.forEach((m) => { m.pos = null; });
    return;
  }

  // 内建屏单独拎出来：它没有 DDC，绝不能占掉某块外接屏的坐标
  const rects = all.filter((r) => !r.internal);
  const inner = all.filter((r) => r.internal);

  const used = new Set();
  const pairs = [];
  const unpaired = [];

  // 同名（Windows 上 DDC 描述常全是 Generic PnP Monitor）说明名字不可靠，
  // 这种情况下不做名字配对，直接按坐标顺序对应
  const keyCount = new Map();
  for (const m of real) {
    const k = normName(m.name);
    if (k) keyCount.set(k, (keyCount.get(k) || 0) + 1);
  }

  // 1) 先按型号名配对（Electron 的 label 与系统友好名同源，命中率最高）
  for (const m of real) {
    const key = normName(m.name);
    let hit = null;
    if (key && keyCount.get(key) === 1) {
      hit = rects.find((r) => !used.has(r) && normName(r.label) && (
        normName(r.label).includes(key) || key.includes(normName(r.label))));
    }
    if (hit) { used.add(hit); pairs.push({ m, r: hit }); }
    else unpaired.push(m);
  }

  // 2) 剩下的按「从左到右」的顺序补齐（数量一致时就是一一对应）
  const free = rects.filter((r) => !used.has(r)).sort((a, b) => (a.x - b.x) || (a.y - b.y));
  unpaired.forEach((m, i) => pairs.push({ m, r: free[i] || null }));

  const orderOf = new Map();
  real.forEach((m, i) => orderOf.set(m, i));

  const list = pairs.map((p) => {
    p.m.pos = p.r ? { x: p.r.x, y: p.r.y, width: p.r.width, height: p.r.height } : null;
    if (p.r) p.m.displayId = p.r.id;
    return p.m;
  });

  // DDC 层给不出名字时（ddcctl 只会编「显示器 1/2」这类占位名），拿系统屏幕标签
  // 补上真实型号名；名字对上了再顺手补序列号 —— 两端的「稳定键」一致了，
  // 归属快照（authority）和接口配置才认得出是同一块屏
  for (const p of pairs) {
    const m = p.m;
    if (isGenericName(m.name) && p.r && !isGenericName(p.r.label)) m.name = p.r.label;
    if (!m.serial && !isGenericName(m.name)) {
      const mk = normName(m.name);
      const f = lastFriendly.find((x) => x.serial && normName(x.name) && (
        normName(x.name) === mk || normName(x.name).includes(mk) || mk.includes(normName(x.name))));
      if (f) { m.serial = f.serial; if (!m.size && f.size) m.size = f.size; }
    }
  }

  // 3) 内建屏作为「只显示不切换」的条目并进列表，排列图里才和系统设置一一对应
  for (const r of inner) {
    list.push({
      id: INTERNAL_ID(r.id),
      displayId: r.id,
      index: null,
      name: r.label || '内建显示器',
      serial: '',
      size: '',
      currentInput: '',
      currentInputLabel: '',
      internal: true,
      pos: { x: r.x, y: r.y, width: r.width, height: r.height }
    });
  }

  list.sort((a, b) => {
    if (!a.pos && !b.pos) return orderOf.get(a) - orderOf.get(b);
    if (!a.pos) return 1;
    if (!b.pos) return -1;
    if (a.pos.x !== b.pos.x) return a.pos.x - b.pos.x;
    return a.pos.y - b.pos.y;
  });

  monitorsCache = list;
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
 * 切到某台设备：算出本机要写的 VCP 值。
 *
 * **DDC 是走视频线的**：本机接了哪块屏，本机就能直接写哪块屏的输入源，
 * 跟「这块屏当前画面在哪台机器上」没有关系。所以这里不再按 owner 把计划
 * 转给对端 —— 以前那样做，只要两端的显示器 index / 名字对不上（Windows 的
 * DDC 描述经常全是 Generic PnP Monitor），就会漏切或切错屏。
 *
 * 本机够不着的屏（没接线、没枚举到）留给对端补：对端也只切它自己连着的屏。
 */
function buildSwitchPlan(targetId) {
  if (!targetId) {
    return { ok: false, total: 0, skipped: 0, unreachable: 0, plan: null, monitors: [], label: '' };
  }
  const map = {};
  const monitors = [];
  const missing = [];
  let total = 0;
  let skipped = 0;
  let already = 0;
  let unreachable = 0;
  let label = '';

  for (const m of monitorsCache) {
    if (m.internal) continue;
    total += 1;
    if (typeof m.index !== 'number') { unreachable += 1; continue; }
    const value = portFor(m.id, targetId);
    if (!value) { skipped += 1; missing.push({ id: m.id, name: m.name }); continue; }
    // 这块屏已经切在目标口上了：别再写一次 —— 每写一次显示器都要重新同步信号
    // （就是那 1~3 秒黑屏），本来就已经对的屏不该跟着再黑一遍。
    // 注意：必须是这块屏此刻确实属于目标设备（ownerOf(m) === targetId）才算真正显示中；
    // 若当前归属还是别的设备（比如在另一台显示中，残存旧读数），绝不能跳过！
    const cur = trustedInput(m);
    if (cur && sameInput(cur, value) && ownerOf(m) === targetId) { already += 1; continue; }
    // 防重复切换抖动：同一块屏若在 4 秒内刚刚切到过该目标设备，绝不再写第二次（避免亮屏后又黑屏再亮屏）
    const recent = recentSwitchLock.get(portKey(m));
    if (recent && recent.target === targetId && Date.now() - recent.at < 4500) { already += 1; continue; }
    if (!label) label = labelForInput(value);
    map[m.index] = value;
    monitors.push({ name: m.name, index: m.index, value, label: labelForInput(value) });
  }

  const count = Object.keys(map).length;
  return {
    ok: count > 0,
    target: targetId,
    total,
    skipped,
    already,
    unreachable,
    missing,
    // 每块屏接口相同时压成一个值：执行端「枚举到几块就切几块」，不依赖 index。
    // 有屏已经切好了的时候必须用 map —— 压成单值会把本来就对的屏也写一遍（白黑一次）
    plan: count ? (already ? map : unifyInput(map, count)) : null,
    monitors,
    label: label || (targetId === cfg.peerName ? cfg.ui.localInputLabel : cfg.ui.remoteInputLabel) || ''
  };
}

/** 单块屏切到某台设备的执行计划 */
function monitorSwitchPlan(monitorId, targetId) {
  const m = monitorsCache.find((x) => x.id === monitorId);
  if (!m) return { ok: false, error: '找不到这台显示器' };
  if (m.internal) return { ok: false, error: '内建屏无法切换输入源' };
  if (typeof m.index !== 'number') return { ok: false, error: '这台显示器不支持 DDC，无法单独切换' };
  const value = portFor(monitorId, targetId);
  if (!value) return { ok: false, error: '这台显示器还没给这台电脑指定接口' };
  // 已经在这个口上：不写（写一次就黑一次屏）
  const already = !!(m.currentInput && sameInput(m.currentInput, value));
  return {
    ok: true,
    already,
    index: m.index,
    value,
    label: labelForInput(value),
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

/* ---------------- 自动识别接口 ---------------- */

/** 试口顺序：常见的先试，少闪一次屏 */
const PROBE_ORDER = ['0x11', '0x12', '0x13', '0x0f', '0x10', '0x03', '0x04', '0x01', '0x1a', '0x1b'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 对端问「这块屏现在显示的是你吗」——只按本机拿得到的证据回答。
 * Windows：枚举得到 = 正在显示本机（切走后系统里就没它了）。
 * Mac：系统枚举不区分，只有 DDC 读回的输入源对得上自己的口才算。
 */
function probeAnswer(key, ports) {
  // 先按稳定键找；键的口径和提问方不一样时，按对方带来的接口指纹认领
  let m = monitorsCache.find((x) => !x.internal && screenKey(x) === key);
  if (!m && ports) m = localMonitorForEntry({ key, ports });
  if (!m) return 'no';
  if (IS_WIN) return 'yes';
  const cur = normInput(m.currentInput);
  if (!cur) return 'unknown';
  if (sameInput(portFor(m.id, cfg.peerName), cur)) return 'yes';
  const other = deviceIds().find((id) => id !== cfg.peerName && sameInput(portFor(m.id, id), cur));
  return other ? 'no' : 'unknown';
}

/** 这块屏还挂在本机上吗（切到别的电脑后 Windows 就枚举不到它了） */
async function stillHere(m) {
  const r = await ddc.listDisplays();
  const list = (r && r.displays) || [];
  if (!list.length) return false;
  return list.some((d) => (d.name && m.name && d.name === m.name) || d.index === m.index);
}

/**
 * 自动识别「这块屏上某台电脑接的是哪个口」。
 *
 * 做法：由**能写这块屏 DDC 的那台**（一般就是正显示着它的那台）逐个候选口试过去，
 * 每试一个就让那台电脑确认一次「现在显示的是你吗」；只有两台电脑时，
 * 「本机失去了这块屏」也算是它接过去的证据（VGA、转接头这类口对端读不到，
 * 只能靠这个判）。认出来就按手配一样存下来，以后直接切、不再试。
 */
async function probePort(monitorId, deviceId, opts) {
  const o = opts || {};
  const m = monitorsCache.find((x) => x.id === monitorId);
  if (!m) return { ok: false, error: '找不到这台显示器' };
  if (m.internal) return { ok: false, error: '笔记本自带屏不用识别接口' };
  if (typeof m.index !== 'number') return { ok: false, error: '这台显示器不支持 DDC，识别不了' };
  if (!deviceId || deviceId === cfg.peerName) return { ok: false, error: '本机接的口会自动认，不用手动识别' };
  if (!peersNow.some((p) => p.name === deviceId)) return { ok: false, error: '那台电脑当前不在线，没法确认' };
  if (!peer || typeof peer.askProbe !== 'function') return { ok: false, error: '还没连上其它设备' };

  const mk = portKey(m);
  const t = cfg.ui.portMap[mk] || {};
  const start = normInput(m.currentInput) || '';
  const selfPort = portFor(m.id, cfg.peerName);
  const cands = (Array.isArray(o.order) && o.order.length ? o.order : PROBE_ORDER).filter((v) => {
    if (v === start) return false;                                   // 现在就在这个口上
    return !Object.keys(t).some((d) => d !== deviceId && sameInput(t[d], v)); // 别的电脑的口
  });
  if (!cands.length) return { ok: false, error: '没有可试的接口了' };

  const two = deviceIds().length === 2;
  for (const v of cands) {
    const w = await ddc.setInput(m.index, v);
    if (w && w.ok === false) continue;
    await sleep(typeof o.wait === 'number' ? o.wait : 1100);
    const ans = await peer.askProbe(deviceId, mk, 1800, portsOfKey(mk));
    const lost = !(await stillHere(m));
    const hit = ans === 'yes' || (ans === 'unknown' && two && lost);
    if (hit) {
      setPort(monitorId, deviceId, v);
      if (!cfg.ui.ownerMap) cfg.ui.ownerMap = {};
      cfg.ui.ownerMap[mk] = deviceId;
      m.currentInput = '';
      m.currentInputLabel = '';
      persist();
      return { ok: true, value: v, label: labelForInput(v), tried: 1 };
    }
  }

  // 一个都没认出来：把屏切回原来那个口，别让用户对着黑屏
  const back = start || selfPort;
  if (back) await ddc.setInput(m.index, back);
  return { ok: false, error: '没认出来，请手动点接口选一下', tried: cands.length };
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
          const dtype = String(d['spdisplays_display-type'] || d.spdisplays_display_type || '');
          // 内建屏没有 DDC，必须摘出来 —— 不然它会把「友好名 ↔ DDC 屏」的数量对齐搞乱，
          // 外接屏的真实型号名和序列号就一个都安不上（全变成「显示器 1/2」）
          const internal = d.spdisplays_builtin === 'spdisplays_yes'
            || /internal|built-?in/i.test(dtype)
            || INTERNAL_LABEL.test(name);
          out.push({ id: serial || name, name, serial, size: d._spdisplays_resolution || '', internal });
        }
      }
      resolve(out);
    });
  });
}

/**
 * 从 ioreg 的 EDID 裸块里解出「型号名（0xFC 描述符）+ 序列号（0xFF 描述符）」。
 *
 * system_profiler 对不少外接屏不吐序列号 —— 没有序列号，Mac 的稳定键就只能是
 * 「nm:型号」口径，跟 Windows 的「sn:EDID 序列号」永远对不上，归属快照就认领
 * 不到屏（界面停在切换前、屏还会重复补行）。EDID 里的序列号和 Windows WMI 的
 * SerialNumberID 同源，两边读到的完全一样 —— 这才是跨机器键一致的正源。
 */
function parseEdidDisplays(ioregOut) {
  const out = [];
  const re = /"IODisplayEDID"\s*=\s*<([0-9a-fA-F]+)>/g;
  let mm;
  while ((mm = re.exec(String(ioregOut || '')))) {
    const clean = mm[1];
    const b = [];
    for (let i = 0; i + 1 < clean.length; i += 2) b.push(parseInt(clean.substr(i, 2), 16));
    if (b.length < 128 || b[0] !== 0x00 || b[1] !== 0xff) continue;
    const info = { name: '', serial: '' };
    for (const off of [54, 72, 90, 108]) {
      if (b[off] !== 0x00 || b[off + 1] !== 0x00) continue;
      const tag = b[off + 3];
      let s = '';
      for (let i = off + 5; i < off + 18; i++) {
        const c = b[i];
        if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
      }
      s = s.trim();
      if (tag === 0xfc && !info.name) info.name = s;
      if (tag === 0xff && !info.serial) info.serial = s;
    }
    if (info.name || info.serial) out.push(info);
  }
  return out;
}

function extractModelTokens(s) {
  const str = String(s || '').toLowerCase();
  const tokens = str.match(/[a-z0-9]{4,}/g) || [];
  return tokens.filter((t) => !/^(dell|generic|monitor|display|screen|color|colour|pnpmonitor)$/i.test(t));
}

/**
 * 型号名能不能算「同一块屏」：整串归一后相等/互相包含算；
 * 「显示器 U2414H」↔「DELL U2414H」这种互不包含的，取两边共有的
 * 型号词（≥4 位字母数字，比如 u2414h / s2316m）也算 —— 厂牌前缀（DELL）不误伤。
 */
function modelNameHit(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = extractModelTokens(a);
  const tb = new Set(extractModelTokens(b));
  return ta.some((t) => tb.has(t));
}

/** system_profiler 不吐序列号的屏，改从 EDID（ioreg）补 —— 两端的稳定键从此同源 */
async function enrichMacEdid() {
  if (!IS_MAC) return;
  const need = monitorsCache.filter((m) => !m.internal && !m.serial);
  if (!need.length) return;
  const r = await tryExec('ioreg', ['-lw0'], { maxBuffer: 64 * 1024 * 1024 });
  if (!r.ok || !r.stdout) return;
  const infos = parseEdidDisplays(r.stdout).filter((e) => e.serial);
  if (!infos.length) return;
  for (const m of need) {
    const mn = normName(m.name);
    let hits = mn
      ? infos.filter((e) => e.name && modelNameHit(e.name, m.name))
      : [];
    // 名字对不上（还挂着占位名）而全机只有一块缺序列号、一条带序列号的 EDID：一对一直接认
    if (hits.length !== 1 && need.length === 1 && infos.length === 1) hits = infos;
    const serials = new Set(hits.map((h) => h.serial));
    if (serials.size !== 1) continue; // 同型号双屏认不出谁是谁，宁缺毋滥
    m.serial = [...serials][0];
    if (isGenericName(m.name) && hits[0] && hits[0].name) m.name = hits[0].name;
  }
}

function detectWin() {
  return new Promise((resolve) => {
    const script = [
      'Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID | ForEach-Object {',
      "  $n = ($_.UserFriendlyName | Where-Object {$_ -ne 0} | ForEach-Object {[char]$_}) -join '';",
      "  $s = ($_.SerialNumberID  | Where-Object {$_ -ne 0} | ForEach-Object {[char]$_}) -join '';",
      "  \"$n|$s|$($_.InstanceName)\" }"
    ].join('\n');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 12000 }, (err, stdout) => {
      if (err) return resolve([]);
      const out = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const t = line.trim();
        if (!t || !t.includes('|')) continue;
        const [name, serial, inst] = t.split('|');
        if (!name) continue;
        // DISPLAY\DELA0A4\5&… → DELA0A4：和 dxva2 报的硬件 ID 同一套编号
        const hwid = (String(inst || '').match(/^[^\\]+\\([^\\]+)/) || [])[1] || '';
        out.push({ id: serial || name, name, serial: serial || '', size: '', hwid });
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
      const friendlyAll = IS_MAC ? await detectMac() : IS_WIN ? await detectWin() : [];
      lastFriendly = friendlyAll;
      // Mac 的系统枚举把内建屏一起算进来，DDC 只数外接屏 —— 先把内建屏摘出去再对齐，
      // 否则数量永远差一个，型号名和序列号全都安不上（屏就变成「显示器 1/2」，跨机器对不上号）
      const friendly = IS_MAC ? friendlyAll.filter((f) => !f.internal) : friendlyAll;
      // ddcctl 没有可靠的列表输出，探测数量可能多于实际，用系统枚举结果裁剪
      let ddcList = r.displays;
      if (friendly.length && friendly.length < ddcList.length) ddcList = ddcList.slice(0, friendly.length);
      // 优先按硬件 ID 精确配对（Windows 的 dxva2 枚举顺序和 WMI 顺序不一定一致，
      // 按顺序对会把两块屏的型号弄反，进而切错屏）；没有硬件 ID 时才退回顺序对齐
      const byHwid = new Map();
      for (const f of friendly) if (f.hwid) byHwid.set(f.hwid, f);
      const aligned = friendly.length === ddcList.length;
      list = ddcList.map((d, i) => {
        let f = d.hwid ? (byHwid.get(d.hwid) || null) : null;
        if (!f && d.name) {
          f = friendly.find((item) => modelNameHit(item.name, d.name) || (item.serial && d.serial && item.serial === d.serial));
        }
        if (!f && aligned) f = friendly[i];
        const isGeneric = (n) => !n || /^显示器\s*\d*$/i.test(String(n).trim());
        const bestName = (!isGeneric(d.name) ? d.name : (f && !isGeneric(f.name) ? f.name : (d.name || (f && f.name) || `显示器 ${d.index}`)));
        return {
          id: `ddc:${d.index}`,
          index: d.index,
          name: bestName,
          serial: (f && f.serial) || d.serial || '',
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
  nextScan();
  // 按系统里的真实排列（左/右/上/下）排好，界面上的「显示器 A/B」才是眼前看到的顺序
  refreshScreenLayout();
  // system_profiler 不吐序列号的屏再从 EDID 补一次：稳定键（sn:）和 Windows 对齐，
  // 归属快照、备忘去重、probe 才认得出是同一块屏 —— 必须赶在键迁移/记备忘之前
  await enrichMacEdid();
  if (!cfg.ui.monitorId || !list.some((m) => m.id === cfg.ui.monitorId)) {
    cfg.ui.monitorId = monitorsCache[0].id;
    cfg.ui.monitorName = monitorsCache[0].name;
    persist();
  }
  // 老配置按 ddc:index 存过：趁这次扫描把「编号 → 屏幕」对上，搬到稳定键上
  migratePortKeys();
  ensurePortDefaults();
  learnPorts();
  rememberScreens();
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
  let slot = 0;
  for (const m of monitorsCache) {
    // 内建屏不参与切换，自然也不该占快捷键
    if (m.internal) {
      if (map[m.id] === undefined) { map[m.id] = ''; changed = true; }
      continue;
    }
    if (map[m.id] === undefined) {
      map[m.id] = MONITOR_HOTKEY_DEFAULTS[slot] || '';
      changed = true;
    }
    slot += 1;
  }
  if (changed) persist();
}

/* ---------------- DDC/CI 输入源切换 ---------------- */

function tryExec(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, ...(opts || {}) }, (err, stdout, stderr) => {
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
  // 若当前本机不是键鼠主控端（即各用各的，或当前由对端主控），本机无需捕获全局输入，不需要报权限错误
  if (!cfg.ui || !cfg.ui.inputMaster || cfg.ui.inputMaster !== cfg.peerName) return true;
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

function openInputMonitoringSettings() {
  if (!IS_MAC) return false;
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
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
  // 本机此刻看不见、但局域网里公认存在的屏也要列出来 —— 被切到别的电脑上的屏
  // 如果凭空消失，用户只会以为软件丢了屏，看不出「它正在显示另一台电脑」
  const rows = monitorRows().concat(offlineRows());
  const arrange = arrangeOrder();
  // 最早打开本软件的那台是主控：它的状态是初始权威，后开的都照它同步
  const primary = primaryDevice();

  // 字母只按「外接屏从左到右」排，内建屏排在最后 —— 快捷键里说的「显示器 A/B」
  // 必须和界面上看到的字母一致，不能被内建屏把 A 抢走（内建屏不参与切换、也不占键）
  const letterMap = new Map();
  let seq = 0;
  for (const m of rows) if (!m.internal) letterMap.set(m.id, String.fromCharCode(65 + (seq++ % 26)));
  for (const m of rows) if (m.internal) letterMap.set(m.id, String.fromCharCode(65 + (seq++ % 26)));

  const devices = arrange.map((id, di) => {
    const info = deviceInfo(id);
    const isThisLocal = info.local;

    // 外接屏由所有设备共享
    const sharedMonitors = rows.filter((m) => !m.internal).map((m) => ({
      id: m.id,
      name: m.name,
      internal: false,
      present: m.present !== false,
      pos: m.pos || null,
      letter: letterMap.get(m.id) || '?',
      port: m.ports[id] ? m.ports[id].label : '未设置',
      hasPort: !!(m.ports[id] && m.ports[id].value),
      here: m.ownerId === '' ? null : m.ownerId === id,
      ownerId: m.ownerId
    }));

    // 为有内建屏的设备添加专属内建屏（排在最左侧体现相对位置）
    const devMonitors = sharedMonitors.slice();
    const extWithPos = sharedMonitors.filter((m) => m.pos);
    const minExtX = extWithPos.length ? Math.min(...extWithPos.map((m) => m.pos.x)) : 0;

    if (isThisLocal) {
      const localInternal = rows.find((m) => m.internal);
      if (localInternal) {
        let intPos = localInternal.pos || null;
        if (sharedMonitors.length && (!intPos || intPos.x >= minExtX)) {
          intPos = { x: minExtX - 2040, y: 0, width: 1920, height: 1200 };
        }
        devMonitors.unshift({
          id: localInternal.id,
          name: localInternal.name,
          internal: true,
          present: true,
          pos: intPos,
          letter: '内',
          port: '内建',
          hasPort: false,
          here: selfAwake,
          ownerId: id
        });
      }
    } else {
      const remInt = remoteInternals.get(id);
      if (remInt) {
        // 远端内建屏坐标系是远端自有的，绝不能与本机外接屏的坐标系混同（否则 x: 0 必与外接屏重叠）
        // 严格定位在所有外接屏的最左侧
        const intWidth = (remInt.pos && remInt.pos.width) || 1920;
        const intHeight = (remInt.pos && remInt.pos.height) || 1200;
        const relPos = { x: minExtX - intWidth - 100, y: 0, width: intWidth, height: intHeight };
        devMonitors.unshift({
          id: `remote-int:${id}`,
          name: remInt.name || '内建视网膜显示器',
          internal: true,
          present: true,
          pos: relPos,
          letter: '内',
          port: '内建',
          hasPort: false,
          here: true,
          ownerId: id
        });
      }
    }

    // hereCount 与屏幕统计严格只计外接屏，内建屏不占外接屏数量
    const hereCount = sharedMonitors.filter((m) => m.here === true).length;
    return {
      id,
      name: info.name,
      kind: info.kind,
      local: info.local,
      online: info.online,
      active: id === activeTarget,
      // 第一个打开本软件的是主控，界面上标出来，省得用户猜谁说了算
      primary: id === primary,
      colorIndex: di % 6,
      // 这台电脑此刻是否在「点亮」某块外接屏 —— 界面靠它决定要不要着色
      inUse: hereCount > 0,
      hereCount,
      note: info.local ? '本机' : (info.online ? '局域网' : '离线'),
      monitors: devMonitors
    };
  });

  const monitors = rows.map((m) => ({
    id: m.id,
    key: m.key || '',
    index: m.index,
    name: m.name,
    serial: m.serial || '',
    internal: m.internal,
    hasDdc: !!m.hasDdc,
    present: m.present !== false,
    // DDC 读回来的「此刻在用哪个口」—— 界面用它显示「当前画面」，也用来顶一个一键配置
    currentInput: m.currentInput || '',
    currentInputLabel: m.currentInputLabel || '',
    ownerId: m.ownerId,
    ownerLabel: m.ownerLabel,
    ports: m.ports,
    deviceCount: m.deviceCount,
    pos: m.pos || null,
    letter: letterMap.get(m.id) || '?'
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
      inputCycle: (cfg.ui.hotkeys && cfg.ui.hotkeys.inputCycle) || 'Alt+Q',
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
    inputMode: (cfg.ui && cfg.ui.inputMaster) ? ((cfg.ui && cfg.ui.inputMaster === cfg.peerName) ? 'local' : 'remote') : 'separate',
    input: {
      master: (cfg.ui && cfg.ui.inputMaster) || '',
      masterName: (cfg.ui && cfg.ui.inputMaster) ? deviceInfo(cfg.ui.inputMaster).name : '',
      isHost: !!(cfg.ui && cfg.ui.inputMaster && cfg.ui.inputMaster === cfg.peerName),
      isGuest: !!(cfg.ui && cfg.ui.inputMaster && cfg.ui.inputMaster !== cfg.peerName),
      sharing: !!(cfg.ui && cfg.ui.inputMaster),
      edgeSwitch: !!(cfg.ui && cfg.ui.edgeSwitch),
      mouseSpeed: Number(cfg.ui.mouseSpeed) || 1,
      capturing: !!(peer && peer.isCapturing && peer.isCapturing()),
      error: (peer && peer.getCaptureError && peer.getCaptureError()) || ''
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
    if (Array.isArray(p.displays)) {
      const intDisp = p.displays.find((d) => d && d.internal);
      if (intDisp) {
        remoteInternals.set(p.name, {
          name: intDisp.name || '内建视网膜显示器',
          pos: intDisp.pos || null
        });
      }
    }
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

/**
 * 执行一次显示器输入源切换（本机或对端请求都走这里）。
 * `input` 是「本机自己的」计划：字符串（所有屏同口）或 { index: 值 }。
 * 不再需要跨机器换 index / 名字 —— 每台机器都只切自己接线能碰到的屏。
 */
async function onSwitchRequest({ input, label, from, index, target }) {
  // 指定了 index = 只切这一台显示器
  if (typeof index === 'number') {
    const value = typeof input === 'string' ? input : Object.values(input || {})[0];
    const name = label || labelForInput(value);
    const r = await ddc.setInput(index, value);
    if (r.ok) {
      // 亲手切成功 → 这块屏现在归它了（下次读不到当前输入源也能着色）
      const m = monitorsCache.find((x) => x.index === index);
      if (m) applySwitched(target, m, value);
      if (target && m) {
        const mk = portKey(m);
        if (!cfg.ui.ownerMap) cfg.ui.ownerMap = {};
        cfg.ui.ownerMap[mk] = target;
        if (!portFor(m.id, target) && normInput(value)) {
          if (!cfg.ui.portMap) cfg.ui.portMap = {};
          cfg.ui.portMap[mk] = { ...(cfg.ui.portMap[mk] || {}), [target]: normInput(value) };
          markPortSrc(mk, target, 'learn');
        }
        persist();
      }
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
    // 亲手切成功 → 把这些屏的归属记下来（读不到当前输入源的屏也能着对色）
    if (target) {
      if (typeof input === 'string') {
        if (!r.partial) {
          for (const m of monitorsCache) {
            if (!m.internal && sameInput(portFor(m.id, target), input)) applySwitched(target, m, input);
          }
        }
      } else {
        for (const [idx, v] of Object.entries(input || {})) {
          const m = monitorsCache.find((x) => x.index === Number(idx));
          if (!m) continue;
          applySwitched(target, m, v);
          if (!portFor(m.id, target) && normInput(v)) {
            const mk = portKey(m);
            if (!cfg.ui.portMap) cfg.ui.portMap = {};
            cfg.ui.portMap[mk] = { ...(cfg.ui.portMap[mk] || {}), [target]: normInput(v) };
            markPortSrc(mk, target, 'learn');
          }
        }
      }
      persist();
    }
    pushStatus(from ? `已由 ${from} 把${scope}切换到 ${name}` : `已将${scope}切换到 ${name}`, 'ok');
    if (r.partial) pushStatus(`有显示器未响应：${r.error}（VGA 线和一些转接头不走 DDC，屏幕收不到切换指令，属于正常现象，这根线连的口请在接了 DDC 可用线的那台电脑上切）`, 'warn');
    setTimeout(() => { detectMonitors().catch(() => {}); }, 1500);
  } else {
    pushStatus(`切换到 ${name} 失败`, 'warn');
    pushStatus(`${r.error || '未知原因'}（若显示器经 VGA / 转接头连接，它可能不支持 DDC/CI，无法远程切换）`, 'warn');
  }
  return r;
}

/** 对端请求协同切换单块显示器 */
async function onRemoteSwitchMonitor({ name, target }) {
  if (!name || !target) return;
  const m = monitorsCache.find((x) => !x.internal && modelNameHit(x.name, name));
  if (!m || typeof m.index !== 'number') return;
  const p = monitorSwitchPlan(m.id, target);
  if (p && p.ok && !p.already) {
    await onSwitchRequest({ input: p.value, label: p.label, index: p.index, target, from: deviceInfo(target).name });
  }
}

function onSwitch({ result, target, label, detail, missing }) {
  const name = target ? deviceInfo(target).name : '';
  if (result === 'no-input') {
    const list = (missing || []).map((m) => m.name).filter(Boolean);
    if (list.length) {
      pushStatus(`「${list.join('」「')}」还没设 ${name} 的接口 —— 点那块屏上的「设置接口」选一下`, 'warn');
    } else {
      pushStatus(`${name} 还没在任何显示器上指定接口，点显示器卡片上的「设置接口」配一下`, 'warn');
    }
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
  } else if (result === 'control') {
    // 只交键鼠控制权、显示器没动
    pushStatus(name ? `键鼠已交给 ${name}（显示器不变）` : '键鼠已交出去（显示器不变）', 'info');
  } else if (result === 'missing') {
    pushStatus('那台设备当前不在线，键鼠没法交过去', 'warn');
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
  if (!cfg.ui.hotkeys) cfg.ui.hotkeys = { global: 'F12', inputCycle: 'Alt+Q', monitor: {} };
  if (!cfg.ui.hotkeys.monitor) cfg.ui.hotkeys.monitor = {};
  const cleanKey = typeof key === 'string' ? key.trim() : '';
  if (kind === 'global') {
    cfg.ui.hotkeys.global = cleanKey;
    cfg.ui.hotkeyKey = cfg.ui.hotkeys.global;
  } else if (kind === 'inputCycle') {
    cfg.ui.hotkeys.inputCycle = cleanKey;
  } else if (kind === 'monitor' && id) {
    if (cleanKey) {
      cfg.ui.hotkeys.monitor[id] = cleanKey;
    } else {
      delete cfg.ui.hotkeys.monitor[id];
    }
  }
  persist();
}

/**
 * 快捷键切换键鼠控制权：
 * 1. 若当前为「各用各的键鼠」，无需也不执行任何控制权切换；
 * 2. 若当前为「共用某台电脑键鼠」，按下快捷键仅在主控设备与受控设备之间来回交接控制权，
 *    绝对不改变谁是共用主控端（inputMaster 始终不变）。
 */
async function cycleInputDevice() {
  if (!peer) return null;

  const masterId = (cfg.ui && cfg.ui.inputMaster) || '';
  if (!masterId) {
    pushStatus('当前为各用各的键鼠模式，无需切换控制权', 'info');
    return { name: '各用各的键鼠', notice: '各用各的模式 · 无需切换控制权', alone: true };
  }

  const masterInfo = deviceInfo(masterId);
  // 关键修复：参与控制权流转的所有设备 = 主控端 + 本机 + 所有在线对端（去重）
  const allDevs = [masterId, cfg.peerName, ...peersNow.map((p) => p.name)];
  const candidates = [...new Set(allDevs)].filter(Boolean);

  if (candidates.length <= 1) {
    pushStatus('局域网未发现其他在线设备，无法切换控制权', 'warn');
    return { name: masterInfo.name, alone: true };
  }

  // 当前键鼠控制权正落在哪个设备上（默认在主控端本地）
  const curTarget = activeTarget || masterId;
  const curIdx = candidates.indexOf(curTarget);
  const safeIdx = curIdx >= 0 ? curIdx : candidates.indexOf(masterId);
  const nextTarget = candidates[(safeIdx + 1) % candidates.length] || masterId;
  const nextInfo = deviceInfo(nextTarget);

  await peer.switchInputTo(nextTarget);
  activeTarget = nextTarget;
  pushStatus(`键鼠控制权已切至「${nextInfo.name}」`, 'ok');
  return { id: nextTarget, name: nextInfo.name, local: nextTarget === cfg.peerName };
}

/** 切换共用键鼠的主控端：'' 表示各用各的，masterId 表示由该设备作为主控 */
function setInputMaster(masterId, edgeSwitch, mouseSpeed) {
  if (!cfg.ui) cfg.ui = {};
  const cleanMaster = typeof masterId === 'string' ? masterId.trim() : '';
  cfg.ui.inputMaster = cleanMaster;
  if (typeof edgeSwitch === 'boolean') cfg.ui.edgeSwitch = edgeSwitch;
  if (typeof mouseSpeed === 'number' && Number.isFinite(mouseSpeed)) {
    cfg.ui.mouseSpeed = Math.max(0.5, Math.min(2, mouseSpeed));
  }
  cfg.shareInput = !!cleanMaster;
  cfg.isHost = cleanMaster === cfg.peerName;
  cfg.ui.inputMode = cleanMaster ? (cleanMaster === cfg.peerName ? 'local' : 'remote') : 'separate';
  
  // 选定共用主控端后，控制权初始默认在该主控端本体
  activeTarget = cleanMaster || cfg.peerName;

  persist();
  if (peer && typeof peer.setInputMaster === 'function') {
    peer.setInputMaster(cleanMaster, cfg.ui.edgeSwitch);
  }
  if (!cleanMaster) {
    pushStatus('已切为：各用各的键鼠', 'info');
  } else {
    const dev = deviceInfo(cleanMaster);
    pushStatus(`已切为：共用 ${dev.name} 键鼠`, 'ok');
  }
  return getState();
}

function applyInputMode(mode) {
  if (mode === 'separate') return setInputMaster('');
  if (mode === 'local') return setInputMaster(cfg.peerName);
  return getState();
}

/* ---------------- 导出 ---------------- */

module.exports = {
  get cfg() { return cfg; },
  get peer() { return peer; },
  get peers() { return peersNow; },
  ensureDefaults,
  persist,
  setPeer,
  setInputMaster,
  applyInputMode,
  cycleInputDevice,
  arrangeOrder,
  setArrange,
  deviceIds,
  deviceInfo,
  localLabel,
  portFor,
  setPort,
  ensurePortDefaults,
  monitorRows,
  exportPorts,
  importPorts,
  publishAuthority,
  applyAuthority,
  settleRemain,
  clearSettle,
  screenKey,
  primaryDevice,
  setSelfAwake,
  buildSwitchPlan,
  monitorSwitchPlan,
  monitorCyclePlan,
  probePort,
  probeAnswer,
  portKey,
  portKeyOf,
  migratePortKeys,
  refreshScreenLayout,
  nextDevice,
  labelForInput,
  targetPeerNames,
  setTargetPeers,
  detectMonitors,
  switchMonitorInput,
  accessibilityGranted,
  openAccessibilitySettings,
  openInputMonitoringSettings,
  getState,
  exportDisplaysMeta,
  onPeers,
  onActive,
  onFileUpdate,
  onSwitch,
  onSwitchRequest,
  onRemoteSwitchMonitor,
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
