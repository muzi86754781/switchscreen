'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let S = null;

/* ---------------- 工具 ---------------- */

function isMacPlatform() {
  return S ? S.isMac : navigator.platform.toLowerCase().includes('mac');
}

function hotkeyLabel(v) {
  if (!v) return '关闭';
  if (v === 'NONE') return '关闭';
  return v
    .replace('CommandOrControl', isMacPlatform() ? '⌘' : 'Ctrl')
    .replace(/\bAlt\b/, isMacPlatform() ? '⌥' : 'Alt')
    .replace(/\+/g, ' + ');
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

/* 当前键鼠模式：直接显示在顶部提示区 */
function renderModeLine(s) {
  const me = (s.me && s.me.name) || '本机';
  const other = (s.connection && s.connection.peers[0] && (s.connection.peers[0].label || s.connection.peers[0].name)) || '其它电脑';
  const modes = s.inputMode || 'separate';
  const value = $('#connModeText');
  const label = modes === 'local' ? `共用 ${me} 的键鼠` : modes === 'remote' ? `共用 ${other} 的键鼠` : '各用各的键鼠';
  value.textContent = label;
  value.classList.toggle('is-separate', modes === 'separate');
}

/* 权限提醒：只在真的缺权限时出现，其余状态不再占位 */
function renderPerm(s) {
  const btn = $('#connPerm');
  const granted = !!(s.permission && s.permission.accessibility);
  const st = s.input || {};
  const need = s.isMac && !granted;
  btn.hidden = !need;
  if (!need) return;
  $('#connPermText').textContent = st.error ? '键鼠捕获未启动' : 'Mac 辅助功能未授权';
  btn.title = st.error ? st.error : '点这里打开系统设置，勾选本应用后键鼠即可控制另一台';
}

/* 键鼠模式按钮（共用键鼠页） */
function renderModes(s) {
  const me = (s.me && s.me.name) || '本机';
  const other = (s.connection && s.connection.peers[0] && (s.connection.peers[0].label || s.connection.peers[0].name)) || '对端';
  $$('[data-role="mode"] button').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.mode === s.inputMode);
    b.textContent = b.dataset.mode === 'local'
      ? `共用 ${me} 键鼠`
      : b.dataset.mode === 'remote'
        ? `共用 ${other} 键鼠`
        : '各用各的';
  });

  const text = s.inputMode === 'separate'
    ? '各设备用各自的键盘鼠标，互不干扰。'
    : s.inputMode === 'local'
      ? `用 ${me} 接的键盘鼠标控制所有设备；鼠标推到边缘就流到相邻设备。`
      : `用 ${other} 接的键盘鼠标控制所有设备；本机只接收操作。`;
  if ($('#inputModeHint')) $('#inputModeHint').textContent = text;
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

  // 内建屏只属于本机，别的电脑那一行不画它
  const items = (d.monitors || []).filter((m) => d.local || !m.internal);
  if (!items.length) {
    chain.appendChild(el('span', 'wb-empty', '未检测到显示器'));
    return chain;
  }

  const map = el('div', 'chain-map');
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
  const cls = ['chain-mon'];
  if (here) cls.push('is-here');
  if (m.internal) cls.push('is-internal');
  else if (!m.hasPort) cls.push('is-noport');
  if (!m.pos) cls.push('is-flat');
  const node = el('div', cls.join(' '));
  node.dataset.mon = m.id;
  node.dataset.device = d.id;
  if (m.pos) node.dataset.g = `${m.pos.x},${m.pos.y},${m.pos.width},${m.pos.height}`;
  node.tabIndex = 0;
  if (here) node.style.setProperty('--dev', color.c);

  node.appendChild(el('span', 'cm-letter', letters[m.id] || '?'));
  if (m.internal) {
    node.appendChild(el('span', 'cm-tag', '内建'));
    node.title = `${m.name}（笔记本自带屏，始终显示本机，不参与切换）`;
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
    ? `${d.name} 正在这块屏上显示（${m.port}）`
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
    const offY = Math.max(0, (H - th * s) / 2);
    for (const g of geo) {
      g.t.style.left = `${(g.x - minX) * s}px`;
      g.t.style.top = `${(g.y - minY) * s + offY}px`;
      g.t.style.width = `${g.w * s}px`;
      g.t.style.height = `${g.h * s}px`;
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

  const n = monitors.length;
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

  const pop = el('div', 'port-pop');
  pop.dataset.anchor = `${monitorId}@${deviceId}`;

  const title = el('div', 'pp-title');
  title.innerHTML = `<b>${m ? m.name : '显示器'}</b> <em>·</em> ${deviceName(deviceId)} 接哪个口？`;
  pop.appendChild(title);

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
  const hk = s.hotkeys || { enabled: true, global: 'F12', monitor: {}, choices: [] };
  // 内建屏不参与切换，也就不给它配快捷键
  const monitors = (s.monitors || []).filter((m) => !m.internal);
  const letters = monitorLetters(s);

  const choices = [{ value: 'NONE', label: '关闭' }]
    .concat((hk.choices || []).map((k) => ({ value: k, label: hotkeyLabel(k) })));

  $('#hotkeyEnabled').checked = !!hk.enabled;
  setOptions($('#hotkeyGlobal'), choices, hk.global || 'NONE');
  $('#hotkeyGlobal').disabled = !hk.enabled;

  const list = $('#hotkeyList');
  const sig = monitors.map((m) => `${m.id}:${(hk.monitor || {})[m.id]}`).join(',');
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    list.innerHTML = '';
    for (const m of monitors) {
      const row = el('div', 'hk-row');
      row.appendChild(el('span', 'hk-name', `显示器 ${letters[m.id] || '?'} 切换`));
      const sel = document.createElement('select');
      sel.className = 'select select-sm';
      sel.dataset.mon = m.id;
      row.appendChild(sel);
      list.appendChild(row);
      setOptions(sel, choices, (hk.monitor || {})[m.id] || 'NONE');
      sel.disabled = !hk.enabled;
      sel.addEventListener('change', (e) => {
        push(window.api.setHotkey(true, 'monitor', m.id, e.target.value === 'NONE' ? '' : e.target.value));
      });
    }
  }
  $$('#hotkeyList select').forEach((sel) => { sel.disabled = !hk.enabled; });
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
  $('#dzPeer').textContent = names.length ? `发送到 ${names.join('、')}` : '未连接 · 等待其它设备';
  $('#targetNote').textContent = names.length > 1 ? `已选 ${names.length} 台` : '';
}

function renderShare(s) {
  const c = s.clipboard || {};
  const f = s.files || { transfers: [], recvDir: '' };

  $('#clipEnabled').checked = !!c.enabled;
  $('#fileRecvDir').value = f.recvDir || '';
  $('#askLarge').checked = c.askLarge !== false;
  $('#autoAccept').checked = !!f.autoAccept;

  renderPeers(s);
  renderTransfers(s);
}

function renderTransfers(s) {
  const f = s.files || { transfers: [], recvDir: '' };
  const list = $('#txList');
  const transfers = f.transfers || [];
  $('#txSummary').textContent = transfers.length ? `最近 ${transfers.length} 条` : '';

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

/* ---------------- 共用键鼠：设备排列 ---------------- */

function renderArrange(s) {
  const box = $('#arrangeStrip');
  const devices = s.devices || [];
  const sig = s.arrange.map((id) => {
    const d = devices.find((x) => x.id === id) || { name: id, online: false };
    return `${id}:${d.name}:${d.online}`;
  }).join('|') + '#' + (s.input && s.input.edgeSwitch ? '1' : '0');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = '';

  s.arrange.forEach((id, i) => {
    const d = devices.find((x) => x.id === id) || { id, name: id, online: false, local: false };
    const tile = el('div', `arr-tile${d.online ? '' : ' is-off'}${d.local ? ' is-local' : ''}`);
    tile.draggable = true;
    tile.dataset.id = id;

    tile.appendChild(el('span', 'arr-idx', String(i + 1)));
    const ico = el('span', 'arr-ico');
    ico.innerHTML = d.kind === 'mac' ? ICON_MAC : ICON_PC;
    tile.appendChild(ico);
    const body = el('div', 'arr-body');
    body.appendChild(el('b', '', d.name));
    body.appendChild(el('em', '', d.local ? '本机' : (d.online ? '在线' : '离线')));
    tile.appendChild(body);
    tile.appendChild(el('span', 'arr-grip', '⠿'));

    tile.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
      tile.classList.add('is-drag');
    });
    tile.addEventListener('dragend', () => tile.classList.remove('is-drag'));
    tile.addEventListener('dragover', (e) => { e.preventDefault(); tile.classList.add('is-over'); });
    tile.addEventListener('dragleave', () => tile.classList.remove('is-over'));
    tile.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      tile.classList.remove('is-over');
      const from = e.dataTransfer.getData('text/plain');
      if (!from || from === id) return;
      const list = s.arrange.slice();
      list.splice(list.indexOf(from), 1);
      list.splice(list.indexOf(id), 0, from);
      push(window.api.setArrange(list));
    });
    box.appendChild(tile);

    if (i < s.arrange.length - 1) box.appendChild(el('span', 'arr-arrow', '→'));
  });

  box.ondragover = (e) => e.preventDefault();
  box.ondrop = (e) => {
    e.preventDefault();
    const from = e.dataTransfer.getData('text/plain');
    if (!from || from === s.arrange[s.arrange.length - 1]) return;
    const list = s.arrange.filter((x) => x !== from);
    list.push(from);
    push(window.api.setArrange(list));
  };

  const others = devices.filter((d) => !d.local).length;
  const hint = $('#arrangeHint');
  if (hint) {
    if (!others) {
      hint.textContent = '还没发现其它设备。让别的电脑也打开本软件（同一局域网），它们会自动出现在这里，再拖到想要的位置。';
    } else {
      hint.textContent = `当前从左到右：${s.arrange.map((id) => (devices.find((x) => x.id === id) || {}).name || id).join(' → ')}。`
        + '鼠标推到某台设备的右边缘，就流到它右边那台；推回左边缘就流回来。';
    }
  }
}

/* ---------------- 渲染：共用键鼠 ---------------- */

function renderInput(s) {
  const st = s.input || {};

  $('#edgeSwitch').checked = st.edgeSwitch !== false;
  $$('#modSeg button').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.mod === (st.modMap || 'cmd-ctrl'));
  });
  $('#modHint').textContent = st.modDesc || '';
  $('#keyDebug').checked = !!st.keyDebug;
}

/* ---------------- 状态行 ---------------- */

function renderStatus(s) {
  const block = $('#switchStatus');
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
  renderPerm(s);
  renderModes(s);
  buildWorkbench(s);
  buildHotkeys(s);
  renderShare(s);
  renderArrange(s);
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
    push(window.api.setHotkey(e.target.checked, 'global', '', $('#hotkeyGlobal').value));
  });
  $('#hotkeyGlobal').addEventListener('change', (e) => {
    const v = e.target.value === 'NONE' ? '' : e.target.value;
    push(window.api.setHotkey(true, 'global', '', v));
  });

  $('#launchAtLogin').addEventListener('change', (e) => push(window.api.setLaunchAtLogin(e.target.checked)));
}

function bindSharePanel() {
  $('#clipEnabled').addEventListener('change', (e) => push(window.api.setClipboardSync(e.target.checked)));
  $('#askLarge').addEventListener('change', (e) => push(window.api.setAskLarge(e.target.checked)));
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
    if (e.key === 'Escape' && !$('#textModal').hidden) closeTextModal();
  });

  $('#fileRecvChoose').addEventListener('click', () => push(window.api.setRecvDir()));
  $('#fileRecvOpen').addEventListener('click', () => push(window.api.openRecvDir()));

  const targets = () => targetsOf(S || {});

  $('#pickFiles').addEventListener('click', (e) => {
    e.stopPropagation();
    push(window.api.pickFiles(targets()));
  });

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
    if (paths.length) push(window.api.sendPaths(paths, targets()));
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

function bindInputPanel() {
  $('#edgeSwitch').addEventListener('change', (e) => push(window.api.setEdgeSwitch(e.target.checked)));
  $$('[data-role="mode"] button').forEach((b) => {
    b.addEventListener('click', () => push(window.api.setInputMode(b.dataset.mode)));
  });
  $$('#modSeg button').forEach((b) => {
    b.addEventListener('click', () => push(window.api.setModMap(b.dataset.mod)));
  });
  $('#keyDebug').addEventListener('change', (e) => push(window.api.setKeyDebug(e.target.checked)));
}

function bindFooter() {
  $('#helpBtn').addEventListener('click', () => window.api.help());
}

/* 顶部提示区：权限提醒按钮 + 点键鼠模式跳去共用键鼠页 */
function bindConnBar() {
  $('#connPerm').addEventListener('click', () => push(window.api.openAccessibility()));
  const mode = $('#connMode');
  mode.classList.add('is-clickable');
  mode.title = '点这里去「共用键鼠」页切换模式';
  mode.addEventListener('click', () => switchTab('input'));
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
