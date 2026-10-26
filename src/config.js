'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.switchscreen');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// 默认配置。switchHotkey 用 iohook 的 keycode（仅非 GUI 场景用到）。
const DEFAULTS = {
  peerName: os.hostname(),
  port: 47748,
  discover: true,
  shareInput: true,        // 共用键鼠总开关
  clipboardSync: true,     // 剪贴板同步开关
  isHost: true,            // 本机是否接物理键鼠（捕获端）
  switchHotkey: { keycode: 192, ctrl: true, alt: true, shift: false, meta: false },
  // 显示器输入源切换命令（旧版命令行兜底，GUI 走内置 DDC）
  monitor: {
    command: {
      linux: 'ddcutil setvcp 60 {input}',
      win32: 'ddcutil setvcp 60 {input}',
      darwin: 'ddcctl -d 1 -i {input}'
    }
  },
  // 本机对应的显示器输入源值（默认值，逐显示器的配置见 ui.portMap）
  selfInput: '0x11',
  // 对端名 -> 显示器输入源值（旧字段，保留兼容）
  peers: {},
  // 界面层配置（GUI 使用）
  ui: {
    activeTab: 'switch',      // switch | share | input
    // 本机显示名：可以随便改，会同步给其它设备显示（网络标识仍用 peerName）
    displayName: '',
    hotkeyEnabled: true,
    // 快捷键：global = 全局切换（切到下一台）；monitor = 每块显示器各自一个
    // { global: 'F12', monitor: { 'ddc:0': 'CommandOrControl+Alt+1' } }
    hotkeyKey: 'F12',         // 兼容旧字段，等同于 hotkeys.global
    hotkeys: { global: 'F12', monitor: {} },
    launchAtLogin: false,
    inputMode: 'separate',    // separate 各用各的 | local 共用本机键鼠 | remote 共用对端键鼠
    mouseSpeed: 1,            // 0.5 ~ 2（相对位移的缩放系数）
    monitorId: '',
    monitorName: '',
    localInput: '0x11',
    localInputLabel: 'HDMI1',
    remoteInput: '0x12',
    remoteInputLabel: 'HDMI2',
    receiveDir: '',           // 空则用 ~/Desktop/SwitchScreen/clipboard/received
    askLarge: true,
    // 每块显示器上，每台电脑各自接哪个口：{ 'ddc:0': { 'PC-A': '0x11', 'PC-B': '0x12' } }
    portMap: {},
    perMonitor: {},           // 旧字段，首次启动自动迁移到 portMap
    autoAccept: false,        // true = 不需要确认直接接收文件（默认需手动确认）
    targetPeer: '',           // 上次选中的接收对象（兼容旧字段）
    targetPeers: [],          // 传输对象（可多选）
    // ---- 共用键鼠 / 无缝移动 ----
    edgeSwitch: true,         // 鼠标推到屏幕边缘就换电脑
    arrange: [],              // 设备排列顺序（deviceId 数组，含本机）；数组下标 = 从左到右的位置
    edgeSide: 'right',        // 旧字段，保留兼容（排列模型已取代它）
    modMap: 'cmd-ctrl',       // 修饰键映射：cmd-ctrl（推荐）| swap | off
    keyDebug: false           // 打开后在状态栏打印原始键码，排查按键问题用
  }
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
  const user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return deepMerge(DEFAULTS, user);
}

function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function setPeerInput(peerName, inputValue) {
  const cfg = loadConfig();
  cfg.peers[peerName] = inputValue;
  saveConfig(cfg);
  return cfg;
}

module.exports = { loadConfig, saveConfig, setPeerInput, CONFIG_PATH, DEFAULTS };
