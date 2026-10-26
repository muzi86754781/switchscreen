'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const HOTKEYS = [
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'CommandOrControl+Shift+F12',
  'CommandOrControl+Alt+F12',
  'CommandOrControl+Shift+Space'
];

const EDGE_TEXT = { left: '左侧', right: '右侧', top: '上方', bottom: '下方' };

let S = null;

/* ---------------- 工具 ---------------- */

function isMacPlatform() {
  return S ? S.isMac : navigator.platform.toLowerCase().includes('mac');
}

function hotkeyLabel(v) {
  if (!v) return '—';
  return v
    .replace('CommandOrControl', isMacPlatform() ? '⌘' : 'Ctrl')
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
  if (preset) return preset.label;
  return String(v);
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

/* ---------------- 图标 ---------------- */

const ICON_PC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.6"/><path d="M9 20h6M12 16v4"/></svg>';
const ICON_MAC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="12" rx="1.6"/><path d="M2 19.5h20"/></svg>';
const ICON_MON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.6"/><path d="M9 20h6M12 16v4"/></svg>';

/* ---------------- 双机工作台 ---------------- */

function buildWorkbench(s) {
  const box = $('#wbList');
  const wb = s.workbench;
  if (!wb) return;

  const sig = wb.rows
    .map((r) => `${r.role}|${r.name}|${r.label}|${r.online}|${r.active}|` +
      r.monitors.map((m) => `${m.id}:${m.io}:${String(m.here)}`).join(','))
    .join(';');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = '';

  for (const r of wb.rows) {
    const row = el('div', `wb-row${r.active ? ' is-active' : ''}${r.online ? '' : ' is-off'}`);
    row.dataset.role = r.role;

    const main = el('div', 'wb-main');
    const ico = el('span', 'wb-ico');
    ico.innerHTML = r.kind === 'mac' ? ICON_MAC : ICON_PC;
    main.appendChild(ico);

    const id = el('div', 'wb-id');
    const nameLine = el('div', 'wb-name');
    nameLine.appendChild(el('b', '', r.label));
    nameLine.appendChild(el('span', 'wb-chip', r.note));
    id.appendChild(nameLine);
    id.appendChild(el('div', 'wb-note', r.name));
    main.appendChild(id);

    const right = el('div', 'wb-right');
    if (r.active) right.appendChild(el('span', 'wb-flag', '使用中'));
    const go = el('button', 'wb-go', r.active ? '当前' : '切到这台');
    go.disabled = r.active || !r.online;
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      doSwitch(r.role, go);
    });
    right.appendChild(go);
    main.appendChild(right);
    row.appendChild(main);

    // 显示器排列：从左到右按检测顺序排开，正在显示这台的高亮
    const strip = el('div', 'wb-mons');
    if (!r.monitors.length) {
      strip.appendChild(el('div', 'wb-empty', '未检测到显示器'));
    } else {
      for (const m of r.monitors) {
        const here = m.here === true;
        const unknown = m.here === null;
        const card = el('div', `wb-mon${here ? ' is-here' : ''}${unknown ? ' is-unknown' : ''}`);
        card.title = `${m.name} · ${m.io || '未指定接口'}${here ? ' · 正在显示这台' : ''}`;
        const bar = el('span', 'wb-mon-bar');
        card.appendChild(bar);
        card.appendChild(el('span', 'wb-mon-name', m.name));
        card.appendChild(el('span', 'wb-mon-io', m.connected ? m.io : '未设接口'));
        strip.appendChild(card);
      }
    }
    row.appendChild(strip);

    row.addEventListener('dblclick', () => {
      if (!r.active) doSwitch(r.role);
    });
    box.appendChild(row);
  }

  const n = wb.monitors ? wb.monitors.length : 0;
  $('#wbNote').textContent = n ? `${n} 块显示器` : '未检测到显示器';
}

/* ---------------- 显示器与接口 ---------------- */

function chipItemsFor(current, m) {
  const items = ((S.inputs && S.inputs.presets) || []).map((p) => ({ value: p.value, label: p.label }));
  for (const v of [m.local.value, m.remote.value, current]) {
    if (v && !items.some((i) => i.value === v)) items.push({ value: v, label: hexLabel(v) });
  }
  items.push({ value: '', label: '不切' });
  return items;
}

function buildMonitorList(s) {
  const ml = $('#monitorList');
  const wb = s.workbench || {};
  const rows = wb.monitors || [];
  const localLabel = s.computers.local.label;
  const remoteLabel = s.computers.remote.label;

  const sig = rows
    .map((m) => `${m.id}|${m.name}|${m.currentInputLabel}|${m.owner}|${m.local.value}|${m.remote.value}|${m.switchable}`)
    .join(',');
  if (ml.dataset.sig === sig) return;
  ml.dataset.sig = sig;
  ml.innerHTML = '';

  if (!rows.length) {
    ml.appendChild(el('div', 'empty', '未检测到显示器，点右上角「重新检测」。'));
    return;
  }

  for (const m of rows) {
    const item = el('div', 'monitor-item');
    item.dataset.mon = m.id;

    const head = el('div', 'mon-head');
    const ico = el('span', 'mon-ico');
    ico.innerHTML = ICON_MON;
    head.appendChild(ico);

    const main = el('div', 'mon-main');
    main.appendChild(el('b', '', m.name));
    let stateText = m.currentInputLabel ? `当前输入：${m.currentInputLabel}` : '当前输入：未知';
    if (m.owner === 'local') stateText += ` · 正显示 ${localLabel}`;
    else if (m.owner === 'remote') stateText += ` · 正显示 ${remoteLabel}`;
    main.appendChild(el('em', '', stateText));
    head.appendChild(main);

    const actions = el('div', 'mon-actions');
    for (const role of ['local', 'remote']) {
      const isLocal = role === 'local';
      const label = isLocal ? localLabel : remoteLabel;
      const b = el('button', 'btn btn-mini', `切到 ${label}`);
      b.disabled = !m.switchable || m.owner === role;
      b.addEventListener('click', () => push(window.api.switchMonitor(m.id, role)));
      actions.appendChild(b);
    }
    head.appendChild(actions);
    item.appendChild(head);

    const ioRows = [
      { key: 'local', label: localLabel, cur: m.local },
      { key: 'remote', label: remoteLabel, cur: m.remote }
    ];
    for (const r of ioRows) {
      const line = el('div', 'mon-io');
      const role = el('span', 'mon-io-role', r.label);
      role.title = r.label;
      line.appendChild(role);
      const chips = el('div', 'chips');
      for (const it of chipItemsFor(m.currentInput || '', m)) {
        const b = el('button', 'chip', it.label);
        b.dataset.value = it.value;
        b.dataset.role = r.key;
        if (it.value === r.cur.value) b.classList.add('is-on');
        if (it.value && it.value === m.currentInput) b.classList.add('is-cur');
        b.addEventListener('click', () => push(window.api.selectMonitorInput(m.id, r.key, it.value)));
        chips.appendChild(b);
      }
      line.appendChild(chips);
      item.appendChild(line);
    }
    ml.appendChild(item);
  }
}

/* ---------------- 渲染：切换电脑 ---------------- */

function renderSwitch(s) {
  buildWorkbench(s);
  buildMonitorList(s);

  // 快捷键
  setOptions($('#hotkeySelect'), HOTKEYS.map((k) => ({ value: k, label: hotkeyLabel(k) })), s.hotkey.key);
  $('#hotkeyEnabled').checked = !!s.hotkey.enabled;
  $('#hotkeySelect').disabled = !s.hotkey.enabled;
  $('#hotkeyHint').textContent = s.hotkey.enabled
    ? `已启用 ${hotkeyLabel(s.hotkey.key)} · 关闭窗口后仍有效。`
    : '全局快捷键未启用，仅可用界面按钮切换。';

  $('#launchAtLogin').checked = !!s.launchAtLogin;

  // DDC 状态
  const hint = $('#ddcHint');
  const ddcOk = s.ddc && s.ddc.available;
  const nMon = (s.workbench && s.workbench.monitors) ? s.workbench.monitors.length : 0;
  hint.textContent = ddcOk
    ? `${nMon} 块显示器均已就绪 · 点「切到」只动那一块屏`
    : `DDC 不可用${s.ddc && s.ddc.error ? `（${s.ddc.error}）` : ''} · 请在显示器菜单里开启 DDC/CI`;
  hint.className = ddcOk ? 'hint' : 'hint warn-text';

  // 一键切换
  const btn = $('#switchBtn');
  const localLabel = s.computers.local.label;
  const goingTo = s.active === 'local' ? s.computers.remote.label : localLabel;
  btn.textContent = `一键切换全部显示器 → ${goingTo}`;
  btn.dataset.target = s.active === 'local' ? 'remote' : 'local';

  // 状态行
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

/* ---------------- 渲染：传输与剪贴板 ---------------- */

const STATUS_TEXT = {
  waiting: '等待对方接收…',
  sending: '发送中',
  receiving: '接收中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
  rejected: '对方已拒绝'
};

function renderPeers(s) {
  const box = $('#peerChips');
  const peers = (s.connection && s.connection.peers) || [];
  const target = (s.files && s.files.target) || '';
  const sig = peers.map((p) => p.name).join(',') + '|' + target;
  if (box.dataset.sig !== sig) {
    box.innerHTML = '';
    if (!peers.length) {
      box.appendChild(el('div', 'peers-empty', '未连接 · 让另一台电脑也打开本软件，同一局域网会自动发现'));
    } else {
      for (const p of peers) {
        const b = el('button', 'peer-chip');
        b.dataset.name = p.name;
        if (p.name === target) b.classList.add('is-on');
        b.innerHTML = '<span class="dot"></span><span class="nm"></span><span class="tag"></span>';
        b.querySelector('.nm').textContent = p.name;
        b.querySelector('.tag').textContent = p.platform === 'darwin' ? 'Mac' : p.platform === 'win32' ? 'Windows' : '';
        b.addEventListener('click', () => push(window.api.setTargetPeer(p.name)));
        box.appendChild(b);
      }
    }
    box.dataset.sig = sig;
  }
  $('#dzPeer').textContent = target ? `发送到 ${target}` : '未连接 · 等待另一台电脑';
}

function renderShare(s) {
  const c = s.clipboard;
  const f = s.files || { transfers: [], recvDir: '' };

  $('#clipEnabled').checked = !!c.enabled;
  $('#fileRecvDir').value = f.recvDir || '';
  $('#askLarge').checked = c.askLarge !== false;
  $('#autoAccept').checked = !!f.autoAccept;

  const banner = $('#pairBanner');
  const connected = s.connection.connected;
  banner.classList.toggle('warn', !connected);
  $('#pairTitle').textContent = connected ? `已连接 · ${s.connection.peers[0].name}` : '未连接 · 等待局域网发现';
  $('#pairSub').textContent = connected
    ? (c.enabled
      ? '双向连接已验证 · A 电脑复制，B 电脑直接粘贴；文件与文字也能直接发。'
      : '双向连接已验证 · 剪贴板同步当前关闭，但文件与文字仍可发送。')
    : '两台电脑连同一个 Wi-Fi 或网线，都打开本软件即可自动连接，无需配对码。';

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
      node.innerHTML = '<div class="tx-head"><span class="tx-dir"></span><b></b><span class="tx-size"></span></div><div class="tx-bar"><i></i></div><div class="tx-foot"><span class="tx-state"></span><span class="tx-extra"></span></div>';
      list.prepend(node);
    }
    const pct = t.size ? Math.min(100, Math.round((t.done / t.size) * 100)) : (t.status === 'done' ? 100 : 0);
    node.classList.toggle('done', t.status === 'done');
    node.classList.toggle('failed', t.status === 'failed' || t.status === 'rejected');
    node.querySelector('.tx-dir').textContent = t.dir === 'in' ? '接收' : '发送';
    node.querySelector('b').textContent = t.name || '未命名';
    node.querySelector('.tx-size').textContent = fmtSize(t.size);
    node.querySelector('.tx-bar i').style.width = `${pct}%`;
    node.querySelector('.tx-state').textContent = `${STATUS_TEXT[t.status] || t.status}${t.size ? ` · ${pct}%` : ''}`;

    const extra = node.querySelector('.tx-extra');
    if (t.status === 'sending' || t.status === 'receiving' || t.status === 'waiting') {
      if (!extra.querySelector('button')) {
        const b = el('button', 'tx-act', '取消');
        b.addEventListener('click', () => push(window.api.cancelTransfer(t.id)));
        extra.innerHTML = '';
        extra.appendChild(b);
      }
    } else if (t.status === 'done' && t.dir === 'in' && t.path) {
      if (!extra.querySelector('button')) {
        const b = el('button', 'tx-act', '在文件夹中显示');
        b.addEventListener('click', () => window.api.revealFile(t.path));
        extra.innerHTML = '';
        extra.appendChild(b);
      }
    } else {
      extra.textContent = t.error || '';
    }
  }

  Array.from(list.children).forEach((c) => {
    const id = c.dataset && c.dataset.id;
    if (id && !seen.has(id)) c.remove();
  });
}

/* ---------------- 渲染：共用键鼠 ---------------- */

function renderInput(s) {
  const local = s.computers.local;
  const remote = s.computers.remote;
  const st = s.input || {};

  $$('#modeList .mode').forEach((n) => {
    n.classList.toggle('is-on', n.dataset.mode === s.inputMode);
  });

  $('#modeLocalTitle').textContent = `共用 ${local.label} 的键鼠`;
  $('#modeLocalDesc').textContent = `${local.label} 的键鼠跟随画面，控制当前电脑`;
  $('#modeRemoteTitle').textContent = `共用 ${remote.label} 的键鼠`;
  $('#modeRemoteDesc').textContent = `${remote.label} 的键鼠跟随画面，控制当前电脑`;

  // 边缘切换
  $('#edgeSwitch').checked = st.edgeSwitch !== false;
  $$('#edgeSideSeg button').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.side === (st.edgeSide || 'right'));
    b.disabled = st.edgeSwitch === false;
  });

  // 按键映射
  $$('#modSeg button').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.mod === (st.modMap || 'cmd-ctrl'));
  });
  $('#modHint').textContent = st.modDesc || '';
  $('#keyDebug').checked = !!st.keyDebug;

  // 权限：只在真正捕获失败时才报警（未签名应用的系统 API 常误报未授权）
  const granted = s.permission.accessibility;
  const capturing = !!st.capturing;
  const line = $('#permLine');
  line.classList.toggle('bad', !granted);
  $('#permMark').textContent = granted ? '✓' : '!';

  if (!s.isMac) {
    $('#permText').textContent = capturing ? '键鼠控制已就绪' : 'Windows 无需额外权限';
  } else if (granted) {
    $('#permText').textContent = capturing ? '键鼠控制已就绪' : '各用各的键鼠 · 无需额外权限';
  } else {
    $('#permText').textContent = st.error
      ? `键鼠捕获未启动：${st.error}`
      : 'Mac 辅助功能未授权，键鼠无法控制另一台';
  }
  $('#openPerm').style.display = s.isMac && !granted ? '' : 'none';

  const currentLabel = s.active === 'local' ? local.label : remote.label;
  $('#currentScreen').textContent = currentLabel;
  $('#currentHost').textContent = s.inputMode === 'local'
    ? local.label
    : s.inputMode === 'remote' ? remote.label : '各自独立';
}

/* ---------------- 总渲染 ---------------- */

function apply(s) {
  S = s;
  document.body.classList.toggle('win', !s.isMac);
  const connected = s.connection.connected;
  $('#netDot').classList.toggle('ok', connected);
  $('#netText').textContent = connected ? `${s.connection.peers[0].name} 已连接` : '未连接 · 等待另一台电脑';
  $('#footVer').textContent = `v${s.version}`;

  renderSwitch(s);
  renderShare(s);
  renderInput(s);
}

/* ---------------- 事件 ---------------- */

function bindTabs() {
  $$('#tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('#tabs .tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab));
    });
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

async function doSwitch(role, btn) {
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '切换中…'; }
  try {
    const r = await window.api.switchTo(role);
    if (r && r.state) apply(r.state);
  } finally {
    if (btn) { btn.textContent = old; btn.disabled = false; }
  }
}

function bindSwitchPanel() {
  $('#redetectBtn').addEventListener('click', () => push(window.api.detectMonitor()));

  $('#hotkeyEnabled').addEventListener('change', (e) => {
    push(window.api.setHotkey(e.target.checked, $('#hotkeySelect').value));
  });
  $('#hotkeySelect').addEventListener('change', (e) => {
    push(window.api.setHotkey(true, e.target.value));
  });

  $('#launchAtLogin').addEventListener('change', (e) => push(window.api.setLaunchAtLogin(e.target.checked)));

  $('#switchBtn').addEventListener('click', (e) => {
    const role = e.currentTarget.dataset.target || 'remote';
    doSwitch(role, e.currentTarget);
  });
}

function bindSharePanel() {
  $('#clipEnabled').addEventListener('change', (e) => push(window.api.setClipboardSync(e.target.checked)));
  $('#askLarge').addEventListener('change', (e) => push(window.api.setAskLarge(e.target.checked)));
  $('#autoAccept').addEventListener('change', (e) => push(window.api.setAutoAccept(e.target.checked)));

  $('#fileRecvChoose').addEventListener('click', () => push(window.api.setRecvDir()));
  $('#fileRecvOpen').addEventListener('click', () => push(window.api.openRecvDir()));

  const target = () => (S && S.files && S.files.target) || '';

  $('#pickFiles').addEventListener('click', (e) => {
    e.stopPropagation();
    push(window.api.pickFiles(target()));
  });

  const sendTextNow = () => {
    const input = $('#textInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    push(window.api.sendText(text, target()));
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
    if (paths.length) push(window.api.sendPaths(paths, target()));
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

function bindInputPanel() {
  $$('#modeList .mode').forEach((btn) => {
    btn.addEventListener('click', () => push(window.api.setInputMode(btn.dataset.mode)));
  });
  $('#openPerm').addEventListener('click', () => push(window.api.openAccessibility()));

  $('#edgeSwitch').addEventListener('change', (e) => push(window.api.setEdgeSwitch(e.target.checked)));
  $$('#edgeSideSeg button').forEach((b) => {
    b.addEventListener('click', () => push(window.api.setEdgeSide(b.dataset.side)));
  });
  $$('#modSeg button').forEach((b) => {
    b.addEventListener('click', () => push(window.api.setModMap(b.dataset.mod)));
  });
  $('#keyDebug').addEventListener('change', (e) => push(window.api.setKeyDebug(e.target.checked)));
}

function bindFooter() {
  $('#helpBtn').addEventListener('click', () => window.api.help());
}

/* ---------------- 启动 ---------------- */

(async function init() {
  bindTabs();
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
})();
