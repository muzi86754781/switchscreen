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
// 本机是否醒着（休眠/锁屏时笔记本内建屏不在显示）
let selfAwake = true;

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
function portFor(monitorId, deviceId) {
  const t = (cfg.ui.portMap && cfg.ui.portMap[monitorId]) || {};
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
    if (!cfg.ui.portMap[m.id]) { cfg.ui.portMap[m.id] = {}; changed = true; }
    const t = cfg.ui.portMap[m.id];
    for (const p of peersNow) {
      if (Object.prototype.hasOwnProperty.call(t, p.name)) continue;
      // 老版本按「对端默认接口」存过，迁移过来（有值才写）
      const legacy = (cfg.ui.legacyRemotePorts && cfg.ui.legacyRemotePorts[m.id]) || '';
      if (legacy) { t[p.name] = legacy; changed = true; }
    }
  }
  if (changed) persist();
}

function setPort(monitorId, deviceId, value) {
  if (!monitorId || !deviceId) return false;
  if (!cfg.ui.portMap) cfg.ui.portMap = {};
  if (!cfg.ui.ownerMap) cfg.ui.ownerMap = {};
  const t = cfg.ui.portMap[monitorId] || {};
  const v = normInput(value);
  t[deviceId] = v;
  cfg.ui.portMap[monitorId] = t;
  // 手配完顺手校准归属：如果这块屏此刻的输入源正好就是这个口，那现在就是这台在用
  const m = monitorsCache.find((x) => x.id === monitorId);
  if (v && m && sameInput(m.currentInput, v)) cfg.ui.ownerMap[monitorId] = deviceId;
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
    const t = (cfg.ui.portMap && cfg.ui.portMap[m.id]) || {};
    const ports = {};
    for (const k of Object.keys(t)) { const v = normInput(t[k]); if (v) ports[k] = v; }
    if (Object.keys(ports).length) out.push({ name: m.name, ports });
  }
  return out;
}

/** 合并对端发来的接口配置：按显示器名字配对，只补本机还没设的（本机手改优先） */
function importPorts(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  let n = 0;
  for (const it of list) {
    const key = normName(it && it.name);
    if (!key || !it.ports) continue;
    const m = monitorsCache.find((x) => !x.internal && normName(x.name) && (
      normName(x.name) === key || normName(x.name).includes(key) || key.includes(normName(x.name))));
    if (!m) continue;
    if (!cfg.ui.portMap) cfg.ui.portMap = {};
    const t = cfg.ui.portMap[m.id] || {};
    const live = normInput(m.currentInput);
    for (const dev of Object.keys(it.ports)) {
      const v = normInput(it.ports[dev]);
      if (!v || t[dev]) continue;
      // 本机此刻正用着这个口（DDC 实测）：一块屏的一个口只接一根线，
      // 说明对端这条记错了 —— 本机实测是唯一能自证的方向，拒收。
      if (dev !== cfg.peerName && live && sameInput(v, live)) continue;
      // 冲突保护：同一个口不可能同时属于两台设备。
      // 如果本地那条是本次「猜」的，就让位给对端（对端的配置是它自己屏幕上的事实）；
      // 不是猜的就保持本地优先，谁也不覆盖谁 —— 否则两端会互相「确认」着错下去。
      const clash = Object.keys(t).find((k) => k !== dev && sameInput(t[k], v));
      if (clash) {
        if (!guessedPorts.has(`${m.id}|${clash}`)) continue;
        delete t[clash];
        if (cfg.ui.ownerMap && cfg.ui.ownerMap[m.id] === clash) delete cfg.ui.ownerMap[m.id];
        guessedPorts.delete(`${m.id}|${clash}`);
      }
      t[dev] = v;
      n += 1;
    }
    cfg.ui.portMap[m.id] = t;
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

    // 枚举得到这块屏 = 它此刻正在显示本机 → 归属一定是本机（不管读不读得到输入源）
    if (cfg.ui.ownerMap[m.id] !== me) {
      cfg.ui.ownerMap[m.id] = me;
      n += 1;
    }

    const cur = normInput(m.currentInput);
    if (!cur) continue; // 读不到就别碰接口配置，免得把对的改错
    const t = cfg.ui.portMap[m.id] || {};

    // 铁证：这块屏正在显示本机 → 当前输入源就是本机的口（存错了就纠正）
    if (!sameInput(t[me], cur)) {
      t[me] = cur;
      guessedPorts.delete(`${m.id}|${me}`);
      n += 1;
      changed = true;
    }

    // 一个口只能接一根线、属于一台机器：别的设备也记着这个口，那条一定是错的
    for (const id of ids) {
      if (id === me || !t[id] || !sameInput(t[id], cur)) continue;
      delete t[id];
      if (cfg.ui.ownerMap[m.id] === id) cfg.ui.ownerMap[m.id] = me;
      guessedPorts.delete(`${m.id}|${id}`);
      n += 1;
      changed = true;
    }
    if (changed) { cfg.ui.portMap[m.id] = t; changed = false; }
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
  if (m.currentInput) {
    for (const id of deviceIds()) {
      if (sameInput(portFor(m.id, id), m.currentInput)) return id;
    }
  } else if (m.present !== false) {
    // 2) 本机枚举得到它、只是读不到输入源 —— 它就在显示本机
    return cfg.peerName;
  }

  // 3) 本机看不到这块屏（或读到的口谁都对不上）→ 用局域网公认的归属
  const a = cfg.ui.authority;
  if (a && Array.isArray(a.screens)) {
    const k = m.key || screenKey(m);
    const hit = a.screens.find((s) => s.key === k);
    if (hit && hit.owner && deviceIds().includes(hit.owner)) return hit.owner;
  }

  // 4) 本机上一次确认过的归属
  const saved = (cfg.ui.ownerMap && cfg.ui.ownerMap[m.id]) || '';
  if (saved && deviceIds().includes(saved)) return saved;
  return '';
}

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
    cfg.ui.ownerMap[m.id] = targetId;
  }
}

/** 记下「这块屏现在归谁」——只该在真的切成功、或自证匹配之后调用 */
function markOwners(targetId, inputValue) {
  if (!targetId) return 0;
  if (!cfg.ui.ownerMap) cfg.ui.ownerMap = {};
  let n = 0;
  for (const m of monitorsCache) {
    if (m.internal) continue;
    if (inputValue !== undefined && inputValue !== '' && !sameInput(portFor(m.id, targetId), inputValue)) continue;
    if (cfg.ui.ownerMap[m.id] !== targetId) { cfg.ui.ownerMap[m.id] = targetId; n += 1; }
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

/** 本机视角的归属：只认本机能自证的证据，不看别的机器怎么说 */
function ownViewOf(m) {
  if (!m) return '';
  if (m.currentInput) {
    for (const id of deviceIds()) {
      if (sameInput(portFor(m.id, id), m.currentInput)) return id;
    }
    return '';
  }
  const saved = (cfg.ui.ownerMap && cfg.ui.ownerMap[m.id]) || '';
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
    byKey.set(k, {
      key: k,
      name: m.name || old.name || '',
      owner: ownViewOf(m) || old.owner || ''
    });
  }
  return { rev: Date.now(), at: cfg.peerName, screens: [...byKey.values()] };
}

/** 本机状态变了（切换成功 / 检测刷新）→ 生成新一版快照，由主进程广播出去 */
function publishAuthority() {
  const a = buildAuthority();
  cfg.ui.authority = a;
  persist();
  return a;
}

/** 收到别的机器发来的快照：只接受更新的那一版（rev 大者胜） */
function applyAuthority(a) {
  if (!a || !Array.isArray(a.screens) || !a.rev) return false;
  const cur = cfg.ui.authority || { rev: 0 };
  if (Number(a.rev) <= Number(cur.rev || 0)) return false;
  cfg.ui.authority = { rev: Number(a.rev), at: a.at || '', screens: a.screens };
  persist();
  return true;
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
    if (!s.key || have.has(s.key)) continue;
    const memo = (cfg.ui.screenMemo && cfg.ui.screenMemo[s.key]) || {};
    out.push({
      key: s.key,
      id: 'mem:' + String(s.key).replace(/[^a-zA-Z0-9]+/g, '_'),
      index: null,
      displayId: null,
      name: s.name || memo.name || '显示器',
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
        const v = portFor(m.id, id);
        ports[id] = { value: v, label: v ? labelForInput(v) : '未设置' };
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

const INTERNAL_LABEL = /built-?in|内建|内置|internal display|colou?r lcd/i;

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
  let unreachable = 0;
  let label = '';

  for (const m of monitorsCache) {
    if (m.internal) continue;
    if (typeof m.index !== 'number') { unreachable += 1; continue; }
    total += 1;
    const value = portFor(m.id, targetId);
    if (!value) { skipped += 1; missing.push({ id: m.id, name: m.name }); continue; }
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
    unreachable,
    missing,
    // 每块屏接口相同时压成一个值：执行端「枚举到几块就切几块」，不依赖 index
    plan: count ? unifyInput(map, count) : null,
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
  return {
    ok: true,
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
      const friendly = IS_MAC ? await detectMac() : IS_WIN ? await detectWin() : [];
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
        if (!f && aligned) f = friendly[i];
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
    const monitors = rows.map((m) => ({
      id: m.id,
      name: m.name,
      internal: m.internal,
      present: m.present !== false, // 本机此刻能不能碰得到它（被切走就是 false）
      pos: m.pos || null,
      letter: letterMap.get(m.id) || '?',
      port: m.ports[id] ? m.ports[id].label : '未设置',
      hasPort: !!(m.ports[id] && m.ports[id].value),
      here: m.ownerId === '' ? null : m.ownerId === id,
      ownerId: m.ownerId
    }));
    const hereCount = monitors.filter((m) => m.here === true && !m.internal).length;
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
      // 这台电脑此刻是否在「点亮」某块屏 —— 界面靠它决定要不要着色
      inUse: hereCount > 0,
      hereCount,
      note: info.local ? '本机' : (info.online ? '局域网' : '离线'),
      monitors
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
        if (!cfg.ui.ownerMap) cfg.ui.ownerMap = {};
        cfg.ui.ownerMap[m.id] = target;
        if (!portFor(m.id, target) && normInput(value)) {
          if (!cfg.ui.portMap) cfg.ui.portMap = {};
          cfg.ui.portMap[m.id] = { ...(cfg.ui.portMap[m.id] || {}), [target]: normInput(value) };
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
            if (!cfg.ui.portMap) cfg.ui.portMap = {};
            cfg.ui.portMap[m.id] = { ...(cfg.ui.portMap[m.id] || {}), [target]: normInput(v) };
          }
        }
      }
      persist();
    }
    pushStatus(from ? `已由 ${from} 把${scope}切换到 ${name}` : `已将${scope}切换到 ${name}`, 'ok');
    if (r.partial) pushStatus(`有显示器未响应：${r.error}`, 'warn');
    setTimeout(() => { detectMonitors().catch(() => {}); }, 1500);
  } else {
    pushStatus(`切换到 ${name} 失败`, 'warn');
    pushStatus(r.error || '未知原因', 'warn');
  }
  return r;
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
  exportPorts,
  importPorts,
  publishAuthority,
  applyAuthority,
  screenKey,
  primaryDevice,
  setSelfAwake,
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
