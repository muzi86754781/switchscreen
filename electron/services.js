'use strict';

/**
 * 主进程服务层：把 src/ 下的能力聚合成 GUI 需要的状态与动作。
 * 所有配置修改都直接改同一个 cfg 对象（peer.js 持有同一引用），
 * 这样界面上的开关能即时生效，无需重启。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, systemPreferences, shell } = require('electron');
const { loadConfig, saveConfig } = require('../src/config');
const { describeModMap } = require('../src/keymap');
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
  const base = IS_MAC ? path.join(os.homedir(), 'Desktop') : path.join(os.homedir(), 'Desktop');
  return path.join(base, 'SwitchScreen', 'clipboard', 'received');
}

/* ---------------- 配置 ---------------- */

function ensureDefaults() {
  if (!cfg.ui) cfg.ui = {};
  const ui = cfg.ui;
  if (!ui.receiveDir) ui.receiveDir = defaultReceiveDir();
  if (typeof ui.mouseSpeed !== 'number') ui.mouseSpeed = 1;
  if (!ui.inputMode) ui.inputMode = 'separate';
  if (!ui.hotkeyKey) ui.hotkeyKey = 'F12';
  if (!ui.perMonitor || typeof ui.perMonitor !== 'object') ui.perMonitor = {};
  if (typeof ui.autoAccept !== 'boolean') ui.autoAccept = false;
  if (typeof ui.targetPeer !== 'string') ui.targetPeer = '';
  // 共用键鼠 / 无缝移动
  if (typeof ui.edgeSwitch !== 'boolean') ui.edgeSwitch = true;
  if (!ui.edgeSide) ui.edgeSide = 'right';
  if (!ui.modMap) ui.modMap = 'cmd-ctrl';
  if (typeof ui.keyDebug !== 'boolean') ui.keyDebug = false;
  // 早期版本存过连接配对密码，已不再使用
  delete ui.usePassword;
  delete ui.password;
  saveConfig(cfg);
}

function persist() {
  saveConfig(cfg);
}

function applyInputMode(mode) {
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
}

/** 把界面上选的接口值同步到 peer 使用的配置里 */
function syncInputMapping() {
  cfg.selfInput = cfg.ui.localInput;
  for (const p of peersNow) cfg.peers[p.name] = cfg.ui.remoteInput;
  persist();
}

/**
 * 每台显示器的接口设置。key 用显示器 id（"ddc:0"）。
 * 返回 { [id]: { local, remote, localLabel, remoteLabel } }
 * 注意：显式存成空字符串表示「这台显示器在这个方向上不切」，不能被全局值覆盖。
 */
function perMonitorMap() {
  if (!cfg.ui.perMonitor) cfg.ui.perMonitor = {};
  const out = {};
  for (const m of monitorsCache) {
    const saved = cfg.ui.perMonitor[m.id] || {};
    const hasLocal = Object.prototype.hasOwnProperty.call(saved, 'local');
    const hasRemote = Object.prototype.hasOwnProperty.call(saved, 'remote');
    const local = hasLocal ? saved.local : cfg.ui.localInput;
    const remote = hasRemote ? saved.remote : cfg.ui.remoteInput;
    out[m.id] = {
      local,
      remote,
      localLabel: local ? (saved.localLabel || labelForInput(local)) : '不切',
      remoteLabel: remote ? (saved.remoteLabel || labelForInput(remote)) : '不切'
    };
  }
  return out;
}

function labelForInput(value) {
  const p = INPUT_PRESETS.find((x) => x.value === value);
  return p ? p.label : String(value || '');
}

/** 保存某台显示器的接口配置；value 传空字符串表示「这台不切」 */
function setMonitorInput(monitorId, role, value) {
  if (!cfg.ui.perMonitor) cfg.ui.perMonitor = {};
  const cur = cfg.ui.perMonitor[monitorId] || {};
  const v = value || '';
  const label = v ? labelForInput(v) : '不切';
  if (role === 'local') { cur.local = v; cur.localLabel = label; }
  else { cur.remote = v; cur.remoteLabel = label; }
  cfg.ui.perMonitor[monitorId] = cur;
  // 同时把全局值跟上，作为兜底（「不切」不影响全局）
  if (v) {
    if (role === 'local') { cfg.ui.localInput = v; cfg.ui.localInputLabel = label; cfg.selfInput = v; }
    else {
      cfg.ui.remoteInput = v;
      cfg.ui.remoteInputLabel = label;
      for (const p of peersNow) cfg.peers[p.name] = v;
    }
  }
  persist();
  return cur;
}

/* ---------------- 工作台模型 ---------------- */

/**
 * 每台显示器的归属与接口。
 *
 * owner 由「当前实际输入源」和配置的接口比对得出：
 *   'local'   —— 这块屏现在显示本机
 *   'remote'  —— 现在显示对端
 *   'unknown' —— 读不到当前输入（没有 DDC），无法判断
 *
 * 界面上的「哪台在用 / 显示器排列」全靠这个字段。
 */
function monitorRows() {
  const pm = perMonitorMap();
  return monitorsCache.map((m) => {
    const p = pm[m.id] || { local: '', remote: '' };
    let owner = 'unknown';
    if (m.currentInput) {
      if (p.local && m.currentInput === p.local) owner = 'local';
      else if (p.remote && m.currentInput === p.remote) owner = 'remote';
    }
    return {
      id: m.id,
      index: typeof m.index === 'number' ? m.index : null,
      name: m.name,
      hasDdc: typeof m.index === 'number',
      currentInput: m.currentInput || '',
      currentInputLabel: m.currentInputLabel || '',
      owner,
      // 这块屏能不能单独切换：两个方向都配了接口才行
      switchable: !!(p.local && p.remote),
      local: { value: p.local, label: p.local ? (p.localLabel || labelForInput(p.local)) : '不切' },
      remote: { value: p.remote, label: p.remote ? (p.remoteLabel || labelForInput(p.remote)) : '不切' }
    };
  });
}

/** 计算「单独把某台显示器切到某台电脑」的执行计划 */
function monitorSwitchPlan(monitorId, role) {
  const m = monitorsCache.find((x) => x.id === monitorId);
  if (!m) return { ok: false, error: '找不到这台显示器' };
  if (typeof m.index !== 'number') return { ok: false, error: '这台显示器不支持 DDC，无法单独切换' };
  const p = perMonitorMap()[monitorId] || {};
  const value = role === 'local' ? p.local : p.remote;
  if (!value) return { ok: false, error: '这台显示器在该方向上设为「不切」，请先选一个接口' };
  // DDC 必须由「这块屏当前显示的那台机器」发出
  let owner = 'unknown';
  if (m.currentInput && m.currentInput === p.local) owner = 'local';
  else if (m.currentInput && m.currentInput === p.remote) owner = 'remote';
  return {
    ok: true,
    index: m.index,
    value,
    label: labelForInput(value),
    owner,
    name: m.name
  };
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
          out.push({
            id: serial || name,
            name,
            serial,
            size: d._spdisplays_resolution || ''
          });
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
  if (!cfg.ui.monitorId || !list.some((m) => m.id === cfg.ui.monitorId)) {
    cfg.ui.monitorId = list[0].id;
    cfg.ui.monitorName = list[0].name;
    persist();
  }
  const cur = list.find((m) => m.id === cfg.ui.monitorId);
  pushStatus(
    via === 'dxva2' || via === 'm1ddc' || via === 'ddcctl'
      ? `已检测到 ${list.length} 台显示器（DDC 可用）`
      : `已检测到 ${list.length} 台显示器（DDC 不可用${ddcError ? '：' + ddcError : ''}）`,
    via === 'sys' ? 'warn' : 'ok'
  );
  if (cur && cur.currentInputLabel) {
    pushStatus(`当前输入源：${cur.currentInputLabel}`, 'info');
  }
  return list;
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

/**
 * 执行一次输入源切换。
 * value 可以是统一接口值（"0x12"），也可以是按显示器 index 的 map（{ "0":"0x11" }）。
 * 1) 首选原生 DDC 层（Windows=dxva2，macOS=m1ddc/ddcctl），无需外部安装；
 * 2) 全部失败时才用外部命令行工具兜底；
 * 3) 都失败则如实返回原因，供界面提示。
 */
async function switchMonitorInput(value, label) {
  const native = await ddc.setInputAll(value);
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
  // 捕获层已经成功启动 => 系统确实放行了，直接算已授权
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

function kindOf(platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return 'pc';
}

function getState() {
  const remote = peersNow[0] || null;
  const connected = !!remote;
  const localName = cfg.peerName;
  const remoteName = remote ? remote.name : (cfg._lastRemoteName || '另一台电脑');
  const active = activeTarget === localName ? 'local' : 'remote';
  const rows = monitorRows();
  const localLabel = IS_MAC ? 'Mac' : 'Windows';
  const remoteLabel = remote
    ? (kindOf(remote.platform) === 'mac' ? 'Mac' : kindOf(remote.platform) === 'win' ? 'Windows' : 'PC')
    : '其它电脑';

  /** 把显示器列表投影到某一台电脑上：显示它从哪个接口进这块屏、这块屏此刻是否正显示它 */
  const project = (role) => rows.map((m) => {
    const io = role === 'local' ? m.local : m.remote;
    return {
      id: m.id,
      name: m.name,
      io: io.label,
      connected: !!io.value,
      // owner === 'unknown' 时无法判断，交给界面显示「未知」
      here: m.owner === 'unknown' ? null : m.owner === role
    };
  });

  return {
    version: app.getVersion(),
    platform: process.platform,
    hostname: os.hostname(),
    isMac: IS_MAC,
    connection: { connected, peers: peersNow, count: peersNow.length },
    computers: {
      local: { name: localName, kind: IS_MAC ? 'mac' : 'win', label: localLabel, local: true },
      remote: { name: remoteName, kind: remote ? kindOf(remote.platform) : 'pc', label: remoteLabel, local: false, connected }
    },
    // 双机工作台：每行一台电脑 + 它在各显示器上的落点
    workbench: {
      rows: [
        {
          id: 'local',
          role: 'local',
          name: localName,
          label: localLabel,
          kind: IS_MAC ? 'mac' : 'win',
          note: '本机',
          online: true,
          active: active === 'local',
          monitors: project('local')
        },
        {
          id: 'remote',
          role: 'remote',
          name: remoteName,
          label: remoteLabel,
          kind: remote ? kindOf(remote.platform) : 'pc',
          note: connected ? '已连接 · 局域网' : '未连接 · 等待局域网发现',
          online: connected,
          active: active === 'remote',
          monitors: project('remote')
        }
      ],
      monitors: rows,
      // 有没有至少一块屏，两个方向都配好了
      anySwitchable: rows.some((m) => m.switchable)
    },
    monitor: {
      list: monitorsCache.length ? monitorsCache : [{ id: cfg.ui.monitorId || 'default', name: cfg.ui.monitorName || '默认显示器', size: '', currentInput: '', currentInputLabel: '' }],
      selectedId: cfg.ui.monitorId || '',
      selectedName: cfg.ui.monitorName || '',
      currentInput: (monitorsCache.find((m) => m.id === cfg.ui.monitorId) || {}).currentInput || '',
      currentInputLabel: (monitorsCache.find((m) => m.id === cfg.ui.monitorId) || {}).currentInputLabel || ''
    },
    ddc: {
      available: monitorsCache.some((m) => typeof m.index === 'number'),
      error: ddcError
    },
    inputs: {
      presets: INPUT_PRESETS,
      local: { value: cfg.ui.localInput, label: cfg.ui.localInputLabel },
      remote: { value: cfg.ui.remoteInput, label: cfg.ui.remoteInputLabel },
      perMonitor: perMonitorMap()
    },
    hotkey: { enabled: cfg.ui.hotkeyEnabled !== false, key: cfg.ui.hotkeyKey || 'F12' },
    launchAtLogin: (() => { try { return app.getLoginItemSettings().openAtLogin; } catch { return false; } })(),
    clipboard: {
      enabled: !!cfg.clipboardSync,
      receiveDir: cfg.ui.receiveDir,
      askLarge: cfg.ui.askLarge !== false,
      progress: clipProgress,
      percent: clipPercent
    },
    inputMode: cfg.ui.inputMode,
    mouseSpeed: cfg.ui.mouseSpeed,
    shareInput: !!cfg.shareInput,
    isHost: !!cfg.isHost,
    input: {
      mode: cfg.ui.inputMode,
      capturing: !!(cfg.shareInput && cfg.isHost),
      error: captureError(),
      edgeSwitch: cfg.ui.edgeSwitch !== false,
      edgeSide: cfg.ui.edgeSide || 'right',
      modMap: cfg.ui.modMap || 'cmd-ctrl',
      modDesc: describeModMap(cfg.ui.modMap || 'cmd-ctrl', process.platform, (remote && remote.platform) || process.platform),
      keyDebug: !!cfg.ui.keyDebug,
      peerPlatform: (remote && remote.platform) || ''
    },
    inputState: {
      mode: cfg.ui.inputMode,
      capturing: !!(cfg.shareInput && cfg.isHost),
      error: captureError()
    },
    files: {
      transfers: fileTransfers,
      recvDir: cfg.ui.receiveDir,
      autoAccept: !!cfg.ui.autoAccept,
      target: targetPeerName()
    },
    permission: { accessibility: accessibilityGranted() },
    active,
    activeTarget,
    statusLines
  };
}

/** 当前选中的接收对象：配置里存的名字若还在线就用它，否则用第一台 */
function targetPeerName() {
  const saved = (cfg.ui && cfg.ui.targetPeer) || '';
  if (saved && peersNow.some((p) => p.name === saved)) return saved;
  return peersNow[0] ? peersNow[0].name : '';
}

function setPeer(p) { peer = p; }

function onPeers(list) {
  peersNow = list;
  syncInputMapping();
  if (list.length) cfg._lastRemoteName = list[0].name;
  pushStatus(list.length ? `已连接：${list[0].name}` : '对端已断开', list.length ? 'ok' : 'warn');
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

/** peer 发起一次显示器输入源切换时调用：真正执行并如实回报结果 */
async function onSwitchRequest({ input, label, from, index }) {
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
    return { ok: !!r.ok, warning: '', error: r.error || '' };
  }

  const name = label || (typeof input === 'string' ? labelForInput(input) : '目标接口');
  const r = await switchMonitorInput(input, name);
  const scope = r.total > 1 ? `${r.success}/${r.total} 台显示器` : '显示器';
  if (r.ok) {
    pushStatus(from ? `已由 ${from} 把${scope}切换到 ${name}` : `已将${scope}切换到 ${name}`, 'ok');
    if (r.partial) pushStatus(`有显示器未响应：${r.error}`, 'warn');
    // 切换后刷新一次，让「当前输入」显示跟上
    setTimeout(() => { detectMonitors().catch(() => {}); }, 1500);
  } else {
    pushStatus(`切换到 ${name} 失败`, 'warn');
    pushStatus(r.error || '未知原因', 'warn');
  }
  return r;
}

function onSwitch({ result, target, label, detail }) {
  if (result === 'no-input') {
    pushStatus('未配置该机器的接口，请先在「连接与目标」里点选接口', 'warn');
  } else if (result === 'relayed') {
    pushStatus('已请求对端执行切换（画面在对端时由它发 DDC 指令）', 'ok');
  } else if (result === 'peers-gone') {
    pushStatus('对端连接已断开，无法切换', 'warn');
  } else if (result === 'failed') {
    pushStatus(`切换未生效${detail && detail.error ? '：' + detail.error : ''}`, 'warn');
  } else if (result === 'screen-kept') {
    pushStatus('已切换键鼠焦点（所有显示器都设为「不切」，画面不变）', 'info');
  } else if (result === 'sent') {
    pushStatus(`已切换到 ${label || target}`, 'ok');
  }
}

function setClipProgress(percent, bytes) {
  clipPercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
  if (typeof bytes === 'number') clipProgress = bytes;
}

/* ---------------- 导出 ---------------- */

module.exports = {
  get cfg() { return cfg; },
  get peer() { return peer; },
  ensureDefaults,
  persist,
  setPeer,
  applyInputMode,
  syncInputMapping,
  setMonitorInput,
  perMonitorMap,
  monitorRows,
  monitorSwitchPlan,
  labelForInput,
  targetPeerName,
  detectMonitors,
  switchMonitorInput,
  accessibilityGranted,
  openAccessibilitySettings,
  getState,
  onPeers,
  onActive,
  onFileUpdate,
  onSwitch,
  onSwitchRequest,
  pushStatus,
  defaultReceiveDir,
  setClipProgress,
  setActiveTarget: (t) => { activeTarget = t; },
  INPUT_PRESETS,
  IS_MAC,
  IS_WIN
};
