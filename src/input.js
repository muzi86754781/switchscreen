'use strict';

const { decodeKey, mapModifier, toRobot, MODS } = require('./keymap');

// 原生模块延迟加载：没有编译环境的机器上也能把界面打开
//
// 捕获层用 uiohook-napi（libuiohook 的 N-API 封装），不用 iohook：
// iohook 0.9.x 的二进制是按「Node ABI + Electron 版本」下载的预编译包，
// 没有 Electron 31(ABI 125) 的版本，且包里根本没有 binding.gyp，无法本地编译，
// 打包后必然报 Cannot find module .../iohook.node。
// uiohook-napi 是 N-API（ABI 稳定）且把预编译 .node 直接放在 npm 包里，
// Electron 升级也不用重编，换机器也不会缺文件。
let hook = null;
let robot = null;

function ensureIoHook() {
  if (!hook) {
    const mod = require('uiohook-napi');
    hook = mod.uIOhook || mod;
    if (hook && typeof hook.start !== 'function') {
      throw new Error('uiohook-napi 结构异常（缺少 start）');
    }
  }
  return hook;
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

/* ---- 桌面实际范围（多显示器必须知道，否则边缘判断全错） ----
 * robotjs 的 getScreenSize() 只给主屏尺寸，而 libuiohook 报的是整个虚拟桌面的坐标。
 * 主机接了两块屏时，鼠标在副屏上「x 超过主屏宽度」就会被误判成顶到右边缘，
 * 于是不停往对端跳。这里由主进程用 Electron 的 screen 模块算好真实范围塞进来。 */
const SCREEN = { rects: [], bounds: null };

function setScreenRect(list) {
  const rects = (Array.isArray(list) ? list : [])
    .filter((r) => r && r.width > 0 && r.height > 0)
    .map((r) => ({
      x: Math.round(r.x) || 0,
      y: Math.round(r.y) || 0,
      width: Math.round(r.width),
      height: Math.round(r.height)
    }));
  SCREEN.rects = rects;
  if (!rects.length) { SCREEN.bounds = null; return; }
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  SCREEN.bounds = { x: left, y: top, width: right - left, height: bottom - top };
}

/** 指针当前所在的屏幕（拿不到就退化成整块桌面） */
function rectAt(x, y) {
  for (const r of SCREEN.rects) {
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return r;
  }
  return SCREEN.bounds;
}

/* ---- 捕获器在进程内只绑定一次 ----
 * libuiohook 是全局单例，反复 start/stop 很容易把监听器叠成多份（一次按键发 N 次）。
 * 所以这里监听器只挂一次、hook 只启动一次，启停只改 active 标志。
 * 注意 bound / running 必须分开记：模块缺失或权限不足时 bound 不能置真，
 * 否则修好之后再也不会重试（这也是上一版「键鼠永远起不来」的原因之一）。 */
const CAP = {
  opts: null,
  active: false,
  bound: false,     // 监听器是否已挂上
  running: false,   // hook 是否真的在跑
  last: null,       // 上一次的绝对坐标
  anchor: null,     // 屏幕中心（转发时把指针拉回来）
  edgeLockAt: 0,    // 边缘触发的冷却时间
  warping: false,   // 是否正在回拉指针
  warpTarget: null  // 回拉的目标坐标 {x, y, at}
};

function capScreen(o) {
  // 优先用主进程给的真实桌面范围（x/y 可能为负，副屏在主屏左侧时就是这样）
  if (SCREEN.bounds) return SCREEN.bounds;
  const s = o && o.getOptions && o.getOptions().screen;
  if (s && s.width && s.height) return { x: 0, y: 0, width: s.width, height: s.height };
  return { x: 0, y: 0, width: 1920, height: 1080 };
}

function capWarp(x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  CAP.warping = true;
  CAP.warpTarget = { x: px, y: py, at: Date.now() };
  try {
    ensureRobot().moveMouse(px, py);
    CAP.last = { x: px, y: py };
  } catch { /* ignore */ }
}

function bindCaptureOnce() {
  if (CAP.bound) return;
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
      o.onDebug(`按键 keycode=${e.keycode} → ${token}${mapped !== token ? ` → ${mapped}` : ''}`);
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

    // 过滤 capWarp 回拉时 OS 触发的合成 mousemove 事件，避免反向跳变导致远端指针剧烈抖动 / 漂移
    if (CAP.warping && CAP.warpTarget) {
      const wt = CAP.warpTarget;
      const isTarget = Math.abs(x - wt.x) <= 3 && Math.abs(y - wt.y) <= 3;
      const isRecent = (Date.now() - wt.at) < 70;
      if (isTarget || isRecent) {
        CAP.last = { x, y };
        if (isTarget) {
          CAP.warping = false;
          CAP.warpTarget = null;
        }
        return;
      }
      CAP.warping = false;
      CAP.warpTarget = null;
    }

    let dx = 0;
    let dy = 0;
    if (CAP.last) { dx = x - CAP.last.x; dy = y - CAP.last.y; }
    CAP.last = { x, y };

    if (cfg.forwarding) {
      if ((dx || dy) && typeof o.onMove === 'function') o.onMove(dx, dy);
      // 拉回「指针所在那块屏」的中心，保证继续有位移可用（顶到边缘就再也喂不出 dx 了）
      if (!CAP.anchor) {
        const r = rectAt(x, y) || scr;
        CAP.anchor = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
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
    const leftEdge = scr.x;
    const rightEdge = scr.x + scr.width;
    let side = '';
    if (x >= rightEdge - 2 && dx > 0) side = 'right';
    else if (x <= leftEdge + 1 && dx < 0) side = 'left';
    if (!side) return;

    CAP.edgeLockAt = Date.now() + 1200;
    if (typeof o.onEdge === 'function') {
      o.onEdge({
        side,
        nx: Math.max(0, Math.min(1, (x - scr.x) / Math.max(1, scr.width))),
        ny: Math.max(0, Math.min(1, (y - scr.y) / Math.max(1, scr.height)))
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
    const n = Number(e.clicks) || Number(e.amount) || 1;
    const step = (n > 1 ? n : 1) * (Number(e.rotation) < 0 ? -1 : 1);
    const horizontal = Number(e.direction) === 4;
    const o = O();
    if (typeof o.onWheel === 'function') o.onWheel(horizontal ? step : 0, horizontal ? 0 : step);
  };
  on('wheel', wheel);
  on('mousewheel', wheel); // 老版本事件名

  CAP.bound = true;
}

/**
 * 真正启动 libuiohook。失败时抛出可读原因（macOS 未授权辅助功能就是这样）。
 * 允许重复调用：上次失败（比如用户刚补上权限）后还能再试。
 */
function startHook() {
  if (CAP.running) return;
  const ih = ensureIoHook();
  try {
    ih.start();
    CAP.running = true;
  } catch (e) {
    CAP.running = false;
    const msg = String((e && e.message) || e || '');
    if (/AXAPI|Accessibility|辅助功能|CREATE_EVENT_PORT|event port|event tap/i.test(msg)) {
      throw new Error('需要系统权限：请在「系统设置 → 隐私与安全性」中同时开启「辅助功能」与「输入监控」；若已勾选仍提示未启动，请先取消勾选再重新勾选（或点 - 号移除后重新添加），然后点击重试或重启应用');
    }
    throw new Error(`键鼠捕获未启动：${msg}`);
  }
}

/**
 * 开始（或更新）捕获。重复调用只是替换回调，不会重复绑定。
 * @param {object} opts 见 bindCaptureOnce 里的用法
 * @returns {{stop:()=>void}}
 */
function createCapture(opts) {
  CAP.opts = Object.assign({ getOptions: () => ({}) }, opts || {});
  bindCaptureOnce();  // 原生模块缺失时在这里抛，界面能显示真正的原因
  startHook();        // 需要辅助功能权限时在这里抛
  CAP.active = true;
  CAP.last = null;
  CAP.anchor = null;
  CAP.edgeLockAt = 0;
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
  let forced = null;             // 对端上报的桌面尺寸（多显示器时比主屏大）
  const pressed = new Set();

  function size() {
    if (SCREEN.bounds && SCREEN.bounds.width > 0 && SCREEN.bounds.height > 0) {
      return SCREEN.bounds;
    }
    if (forced) return forced;
    const now = Date.now();
    if (dim && now - dimAt < 5000) return dim;
    try {
      const s = ensureRobot().getScreenSize();
      if (s && s.width) {
        dim = { x: 0, y: 0, width: s.width, height: s.height };
        dimAt = now;
        return dim;
      }
    } catch { /* ignore */ }
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }

  /** 对端连上时告诉我们的桌面尺寸，注入时按它算范围 */
  function setScreen(s) {
    if (!s || !s.width || !s.height) return;
    const next = { x: Math.round(s.x || 0), y: Math.round(s.y || 0), width: Math.round(s.width), height: Math.round(s.height) };
    if (forced && forced.x === next.x && forced.y === next.y && forced.width === next.width && forced.height === next.height) return;
    forced = next;
    if (cursor) clamp();
  }

  function ensure() {
    if (!cursor) {
      const s = size();
      const minX = s.x || 0;
      const minY = s.y || 0;
      cursor = { x: Math.round(minX + s.width / 2), y: Math.round(minY + s.height / 2) };
    }
    return cursor;
  }

  function clamp() {
    const s = size();
    const minX = s.x || 0;
    const minY = s.y || 0;
    const maxX = minX + s.width - 1;
    const maxY = minY + s.height - 1;
    cursor.x = Math.max(minX, Math.min(maxX, cursor.x));
    cursor.y = Math.max(minY, Math.min(maxY, cursor.y));
  }

  function place(edge, nx, ny) {
    const s = size();
    const c = ensure();
    const minX = s.x || 0;
    const minY = s.y || 0;
    if (edge === 'center') {
      c.x = Math.round(minX + (typeof nx === 'number' ? nx : 0.5) * s.width);
      c.y = Math.round(minY + (typeof ny === 'number' ? ny : 0.5) * s.height);
    } else if (edge === 'right') {
      c.x = minX + 12;
    } else if (edge === 'left') {
      c.x = Math.max(minX + 12, minX + s.width - 14);
    } else if (edge === 'bottom') {
      c.y = minY + 12;
    } else if (edge === 'top') {
      c.y = Math.max(minY + 12, minY + s.height - 14);
    }

    if ((edge === 'right' || edge === 'left') && typeof ny === 'number') {
      c.y = Math.round(minY + ny * s.height);
    }
    if ((edge === 'top' || edge === 'bottom') && typeof nx === 'number') {
      c.x = Math.round(minX + nx * s.width);
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
    // 强制再释放所有基础修饰键，防止任何漏网粘滞
    for (const mod of ['control', 'alt', 'shift', 'command']) {
      try { ensureRobot().keyToggle(mod, 'up'); } catch { /* ignore */ }
    }
  }

  return { place, move, wheel, key, button, releaseAll, setScreen, getCursor: () => cursor };
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
  // 多显示器时用整块桌面的尺寸，对端的虚拟指针才够长
  if (SCREEN.bounds) {
    screenCache = { width: SCREEN.bounds.width, height: SCREEN.bounds.height };
    screenCacheAt = now;
    return screenCache;
  }
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
  setScreenRect,
  ensureIoHook,
  ensureRobot
};
