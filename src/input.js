'use strict';

// 延迟 require 原生模块，避免在没有编译环境的机器上加载即报错。
let iohook = null;
let robot = null;

function ensureIoHook() {
  if (!iohook) iohook = require('iohook');
  return iohook;
}
function ensureRobot() {
  if (!robot) robot = require('robotjs');
  return robot;
}

/**
 * iohook keycode -> robotjs 键名 的映射（常用键，特殊键需真机校准）。
 * iohook 字母键 keycode 与 ASCII 大写一致（A=65），数字同理。
 */
const IOHOOK_TO_ROBOT = {
  192: '`', 189: '-', 187: '=', 8: 'backspace', 9: 'tab', 13: 'enter',
  27: 'escape', 32: 'space', 46: 'delete', 36: 'home', 35: 'end',
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 33: 'pageup', 34: 'pagedown',
  20: 'capslock', 112: 'f1', 113: 'f2', 114: 'f3', 115: 'f4', 116: 'f5',
  117: 'f6', 118: 'f7', 119: 'f8', 120: 'f9', 121: 'f10', 122: 'f11', 123: 'f12',
  // 修饰键
  160: 'shift', 161: 'shift', 162: 'control', 163: 'control', 164: 'alt', 165: 'alt',
  91: 'meta', 92: 'meta'
};

function keycodeToRobotName(keycode) {
  if (IOHOOK_TO_ROBOT[keycode]) return IOHOOK_TO_ROBOT[keycode];
  if (keycode >= 65 && keycode <= 90) return String.fromCharCode(keycode).toLowerCase();
  if (keycode >= 48 && keycode <= 57) return String.fromCharCode(keycode);
  return null; // 未知键，转发层会跳过
}

/**
 * 主机：捕获本地键鼠事件，通过 onEvent 回调转发出去。
 * 当 active=true 时才真正捕获（即当前控制的是对端）。
 */
function startCapture({ onEvent, isActive }) {
  const ih = ensureIoHook();
  const handle = (type, map) => (e) => {
    if (!isActive()) return;
    onEvent(Object.assign({ kind: type }, map ? map(e) : e));
  };

  ih.on('keydown', handle('key', (e) => ({ keycode: e.keycode, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey })));
  ih.on('keyup', handle('key', (e) => ({ keycode: e.keycode, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, up: true })));
  ih.on('mousemove', handle('move', (e) => ({ x: e.x, y: e.y })));
  ih.on('mousedown', handle('mouse', (e) => ({ button: e.button, down: true })));
  ih.on('mouseup', handle('mouse', (e) => ({ button: e.button, up: true })));
  // 捕获快捷键：在 keydown 里判断
  ih.on('keydown', (e) => { if (onEvent._hotkey) onEvent._hotkey(e); });

  ih.start(false); // false = 不禁用本地输入（主机自身还要用）
  return ih;
}

/**
 * 客户端：把收到的事件注入到本机。
 */
function injectEvent(ev) {
  const r = ensureRobot();
  if (ev.kind === 'key') {
    const name = keycodeToRobotName(ev.keycode);
    if (!name) return;
    const down = !ev.up;
    try { r.keyToggle(name, down ? 'down' : 'up'); } catch (e) { /* 忽略无效键 */ }
  } else if (ev.kind === 'move') {
    try { r.moveMouse(ev.x, ev.y); } catch {}
  } else if (ev.kind === 'mouse') {
    const btn = ev.button === 2 ? 'right' : ev.button === 3 ? 'middle' : 'left';
    try { r.mouseToggle(ev.down ? 'down' : 'up', btn); } catch {}
  }
}

module.exports = { startCapture, injectEvent, keycodeToRobotName, ensureIoHook, ensureRobot };
