'use strict';

const { decodeKey, mapModifier, toRobot, MODS } = require('./keymap');

// 原生模块延迟加载：没有编译环境的机器上也能把界面打开
let iohook = null;
let robot = null;

function ensureIoHook() {
  if (!iohook) iohook = require('iohook');
  return iohook;
}

function ensureRobot() {
  if (!robot) {
    robot = require('robotjs');
    // 默认有 10ms 延迟，会让鼠标移动明显发涩
    try { robot.setMouseDelay(0); robot.setKeyboardDelay(0); } catch { /* ignore */ }
  }
  return robot;
}

/* ================= 捕获端（接物理键鼠的那台） ================= */

/* ---- 捕获器在进程内只绑定一次 ----
 * iohook 是全局单例，反复 start/stop 很容易把监听器叠成多份（一次按键发 N 次）。
 * 所以这里绑定一次，启停只改 active 标志。 */
const CAP = {
  opts: null,
  active: false,
  bound: false,
  last: null,       // 上一次的绝对坐标
  anchor: null,     // 屏幕中心（转发时把指针拉回来）
  edgeLockAt: 0     // 边缘触发的冷却时间
};

function capScreen(o) {
  const s = o.getOptions && o.getOptions().screen;
  return s && s.width && s.height ? s : { width: 1920, height: 1080 };
}

function capWarp(x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  try {
    ensureRobot().moveMouse(px, py);
    CAP.last = { x: px, y: py };
  } catch { /* ignore */ }
}

function bindCaptureOnce() {
  if (CAP.bound) return;
  CAP.bound = true;
  const ih = ensureIoHook();
  const on = (name, fn) => { try { ih.on(name, fn); } catch { /* 某些版本没有该事件 */ } };
  // 取当前有效的回调（CAP.opts 会在复用时被替换）
  const O = () => CAP.opts;
  const live = () => CAP.active && !!CAP.opts;
  const forwarding = () => live() && !!CAP.opts.getOptions().forwarding;

  /* ---- 键盘 ---- */
  const handleKey = (up) => (e) => {
    if (!live()) return;
    const o = O();
    if (!up && typeof o.onHotkey === 'function') o.onHotkey(e);
    if (!forwarding()) return;
    const token = decodeKey(e);
    if (!token) return;
    const cfg = o.getOptions();
    const mapped = mapModifier(token, cfg.selfPlatform, cfg.peerPlatform, cfg.modMap);
    if (typeof o.onKey === 'function') o.onKey({ token: mapped, raw: token, up });
    if (cfg.keyDebug && typeof o.onDebug === 'function' && !up) {
      o.onDebug(`按键 keycode=${e.keycode} keychar=${JSON.stringify(e.keychar || '')} → ${token}${mapped !== token ? ` → ${mapped}` : ''}`);
    }
  };
  on('keydown', handleKey(false));
  on('keyup', handleKey(true));

  /* ---- 鼠标 ---- */
  on('mousemove', (e) => {
    if (!live()) return;
    const o = O();
    const cfg = o.getOptions();
    const scr = capScreen(o);
    const x = e.x;
    const y = e.y;
    let dx = 0;
    let dy = 0;
    if (CAP.last) { dx = x - CAP.last.x; dy = y - CAP.last.y; }
    CAP.last = { x, y };

    if (cfg.forwarding) {
      if ((dx || dy) && typeof o.onMove === 'function') o.onMove(dx, dy);
      // 拉回中心，保证继续有位移可用（顶到边缘就再也喂不出 dx 了）
      if (!CAP.anchor) CAP.anchor = { x: scr.width / 2, y: scr.height / 2 };
      if (Math.abs(x - CAP.anchor.x) > 20 || Math.abs(y - CAP.anchor.y) > 20) {
        capWarp(CAP.anchor.x, CAP.anchor.y);
      }
      return;
    }

    // 下面只在「本机正在被操作」时判断边界穿越
    CAP.anchor = null;
    if (!cfg.edgeSwitch) return;
    if (Date.now() < CAP.edgeLockAt) return;

    // 设备按「从左到右」排列，所以只需要看左右两个边缘
    let side = '';
    if (x >= scr.width - 2 && dx > 0) side = 'right';
    else if (x <= 1 && dx < 0) side = 'left';
    if (!side) return;

    CAP.edgeLockAt = Date.now() + 1200;
    if (typeof o.onEdge === 'function') {
      o.onEdge({
        side,
        nx: Math.max(0, Math.min(1, x / Math.max(1, scr.width))),
        ny: Math.max(0, Math.min(1, y / Math.max(1, scr.height)))
      });
    }
  });

  const btnName = (b) => (b === 2 ? 'right' : b === 3 ? 'middle' : 'left');
  on('mousedown', (e) => {
    if (!forwarding()) return;
    const o = O();
    if (typeof o.onButton === 'function') o.onButton(btnName(e.button), true);
  });
  on('mouseup', (e) => {
    if (!forwarding()) return;
    const o = O();
    if (typeof o.onButton === 'function') o.onButton(btnName(e.button), false);
  });

  const wheel = (e) => {
    if (!forwarding()) return;
    const step = (e.amount && e.amount > 1 ? e.amount : 1) * (e.rotation < 0 ? -1 : 1);
    const horizontal = e.direction === 4;
    const o = O();
    if (typeof o.onWheel === 'function') o.onWheel(horizontal ? step : 0, horizontal ? 0 : step);
  };
  on('wheel', wheel);
  on('mousewheel', wheel); // 老版本事件名

  // iohook 的 start 参数是「是否用 rawcode」，不是抑制本地输入
  ih.start(false);
}

/**
 * 开始（或更新）捕获。重复调用只是替换回调，不会重复绑定。
 * @param {object} opts 见 bindCaptureOnce 里的用法
 * @returns {{stop:()=>void}}
 */
function createCapture(opts) {
  ensureIoHook();
  CAP.opts = Object.assign({ getOptions: () => ({}) }, opts || {});
  CAP.active = true;
  CAP.last = null;
  CAP.anchor = null;
  CAP.edgeLockAt = 0;
  bindCaptureOnce();
  return {
    stop() {
      CAP.active = false;
      CAP.last = null;
      CAP.anchor = null;
    }
  };
}

/* ================= 注入端（被控制的那台） ================= */

/**
 * 把收到的事件注入本机。
 *
 * 注入是绝对坐标（robotjs 只能绝对定位），所以这里自己维护一个虚拟指针，
 * 收到相对位移后累加再注入。这样两台分辨率、缩放不同也能保持一致手感。
 */
function createInjector() {
  let cursor = null;
  let dim = null;
  let dimAt = 0;
  const pressed = new Set();

  function size() {
    const now = Date.now();
    if (dim && now - dimAt < 5000) return dim;
    try {
      const s = ensureRobot().getScreenSize();
      if (s && s.width) {
        dim = { width: s.width, height: s.height };
        dimAt = now;
        return dim;
      }
    } catch { /* ignore */ }
    return { width: 1920, height: 1080 };
  }

  function ensure() {
    if (!cursor) {
      const s = size();
      cursor = { x: Math.round(s.width / 2), y: Math.round(s.height / 2) };
    }
    return cursor;
  }

  function clamp() {
    const s = size();
    cursor.x = Math.max(0, Math.min(s.width - 1, cursor.x));
    cursor.y = Math.max(0, Math.min(s.height - 1, cursor.y));
  }

  function place(edge, nx, ny) {
    const s = size();
    const c = ensure();
    // 从本机右侧穿出去 → 落在对端的左侧，反之亦然
    if (edge === 'right') c.x = 1;
    else if (edge === 'left') c.x = s.width - 2;
    else if (edge === 'bottom') c.y = 1;
    else if (edge === 'top') c.y = s.height - 2;

    if ((edge === 'right' || edge === 'left') && typeof ny === 'number') {
      c.y = Math.round(ny * s.height);
    }
    if ((edge === 'top' || edge === 'bottom') && typeof nx === 'number') {
      c.x = Math.round(nx * s.width);
    }
    clamp();
    try { ensureRobot().moveMouse(c.x, c.y); } catch { /* ignore */ }
  }

  function move(dx, dy) {
    const c = ensure();
    c.x += Number(dx) || 0;
    c.y += Number(dy) || 0;
    clamp();
    try { ensureRobot().moveMouse(c.x, c.y); } catch { /* ignore */ }
  }

  function wheel(dx, dy) {
    try { ensureRobot().scroll(Math.round(dx) || 0, Math.round(dy) || 0); } catch { /* ignore */ }
  }

  function key(token, up) {
    const name = toRobot(token);
    if (!name) return;
    try { ensureRobot().keyToggle(name, up ? 'up' : 'down'); } catch { /* ignore */ }
    if (MODS.has(token)) {
      if (up) pressed.delete(token); else pressed.add(token);
    }
  }

  function button(btn, down) {
    const b = btn === 'right' ? 'right' : btn === 'middle' ? 'middle' : 'left';
    try { ensureRobot().mouseToggle(down ? 'down' : 'up', b); } catch { /* ignore */ }
  }

  /** 释放所有还按着的修饰键，避免切换后卡住 Shift / ⌘ */
  function releaseAll() {
    for (const m of pressed) {
      try { ensureRobot().keyToggle(toRobot(m), 'up'); } catch { /* ignore */ }
    }
    pressed.clear();
  }

  return { place, move, wheel, key, button, releaseAll, getCursor: () => cursor };
}

/** 把本机指针挪到指定位置（切回本机时落在边缘用） */
function moveLocalCursor(x, y) {
  try { ensureRobot().moveMouse(Math.max(0, Math.round(x)), Math.max(0, Math.round(y))); } catch { /* ignore */ }
}

/** 本机屏幕尺寸（与 iohook 坐标系一致）。缓存 5 秒，避免每次鼠标事件都问系统 */
let screenCache = null;
let screenCacheAt = 0;
function localScreenSize() {
  const now = Date.now();
  if (screenCache && now - screenCacheAt < 5000) return screenCache;
  try {
    const s = ensureRobot().getScreenSize();
    if (s && s.width) {
      screenCache = { width: s.width, height: s.height };
      screenCacheAt = now;
      return screenCache;
    }
  } catch { /* ignore */ }
  return { width: 1920, height: 1080 };
}

module.exports = {
  createCapture,
  createInjector,
  moveLocalCursor,
  localScreenSize,
  ensureIoHook,
  ensureRobot
};
