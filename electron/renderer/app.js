'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let S = null;

/* ---------------- 工具 ---------------- */

function isMacPlatform() {
  return S ? S.isMac : navigator.platform.toLowerCase().includes('mac');
}

function hotkeyLabel(v) {
  if (!v || v === 'NONE') return '';
  const isM = isMacPlatform();
  return String(v)
    .replace(/\bCommandOrControl\b/g, isM ? '⌘' : 'Ctrl')
    .replace(/\bControl\b/g, isM ? '⌃' : 'Ctrl')
    .replace(/\bAlt\b/g, isM ? '⌥' : 'Alt')
    .replace(/\bShift\b/g, isM ? '⇧' : 'Shift')
    .replace(/\bMeta\b/g, isM ? '⌘' : 'Win')
    .replace(/\+/g, ' + ');
}

let activeRecorderCleanup = null;

function normalizeKeyName(e) {
  const code = e.code || '';
  const key = e.key || '';

  // F1 - F24
  if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase();
  // 字母 A-Z
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toUpperCase();
  // 数字 0-9
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  // 小键盘数字 Numpad0-9
  if (code.startsWith('Numpad') && /^\d$/.test(code.slice(6))) return `num${code.slice(6)}`;

  const map = {
    Space: 'Space',
    Tab: 'Tab',
    Enter: 'Enter',
    Escape: 'Escape',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backquote: '`',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/'
  };
  if (map[code]) return map[code];
  if (key && key.length === 1 && key >= '!' && key <= '~') return key.toUpperCase();
  return '';
}

function bindHotkeyRecorder(btnEl, clearBtnEl, getCurrentValue, onSave) {
  if (!btnEl) return;
  const updateDisplay = () => {
    const val = getCurrentValue() || '';
    const label = hotkeyLabel(val);
    const textEl = btnEl.querySelector('.hk-key-text');
    if (textEl) textEl.textContent = label || '点击录制';
    btnEl.classList.toggle('has-value', !!label);
    if (clearBtnEl) clearBtnEl.style.visibility = label ? 'visible' : 'hidden';
  };
  updateDisplay();

  btnEl.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    if (btnEl.classList.contains('is-recording')) {
      if (activeRecorderCleanup) activeRecorderCleanup();
      return;
    }

    if (activeRecorderCleanup) activeRecorderCleanup();

    btnEl.classList.add('is-recording');
    const textEl = btnEl.querySelector('.hk-key-text');
    if (textEl) textEl.textContent = '请按下按键组合…';

    const onKeyDown = (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Esc 取消录制
      if (e.key === 'Escape') {
        cleanup();
        updateDisplay();
        return;
      }
      // Backspace 或 Delete 清除快捷键
      if (e.key === 'Backspace' || e.key === 'Delete') {
        cleanup();
        onSave('');
        return;
      }

      const ctrl = e.ctrlKey;
      const alt = e.altKey;
      const shift = e.shiftKey;
      const meta = e.metaKey;

      // 仅修饰键按下时提示
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        const mods = [];
        if (ctrl || meta) mods.push(isMacPlatform() ? '⌘' : 'Ctrl');
        if (alt) mods.push(isMacPlatform() ? '⌥' : 'Alt');
        if (shift) mods.push(isMacPlatform() ? '⇧' : 'Shift');
        if (textEl) textEl.textContent = mods.length ? mods.join(' + ') + ' + …' : '请按下按键组合…';
        return;
      }

      const primary = normalizeKeyName(e);
      if (!primary) return;

      // 构建 Electron 快捷键字符串
      const parts = [];
      if (ctrl || meta) parts.push('CommandOrControl');
      if (alt) parts.push('Alt');
      if (shift) parts.push('Shift');
      parts.push(primary);

      const accel = parts.join('+');
      cleanup();
      onSave(accel);
    };

    const onClickOutside = (e) => {
      if (!btnEl.contains(e.target)) {
        cleanup();
        updateDisplay();
      }
    };

    const cleanup = () => {
      btnEl.classList.remove('is-recording');
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onClickOutside, true);
      activeRecorderCleanup = null;
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onClickOutside, true);
    activeRecorderCleanup = cleanup;
  });

  if (clearBtnEl) {
    clearBtnEl.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (activeRecorderCleanup) activeRecorderCleanup();
      onSave('');
    });
  }
}

function setOptions(select, items, value) {
  const sig = items.map((i) => `${i.value}|${i.label}`).join(',');
  if (select.dataset.sig !== sig) {
    select.innerHTML = '';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.value;
      o.textContent = it.label;
      select.appendChild(o);
    }
    select.dataset.sig = sig;
  }
  if (value !== undefined && items.length) {
    const want = String(value);
    const has = items.some((i) => String(i.value) === want);
    select.value = has ? want : String(items[0].value);
  }
}

function hexLabel(v) {
  if (!v) return '';
  const preset = ((S && S.inputs && S.inputs.presets) || []).find((p) => p.value === v);
  return preset ? preset.label : String(v);
}

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let x = v;
  do { x /= 1024; i += 1; } while (x >= 1024 && i < u.length - 1);
  return `${x >= 10 || i === 0 ? x.toFixed(0) : x.toFixed(1)} ${u[i]}`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function deviceName(id) {
  const d = ((S && S.devices) || []).find((x) => x.id === id);
  if (d) return d.name;
  const p = ((S && S.connection && S.connection.peers) || []).find((x) => x.name === id);
  return p ? (p.label || p.name) : id;
}

const ICON_PC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.6"/><path d="M9 20h6M12 16v4"/></svg>';
const ICON_MAC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="12" rx="1.6"/><path d="M2 19.5h20"/></svg>';
/* 排列图里的「电脑」节点用机箱/笔电造型，和显示器卡片区分开 */
const ICON_TOWER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M6.5 6.5v11"/><circle cx="9.2" cy="12" r="0.9"/><path d="M13 10.5h5M13 13.5h3.5"/></svg>';
const ICON_LAPTOP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="5" width="15" height="10.5" rx="1.5"/><path d="M2 18.5h20"/></svg>';

/* ---------------- 顶部提示区：连接 + 键鼠模式 + 权限 ---------------- */

function renderConn(s) {
  const c = s.connection || { count: 0, peers: [] };
  const connected = !!c.connected;

  const bar = $('#connBar');
  bar.classList.toggle('ok', connected);
  $('#connDot').classList.toggle('ok', connected);
  $('#connTitle').textContent = connected
    ? `已连接 ${c.count} 台设备 · 局域网自动发现`
    : '未连接 · 等待局域网发现';
  $('#connSub').textContent = connected
    ? 'A 电脑复制 B 电脑粘贴；文件与文字可以直接发，也可以同时发给多台。'
    : '两台电脑连同一个 Wi-Fi 或网线，都打开本软件即可自动连接，无需配对码。';

  const box = $('#connPeers');
  const sig = c.peers.map((p) => `${p.name}:${p.label}`).join(',');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = '';
    for (const p of c.peers) {
      const chip = el('span', 'conn-peer');
      chip.appendChild(el('i', 'dot'));
      chip.appendChild(el('span', '', p.label || p.name));
      box.appendChild(chip);
    }
  }
}

/* 键鼠模式顶部展示 */
function renderModeLine(s) {
  const textEl = $('#connModeText');
  const input = s.input || {};
  if (!input.sharing) {
    textEl.textContent = '各用各的';
    textEl.className = 'cm-value is-separate';
  } else if (input.isHost) {
    textEl.textContent = '共用本机键鼠';
    textEl.className = 'cm-value is-host';
  } else {
    textEl.textContent = `共用 ${input.masterName || '对端'} 键鼠`;
    textEl.className = 'cm-value is-guest';
  }
}

/* 渲染共用键鼠面板 */
function renderInput(s) {
  const input = s.input || {};
  const banner = $('#inputStatusBanner');
  const titleEl = $('#inputStatusTitle');
  const descEl = $('#inputStatusDesc');

  if (banner && titleEl && descEl) {
    banner.classList.remove('is-host', 'is-guest');
    if (!input.sharing) {
      titleEl.textContent = '各用各的键鼠（独立模式）';
      descEl.textContent = '当前每台电脑使用各自物理连接的键盘与鼠标，互不干扰，完全独立操作。';
    } else if (input.isHost) {
      banner.classList.add('is-host');
      titleEl.textContent = '本机为主控端（共用本机键鼠）';
      descEl.textContent = '正在使用本机的键盘与鼠标！按快捷键即可无缝切换控制其他电脑。';
    } else {
      banner.classList.add('is-guest');
      titleEl.textContent = `受控中 · 正在共用 ${input.masterName || '对端'} 键鼠`;
      descEl.textContent = `当前电脑接受来自 ${input.masterName || '对端'} 的键鼠输入控制，本机物理键鼠也随时可用。`;
    }
  }

  const list = $('#inputMasterList');
  if (!list) return;
  list.innerHTML = '';

  // 1. 各用各的键鼠
  const sepCard = el('div', 'input-master-card' + (!input.sharing ? ' is-active' : ''));
  const sepRadio = el('div', 'imc-radio');
  sepRadio.appendChild(el('div', 'imc-radio-dot'));
  sepCard.appendChild(sepRadio);

  const sepMain = el('div', 'imc-main');
  const sepHead = el('div', 'imc-header');
  sepHead.appendChild(el('span', 'imc-title', '各用各的键鼠'));
  sepMain.appendChild(sepHead);
  sepMain.appendChild(el('div', 'imc-desc', '每台电脑使用各自连接的键盘鼠标，互不影响'));
  sepCard.appendChild(sepMain);

  sepCard.addEventListener('click', () => {
    push(window.api.setInputMaster('', false, 1.0));
  });
  list.appendChild(sepCard);

  // 2. 动态枚举所有设备卡片：共用 [设备名] 键鼠
  const devices = (s.devices || []).filter((d) => d.online || d.local);
  for (const d of devices) {
    const isActive = input.sharing && input.master === d.id;
    const card = el('div', 'input-master-card' + (isActive ? ' is-active' : ''));

    const radio = el('div', 'imc-radio');
    radio.appendChild(el('div', 'imc-radio-dot'));
    card.appendChild(radio);

    const main = el('div', 'imc-main');
    const head = el('div', 'imc-header');
    head.appendChild(el('span', 'imc-title', `共用 ${d.name} 键鼠`));
    if (d.local) head.appendChild(el('span', 'imc-badge is-local', '本机'));
    main.appendChild(head);

    const desc = el('div', 'imc-desc', `使用 ${d.name} 的键鼠控制所有电脑，按快捷键自由切换`);
    main.appendChild(desc);
    card.appendChild(main);

    card.addEventListener('click', () => {
      push(window.api.setInputMaster(d.id, false, 1.0));
    });
    list.appendChild(card);
  }

  // 3. 键鼠切换快捷键展示
  const hkBtn = $('#hotkeyInputCycleBtn');
  const hkClear = $('#hotkeyInputCycleClear');
  if (hkBtn && !hkBtn.classList.contains('is-recording')) {
    const val = (s.hotkeys && s.hotkeys.inputCycle) || 'Alt+Q';
    const label = hotkeyLabel(val);
    const textEl = hkBtn.querySelector('.hk-key-text');
    if (textEl) textEl.textContent = label || '点击录制';
    hkBtn.classList.toggle('has-value', !!label);
    if (hkClear) hkClear.style.visibility = label ? 'visible' : 'hidden';
  }

  const tipEl = $('#hotkeyInputCycleTip');
  if (tipEl) {
    if (!input.sharing) {
      tipEl.textContent = '提示：当前为各用各的键鼠模式，每台电脑独立使用各自物理键鼠，无需切换控制权。在上方选中共用某台电脑键鼠后，按此快捷键即可在两台电脑间流转切换使用。';
    } else {
      tipEl.textContent = `提示：当前正在共用「${input.masterName || '主控电脑'}」的物理键鼠。按下快捷键即可在两台电脑之间秒级交接控制权，屏幕正上方将弹出浮窗提示！`;
    }
  }
}

/* ---------------- 设备与显示器 ---------------- */

function monitorLetters(s) {
  const map = {};
  for (const m of (s.monitors || [])) map[m.id] = m.letter || '?';
  return map;
}

/* 每台设备一个颜色：电脑卡片和它正在点亮的那块屏用同一个颜色 */
const DEV_COLORS = [
  { c: '#5b9bff', soft: 'rgba(91,155,255,0.17)', line: 'rgba(122,166,255,0.6)' },
  { c: '#f2a45c', soft: 'rgba(242,164,92,0.17)', line: 'rgba(242,164,92,0.6)' },
  { c: '#48c9a1', soft: 'rgba(72,201,161,0.17)', line: 'rgba(72,201,161,0.6)' },
  { c: '#b58bff', soft: 'rgba(181,139,255,0.17)', line: 'rgba(181,139,255,0.6)' },
  { c: '#e879a6', soft: 'rgba(232,121,166,0.17)', line: 'rgba(232,121,166,0.6)' },
  { c: '#8ab4d8', soft: 'rgba(138,180,216,0.17)', line: 'rgba(138,180,216,0.6)' }
];

function devColor(d, i) {
  const idx = typeof d.colorIndex === 'number' ? d.colorIndex : i;
  return DEV_COLORS[idx % DEV_COLORS.length];
}

/**
 * 右列排列图：按系统设置里显示器的**真实位置**摆开（左/右/上下、相对大小都照原样），
 * 电脑图标贴在左边。这样「显示器 A」就是系统里最左边那块，不会和实际接的屏搞混。
 */
function buildChain(d, letters, color) {
  const chain = el('div', 'wb-chain');

  const dev = el('div', 'chain-dev');
  dev.innerHTML = d.kind === 'mac' ? ICON_LAPTOP : ICON_TOWER;
  dev.title = d.name;
  chain.appendChild(dev);
  chain.appendChild(el('span', 'chain-link'));

  // 每台设备展示属于它的显示器（外接屏 + 设备专属内建屏）
  const items = d.monitors || [];
  if (!items.length) {
    chain.appendChild(el('span', 'wb-empty', '未检测到显示器'));
    return chain;
  }

  const map = el('div', 'chain-map');
  const nonInternal = items.filter((m) => !m.internal);
  let minExtX = Infinity;
  let maxExtX = -Infinity;
  for (const m of nonInternal) {
    if (m.pos) {
      minExtX = Math.min(minExtX, m.pos.x);
      maxExtX = Math.max(maxExtX, m.pos.x + m.pos.width);
    }
  }
  if (!Number.isFinite(minExtX)) { minExtX = 0; maxExtX = 1920; }

  // 保证内建屏（无论本机还是远端上报）严格排在所有外接屏的最左边
  for (const m of items) {
    if (m.internal) {
      const w = (m.pos && m.pos.width) || 1920;
      const h = (m.pos && m.pos.height) || 1200;
      m.pos = { x: minExtX - w - 100, y: 0, width: w, height: h };
      minExtX -= (w + 100);
    } else if (!m.pos) {
      m.pos = { x: maxExtX + 60, y: 0, width: 1920, height: 1080 };
      maxExtX += 2040;
    }
  }
  for (const m of items) map.appendChild(buildTile(m, d, letters, color));
  chain.appendChild(map);

  const noPos = items.length && items.every((m) => !m.pos);
  if (noPos) {
    // 拿不到系统坐标时退化成一行等宽卡片，至少还能点
    map.classList.add('is-flat');
  }
  return chain;
}

function buildTile(m, d, letters, color) {
  const here = m.here === true;
  const away = m.present === false;
  const cls = ['chain-mon'];
  if (here) cls.push('is-here');
  if (m.internal) cls.push('is-internal');
  else if (away) cls.push('is-away');
  else if (!m.hasPort) cls.push('is-noport');
  if (!m.pos) cls.push('is-flat');
  const node = el('div', cls.join(' '));
  node.dataset.mon = m.id;
  node.dataset.device = d.id;
  if (m.pos) node.dataset.g = `${m.pos.x},${m.pos.y},${m.pos.width},${m.pos.height}`;
  node.tabIndex = 0;
  if (here) node.style.setProperty('--dev', color.c);

  // 屏幕上写真实型号（DELL U2414H），字母留作快捷键对应的小角标
  const head = el('div', 'cm-head');
  if (!m.internal) {
    head.appendChild(el('span', 'cm-key', letters[m.id] || '?'));
  }
  head.appendChild(el('span', 'cm-name', m.name || (m.internal ? '内建显示器' : '显示器')));
  node.appendChild(head);

  if (m.internal) {
    const bottomTag = el('span', 'cm-tag is-internal-bottom', '内建');
    node.appendChild(bottomTag);
    node.title = m.name || '内建显示器';
    return node;
  }

  const port = el('button', 'cm-port' + (m.hasPort ? '' : ' is-unset'), m.hasPort ? m.port : '设置接口');
  port.type = 'button';
  port.title = `设置「${m.name}」上 ${d.name} 的接口`;
  port.addEventListener('click', (e) => {
    e.stopPropagation();
    openPortMenu(port, m.id, d.id);
  });
  node.appendChild(port);

  node.title = here
    ? `${d.name} 正在这块屏上显示（${m.port || '未设置接口'}）`
    : m.hasPort
      ? `把「${m.name}」切到 ${d.name}（${m.port}）`
      : `先给这块屏设置 ${d.name} 的接口`;

  if (!here) {
    const go = () => {
      if (!m.hasPort) { openPortMenu(port, m.id, d.id); return; }
      switchMonitor(m.id, d.id, node);
    };
    node.addEventListener('click', go);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  }
  return node;
}

/**
 * 把每块屏按 system 坐标摆到对应位置。
 * 面板宽度是自适应的，所以先量容器再算比例（窗口缩放时重算）。
 * 加入物理像素防重叠推开（Collision Avoidance），彻底杜绝任何卡片重合现象。
 */
function layoutChains() {
  const maps = document.querySelectorAll('.chain-map');
  for (const map of maps) {
    const tiles = map.querySelectorAll('.chain-mon');
    if (!tiles.length) continue;
    const W = map.clientWidth - 2;
    const H = map.clientHeight - 2;
    if (W < 60 || H < 24) continue;

    const geo = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const t of tiles) {
      const p = String(t.dataset.g || '').split(',').map(Number);
      if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) continue;
      const g = { t, x: p[0], y: p[1], w: p[2], h: p[3] };
      geo.push(g);
      minX = Math.min(minX, g.x); minY = Math.min(minY, g.y);
      maxX = Math.max(maxX, g.x + g.w); maxY = Math.max(maxY, g.y + g.h);
    }
    if (!geo.length) continue;

    const tw = Math.max(1, maxX - minX);
    const th = Math.max(1, maxY - minY);
    const s = Math.min(W / tw, H / th);
    const GAP = 8;
    const MIN_W = 124;

    // 按物理坐标从左到右排序
    geo.sort((a, b) => a.x - b.x);

    let curLeft = 0;
    for (const g of geo) {
      let left = (g.x - minX) * s;
      if (left < curLeft) left = curLeft;
      const tileW = Math.max(MIN_W, g.w * s);
      const tileH = Math.max(54, Math.min(H, g.h * s));
      const offY = Math.max(0, (H - tileH) / 2);
      g.t.style.left = `${left}px`;
      g.t.style.top = `${offY}px`;
      g.t.style.width = `${tileW}px`;
      g.t.style.height = `${tileH}px`;
      curLeft = left + tileW + GAP;
    }
  }
}

let layoutTimer = null;
function scheduleLayout() {
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => { layoutTimer = null; layoutChains(); }, 60);
}

function buildWorkbench(s) {
  const box = $('#wbList');
  const devices = s.devices || [];
  const letters = monitorLetters(s);
  const monitors = s.monitors || [];

  const sig = devices
    .map((d) => `${d.id}|${d.name}|${d.online}|${d.inUse}|${d.colorIndex}|` +
      (d.monitors || []).map((m) => `${m.id}:${m.here}:${m.hasPort}:${m.port}:${m.internal}:${m.pos ? m.pos.x + '.' + m.pos.y + '.' + m.pos.width : ''}`).join(','))
    .join(';') + `#${monitors.map((m) => m.id).join(',')}`;
  if (box.dataset.sig === sig) { scheduleLayout(); return; }
  box.dataset.sig = sig;
  box.innerHTML = '';

  devices.forEach((d, i) => {
    const color = devColor(d, i);
    const shared = (d.monitors || []).filter((m) => !m.internal);
    const hereCount = shared.filter((m) => m.here === true).length;
    const allHere = shared.length > 0 && hereCount === shared.length;

    // 整行不再着色：只有「电脑」和「它点亮的屏」分别用同一个颜色标出来
    const row = el('div', `wb-row${d.online ? '' : ' is-off'}${d.inUse ? ' is-inuse' : ''}`);
    row.style.setProperty('--dev', color.c);
    row.style.setProperty('--dev-soft', color.soft);
    row.style.setProperty('--dev-line', color.line);

    /* ---- 左列：电脑信息 ---- */
    const left = el('div', 'wb-left');
    const head = el('div', 'wb-head');
    const ico = el('span', 'wb-ico');
    ico.innerHTML = d.kind === 'mac' ? ICON_MAC : ICON_PC;
    head.appendChild(ico);

    const idBox = el('div', 'wb-id');
    const nameLine = el('div', 'wb-name');
    const nameNode = el('b', 'wb-name-text', d.name);
    if (d.local) {
      nameNode.classList.add('is-editable');
      nameNode.title = '点一下改这台电脑的名字（会同步到其它设备）';
      nameNode.addEventListener('click', () => startRename(d, nameNode));
    }
    nameLine.appendChild(nameNode);
    // 第一个打开本软件的那台是主控，它的状态是初始权威
    if (d.primary) {
      const tag = el('span', 'wb-chip is-primary', '主控');
      tag.title = '最早打开本软件的这台：后开的机器都按它的状态对齐';
      nameLine.appendChild(tag);
    }
    nameLine.appendChild(el('span', `wb-chip${d.online ? '' : ' off'}`, d.note));
    idBox.appendChild(nameLine);

    const total = shared.length;
    const sub = d.local
      ? `本机${total ? ` · 接 ${total} 块屏${hereCount ? `（正在显示 ${hereCount} 块）` : ''}` : ''}`
      : `${d.online ? '已连接 · 同局域网' : '离线'}${total ? ` · 接 ${total} 块屏${hereCount ? `（正在显示 ${hereCount} 块）` : ''}` : ''}`;
    idBox.appendChild(el('div', 'wb-sub', sub));
    head.appendChild(idBox);
    left.appendChild(head);

    const actions = el('div', 'wb-actions');
    // 全部在用时不重复说一遍（按钮已经写着「全部显示中」）
    if (d.inUse && !allHere) actions.appendChild(el('span', 'wb-flag', '使用中'));
    const go = el('button', 'wb-go', allHere ? '全部显示中' : '全部切到这台');
    go.type = 'button';
    go.disabled = allHere || !d.online;
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      switchToDevice(d.id);
    });
    actions.appendChild(go);
    left.appendChild(actions);
    row.appendChild(left);

    /* ---- 右列：这台电脑与显示器的真实排列 ---- */
    row.appendChild(buildChain(d, letters, color));
    box.appendChild(row);
  });

  const extMonitors = monitors.filter((m) => !m.internal);
  const n = extMonitors.length;
  const devs = devices.length;
  const onlineOthers = devices.filter((d) => !d.local && d.online).length;
  $('#wbNote').textContent = n
    ? `${devs} 台设备 · ${n} 块屏${onlineOthers ? '' : ' · 没有其它设备在线'}`
    : '未检测到显示器';
  layoutChains();
}

/* 本机改名（就地编辑） */
function startRename(d, node) {
  if (node.dataset.editing === '1') return;
  node.dataset.editing = '1';
  const input = document.createElement('input');
  input.className = 'wb-rename';
  input.value = d.name;
  input.maxLength = 24;
  node.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.replaceWith(node);
    node.dataset.editing = '0';
    if (save && v && v !== d.name) push(window.api.rename(v));
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

/* ---------------- 接口选择浮层（点接口标签打开） ---------------- */

let portPop = null;

function closePortMenu() {
  if (portPop && portPop.parentNode) portPop.parentNode.removeChild(portPop);
  portPop = null;
  document.removeEventListener('mousedown', onPortOutside, true);
  window.removeEventListener('resize', closePortMenu);
  window.removeEventListener('scroll', closePortMenu, true);
}

function onPortOutside(e) {
  if (portPop && !portPop.contains(e.target)) closePortMenu();
}

function openPortMenu(anchor, monitorId, deviceId) {
  const sameAnchor = portPop && portPop.dataset.anchor === `${monitorId}@${deviceId}`;
  closePortMenu();
  if (sameAnchor) return;

  const m = ((S && S.monitors) || []).find((x) => x.id === monitorId);
  const cur = m && m.ports && m.ports[deviceId] ? m.ports[deviceId].value : '';
  const curSrc = m && m.ports && m.ports[deviceId] ? m.ports[deviceId].src : '';

  const pop = el('div', 'port-pop');
  pop.dataset.anchor = `${monitorId}@${deviceId}`;

  const title = el('div', 'pp-title');
  title.innerHTML = `<b>${m ? m.name : '显示器'}</b> <em>·</em> ${deviceName(deviceId)} 接哪个口？`;
  pop.appendChild(title);

  // 记下来的口标一句来源：手配 / 自动识别的都在，不会被自动清掉
  if (cur) {
    const note = el('div', 'pp-note', curSrc === 'manual'
      ? '已保存（手配或自动识别，不会被自动清掉）'
      : '已保存');
    pop.appendChild(note);
  }

  // 没配过就先自动认一次：省得用户去猜自己的线插在 HDMI1 还是 DVI 上
  if (!cur) {
    const auto = el('button', 'chip chip-auto', '自动识别');
    auto.type = 'button';
    auto.title = '逐个口试一下，认出来就记住（识别时屏幕会闪几下）';
    auto.addEventListener('click', async () => {
      closePortMenu();
      auto.disabled = true;
      auto.textContent = '识别中…';
      try {
        const r = await window.api.probePort(monitorId, deviceId);
        if (r && r.state) apply(r.state);
      } catch (e) {
        console.error('[ui]', e);
      }
    });
    pop.appendChild(auto);
  }

  // 这块屏「此刻正在用」的口直接顶在最上面：多数情况下点一下就对，
  // 不用去猜自己的线插在 HDMI1 还是 DVI 上（有的显示器读回来是 0x03 这类非常见值）
  const live = m && m.currentInput ? m.currentInput : '';
  if (live) {
    const row = el('div', 'pp-live');
    row.appendChild(el('span', 'pp-live-t', `当前画面 ${m.currentInputLabel || hexLabel(live)}`));
    const use = el('button', 'chip chip-live', '就用这个口');
    use.type = 'button';
    use.title = '这块屏现在就在用这个口 —— 记成这台电脑接的口';
    use.addEventListener('click', async () => {
      closePortMenu();
      await push(window.api.setPort(monitorId, deviceId, live));
    });
    row.appendChild(use);
    pop.appendChild(row);
  }

  const chips = el('div', 'chips');
  for (const it of chipItems([cur])) {
    const b = el('button', 'chip', it.label);
    b.type = 'button';
    if (it.value === cur) b.classList.add('is-on');
    b.addEventListener('click', async () => {
      closePortMenu();
      await push(window.api.setPort(monitorId, deviceId, it.value));
    });
    chips.appendChild(b);
  }
  pop.appendChild(chips);

  document.body.appendChild(pop);
  portPop = pop;

  /* 贴着目标控件定位，避免超出窗口 */
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  let y = r.bottom + 8;
  x = Math.max(10, Math.min(window.innerWidth - w - 10, x));
  if (y + h > window.innerHeight - 10) y = Math.max(10, r.top - h - 8);
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(y)}px`;

  setTimeout(() => {
    document.addEventListener('mousedown', onPortOutside, true);
    window.addEventListener('resize', closePortMenu);
    window.addEventListener('scroll', closePortMenu, true);
  }, 0);
}

function chipItems(values) {
  const items = ((S && S.inputs && S.inputs.presets) || []).map((p) => ({ value: p.value, label: p.label }));
  for (const v of values) {
    if (v && !items.some((i) => i.value === v)) items.push({ value: v, label: hexLabel(v) });
  }
  items.push({ value: '', label: '不切' });
  return items;
}

/* ---------------- 快捷键 ---------------- */

function buildHotkeys(s) {
  const hk = s.hotkeys || { enabled: true, global: 'F12', monitor: {} };
  const monitors = (s.monitors || []).filter((m) => !m.internal);
  const letters = monitorLetters(s);

  $('#hotkeyEnabled').checked = !!hk.enabled;

  const launchEl = $('#launchAtLogin');
  if (launchEl) launchEl.checked = !!s.launchAtLogin;

  const globalBtn = $('#hotkeyGlobalBtn');
  const globalClear = $('#hotkeyGlobalClear');
  if (globalBtn) {
    globalBtn.disabled = !hk.enabled;
    if (globalClear) globalClear.disabled = !hk.enabled;
    const gText = globalBtn.querySelector('.hk-key-text');
    const label = hotkeyLabel(hk.global);
    if (textNotEqual(gText, label || '点击录制')) {
      if (gText) gText.textContent = label || '点击录制';
    }
    if (globalClear) globalClear.style.visibility = label ? 'visible' : 'hidden';
  }

  const list = $('#hotkeyList');
  const sig = monitors.map((m) => `${m.id}:${(hk.monitor || {})[m.id] || ''}`).join(',');
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    list.innerHTML = '';
    for (const m of monitors) {
      const monKey = (hk.monitor || {})[m.id] || '';
      const row = el('div', 'hk-row');
      const isOffline = m.present === false;
      const letter = letters[m.id] || m.letter || '';
      row.appendChild(el('span', 'hk-name',
        `${m.name || '显示器'}${letter ? `（${letter}）` : ''}${isOffline ? ' [当前在对端]' : ''} 切换`));

      const group = el('div', 'hk-recorder-group');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hk-record-btn';
      btn.title = '点击后直接按下键盘快捷键进行自定义';
      const label = hotkeyLabel(monKey);
      btn.innerHTML = `<span class="hk-key-text">${label || '点击录制'}</span>`;
      btn.disabled = !hk.enabled;

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'hk-clear-btn';
      clearBtn.title = '清除快捷键';
      clearBtn.textContent = '✕';
      clearBtn.style.visibility = label ? 'visible' : 'hidden';
      clearBtn.disabled = !hk.enabled;

      group.appendChild(btn);
      group.appendChild(clearBtn);
      row.appendChild(group);
      list.appendChild(row);

      bindHotkeyRecorder(btn, clearBtn, () => ((S && S.hotkeys && S.hotkeys.monitor) || {})[m.id] || '', (val) => {
        push(window.api.setHotkey(true, 'monitor', m.id, val));
      });
    }
  }

  $$('#hotkeyList .hk-record-btn').forEach((b) => { b.disabled = !hk.enabled; });
  $$('#hotkeyList .hk-clear-btn').forEach((b) => { b.disabled = !hk.enabled; });
}

function textNotEqual(el, text) {
  return el && el.textContent !== text;
}

/* ---------------- 传输与剪贴板 ---------------- */

const STATUS_TEXT = {
  waiting: '等待对方接收…',
  sending: '发送中',
  receiving: '接收中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
  rejected: '对方已拒绝'
};

function targetsOf(s) {
  return (s.files && s.files.targets) || [];
}

function renderPeers(s) {
  const box = $('#peerChips');
  const peers = (s.connection && s.connection.peers) || [];
  const targets = targetsOf(s);
  const sig = peers.map((p) => `${p.name}:${p.label}`).join(',') + '|' + targets.join(',');
  if (box.dataset.sig !== sig) {
    box.innerHTML = '';
    if (!peers.length) {
      box.appendChild(el('div', 'peers-empty', '未连接 · 让其它电脑也打开本软件，同一局域网会自动发现'));
    } else {
      for (const p of peers) {
        const b = el('button', 'peer-chip');
        b.type = 'button';
        b.dataset.name = p.name;
        if (targets.includes(p.name)) b.classList.add('is-on');
        b.innerHTML = '<span class="dot"></span><span class="nm"></span><span class="tag"></span><span class="tick">✓</span>';
        b.querySelector('.nm').textContent = p.label || p.name;
        b.querySelector('.tag').textContent = p.platform === 'darwin' ? 'Mac' : p.platform === 'win32' ? 'Windows' : '';
        b.addEventListener('click', () => {
          const next = targets.includes(p.name)
            ? targets.filter((n) => n !== p.name)
            : targets.concat(p.name);
          push(window.api.setTargets(next));
        });
        box.appendChild(b);
      }
    }
    box.dataset.sig = sig;
  }

  const names = targets.map((n) => {
    const p = peers.find((x) => x.name === n);
    return p ? (p.label || p.name) : n;
  });
  $('#targetNote').textContent = names.length > 1 ? `已选 ${names.length} 台` : '';
}

function renderShare(s) {
  const c = s.clipboard || {};
  const f = s.files || { transfers: [], recvDir: '' };

  $('#clipEnabled').checked = !!c.enabled;
  $('#fileRecvDir').value = f.recvDir || '';
  $('#autoAccept').checked = !!f.autoAccept;

  renderPeers(s);
  renderTransfers(s);
}

const activeTransferSeen = new Set();

function renderTransfers(s) {
  const f = s.files || { transfers: [], recvDir: '' };
  const list = $('#txList');
  const transfers = f.transfers || [];
  $('#txSummary').textContent = transfers.length ? `最近 ${transfers.length} 条` : '';

  // 当有正在进行或新发起的文件传输时，自动切换到「传输与剪贴板」选项卡
  const activeTransfers = transfers.filter((t) => t.status === 'sending' || t.status === 'receiving' || t.status === 'waiting');
  let hasNewActive = false;
  for (const t of activeTransfers) {
    if (!activeTransferSeen.has(t.id)) {
      activeTransferSeen.add(t.id);
      hasNewActive = true;
    }
  }
  if (hasNewActive) {
    switchTab('share');
  }

  if (!transfers.length) {
    if (!list.querySelector('.empty')) list.innerHTML = '<div class="empty">还没有传输记录</div>';
    return;
  }
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();

  const seen = new Set();
  for (const t of transfers) {
    seen.add(t.id);
    let node = list.querySelector(`[data-id="${t.id}"]`);
    if (!node) {
      node = el('div', 'tx');
      node.dataset.id = t.id;
      node.innerHTML = '<div class="tx-head"><span class="tx-dir"></span><b></b><span class="tx-size"></span>'
        + '<button class="tx-del" type="button" title="删除这条记录">×</button></div>'
        + '<div class="tx-bar"><i></i></div>'
        + '<div class="tx-foot"><span class="tx-state"></span><span class="tx-extra"></span></div>';
      node.querySelector('.tx-del').addEventListener('click', (e) => {
        e.stopPropagation();
        push(window.api.removeTransfer(t.id));
      });
      // 点整行：文本 → 弹出全文；文件 → 在文件夹里选中
      node.addEventListener('click', () => openRecord(node.dataset.id));
      list.prepend(node);
    }
    const pct = t.size ? Math.min(100, Math.round((t.done / t.size) * 100)) : (t.status === 'done' ? 100 : 0);
    node.classList.toggle('done', t.status === 'done');
    node.classList.toggle('failed', t.status === 'failed' || t.status === 'rejected');
    node.classList.toggle('is-text', !!t.text);
    node.classList.toggle('is-clickable', !!(t.text || t.path || (t.saved && t.saved.length)));
    node.querySelector('.tx-dir').textContent = t.dir === 'in' ? '接收' : '发送';
    node.querySelector('b').textContent = t.name || '未命名';
    node.querySelector('.tx-size').textContent = fmtSize(t.size);
    node.querySelector('.tx-bar i').style.width = `${pct}%`;
    node.querySelector('.tx-state').textContent = `${STATUS_TEXT[t.status] || t.status}${t.size ? ` · ${pct}%` : ''}`;
    node.title = t.text
      ? '点一下查看全文，可拷贝'
      : (t.path ? '点一下在文件夹中显示这个文件' : '');

    const extra = node.querySelector('.tx-extra');
    const sig = `${t.status}|${t.dir}|${t.text ? 1 : 0}|${t.path ? 1 : 0}`;
    if (extra.dataset.sig !== sig) {
      extra.dataset.sig = sig;
      extra.innerHTML = '';
      if (t.status === 'sending' || t.status === 'receiving' || t.status === 'waiting') {
        const b = el('button', 'tx-act', '取消');
        b.addEventListener('click', (e) => { e.stopPropagation(); push(window.api.cancelTransfer(t.id)); });
        extra.appendChild(b);
      } else if (t.text) {
        const view = el('button', 'tx-act', '查看');
        view.addEventListener('click', (e) => { e.stopPropagation(); openTextRecord(t.id); });
        extra.appendChild(view);
        const cp = el('button', 'tx-act', '拷贝');
        cp.addEventListener('click', (e) => { e.stopPropagation(); copyRecord(t.id); });
        extra.appendChild(cp);
      } else if (t.path) {
        const b = el('button', 'tx-act', '在文件夹中显示');
        b.addEventListener('click', (e) => { e.stopPropagation(); window.api.revealFile(t.path); });
        extra.appendChild(b);
      } else {
        extra.textContent = t.error || '';
      }
    }
  }

  Array.from(list.children).forEach((c) => {
    const id = c.dataset && c.dataset.id;
    if (id && !seen.has(id)) c.remove();
  });
}

/** 从最新状态里取记录（列表是增量更新的，闭包里那份可能已经过期） */
function recordById(id) {
  const list = (S && S.files && S.files.transfers) || [];
  return list.find((x) => x.id === id) || null;
}

function openRecord(id) {
  const r = recordById(id);
  if (!r) return;
  if (r.text) { openTextRecord(id); return; }
  const p = r.path || (r.saved && r.saved[0]);
  if (p) window.api.revealFile(p);
}

function copyRecord(id) {
  const r = recordById(id);
  if (!r || !r.text) return;
  push(window.api.copyText(r.text));
  toast('已拷贝到剪贴板');
}

function openTextRecord(id) {
  const r = recordById(id);
  if (!r) return;
  const from = r.peer ? deviceName(r.peer) : '';
  const title = `${r.dir === 'in' ? '收到' : '发出'}的文本${from ? ` · ${from}` : ''}`;
  openTextModal(r.text || '', title);
}

/* ---------------- 文本查看弹窗 ---------------- */

let tmText = '';

function openTextModal(text, title) {
  tmText = text || '';
  $('#tmTitle').textContent = title || '文本';
  $('#tmBody').textContent = tmText || '（空）';
  $('#tmMeta').textContent = `${tmText.length} 字`;
  $('#textModal').hidden = false;
  document.body.classList.add('modal-open');
}

function closeTextModal() {
  $('#textModal').hidden = true;
  document.body.classList.remove('modal-open');
}

/** 轻提示（3 秒后自动消失） */
let toastTimer = null;
function toast(text) {
  let box = $('#toast');
  if (!box) {
    box = el('div', 'toast');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.textContent = text;
  box.classList.add('is-on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('is-on'), 2600);
}

/* ---------------- 状态行 ---------------- */

function renderStatus(s) {
  const block = $('#switchStatus');
  if (!block) return;
  block.innerHTML = '';
  const lines = (s.statusLines || []).slice(0, 3);
  if (!lines.length) block.appendChild(el('span', '', '准备就绪'));
  else {
    for (const it of lines) {
      block.appendChild(el('div', it.kind === 'warn' ? 'warn' : it.kind === 'ok' ? 'ok' : '', it.text));
    }
  }
}

/* ---------------- 总渲染 ---------------- */

function apply(s) {
  S = s;
  document.body.classList.toggle('win', !s.isMac);
  $('#footVer').textContent = `v${s.version}`;

  renderConn(s);
  renderModeLine(s);
  buildWorkbench(s);
  buildHotkeys(s);
  renderShare(s);
  renderInput(s);
  renderStatus(s);
}

/* ---------------- 事件 ---------------- */

function switchTab(name) {
  $$('#tabs .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
  closePortMenu();
  if (name === 'switch') scheduleLayout();
}

function bindTabs() {
  $$('#tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

async function push(promise) {
  try {
    const s = await promise;
    if (s && s.version) apply(s);
  } catch (e) {
    console.error('[ui]', e);
  }
}

async function switchToDevice(deviceId) {
  try {
    const r = await window.api.switchDevice(deviceId);
    if (r && r.state) apply(r.state);
  } catch (e) {
    console.error('[ui] switch', e);
  }
}

async function switchMonitor(monitorId, deviceId, tile) {
  if (tile) { tile.classList.add('is-busy'); }
  try {
    const s = await window.api.switchMonitor(monitorId, deviceId);
    if (s && s.version) apply(s);
  } catch (e) {
    console.error('[ui] switchMonitor', e);
  } finally {
    if (tile) tile.classList.remove('is-busy');
  }
}

function bindSwitchPanel() {
  $('#redetectBtn').addEventListener('click', () => push(window.api.detectMonitor()));

  $('#hotkeyEnabled').addEventListener('change', (e) => {
    const cur = (S && S.hotkeys && S.hotkeys.global) || 'F12';
    push(window.api.setHotkey(e.target.checked, 'global', '', cur));
  });

  bindHotkeyRecorder(
    $('#hotkeyGlobalBtn'),
    $('#hotkeyGlobalClear'),
    () => (S && S.hotkeys && S.hotkeys.global) || '',
    (val) => push(window.api.setHotkey(true, 'global', '', val))
  );

  $('#launchAtLogin').addEventListener('change', (e) => push(window.api.setLaunchAtLogin(e.target.checked)));

  const openLog = () => { if (window.api && window.api.openLogFile) window.api.openLogFile(); };
  const openLogDir = () => { if (window.api && window.api.openLogDir) window.api.openLogDir(); };
  const btn1 = $('#openLogBtn');
  if (btn1) btn1.addEventListener('click', openLog);
  const btn2 = $('#openLogDirBtn');
  if (btn2) btn2.addEventListener('click', openLogDir);
}

let stagedPaths = [];

async function renderStagedFiles() {
  const wrap = $('#stagedWrap');
  const list = $('#stagedList');
  const btn = $('#sendFilesBtn');
  const summary = $('#stagedSummary');
  if (!wrap || !list || !btn) return;

  if (!stagedPaths.length) {
    wrap.hidden = true;
    btn.disabled = true;
    list.innerHTML = '';
    return;
  }

  wrap.hidden = false;
  btn.disabled = false;

  let info = { items: [], totalSize: 0 };
  try {
    if (window.api && window.api.inspectFiles) {
      info = await window.api.inspectFiles(stagedPaths);
    }
  } catch (e) {
    console.error('[ui] inspectFiles error', e);
  }

  const items = (info && info.items && info.items.length) ? info.items : stagedPaths.map((p) => ({
    path: p,
    name: p.split(/[/\\]/).pop() || p,
    isDir: false,
    size: 0
  }));

  if (summary) {
    summary.textContent = `已选择 ${items.length} 项${info && info.totalSize > 0 ? `（共 ${fmtSize(info.totalSize)}）` : ''}`;
  }

  list.innerHTML = '';
  for (const item of items) {
    const row = el('div', 'staged-item');
    row.innerHTML = `<span class="si-icon">${item.isDir ? '📁' : '📄'}</span>`
      + `<span class="si-name" title="${item.path}">${item.name}</span>`
      + `<span class="si-size">${item.isDir ? '文件夹' : fmtSize(item.size)}</span>`
      + `<button type="button" class="si-del" title="移除此项">✕</button>`;
    row.querySelector('.si-del').addEventListener('click', (e) => {
      e.stopPropagation();
      stagedPaths = stagedPaths.filter((p) => p !== item.path);
      renderStagedFiles();
    });
    list.appendChild(row);
  }
}

function bindSharePanel() {
  $('#clipEnabled').addEventListener('change', (e) => push(window.api.setClipboardSync(e.target.checked)));
  $('#autoAccept').addEventListener('change', (e) => push(window.api.setAutoAccept(e.target.checked)));

  $('#txClear').addEventListener('click', () => push(window.api.clearTransfers()));

  /* 文本查看弹窗 */
  $('#tmClose').addEventListener('click', closeTextModal);
  $('#tmDone').addEventListener('click', closeTextModal);
  $('#tmCopy').addEventListener('click', () => {
    push(window.api.copyText(tmText));
    toast('已拷贝到剪贴板');
  });
  $('#textModal').addEventListener('click', (e) => {
    if (e.target.id === 'textModal') closeTextModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#textModal').hidden) closeTextModal();
      const sm = $('#sponsorModal');
      if (sm && !sm.hidden) sm.hidden = true;
    }
  });

  $('#fileRecvChoose').addEventListener('click', () => push(window.api.setRecvDir()));
  $('#fileRecvOpen').addEventListener('click', () => push(window.api.openRecvDir()));

  const targets = () => targetsOf(S || {});

  const addStagedPaths = (paths) => {
    if (!paths || !paths.length) return;
    let added = 0;
    for (const p of paths) {
      if (!stagedPaths.includes(p)) {
        stagedPaths.push(p);
        added++;
      }
    }
    if (added > 0) {
      renderStagedFiles();
      toast(`已选择 ${stagedPaths.length} 项，点击「发送文件」即可发送`);
    }
  };

  const clearStaged = $('#stagedClearBtn');
  if (clearStaged) {
    clearStaged.addEventListener('click', () => {
      stagedPaths = [];
      renderStagedFiles();
    });
  }

  $('#pickFiles').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const files = await window.api.selectFiles('file');
      addStagedPaths(files);
    } catch (e) {
      console.error('[ui] selectFiles error', e);
    }
  });

  const pickFolderBtn = $('#pickFolder');
  if (pickFolderBtn) {
    pickFolderBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const dirs = await window.api.selectFiles('dir');
        addStagedPaths(dirs);
      } catch (e) {
        console.error('[ui] selectFolder error', e);
      }
    });
  }

  const sendFilesBtn = $('#sendFilesBtn');
  if (sendFilesBtn) {
    sendFilesBtn.addEventListener('click', () => {
      if (!stagedPaths.length) return;
      const t = targets();
      if (!t.length) {
        toast('未连接其它设备或未勾选接收方');
        return;
      }
      const pathsToSend = [...stagedPaths];
      stagedPaths = [];
      renderStagedFiles();
      switchTab('share');
      push(window.api.sendPaths(pathsToSend, t));
      toast(`已发起发送 ${pathsToSend.length} 项`);
    });
  }

  const sendTextNow = () => {
    const input = $('#textInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    push(window.api.sendText(text, targets()));
  };
  $('#sendTextBtn').addEventListener('click', sendTextNow);
  $('#textInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendTextNow();
  });

  const dz = $('#dropzone');
  const over = (v) => dz.classList.toggle('is-over', v);
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); over(true); }));
  ['dragleave', 'dragend'].forEach((ev) => dz.addEventListener(ev, () => over(false)));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    over(false);
    const paths = Array.from(e.dataTransfer.files || []).map((f) => f.path).filter(Boolean);
    if (paths.length) {
      addStagedPaths(paths);
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

function bindFooter() {
  const helpBtn = $('#helpBtn');
  if (helpBtn) helpBtn.addEventListener('click', () => window.api.help());
  const footLog = $('#footLogBtn');
  if (footLog) footLog.addEventListener('click', () => {
    if (window.api && window.api.openLogFile) window.api.openLogFile();
  });

  const sponsorBtn = $('#sponsorBtn');
  const sm = $('#sponsorModal');
  const smClose = $('#smClose');
  const smDone = $('#smDone');
  const smCopyQq = $('#smCopyQq');
  const smCopyTip = $('#smCopyTip');

  const openSponsor = () => {
    if (sm) {
      sm.hidden = false;
      if (smCopyTip) smCopyTip.classList.remove('is-shown');
    }
  };
  const closeSponsor = () => {
    if (sm) sm.hidden = true;
  };

  if (sponsorBtn) sponsorBtn.addEventListener('click', openSponsor);
  if (smClose) smClose.addEventListener('click', closeSponsor);
  if (smDone) smDone.addEventListener('click', closeSponsor);
  if (sm) {
    sm.addEventListener('click', (e) => {
      if (e.target.id === 'sponsorModal') closeSponsor();
    });
  }

  if (smCopyQq) {
    smCopyQq.addEventListener('click', () => {
      const qq = '285351298';
      const fallbackCopy = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = qq;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          return true;
        } catch { return false; }
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(qq).then(() => {
          if (smCopyTip) {
            smCopyTip.classList.add('is-shown');
            setTimeout(() => smCopyTip.classList.remove('is-shown'), 1800);
          }
        }).catch(() => {
          if (fallbackCopy() && smCopyTip) {
            smCopyTip.classList.add('is-shown');
            setTimeout(() => smCopyTip.classList.remove('is-shown'), 1800);
          }
        });
      } else {
        if (fallbackCopy() && smCopyTip) {
          smCopyTip.classList.add('is-shown');
          setTimeout(() => smCopyTip.classList.remove('is-shown'), 1800);
        }
      }
    });
  }
}

/* 顶部提示区：点击跳转到共用键鼠 Tab */
function bindConnBar() {
  const mode = $('#connMode');
  mode.title = '点击切换共用键鼠';
  mode.style.cursor = 'pointer';
  mode.addEventListener('click', () => switchTab('input'));
}

function bindInputPanel() {
  bindHotkeyRecorder(
    $('#hotkeyInputCycleBtn'),
    $('#hotkeyInputCycleClear'),
    () => (S && S.hotkeys && S.hotkeys.inputCycle) || 'Alt+Q',
    (val) => push(window.api.setHotkey(true, 'inputCycle', '', val))
  );

  const testBtn = $('#testCycleInputBtn');
  if (testBtn) {
    testBtn.addEventListener('click', () => push(window.api.cycleInput()));
  }
}

/* ---------------- 启动 ---------------- */

(async function init() {
  bindTabs();
  bindConnBar();
  bindSwitchPanel();
  bindSharePanel();
  bindInputPanel();
  bindFooter();

  try {
    apply(await window.api.getState());
  } catch (e) {
    console.error('[ui] 初始化失败', e);
  }

  window.api.onState((s) => {
    if (s && s.version) apply(s);
  });

  // 兜底轮询：权限状态等系统信息变化不产生事件
  setInterval(async () => {
    try {
      const s = await window.api.permissionStatus();
      if (s && s.version && S && s.permission.accessibility !== S.permission.accessibility) apply(s);
    } catch { /* ignore */ }
  }, 3000);

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePortMenu(); }, true);
  window.addEventListener('resize', scheduleLayout);
})();
