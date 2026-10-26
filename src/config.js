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
