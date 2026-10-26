'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const HOTKEYS = [
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'CommandOrControl+Alt+F12',
  'CommandOrControl+Shift+Space'
];

let S = null;
let speedTimer = null;

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

/* ---------------- 渲染 ---------------- */

function renderHeader(s) {
  const dot = $('#netDot');
  const txt = $('#netText');
  const connected = s.connection.connected;
  dot.classList.toggle('ok', connected);
  txt.textContent = connected ? `${s.connection.peers[0].name} 已连接` : '未配对 · 等待另一台电脑';
  $('#footVer').textContent = `v${s.version}`;
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

  // 显示器：直接列出全部（不用下拉框）
  const ml = $('#monitorList');
  const sig = s.monitor.list.map((m) => `${m.id}|${m.name}|${m.currentInputLabel || ''}|${m.index}`).join(',');
  if (ml.dataset.sig !== sig) {
    ml.innerHTML = '';
    for (const m of s.monitor.list) {
      const item = document.createElement('div');
      item.className = 'monitor-item';
      item.innerHTML = '<span class="mon-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.6"/><path d="M9 20h6M12 16v4"/></svg></span><div class="mon-main"><b></b><em></em></div><span class="mon-tag"></span>';
      item.querySelector('b').textContent = m.name;
      item.querySelector('em').textContent = m.currentInputLabel ? `当前输入：${m.currentInputLabel}` : '当前输入：未知';
      const tag = item.querySelector('.mon-tag');
      const hasDdc = typeof m.index === 'number';
      tag.className = `mon-tag ${hasDdc ? 'ok' : 'no'}`;
      tag.textContent = hasDdc ? 'DDC' : '无 DDC';
      ml.appendChild(item);
    }
    ml.dataset.sig = sig;
  }

  const monItems = s.monitor.list.map((m) => ({
    value: m.id,
    label: m.serial ? `${m.name} · ${m.serial}` : m.name
  }));
  setOptions($('#monitorSelect2'), monItems, s.monitor.selectedId);

  // 接口
  const inputItems = s.inputs.presets.map((p) => ({ value: p.value, label: p.label }));
  setOptions($('#remoteInputSelect'), inputItems, s.inputs.remote.value);
  setOptions($('#localInputSelect'), inputItems, s.inputs.local.value);
  $('#remoteInputLabel').textContent = `${remote.label} 所在接口`;

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
  parts.push(ddcOk ? 'DDC 可用' : `DDC 不可用${s.ddc && s.ddc.error ? `（${s.ddc.error}）` : ''}`);
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
  const lines = (s.statusLines || []).slice(0, 2);
  if (!lines.length) {
    block.innerHTML = `<span>设置已保存 · ${s.inputs.remote.label}</span>`;
  } else {
    for (const it of lines) {
      const div = document.createElement('div');
      div.className = it.kind === 'warn' ? 'warn' : it.kind === 'ok' ? 'ok' : '';
      div.textContent = it.text;
      block.appendChild(div);
    }
  }
}

function renderClip(s) {
  const c = s.clipboard;
  $('#clipEnabled').checked = !!c.enabled;
  $('#usePassword').checked = !!c.usePassword;
  $('#passwordInput').value = c.password || '';
  $('#passwordInput').disabled = !c.usePassword;
  $('#receiveDir').value = c.receiveDir || '';
  $('#askLarge').checked = !!c.askLarge;

  const banner = $('#pairBanner');
  const connected = s.connection.connected;
  banner.classList.toggle('warn', !connected);
  $('#pairTitle').textContent = connected ? '配对成功 · 已连接' : '等待配对 · 未连接';
  $('#pairSub').textContent = connected
    ? `双向连接已验证，可以复制文字、截图、图片、文件和文件夹。`
    : '请让另一台电脑打开本软件并填入相同的 6 位密码，同一局域网会自动连接。';

  const pct = Math.max(0, Math.min(100, c.percent || 0));
  $('#progressFill').style.width = `${pct}%`;
  $('#progressNum').textContent = `${pct}%`;

  $('#clipHint').textContent = s.isMac
    ? '已放入剪贴板，可以 ⌘V 粘贴。文件请粘贴到访达（Finder）文件夹。'
    : '已放入剪贴板，可以 Ctrl+V 粘贴。文件请粘贴到资源管理器文件夹。';
}

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

  const permLine = $('#permMark').parentElement;
  const granted = s.permission.accessibility;
  permLine.classList.toggle('bad', !granted);
  $('#permMark').textContent = granted ? '✓' : '!';
  if (s.isMac) {
    $('#permText').textContent = granted ? 'Mac 辅助功能已授权' : 'Mac 辅助功能未授权，键鼠无法控制';
  } else {
    $('#permText').textContent = 'Windows 无需额外权限，已就绪';
  }
  $('#openPerm').style.display = s.isMac ? '' : 'none';

  const currentLabel = s.active === 'local' ? local.label : remote.label;
  $('#currentScreen').textContent = currentLabel;
  $('#hostCardLabel').textContent = `${local.label} 显示器与鼠标`;

  const speed = Number(s.mouseSpeed) || 1;
  if (document.activeElement !== $('#speedRange')) {
    $('#speedRange').value = speed;
  }
  $('#speedVal').textContent = `${speed.toFixed(1)}×`;
  paintRange(speed);
}

function paintRange(v) {
  const el = $('#speedRange');
  const pct = ((Number(v) - 0.5) / 1.5) * 100;
  el.style.background = `linear-gradient(90deg, #5b8cf0 0%, #7aa5ff ${pct}%, rgba(255,255,255,0.14) ${pct}%)`;
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

const STATUS_TEXT = {
  waiting: '等待对方接收…',
  sending: '发送中',
  receiving: '接收中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消'
};

function renderFile(s) {
  const f = s.files || { transfers: [], recvDir: '' };
  const peers = (s.connection && s.connection.peers) || [];
  $('#fileRecvDir').value = f.recvDir || '';
  $('#dzPeer').textContent = peers.length
    ? `发送到 ${peers[0].name}`
    : '未连接 · 请让另一台电脑打开本软件并填入相同密码';

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
    el.classList.toggle('failed', t.status === 'failed');
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
    } else if (t.status === 'done' && t.dir === 'in') {
      if (!extra.querySelector('button')) {
        extra.innerHTML = '<button class="tx-act" data-reveal="1">在文件夹中显示</button>';
        extra.querySelector('button').addEventListener('click', () => window.api.revealFile(t.path || f.recvDir));
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

function apply(s) {
  S = s;
  document.body.classList.toggle('win', !s.isMac);
  renderHeader(s);
  renderSwitch(s);
  renderClip(s);
  renderInput(s);
  renderFile(s);
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
  $('#monitorSelect2').addEventListener('change', (e) => push(window.api.selectMonitor(e.target.value)));
  $('#redetectBtn').addEventListener('click', () => push(window.api.detectMonitor()));
  $('#redetectBtn2').addEventListener('click', () => push(window.api.detectMonitor()));

  $('#remoteInputSelect').addEventListener('change', (e) => push(window.api.selectInput('remote', e.target.value)));
  $('#localInputSelect').addEventListener('change', (e) => push(window.api.selectInput('local', e.target.value)));

  $('#hotkeyEnabled').addEventListener('change', (e) => {
    push(window.api.setHotkey(e.target.checked, $('#hotkeySelect').value));
  });
  $('#hotkeySelect').addEventListener('change', (e) => {
    push(window.api.setHotkey(true, e.target.value));
  });

  $('#launchAtLogin').addEventListener('change', (e) => push(window.api.setLaunchAtLogin(e.target.checked)));

  $('#switchBtn').addEventListener('click', async (e) => {
    const role = e.currentTarget.dataset.target || 'remote';
    const r = await window.api.switchTo(role);
    if (r && r.state) apply(r.state);
  });

  // 双击工作台里的电脑直接切过去
  $('#devLocal').addEventListener('dblclick', () => push(window.api.switchTo('local')));
  $('#devRemote').addEventListener('dblclick', () => push(window.api.switchTo('remote')));
}

function bindFilePanel() {
  $('#pickFiles').addEventListener('click', (e) => {
    e.stopPropagation();
    push(window.api.pickFiles());
  });
  $('#fileRecvChoose').addEventListener('click', () => push(window.api.setRecvDir()));
  $('#fileRecvOpen').addEventListener('click', () => push(window.api.openRecvDir()));

  const sendTextNow = () => {
    const el = $('#textInput');
    const text = el.value.trim();
    if (!text) return;
    el.value = '';
    push(window.api.sendText(text));
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
    if (paths.length) push(window.api.sendPaths(paths));
  });
  // 防止把文件拖到别处时窗口直接打开它
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

function bindClipPanel() {
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

  $$('[data-dir]').forEach((btn) => {
    btn.addEventListener('click', () => push(window.api.clipDir(btn.dataset.dir)));
  });

  $('#askLarge').addEventListener('change', () => {
    // 与「保存并连接」一起落盘的轻量项：直接走保存
    push(window.api.clipSaveConnect());
  });

  $('#saveConnect').addEventListener('click', () => push(window.api.clipSaveConnect()));
  $('#cancelTransfer').addEventListener('click', () => push(window.api.clipCancel()));
  $('#useRecent').addEventListener('click', () => push(window.api.clipDir('open')));
}

function bindInputPanel() {
  $$('#modeList .mode').forEach((btn) => {
    btn.addEventListener('click', () => push(window.api.setInputMode(btn.dataset.mode)));
  });

  $('#openPerm').addEventListener('click', () => push(window.api.openAccessibility()));

  const range = $('#speedRange');
  range.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#speedVal').textContent = `${v.toFixed(1)}×`;
    paintRange(v);
    clearTimeout(speedTimer);
    speedTimer = setTimeout(() => push(window.api.setMouseSpeed(v)), 180);
  });
}

function bindFooter() {
  $('#helpBtn').addEventListener('click', () => window.api.help());
}

/* ---------------- 启动 ---------------- */

(async function init() {
  bindTabs();
  bindSwitchPanel();
  bindClipPanel();
  bindInputPanel();
  bindFilePanel();
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
