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

  // 显示器
  const monItems = s.monitor.list.map((m) => ({
    value: m.id,
    label: m.serial ? `${m.name} · ${m.serial}` : m.name
  }));
  setOptions($('#monitorSelect'), monItems, s.monitor.selectedId);
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

function apply(s) {
  S = s;
  document.body.classList.toggle('win', !s.isMac);
  renderHeader(s);
  renderSwitch(s);
  renderClip(s);
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
  $('#monitorSelect').addEventListener('change', (e) => push(window.api.selectMonitor(e.target.value)));
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
