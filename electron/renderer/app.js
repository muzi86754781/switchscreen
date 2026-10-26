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

const ICON_PC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.6"/><path d="M9 20h6M12 16v4"/></svg>';
const ICON_MAC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="12" rx="1.6"/><path d="M2 19.5h20"/></svg>';
const ICON_MON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="11" rx="1.6"/><path d="M8 20h8M12 16v4"/></svg>';

/* ---------------- 顶部连接状态 ---------------- */

function renderConn(s) {
  const c = s.connection || { count: 0, peers: [] };
  const connected = !!c.connected;

  $('#netDot').classList.toggle('ok', connected);
  $('#netText').textContent = connected ? `${c.count} 台设备在线` : '未连接';

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

/* ---------------- 键鼠模式（顶部 + 共用键鼠页共用一套按钮） ---------------- */

function renderModes(s) {
  const me = s.me ? s.me.name : '本机';
  const other = (s.connection && s.connection.peers[0] && (s.connection.peers[0].label || s.connection.peers[0].name)) || '对端';
  $$('[data-role="mode"] button').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.mode === s.inputMode);
  });
  const label = (b, mode) => {
    if (mode === 'local') return `共用 ${me} 键鼠`;
    if (mode === 'remote') return `共用 ${other} 键鼠`;
    return '各用各的';
  };
  $$('[data-role="mode"] button').forEach((b) => {
    b.textContent = label(b, b.dataset.mode);
  });

  const text = s.inputMode === 'separate'
    ? '两台电脑各用各的键盘鼠标，互不干扰。'
    : s.inputMode === 'local'
      ? `用 ${me} 接的键盘鼠标控制所有电脑；鼠标推到边缘就流到相邻设备。`
      : `用 ${other} 接的键盘鼠标控制所有电脑；本机只接收操作。`;
  if ($('#modeHint')) $('#modeHint').textContent = text;
  if ($('#inputModeHint')) $('#inputModeHint').textContent = text;
  if ($('#modeNote')) $('#modeNote').textContent = s.inputMode === 'separate' ? '互不干扰' : '一套键鼠走多台';
}

/* ---------------- 设备与显示器 ---------------- */

function monitorLetters(s) {
  const map = {};
  for (const m of (s.monitors || [])) map[m.id] = m.letter || '?';
  return map;
}

function buildWorkbench(s) {
  const box = $('#wbList');
  const devices = s.devices || [];
  const letters = monitorLetters(s);

  const sig = devices
    .map((d) => `${d.id}|${d.name}|${d.online}|${d.active}|` +
      d.monitors.map((m) => `${m.id}:${m.here}:${m.hasPort}:${m.port}`).join(','))
    .join(';');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = '';

  for (const d of devices) {
    const row = el('div', `wb-row${d.active ? ' is-active' : ''}${d.online ? '' : ' is-off'}`);

    /* 行首：图标 + 名字（本机可点开改名）+ 状态 */
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
    if (d.local) nameLine.appendChild(el('span', 'wb-chip quiet', '可改名'));
    idBox.appendChild(nameLine);
    idBox.appendChild(el('div', 'wb-sub', d.local ? `本机 · 正在这台电脑上操作` : (d.online ? '已连接 · 同局域网' : '离线')));
    head.appendChild(idBox);

    const right = el('div', 'wb-right');
    if (d.active) right.appendChild(el('span', 'wb-flag', '使用中'));
    const go = el('button', 'wb-go', d.active ? '当前' : '全部切到这台');
    go.type = 'button';
    go.disabled = d.active || !d.online;
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      switchToDevice(d.id);
    });
    right.appendChild(go);
    head.appendChild(right);
    row.appendChild(head);

    /* 行内：这台电脑在各块显示器上的落点 */
    const strip = el('div', 'wb-mons');
    if (!d.monitors.length) {
      strip.appendChild(el('div', 'wb-empty', '未检测到显示器'));
    } else {
      for (const m of d.monitors) {
        const here = m.here === true;
        const away = m.here === false;
        const tile = el('button', 'wb-mon' + (here ? ' is-here' : '') + (away ? ' is-away' : '') + (m.hasPort ? '' : ' is-noport'));
        tile.type = 'button';
        tile.dataset.mon = m.id;
        tile.dataset.device = d.id;

        const bar = el('span', 'wb-mon-bar');
        tile.appendChild(bar);

        const body = el('span', 'wb-mon-body');
        body.appendChild(el('span', 'wb-mon-name', `显示器 ${letters[m.id] || '?'} · ${m.name}`));
        let metaText;
        if (here) metaText = '正在显示这台';
        else if (!m.hasPort) metaText = '未设置接口 · 点齿轮配置';
        else if (away) metaText = `点一下切到这台 · ${m.port}`;
        else metaText = `接口 ${m.port}`;
        body.appendChild(el('span', 'wb-mon-meta', metaText));
        tile.appendChild(body);

        if (!here && m.hasPort) tile.appendChild(el('span', 'wb-mon-go', '切'));

        if (!here) {
          tile.title = m.hasPort
            ? `把「${m.name}」切到 ${d.name}（${m.port}）`
            : '先展开「接口映射」给这台电脑选一个口';
          tile.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!m.hasPort) { revealPorts(); return; }
            await switchMonitor(m.id, d.id, tile);
          });
        }
        strip.appendChild(tile);
      }
    }
    row.appendChild(strip);

    row.addEventListener('dblclick', () => {
      if (!d.active && d.online) switchToDevice(d.id);
    });
    box.appendChild(row);
  }

  const n = (s.monitors || []).length;
  const devs = devices.length;
  $('#wbNote').textContent = n ? `${devs} 台设备 · ${n} 块显示器` : '未检测到显示器';
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

/* ---------------- 接口映射（折叠的进阶设置） ---------------- */

function revealPorts() {
  const list = $('#monitorList');
  if (list) list.classList.remove('is-collapsed');
  const btn = $('#portToggle');
  if (btn) btn.textContent = '收起设置';
  if (list) list.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function chipItems(values) {
  const items = ((S && S.inputs && S.inputs.presets) || []).map((p) => ({ value: p.value, label: p.label }));
  for (const v of values) {
    if (v && !items.some((i) => i.value === v)) items.push({ value: v, label: hexLabel(v) });
  }
  items.push({ value: '', label: '不切' });
  return items;
}

function buildMonitorList(s) {
  const ml = $('#monitorList');
  if (!ml) return;
  const monitors = s.monitors || [];
  const devices = s.devices || [];
  const letters = monitorLetters(s);

  const sig = monitors
    .map((m) => `${m.id}|${m.name}|${m.ownerId}|` + devices.map((d) => `${d.id}:${(m.ports[d.id] || {}).value}`).join(','))
    .join(';');
  if (ml.dataset.sig === sig) return;
  ml.dataset.sig = sig;
  ml.innerHTML = '';

  if (!monitors.length) {
    ml.appendChild(el('div', 'empty', '未检测到显示器，点右上角「重新检测」。'));
    return;
  }

  for (const m of monitors) {
    const item = el('div', 'monitor-item');

    const head = el('div', 'mon-head');
    const ico = el('span', 'mon-ico');
    ico.innerHTML = ICON_MON;
    head.appendChild(ico);
    const main = el('div', 'mon-main');
    main.appendChild(el('b', '', `显示器 ${letters[m.id] || '?'} · ${m.name}`));
    main.appendChild(el('em', '', m.ownerLabel ? `正在显示 ${m.ownerLabel}` : '当前显示：未知（DDC 读不到）'));
    head.appendChild(main);
    item.appendChild(head);

    for (const d of devices) {
      const line = el('div', 'mon-io');
      const role = el('span', 'mon-io-role', d.name);
      role.title = d.name;
      line.appendChild(role);

      const chips = el('div', 'chips');
      const cur = (m.ports[d.id] || {}).value || '';
      for (const it of chipItems([cur])) {
        const b = el('button', 'chip', it.label);
        b.type = 'button';
        if (it.value === cur) b.classList.add('is-on');
        b.addEventListener('click', () => push(window.api.setPort(m.id, d.id, it.value)));
        chips.appendChild(b);
      }
      line.appendChild(chips);
      item.appendChild(line);
    }
    ml.appendChild(item);
  }
}

/* ---------------- 快捷键 ---------------- */

function buildHotkeys(s) {
  const hk = s.hotkeys || { enabled: true, global: 'F12', monitor: {}, choices: [] };
  const monitors = s.monitors || [];
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

  $('#hotkeyHint').textContent = hk.enabled
    ? `全部显示器切换：${hotkeyLabel(hk.global)} · 窗口关闭后仍然有效。某块屏专注用时可以直接用它的专属键。`
    : '全局快捷键未启用，只能用界面上的按钮切换。';
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
      const first = devices.find((d) => s.arrange.indexOf(d.id) === 0);
      hint.textContent = `当前从左到右：${s.arrange.map((id) => (devices.find((x) => x.id === id) || {}).name || id).join(' → ')}。`
        + '鼠标推到某台设备的右边缘，就流到它右边那台；推回左边缘就流回来。';
      if (first && first.local) hint.textContent += '';
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

  $('#currentScreen').textContent = s.activeName || '—';
  const hostLabel = s.inputMode === 'local'
    ? (s.me ? s.me.name : '本机')
    : s.inputMode === 'remote'
      ? ((s.connection.peers[0] && (s.connection.peers[0].label || s.connection.peers[0].name)) || '对端')
      : '各自独立';
  $('#currentHost').textContent = hostLabel;
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
  renderModes(s);
  buildWorkbench(s);
  buildMonitorList(s);
  buildHotkeys(s);
  renderShare(s);
  renderArrange(s);
  renderInput(s);
  renderStatus(s);
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

  $$('[data-role="mode"] button').forEach((b) => {
    b.addEventListener('click', () => push(window.api.setInputMode(b.dataset.mode)));
  });

  $('#portToggle').addEventListener('click', () => {
    const list = $('#monitorList');
    const collapsed = list.classList.toggle('is-collapsed');
    $('#portToggle').textContent = collapsed ? '展开设置' : '收起设置';
  });

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
  $('#openPerm').addEventListener('click', () => push(window.api.openAccessibility()));
  $('#edgeSwitch').addEventListener('change', (e) => push(window.api.setEdgeSwitch(e.target.checked)));
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
