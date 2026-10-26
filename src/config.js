'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.switchscreen');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// 默认配置。switchHotkey 用 iohook 的 keycode。
// 默认：Ctrl + Alt + ` (keycode 192) 作为「切到下一台」快捷键。
const DEFAULTS = {
  peerName: os.hostname(),
  port: 47748,
  discover: true,
  shareInput: true,        // 共用键鼠总开关
  clipboardSync: true,     // 剪贴板同步开关
  isHost: true,            // 本机是否接物理键鼠（捕获端）
  switchHotkey: { keycode: 192, ctrl: true, alt: true, shift: false, meta: false },
  // 显示器输入源切换命令（按平台）。{input} 会被替换成目标机的输入源值。
  // 例：Linux/Win 用 ddcutil，macOS 用 ddcctl。
  monitor: {
    command: {
      linux: 'ddcutil setvcp 60 {input}',
      win32: 'ddcutil setvcp 60 {input}',
      darwin: 'ddcctl -d 1 -i {input}'
    }
  },
  // 本机对应的显示器输入源值（切回本机时用）。例 "0x11"
  selfInput: '0x11',
  // 对端名 -> 显示器输入源值。切换时用目标机的 input 填到 monitor.command。
  peers: {
    // "MacBook-Pro": "0x12"
  },
  // 界面层配置（GUI 使用）
  ui: {
    activeTab: 'switch',      // switch | share | input
    hotkeyEnabled: true,
    hotkeyKey: 'F12',         // 界面里展示的快捷键名，实际生效见 switchHotkey
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
    // 每台显示器各自的接口：{ "ddc:0": { local: "0x11", remote: "0x12" } }
    // 未配置时回退到上面的 localInput / remoteInput
    perMonitor: {},
    autoAccept: false,        // true = 不需要确认直接接收文件（默认需手动确认）
    targetPeer: '',           // 上次选中的接收对象
    // ---- 共用键鼠 ----
    edgeSwitch: true,         // 鼠标推到屏幕边缘就切到另一台
    edgeSide: 'right',        // 另一台电脑在本机的哪一侧：right | left | top | bottom
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
