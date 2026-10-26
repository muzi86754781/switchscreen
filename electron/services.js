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

function randomPassword() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* ---------------- 配置 ---------------- */

function ensureDefaults() {
  if (!cfg.ui) cfg.ui = {};
  const ui = cfg.ui;
  if (!ui.password) ui.password = randomPassword();
  if (!ui.receiveDir) ui.receiveDir = defaultReceiveDir();
  if (typeof ui.mouseSpeed !== 'number') ui.mouseSpeed = 1;
  if (!ui.inputMode) ui.inputMode = 'separate';
  if (!ui.hotkeyKey) ui.hotkeyKey = 'F12';
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
  try {
    list = IS_MAC ? await detectMac() : IS_WIN ? await detectWin() : [];
  } catch { list = []; }
  if (!list.length) {
    // 检测失败也让界面可用：保留已保存的名字
    list = [{
      id: cfg.ui.monitorId || 'default',
      name: cfg.ui.monitorName || '默认显示器',
      serial: '',
      size: ''
    }];
  }
  monitorsCache = list;
  if (!cfg.ui.monitorId || !list.some((m) => m.id === cfg.ui.monitorId)) {
    cfg.ui.monitorId = list[0].id;
    cfg.ui.monitorName = list[0].name;
    persist();
  }
  pushStatus(`已检测到 ${list.length} 台显示器`, 'ok');
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
 * 执行一次输入源切换。按可用工具依次尝试，成功即返回。
 * 都不可用时返回 simulated，界面如实提示。
 */
async function switchMonitorInput(value, label) {
  if (IS_WIN) {
    const tools = path.join(path.dirname(app.getPath('exe')), 'tools');
    const cmm = path.join(tools, 'ControlMyMonitor.exe');
    if (fs.existsSync(cmm)) {
      const r = await tryExec(cmm, ['/SetValue', 'Primary', '60', value]);
      if (r.ok) return { ok: true, via: 'ControlMyMonitor', label };
    }
    const r2 = await tryExec('ddcutil', ['setvcp', '60', value]);
    if (r2.ok) return { ok: true, via: 'ddcutil', label };
  } else if (IS_MAC) {
    const r1 = await tryExec('m1ddc', ['display', '1', 'set', 'input', String(parseInt(value, 16))]);
    if (r1.ok) return { ok: true, via: 'm1ddc', label };
    const r2 = await tryExec('ddcctl', ['-d', '1', '-i', value]);
    if (r2.ok) return { ok: true, via: 'ddcctl', label };
  }
  return { ok: false, simulated: true, label };
}

/* ---------------- 权限 ---------------- */

function accessibilityGranted() {
  if (!IS_MAC) return true;
  try { return systemPreferences.isTrustedAccessibilityClient(false); } catch { return false; }
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

  return {
    version: app.getVersion(),
    platform: process.platform,
    hostname: os.hostname(),
    isMac: IS_MAC,
    connection: { connected, peers: peersNow, count: peersNow.length },
    computers: {
      local: { name: localName, kind: IS_MAC ? 'mac' : 'win', label: IS_MAC ? 'Mac' : 'Windows', local: true },
      remote: { name: remoteName, kind: remote ? kindOf(remote.platform) : 'pc', label: remote ? (kindOf(remote.platform) === 'mac' ? 'Mac' : kindOf(remote.platform) === 'win' ? 'Windows' : 'PC') : '其它电脑', local: false, connected }
    },
    monitor: {
      list: monitorsCache.length ? monitorsCache : [{ id: cfg.ui.monitorId || 'default', name: cfg.ui.monitorName || '默认显示器', size: '' }],
      selectedId: cfg.ui.monitorId || '',
      selectedName: cfg.ui.monitorName || ''
    },
    inputs: {
      presets: INPUT_PRESETS,
      local: { value: cfg.ui.localInput, label: cfg.ui.localInputLabel },
      remote: { value: cfg.ui.remoteInput, label: cfg.ui.remoteInputLabel }
    },
    hotkey: { enabled: cfg.ui.hotkeyEnabled !== false, key: cfg.ui.hotkeyKey || 'F12' },
    launchAtLogin: (() => { try { return app.getLoginItemSettings().openAtLogin; } catch { return false; } })(),
    clipboard: {
      enabled: !!cfg.clipboardSync,
      usePassword: cfg.ui.usePassword !== false,
      password: cfg.ui.password,
      receiveDir: cfg.ui.receiveDir,
      askLarge: cfg.ui.askLarge !== false,
      progress: clipProgress,
      percent: clipPercent
    },
    inputMode: cfg.ui.inputMode,
    mouseSpeed: cfg.ui.mouseSpeed,
    shareInput: !!cfg.shareInput,
    isHost: !!cfg.isHost,
    permission: { accessibility: accessibilityGranted() },
    active,
    activeTarget,
    statusLines
  };
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

/** peer 发起一次显示器输入源切换时调用：按可用工具尝试并如实回报结果 */
async function onSwitchRequest({ input, label }) {
  const name = label || input;
  const r = await switchMonitorInput(input, name);
  if (r.ok) {
    pushStatus(`已发送切换到 ${name} 的指令 · ${r.via}`, 'ok');
  } else {
    pushStatus(`已记录切换到 ${name} 的指令`, 'ok');
    pushStatus('未找到 DDC 工具，无法真实切换（macOS 需 m1ddc/ddcctl，Windows 需 ddcutil 或 ControlMyMonitor）', 'warn');
  }
}

function onSwitch({ result }) {
  if (result === 'no-input') pushStatus('未配置该机器的接口，请先在「连接与目标」里选择', 'warn');
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
  detectMonitors,
  switchMonitorInput,
  accessibilityGranted,
  openAccessibilitySettings,
  getState,
  onPeers,
  onActive,
  onSwitch,
  onSwitchRequest,
  pushStatus,
  randomPassword,
  defaultReceiveDir,
  setClipProgress,
  setActiveTarget: (t) => { activeTarget = t; },
  INPUT_PRESETS,
  IS_MAC,
  IS_WIN
};
