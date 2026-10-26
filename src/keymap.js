'use strict';

/**
 * 键位翻译层。
 *
 * 目标：在 Mac 与 Windows 之间转发按键时，让「语义」正确，而不只是「键码」正确。
 *
 * 两个必须解决的问题：
 *
 * 1) 键码约定不统一。捕获层（iohook / libuiohook）在理想情况下给的是跨平台的
 *    VC_* 虚拟键码（A=0x1E，F12=0x58）；但个别版本/平台会退化成 ASCII 或
 *    Windows VK 码（A=65，F12=123）。这里以 event.keychar 优先识别可打印字符，
 *    只有功能键才查表，从而绕开两套约定在 46/48/57 等码位上的冲突。
 *
 * 2) 主修饰键不同。macOS 的快捷键主键是 ⌘(Command)，Windows 是 Ctrl。
 *    如果只按码转发，在 Mac 上按 ⌘C 到了 Windows 会变成「Win+C」（打开搜索），
 *    用户会认为「快捷键全都坏了」。这里做语义映射（见 mapModifier）。
 */

/* ---------------- token 定义 ---------------- */

// 修饰键 token，避免拼错
const MODS = new Set(['meta', 'control', 'alt', 'shift']);

/**
 * 特殊键 token -> robotjs 键名。
 * token 刻意与 robotjs 键名同名，只有 meta 需要转成 'command'
 * （robotjs 在 Windows 上把 command 映射为 VK_LWIN，正是我们要的 Win 键）。
 */
const SPECIAL = {
  escape: 'escape',
  tab: 'tab',
  capslock: 'capslock',
  space: 'space',
  enter: 'enter',
  backspace: 'backspace',
  delete: 'delete',
  insert: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  printscreen: 'printscreen',
  menu: 'menu',
  shift: 'shift',
  control: 'control',
  alt: 'alt',
  meta: 'command'
};
for (let i = 0; i <= 9; i += 1) SPECIAL[`numpad_${i}`] = `numpad_${i}`;
SPECIAL['numpad_+'] = 'numpad_+';
SPECIAL['numpad_-'] = 'numpad_-';
SPECIAL['numpad_*'] = 'numpad_*';
SPECIAL['numpad_/'] = 'numpad_/';
SPECIAL['numpad_.'] = 'numpad_.';
SPECIAL.numpad_lock = 'numpad_lock';
for (let i = 1; i <= 12; i += 1) SPECIAL[`f${i}`] = `f${i}`;

/**
 * libuiohook 的 VC_* 虚拟键码（iohook 的标准约定，跨平台一致）。
 * 刻意不含小键盘：小键盘与方向键在 uiohook 里码位重叠，误判代价高于收益。
 */
const VC = {
  0x0001: 'escape',
  0x003b: 'f1', 0x003c: 'f2', 0x003d: 'f3', 0x003e: 'f4',
  0x003f: 'f5', 0x0040: 'f6', 0x0041: 'f7', 0x0042: 'f8',
  0x0043: 'f9', 0x0044: 'f10', 0x0057: 'f11', 0x0058: 'f12',

  0x0029: '`',
  0x0002: '1', 0x0003: '2', 0x0004: '3', 0x0005: '4', 0x0006: '5',
  0x0007: '6', 0x0008: '7', 0x0009: '8', 0x000a: '9', 0x000b: '0',
  0x000c: '-', 0x000d: '=',
  0x000e: 'backspace', 0x000f: 'tab',

  0x0010: 'q', 0x0011: 'w', 0x0012: 'e', 0x0013: 'r', 0x0014: 't',
  0x0015: 'y', 0x0016: 'u', 0x0017: 'i', 0x0018: 'o', 0x0019: 'p',
  0x001a: '[', 0x001b: ']',
  0x001c: 'enter',
  0x001d: 'control',
  0x001e: 'a', 0x001f: 's', 0x0020: 'd', 0x0021: 'f', 0x0022: 'g',
  0x0023: 'h', 0x0024: 'j', 0x0025: 'k', 0x0026: 'l',
  0x0027: ';', 0x0028: "'",
  0x002a: 'shift',
  0x002b: '\\',
  0x002c: 'z', 0x002d: 'x', 0x002e: 'c', 0x002f: 'v',
  0x0030: 'b', 0x0031: 'n', 0x0032: 'm',
  0x0033: ',', 0x0034: '.', 0x0035: '/',
  0x0036: 'shift',
  0x0038: 'alt',
  0x0039: 'space',
  0x003a: 'capslock',

  0x0e1d: 'control', 0x0e38: 'alt', 0x0e5b: 'meta', 0x0e5c: 'meta',
  0x0e47: 'home', 0x0e4f: 'end', 0x0e49: 'pageup', 0x0e51: 'pagedown',
  0x0e48: 'up', 0x0e4b: 'left', 0x0e4d: 'right', 0x0e50: 'down',
  0x0e52: 'insert', 0x0e53: 'delete', 0x0e37: 'printscreen',
  0x0e5d: 'menu',

  // uiohook-napi 扩展键别名（部分平台 / 驱动下高位为 0xE000 格式）
  0xe01d: 'control', 0xe038: 'alt', 0xe05b: 'meta', 0xe05c: 'meta',
  0xe047: 'home', 0xe04f: 'end', 0xe049: 'pageup', 0xe051: 'pagedown',
  0xe048: 'up', 0xe04b: 'left', 0xe04d: 'right', 0xe050: 'down',
  0xe052: 'insert', 0xe053: 'delete', 0xe037: 'printscreen',
  0xe05d: 'menu', 0xe01c: 'enter',

  // 小键盘：必须显式列出，否则会落进下面的 ASCII 兜底
  // （0x004C 是 76 → 被当成字母 L，按小键盘 5 就打出一个 l）
  0x0045: 'numpad_lock', 0x0046: 'scrolllock',
  0x0037: 'numpad_*', 0x004a: 'numpad_-', 0x004e: 'numpad_+',
  0x0053: 'numpad_.', 0x0e35: 'numpad_/', 0xe035: 'numpad_/',
  0x004f: 'numpad_1', 0x0050: 'numpad_2', 0x0051: 'numpad_3',
  0x004b: 'numpad_4', 0x004c: 'numpad_5', 0x004d: 'numpad_6',
  0x0047: 'numpad_7', 0x0048: 'numpad_8', 0x0049: 'numpad_9',
  0x0052: 'numpad_0', 0x0e1c: 'enter',
  // uiohook 扩展小键盘光标键
  0xee4f: 'numpad_1', 0xee50: 'numpad_2', 0xee51: 'numpad_3',
  0xee4b: 'numpad_4', 0xee4d: 'numpad_6',
  0xee47: 'numpad_7', 0xee48: 'numpad_8', 0xee49: 'numpad_9',
  0xee52: 'numpad_0', 0xee53: 'numpad_.'
};

/**
 * Windows VK / ASCII 码兜底（只在 keychar 拿不到字符、且 VC 表也没有时才用）。
 * 字母与数字故意不列：它们一定能被 keychar 覆盖，列进来反而会和 VC 表打架。
 */
const VK = {
  8: 'backspace', 9: 'tab', 13: 'enter', 27: 'escape', 32: 'space',
  45: 'insert', 46: 'delete', 36: 'home', 35: 'end',
  33: 'pageup', 34: 'pagedown',
  37: 'left', 38: 'up', 39: 'right', 40: 'down',
  20: 'capslock',
  112: 'f1', 113: 'f2', 114: 'f3', 115: 'f4', 116: 'f5', 117: 'f6',
  118: 'f7', 119: 'f8', 120: 'f9', 121: 'f10', 122: 'f11', 123: 'f12',
  160: 'shift', 161: 'shift', 162: 'control', 163: 'control',
  164: 'alt', 165: 'alt', 91: 'meta', 92: 'meta',
  186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/',
  192: '`', 219: '[', 220: '\\', 221: ']', 222: "'"
};

/** Windows VK 码里可能出现的可打印字符（Shift 未按下时的语义） */
const VK_CHAR = {
  186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/',
  192: '`', 219: '[', 220: '\\', 221: ']', 222: "'"
};

/* ---------------- 解码 ---------------- */

/**
 * 把捕获到的原始事件翻译成 token。
 * @param {{keycode:number, keychar?:string, rawcode?:number}} e
 * @returns {string|null} token，无法识别时返回 null
 */
function decodeKey(e) {
  if (!e) return null;

  // 1) 可打印字符优先：绕开键码约定差异，并且天然处理了键盘布局
  const ch = e.keychar;
  if (typeof ch === 'string' && ch.length === 1) {
    const code = ch.charCodeAt(0);
    // 32..126 是可打印 ASCII；控制字符（\u0001 等）交给下面的表
    if (code >= 32 && code <= 126) return ch.toLowerCase();
  }

  const kc = Number(e.keycode);
  if (!Number.isFinite(kc)) return null;

  // 2) VC 表（标准约定）
  if (VC[kc]) return VC[kc];
  // 3) VK / ASCII 兜底
  if (VK[kc]) return VK[kc];
  if (kc >= 65 && kc <= 90) return String.fromCharCode(kc).toLowerCase();
  if (kc >= 48 && kc <= 57) return String.fromCharCode(kc);
  if (kc >= 96 && kc <= 105) return String(kc - 96); // 小键盘数字（部分实现）
  return null;
}

/* ---------------- 修饰键语义映射 ---------------- */

const MAP_MODES = ['cmd-ctrl', 'swap', 'off'];

function isMac(p) {
  return p === 'darwin';
}

/**
 * 把一个修饰键 token 翻译成目标平台上「语义等价」的修饰键。
 *
 * mode:
 *   'cmd-ctrl'（默认）Mac 的 ⌘ 与 ⌃ 都发成 Windows 的 Ctrl；
 *                     Windows 的 Ctrl 与 Win 都发成 Mac 的 ⌘。
 *                     最直观：⌘C → Ctrl+C，Ctrl+C → ⌘C。
 *   'swap'            ⌘ 与 Ctrl 严格互换（⌃C 会变成 Win+C，很少用）。
 *   'off'             原样转发（两端都是同一种系统时才合理）。
 */
function mapModifier(token, from, to, mode) {
  if (!MODS.has(token) || mode === 'off' || !from || from === to) return token;
  const macToOther = isMac(from) && !isMac(to);
  const otherToMac = !isMac(from) && isMac(to);

  if (mode === 'swap') {
    if (token === 'meta') return 'control';
    if (token === 'control') return 'meta';
    return token;
  }

  // cmd-ctrl：两个主修饰键在对方系统上都变成对方的主修饰键
  if (macToOther) {
    if (token === 'meta' || token === 'control') return 'control';
    return token;
  }
  if (otherToMac) {
    if (token === 'control' || token === 'meta') return 'meta';
    return token;
  }
  return token;
}

/** token -> robotjs 键名 */
function toRobot(token) {
  if (!token) return null;
  if (SPECIAL[token]) return SPECIAL[token];
  if (token.length === 1) return token; // 单字符直接交给 robotjs
  return null;
}

/** 给界面用的说明文案 */
function describeModMap(mode, from, to) {
  if (!from || from === to) return '两端系统相同，按键原样转发。';
  const macToOther = isMac(from) && !isMac(to);
  const winName = isMac(from) ? 'Windows' : 'Mac';
  if (mode === 'off') {
    return `不映射：在${isMac(from) ? 'Mac' : 'Windows'} 上按 ⌘/Ctrl 会原样发给 ${winName}。`;
  }
  if (mode === 'swap') {
    return macToOther
      ? '⌘ 与 Ctrl 严格互换：⌘C → Ctrl+C，⌃C → Win+C。'
      : 'Ctrl 与 Win 键严格互换：Ctrl+C → ⌘C，Win+C → ⌃C。';
  }
  return macToOther
    ? '⌘ 与 ⌃ 都识别为 Ctrl：⌘C / ⌃C 到 Windows 都是 Ctrl+C。'
    : 'Ctrl 与 Win 键都识别为 ⌘：Ctrl+C / Win+C 到 Mac 都是 ⌘C。';
}

module.exports = {
  decodeKey,
  mapModifier,
  toRobot,
  describeModMap,
  MODS,
  SPECIAL,
  MAP_MODES,
  VC,
  VK
};
