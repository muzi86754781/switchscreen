'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const HOTKEYS = [
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'CommandOrControl+Shift+F12',
  'CommandOrControl+Alt+F12',
  'CommandOrControl+Shift+Space'
];

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
  return String(v).toLowerCase().replace('0x', '0x');
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

/* ---------------- 渲染：切换电脑 ---------------- */

const MON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.6"/><path d="M9 20h6M12 16v4"/></svg>';

function chipItemsFor(current, pm) {
  const items = ((S.inputs && S.inputs.presets) || []).map((p) => ({ value: p.value, label: p.label }));
  for (const v of [pm.local, pm.remote, current]) {
    if (v && !items.some((i) => i.value === v)) {
      items.push({ value: v, label: hexLabel(v) });
    }
  }
  // 「不切」：这台显示器不跟着切换（例如它只接了其中一台电脑）
  items.push({ value: '', label: '不切' });
  return items;
}

function buildMonitorList(s) {
  const ml = $('#monitorList');
  const pmMap = (s.inputs && s.inputs.perMonitor) || {};
  const sig = s.monitor.list
    .map((m) => {
      const pm = pmMap[m.id] || {};
      return `${m.id}|${m.name}|${m.currentInputLabel || ''}|${m.index}|${pm.local}|${pm.remote}`;
    })
    .join(',');

  if (ml.dataset.sig === sig) return;
  ml.innerHTML = '';

  for (const m of s.monitor.list) {
    const pm = pmMap[m.id] || { local: '', remote: '' };
    const hasDdc = typeof m.index === 'number';

    const item = document.createElement('div');
    item.className = 'monitor-item';
    item.dataset.mon = m.id;

    const head = document.createElement('div');
    head.className = 'mon-head';
    head.innerHTML = `<span class="mon-ico">${MON_ICON}</span>
      <div class="mon-main"><b></b><em></em></div>
      <span class="mon-tag ${hasDdc ? 'ok' : 'no'}">${hasDdc ? 'DDC' : '无 DDC'}</span>`;
    head.querySelector('b').textContent = m.name;
    head.querySelector('em').textContent = m.currentInputLabel
      ? `当前输入：${m.currentInputLabel}`
      : '当前输入：未知';
    item.appendChild(head);

    const roles = [
      { key: 'local', label: '本机', value: pm.local },
      { key: 'remote', label: '对端', value: pm.remote }
    ];
    for (const r of roles) {
      const row = document.createElement('div');
      row.className = 'mon-io';
      const role = document.createElement('span');
      role.className = 'mon-io-role';
      role.textContent = r.label;
      const chips = document.createElement('div');
      chips.className = 'chips';
      for (const it of chipItemsFor(m.currentInput || '', pm)) {
        const b = document.createElement('button');
        b.className = 'chip';
        b.dataset.value = it.value;
        b.dataset.role = r.key;
        if (it.value === r.value) b.classList.add('is-on');
        if (it.value && it.value === m.currentInput) b.classList.add('is-cur');
        b.textContent = it.label;
        b.addEventListener('click', () => {
          push(window.api.selectMonitorInput(m.id, r.key, it.value));
        });
        chips.appendChild(b);
      }
      row.appendChild(role);
      row.appendChild(chips);
      item.appendChild(row);
    }
    ml.appendChild(item);
  }
  ml.dataset.sig = sig;
}

function renderSwitch(s) {
  const local = s.computers.local;
  const remote = s.computers.remote;

  $('#devLocalName').textContent = local.label;
  $('#devRemoteName').textContent = remote.connected ? remote.label : '其它电脑';
  $('#devRemoteRole').textContent = remote.connected ? remote.name : '另一台电脑';
  $('#devRemote').classList.toggle('is-on', remote.connected);

  // 当前是哪台，就用颜色标注哪台
  const localActive = s.active === 'local';
  $('#devLocal').classList.toggle('is-active', localActive);
  $('#devRemote').classList.toggle('is-active', !localActive);
  $('#devLocalBadge').style.display = localActive ? '' : 'none';
  $('#devRemoteBadge').style.display = localActive ? 'none' : '';

  buildMonitorList(s);

  // 快捷键
  setOptions($('#hotkeySelect'), HOTKEYS.map((k) => ({ value: k, label: hotkeyLabel(k) })), s.hotkey.key);
  $('#hotkeyEnabled').checked = !!s.hotkey.enabled;
  $('#hotkeySelect').disabled = !s.hotkey.enabled;
  $('#hotkeyHint').textContent = s.hotkey.enabled
    ? `已启用 ${hotkeyLabel(s.hotkey.key)} · 关闭窗口后仍有效。`
    : '全局快捷键未启用，仅可用界面按钮切换。';

  $('#launchAtLogin').checked = !!s.launchAtLogin;

  // DDC 状态与当前输入源
  const hint = $('#ddcHint');
  const curLabel = s.monitor.currentInputLabel;
  const ddcOk = s.ddc && s.ddc.available;
  const parts = [];
  if (curLabel) parts.push(`当前输入：${curLabel}`);
  parts.push(ddcOk ? 'DDC 可用 · 切换时所有显示器一起切' : `DDC 不可用${s.ddc && s.ddc.error ? `（${s.ddc.error}）` : ''}`);
  hint.textContent = parts.join(' · ');
  hint.className = ddcOk ? 'hint' : 'hint warn-text';

  // 切换按钮
  const btn = $('#switchBtn');
  const goingTo = s.active === 'local' ? remote.label : local.label;
  btn.textContent = `切换到 ${goingTo}`;
  btn.dataset.target = s.active === 'local' ? 'remote' : 'local';

  // 状态行
  const block = $('#switchStatus');
  block.innerHTML = '';
  const lines = (s.statusLines || []).slice(0, 3);
  if (!lines.length) {
    block.innerHTML = '<span>准备就绪</span>';
  } else {
    for (const it of lines) {
      const div = document.createElement('div');
      div.className = it.kind === 'warn' ? 'warn' : it.kind === 'ok' ? 'ok' : '';
      div.textContent = it.text;
      block.appendChild(div);
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
      const e = document.createElement('div');
      e.className = 'peers-empty';
      e.textContent = '未连接 · 请让另一台电脑打开本软件并填入相同密码';
      box.appendChild(e);
    } else {
      for (const p of peers) {
        const b = document.createElement('button');
        b.className = 'peer-chip';
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
  $('#dzPeer').textContent = target
    ? `发送到 ${target}`
    : '未连接 · 请让另一台电脑打开本软件并填入相同密码';
}

function renderShare(s) {
  const c = s.clipboard;
  const f = s.files || { transfers: [], recvDir: '' };

  $('#clipEnabled').checked = !!c.enabled;
  $('#usePassword').checked = !!c.usePassword;
  $('#passwordInput').value = c.password || '';
  $('#passwordInput').disabled = !c.usePassword;
  $('#fileRecvDir').value = f.recvDir || '';
  $('#askLarge').checked = c.askLarge !== false;
  $('#autoAccept').checked = !!f.autoAccept;

  const banner = $('#pairBanner');
  const connected = s.connection.connected;
  banner.classList.toggle('warn', !connected);
  $('#pairTitle').textContent = connected ? '配对成功 · 已连接' : '等待配对 · 未连接';
  $('#pairSub').textContent = connected
    ? (c.enabled
      ? '双向连接已验证 · A 电脑复制，B 电脑直接粘贴；文件与文字也能直接发。'
      : '双向连接已验证 · 剪贴板同步当前关闭，但文件与文字仍可发送。')
    : '请让另一台电脑打开本软件并填入相同的 6 位密码，同一局域网会自动连接。';

  renderPeers(s);
  renderTransfers(s);
}

function renderTransfers(s) {
  const f = s.files || { transfers: [], recvDir: '' };
  const list = $('#txList');
  const transfers = f.transfers || [];
  const summary = $('#txSummary');
  summary.textContent = transfers.length ? `最近 ${transfers.length} 条` : '';

  if (!transfers.length) {
    if (!list.querySelector('.empty')) list.innerHTML = '<div class="empty">还没有传输记录</div>';
    return;
  }
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();

  const seen = new Set();
  for (const t of transfers) {
    seen.add(t.id);
    let el = list.querySelector(`[data-id="${t.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tx';
      el.dataset.id = t.id;
      el.innerHTML = '<div class="tx-head"><span class="tx-dir"></span><b></b><span class="tx-size"></span></div><div class="tx-bar"><i></i></div><div class="tx-foot"><span class="tx-state"></span><span class="tx-extra"></span></div>';
      list.prepend(el);
    }
    const pct = t.size ? Math.min(100, Math.round((t.done / t.size) * 100)) : (t.status === 'done' ? 100 : 0);
    el.classList.toggle('done', t.status === 'done');
    el.classList.toggle('failed', t.status === 'failed' || t.status === 'rejected');
    el.querySelector('.tx-dir').textContent = t.dir === 'in' ? '接收' : '发送';
    el.querySelector('b').textContent = t.name || '未命名';
    el.querySelector('.tx-size').textContent = fmtSize(t.size);
    el.querySelector('.tx-bar i').style.width = `${pct}%`;
    el.querySelector('.tx-state').textContent = `${STATUS_TEXT[t.status] || t.status}${t.size ? ` · ${pct}%` : ''}`;

    const extra = el.querySelector('.tx-extra');
    if (t.status === 'sending' || t.status === 'receiving' || t.status === 'waiting') {
      if (!extra.querySelector('button')) {
        extra.innerHTML = '<button class="tx-act" data-cancel="1">取消</button>';
        extra.querySelector('button').addEventListener('click', () => push(window.api.cancelTransfer(t.id)));
      }
    } else if (t.status === 'done' && t.dir === 'in' && t.path) {
      if (!extra.querySelector('button')) {
        extra.innerHTML = '<button class="tx-act" data-reveal="1">在文件夹中显示</button>';
        extra.querySelector('button').addEventListener('click', () => window.api.revealFile(t.path));
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

  $$('#modeList .mode').forEach((el) => {
    el.classList.toggle('is-on', el.dataset.mode === s.inputMode);
  });

  $('#modeLocalTitle').textContent = `共用 ${local.label} 的键鼠`;
  $('#modeLocalDesc').textContent = `${local.label} 的键鼠跟随画面，控制当前电脑`;
  $('#modeRemoteTitle').textContent = `共用 ${remote.label} 的键鼠`;
  $('#modeRemoteDesc').textContent = `${remote.label} 的键鼠跟随画面，控制当前电脑`;

  // 权限：只在真正捕获失败时才报警（未签名应用的系统 API 常误报未授权）
  const st = s.inputState || {};
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
}

/* ---------------- 总渲染 ---------------- */

function apply(s) {
  S = s;
  document.body.classList.toggle('win', !s.isMac);
  const connected = s.connection.connected;
  $('#netDot').classList.toggle('ok', connected);
  $('#netText').textContent = connected ? `${s.connection.peers[0].name} 已连接` : '未配对 · 等待另一台电脑';
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

function bindSwitchPanel() {
  $('#redetectBtn').addEventListener('click', () => push(window.api.detectMonitor()));

  $('#hotkeyEnabled').addEventListener('change', (e) => {
    push(window.api.setHotkey(e.target.checked, $('#hotkeySelect').value));
  });
  $('#hotkeySelect').addEventListener('change', (e) => {
    push(window.api.setHotkey(true, e.target.value));
  });

  $('#launchAtLogin').addEventListener('change', (e) => push(window.api.setLaunchAtLogin(e.target.checked)));

  $('#switchBtn').addEventListener('click', async (e) => {
    const role = e.currentTarget.dataset.target || 'remote';
    e.currentTarget.disabled = true;
    try {
      const r = await window.api.switchTo(role);
      if (r && r.state) apply(r.state);
    } finally {
      e.currentTarget.disabled = false;
    }
  });

  // 双击工作台里的电脑直接切过去
  $('#devLocal').addEventListener('dblclick', () => push(window.api.switchTo('local').then((r) => (r && r.state) || null)));
  $('#devRemote').addEventListener('dblclick', () => push(window.api.switchTo('remote').then((r) => (r && r.state) || null)));
}

function bindSharePanel() {
  $('#clipEnabled').addEventListener('change', (e) => push(window.api.setClipboardSync(e.target.checked)));

  $('#usePassword').addEventListener('change', (e) => {
    push(window.api.setClipboardPassword(e.target.checked, $('#passwordInput').value));
  });

  const pw = $('#passwordInput');
  pw.addEventListener('input', () => {
    pw.value = pw.value.replace(/\D/g, '').slice(0, 6);
  });
  pw.addEventListener('change', () => {
    push(window.api.setClipboardPassword($('#usePassword').checked, pw.value));
  });

  $('#randomBtn').addEventListener('click', () => push(window.api.randomPassword()));

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
    const el = $('#textInput');
    const text = el.value.trim();
    if (!text) return;
    el.value = '';
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
  // 防止把文件拖到别处时窗口直接打开它
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

function bindInputPanel() {
  $$('#modeList .mode').forEach((btn) => {
    btn.addEventListener('click', () => push(window.api.setInputMode(btn.dataset.mode)));
  });
  $('#openPerm').addEventListener('click', () => push(window.api.openAccessibility()));
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
