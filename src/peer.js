'use strict';

const os = require('os');
const path = require('path');
const { startDiscovery, connectPeer, startServer } = require('./net');
const { createClipboardSync } = require('./clipboard');
const { createFileTransfer } = require('./filetransfer');
const { switchSource, getPlatform } = require('./monitor');
const { createCapture, createInjector, localScreenSize, moveLocalCursor } = require('./input');
const { loadConfig } = require('./config');

/**
 * 编排层：把发现 / 传输 / 剪贴板 / 切换 / 键鼠 串成状态机。
 *
 * 状态：activePeer = 当前显示器显示的机器（= 当前用键鼠控制的对象），初始为本机。
 *
 * 键鼠共用采用「相对位移 + 幻影指针」模型：
 *   - 接物理键鼠的一端（host）捕获事件，鼠标只发相对位移，两端分辨率不同也一致；
 *   - host 另外维护一个「对端指针位置」的幻影坐标，用来判断指针是否顶到当前屏幕
 *     的左右边缘 —— 顶到了就按「设备排列」找相邻的那台，形成无缝穿梭；
 *   - 修饰键在发送前按两端平台做语义映射（⌘ ⇄ Ctrl），见 keymap.js。
 *
 * hooks（可选，供 GUI 订阅）：
 *   onPeers(list) / onActive(name) / onSwitch({...}) / onFileUpdate / onAskIncoming
 *   onText({text, from}) / onInputDebug(line) / onEdgeSwitch({...})
 *   getSwitchPlan(target) -> { plan, monitors, label }  （本机要写的 VCP 值）
 *   onSwitchRequest({target, input, label, index}) -> Promise<{ok}>
 */
function createPeer(userConfig, hooks) {
  const cfg = userConfig || loadConfig();
  const h = hooks || {};
  const myName = cfg.peerName;
  const platform = getPlatform();

  const peers = new Map();       // name -> ws
  const peersMeta = new Map();   // name -> { name, label, platform, screen }
  let activePeer = myName;
  let capture = null;
  let captureError = '';
  let phantom = null;            // 对端指针位置（host 侧跟踪）
  let busy = false;              // 正在执行一次切换，避免边界反复触发
  let autoLockUntil = 0;         // 手动切换后短暂关闭自动穿越（切换优先）
  // 「每块屏归谁」的快照版本，按来源分别记：每台机器自己的版本号才是单调可比的，
  // 跨机器比大小会把对端真正的新快照当成旧的丢掉（界面于是停在切换前）
  const authRevByOrigin = new Map();

  const BOOT_AT = Date.now() - Math.round((typeof process !== 'undefined' && process.uptime ? process.uptime() : 0) * 1000);
  const injector = createInjector();

  function ui(k, dflt) {
    const v = cfg.ui && cfg.ui[k];
    return v === undefined || v === null ? dflt : v;
  }

  function myLabel() {
    return (cfg.ui && cfg.ui.displayName) || myName;
  }

  function metaPayload() {
    let displays = [];
    if (typeof h.getDisplaysMeta === 'function') {
      try { displays = h.getDisplaysMeta() || []; } catch { /* ignore */ }
    }
    return { type: 'meta', platform, screen: localScreenSize(), displays, name: myName, displayName: myLabel(), bootAt: BOOT_AT };
  }

  function notifyPeers() {
    if (typeof h.onPeers === 'function') h.onPeers(listPeers());
  }
  function listPeers() {
    return [...peers.keys()].map((n) => {
      const m = peersMeta.get(n) || {};
      return {
        name: n,
        label: m.label || n,
        platform: m.platform || 'unknown',
        screen: m.screen || null,
        displays: m.displays || [],
        bootAt: Number(m.bootAt) || 0
      };
    });
  }
  function notifyActive() {
    if (typeof h.onActive === 'function') h.onActive(activePeer);
  }

  function send(msg) {
    const ws = peers.get(activePeer);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of peers.values()) if (ws.readyState === 1) ws.send(s);
  }
  function sendTo(name, msg) {
    const ws = peers.get(name);
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
    return false;
  }

  /** 发给所有在线对端：只要有一台收到就算送达 */
  function sendToAny(msg) {
    const s = JSON.stringify(msg);
    let n = 0;
    for (const ws of peers.values()) if (ws.readyState === 1) { ws.send(s); n += 1; }
    return n > 0;
  }

  /* ---------------- 设备排列（无缝移动的方向依据） ---------------- */

  /** 排列里记录所有设备（含暂时离线的），位置不会因为掉线被忘掉 */
  function arrangeOrder() {
    const raw = Array.isArray(ui('arrange', [])) ? ui('arrange').slice() : [];
    const seen = new Set(raw);
    // 还没排过队的设备按 id 字典序补在后面 —— 两台机器各算各的也能算出同一个顺序，
    // 「往左 / 往右是哪台」才不会两端打架（以前按上线先后补，先开的那台顺序和后开的不一样）
    const extra = [myName, ...peers.keys(), ...Object.keys(ui('knownPeers', {}))]
      .filter((id) => typeof id === 'string' && id && !seen.has(id));
    extra.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return raw.concat(extra);
  }

  /** 手动改排列：写进配置并同步给对端，两端方向才一致 */
  function setArrange(list) {
    const input = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [];
    if (!input.length) return arrangeOrder();
    const clean = [...new Set(input)];
    for (const id of arrangeOrder()) if (!clean.includes(id)) clean.push(id);
    cfg.ui.arrange = clean;
    cfg.ui.arrangeTouched = true;
    broadcast({ type: 'arrange', list: clean });
    if (typeof h.onArrange === 'function') h.onArrange(clean);
    return clean;
  }

  /** 给界面用的方向信息：此刻键鼠在哪台、左右各是哪台 */
  function neighborInfo() {
    const list = arrangeOrder();
    const me = activePeer;
    const i = list.indexOf(me);
    const pick = (dir) => {
      if (i < 0) return '';
      const step = dir === 'left' ? -1 : 1;
      for (let j = i + step; j >= 0 && j < list.length; j += step) {
        if (isOnline(list[j])) return list[j];
      }
      return '';
    };
    return {
      order: list.slice(),
      me,
      self: myName,
      controlling: me,
      local: me === myName,
      left: pick('left'),
      right: pick('right')
    };
  }

  function isOnline(id) {
    return id === myName || peers.has(id);
  }

  /** 链路真的通着才能转发：只剩半个 TCP 连接时转发会把本机鼠标「冻」在屏幕中间 */
  function isPeerReady(id) {
    const ws = peers.get(id);
    return !!ws && ws.readyState === 1;
  }

  /** 从 id 出发，往 dir（left/right）找第一台在线设备 */
  function neighborOf(id, dir) {
    const list = arrangeOrder();
    const i = list.indexOf(id);
    if (i < 0) return '';
    const step = dir === 'left' ? -1 : 1;
    for (let j = i + step; j >= 0 && j < list.length; j += step) {
      if (isOnline(list[j])) return list[j];
    }
    return '';
  }

  /* ---------------- 切换 ---------------- */

  /** 两端都要把还按着的修饰键松掉，否则切完会「一直按着 ⌘」 */
  function resetInputState() {
    broadcast({ type: 'input-reset' });
    injector.releaseAll();
    phantom = null;
  }

  /**
   * @param {string} target 目标设备（peerName）
   * @param {{edge?:{side:string,nx:number,ny:number}}} [opts]
   */
  async function applySwitch(target, opts) {
    const o = opts || {};
    const prev = activePeer;
    let result = 'skipped';
    let detail = null;
    let label = '';
    let plan = null;

    // 「切换电脑 / 显示器」是主功能，优先级高于无缝键鼠：
    // 手动切换后先压住自动穿越一小会儿，免得鼠标还停在屏幕边上、一动就又弹回去。
    // 鼠标推边缘触发也加 400ms 短暂冷却，杜绝左右边界反向跳动的乒乓振荡。
    if (!o.edge && !o.inputOnly) autoLockUntil = Date.now() + 1500;
    else autoLockUntil = Date.now() + 400;

    // 鼠标跨设备流动或快捷键交接只切「键鼠控制权」，不动显示器 ——
    // 屏幕怎么分是用户在「设备与显示器」里手动切的，键鼠交接不能去改它。
    if (o.edge || o.inputOnly) {
      plan = null;
    } else if (typeof h.getSwitchPlan === 'function') {
      try { plan = h.getSwitchPlan(target); } catch (e) { console.warn('[peer] 计算切换计划失败:', e.message); }
    }

    activePeer = target;

    if (o.edge || o.inputOnly) {
      // 只切键鼠控制权，不动显示器（也不通知对端切屏）
      result = 'control';
    } else if (plan) {
      label = plan.label || '';
      const hadPlan = !!plan.plan;
      // 关键双向保障：现实中很多显示器（如 DELL U2414H）在非活动端口（如当前处于 HDMI1，Mac 接在 HDMI2）时，
      // 会关闭或屏蔽非活动接口的 DDC/CI 通信，导致从非活动端发送的 DDC 命令无效；
      // 必须由当前正点亮该屏的对端机器（活动信号源）协同下发切换命令，两端同时下发，100% 确保全部显示器切到位。
      sendToAny({ type: 'switch-target', target });

      // 本机直接切自己接线能碰到的每一块屏（DDC 走视频线，与当前画面在哪台无关）
      if (hadPlan && typeof h.onSwitchRequest === 'function') {
        try {
          // 等 DDC 真正执行完，把结果回传给界面（否则界面永远停在「切换中」）
          detail = await h.onSwitchRequest({ target, input: plan.plan, label });
          result = detail && detail.ok === false ? 'failed' : 'sent';
        } catch (e) {
          detail = { ok: false, error: e.message };
          result = 'failed';
        }
      }
      if (result !== 'sent') result = 'relayed';
      if (!hadPlan && result === 'skipped') result = 'no-input';
      else if (hadPlan && result === 'skipped') result = 'screen-kept';
    } else {
      // 兜底：没有注入计划时，用配置里的单一接口值
      const input = target === myName ? cfg.selfInput : cfg.peers[target];
      label = target === myName
        ? ((cfg.ui && cfg.ui.localInputLabel) || input || '')
        : ((cfg.ui && cfg.ui.remoteInputLabel) || input || '');
      if (input) {
        if (prev !== myName && prev !== target) {
          if (sendTo(prev, { type: 'ddc', input, label })) result = 'relayed';
          else result = 'peers-gone';
        }
        if (result === 'skipped') {
          result = 'sent';
          if (typeof h.onSwitchRequest === 'function') {
            try {
              detail = await h.onSwitchRequest({ target, input, label });
            } catch (e) {
              detail = { ok: false, error: e.message };
              result = 'failed';
            }
            if (detail && detail.ok === false) result = 'failed';
          } else {
            switchSource({ platform, command: (cfg.monitor.command[platform]), input });
          }
        }
      } else {
        result = 'screen-kept';
      }
    }

    // 仅在「未开启键鼠共用」且明确切屏失败/没配接口时才回退焦点；
    // 若开启了共用键鼠，键鼠控制权允许跨机切换，不被 DDC 硬件失败或单屏无接口卡死
    const sharingInput = !!cfg.shareInput;
    if ((result === 'failed' || result === 'no-input') && prev !== target && !sharingInput && !o.edge && !o.inputOnly) {
      activePeer = prev;
    }

    resetInputState();

    // 告诉所有设备「现在画面在哪台」
    broadcast({ type: 'active', target: activePeer });

    // 进入对端：把对端指针放到穿越进来的那条边上
    if (activePeer !== myName) {
      const meta = peersMeta.get(activePeer);
      const scr = (meta && meta.screen) || localScreenSize();
      const edge = (o.edge && o.edge.side) || '';
      if (edge) {
        sendTo(activePeer, { type: 'cursor-enter', edge, nx: o.edge.nx, ny: o.edge.ny });
        phantom = enterPoint(scr, edge, o.edge.nx, o.edge.ny);
      } else {
        phantom = { x: Math.round(scr.width / 2), y: Math.round(scr.height / 2) };
        sendTo(activePeer, { type: 'cursor-enter', edge: 'center', nx: 0.5, ny: 0.5 });
      }
    } else if (o.edge) {
      // 穿回本机：把本机指针放到对应那一侧的边上，手感才连续
      phantom = null;
      const lscr = localScreenSize();
      const ny = typeof o.edge.ny === 'number' ? o.edge.ny : 0.5;
      if (o.edge.side === 'right') moveLocalCursor(12, ny * lscr.height);
      else if (o.edge.side === 'left') moveLocalCursor(lscr.width - 16, ny * lscr.height);
    } else {
      phantom = null;
      if (o.inputOnly) {
        const lscr = localScreenSize();
        moveLocalCursor(Math.round(lscr.width / 2), Math.round(lscr.height / 2));
      }
    }

    notifyActive();
    if (typeof h.onSwitch === 'function') {
      h.onSwitch({ target, label, result, detail, edge: o.edge || null, missing: (plan && plan.missing) || [] });
    }
    console.log(`[peer] 已切换到: ${target} (${result})`);
    return result;
  }

  function enterPoint(scr, side, nx, ny) {
    if (side === 'right') return { x: 12, y: Math.round(ny * scr.height) };
    if (side === 'left') return { x: Math.max(12, scr.width - 14), y: Math.round(ny * scr.height) };
    if (side === 'bottom') return { x: Math.round(nx * scr.width), y: 12 };
    if (side === 'top') return { x: Math.round(nx * scr.width), y: Math.max(12, scr.height - 14) };
    return { x: Math.round(scr.width / 2), y: Math.round(scr.height / 2) };
  }

  /** 「这块屏现在显示的是你吗」的等待队列：自动识别接口时用它确认候选口 */
  const probeWaiters = new Map();

  function askProbe(target, key, timeout, ports) {
    const k = `${target}|${key}`;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        probeWaiters.delete(k);
        resolve(v || 'unknown');
      };
      const timer = setTimeout(() => finish('unknown'), Number(timeout) > 0 ? Number(timeout) : 1800);
      probeWaiters.set(k, finish);
      // 带上这块屏的接口指纹：对端键的口径可能跟本机不一样（占位名 vs EDID 序列号）
      if (!sendTo(target, { type: 'probe-ask', key, ports: ports || undefined })) finish('unknown');
    });
  }

  function triggerSwitch() {
    const list = arrangeOrder().filter(isOnline);
    const idx = list.indexOf(activePeer);
    const next = list[(idx + 1) % list.length] || myName;
    return applySwitch(next);
  }

  function checkHotkey(e) {
    const hk = cfg.switchHotkey;
    if (!hk) return;
    if (e.keycode === hk.keycode &&
        !!e.ctrlKey === !!hk.ctrl && !!e.altKey === !!hk.alt &&
        !!e.shiftKey === !!hk.shift && !!e.metaKey === !!hk.meta) {
      triggerSwitch();
    }
  }

  /* ---------------- 键鼠：捕获与转发 ---------------- */

  function inputOptions() {
    const isMaster = !!(cfg.ui && cfg.ui.inputMaster === myName);
    if (activePeer === myName || !isPeerReady(activePeer)) {
      return {
        forwarding: false,
        selfPlatform: platform,
        peerPlatform: 'unknown',
        modMap: ui('modMap', 'cmd-ctrl'),
        edgeSwitch: isMaster && !!ui('edgeSwitch', true) && peers.size > 0 && Date.now() >= autoLockUntil,
        screen: localScreenSize()
      };
    }
    const meta = peersMeta.get(activePeer);
    return {
      forwarding: isMaster,
      selfPlatform: platform,
      peerPlatform: (meta && meta.platform) || 'unknown',
      modMap: ui('modMap', 'cmd-ctrl'),
      edgeSwitch: false,
      screen: localScreenSize(),
      keyDebug: !!ui('keyDebug', false)
    };
  }

  function forwardMove(dx, dy) {
    const scale = Number(ui('mouseSpeed', 1)) || 1;
    const sx = dx * scale;
    const sy = dy * scale;
    const meta = peersMeta.get(activePeer);
    const scr = (meta && meta.screen) || localScreenSize();
    if (!phantom) phantom = { x: scr.width / 2, y: scr.height / 2 };

    phantom.x += sx;
    phantom.y += sy;

    send({ type: 'input', ev: { kind: 'move', dx: sx, dy: sy } });

    if (!ui('edgeSwitch', true) || Date.now() < autoLockUntil) return;
    // 幻影指针顶出当前屏幕的左右边缘 → 交给排列里相邻的那台
    let dir = '';
    if (phantom.x < 0) dir = 'left';
    else if (phantom.x > scr.width - 1) dir = 'right';
    if (!dir) return;

    const target = neighborOf(activePeer, dir);
    if (!target) {
      // 边上是墙：把幻影指针夹回屏幕内，避免一直触发
      phantom.x = Math.max(0, Math.min(scr.width - 1, phantom.x));
      return;
    }
    const nx = Math.max(0, Math.min(1, phantom.x / Math.max(1, scr.width)));
    const ny = Math.max(0, Math.min(1, phantom.y / Math.max(1, scr.height)));
    phantom = null;
    applySwitch(target, { edge: { side: dir, nx, ny } }).catch(() => {});
  }

  /** 指针推到本机边缘：按排列切到相邻设备，并把指针放到对侧 */
  async function edgeTo(info) {
    if (busy || Date.now() < autoLockUntil) return;
    const dir = info.side === 'left' ? 'left' : info.side === 'right' ? 'right' : '';
    if (!dir) return;
    const target = neighborOf(myName, dir);
    if (!target) return;
    busy = true;
    try {
      await applySwitch(target, { edge: info });
      if (typeof h.onEdgeSwitch === 'function') h.onEdgeSwitch({ to: target, side: info.side });
    } finally {
      busy = false;
    }
  }

  function onKey(ev) {
    send({ type: 'input', ev: { kind: 'key', token: ev.token, up: !!ev.up } });
  }
  function onWheel(dx, dy) {
    send({ type: 'input', ev: { kind: 'wheel', dx, dy } });
  }
  function onButton(button, down) {
    send({ type: 'input', ev: { kind: 'button', button, down } });
  }

  /* ---------------- 收到对端消息 ---------------- */

  function handleMessage(name, msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'text-send') {
      fileTransfer.onText(msg, name);
      if (typeof h.onText === 'function') h.onText({ text: msg.text || '', from: name });
      return;
    }
    if (fileTransfer.handle(msg, name)) return;

    if (msg.type === 'clipboard') clipboard.onRemoteClipboard(msg.text);
    else if (msg.type === 'meta') {
      const meta = peersMeta.get(name) || { name };
      const before = meta.label;
      const beforeDisplays = JSON.stringify(meta.displays || []);
      meta.platform = msg.platform || meta.platform || 'unknown';
      if (msg.screen && msg.screen.width) {
        meta.screen = msg.screen;
        // 注入端按对端的桌面范围算虚拟指针，多显示器时不会顶死在主屏边界
        if (typeof injector.setScreen === 'function') injector.setScreen(msg.screen);
      }
      if (Array.isArray(msg.displays)) meta.displays = msg.displays;
      if (msg.displayName) meta.label = msg.displayName;
      peersMeta.set(name, meta);
      if (meta.label !== before || JSON.stringify(meta.displays || []) !== beforeDisplays) notifyPeers();
    }
    else if (msg.type === 'input') {
      const ev = msg.ev || {};
      if (ev.kind === 'key') injector.key(ev.token, !!ev.up);
      else if (ev.kind === 'move') injector.move(ev.dx, ev.dy);
      else if (ev.kind === 'wheel') injector.wheel(ev.dx, ev.dy);
      else if (ev.kind === 'button') injector.button(ev.button, !!ev.down);
    }
    else if (msg.type === 'input-reset') injector.releaseAll();
    else if (msg.type === 'input-mode') applyRemoteInputMode(msg.mode, name);
    else if (msg.type === 'input-master') applyRemoteInputMaster(msg.master, msg.edgeSwitch);
    else if (msg.type === 'switch-input') {
      if (msg.target) applySwitch(msg.target, { inputOnly: true }).catch(() => {});
    }
    else if (msg.type === 'ports') {
      // 对端的接口配置：按显示器名字合并，只补本机还没设的
      if (typeof h.onPorts === 'function') h.onPorts(msg.list);
    }
    else if (msg.type === 'authority') {
      // 对端发来的「每块屏现在归谁」：新开的软件靠它对齐到局域网里已有的状态，
      // 任意一台切换之后也靠它让所有界面保持一致 —— 旧的直接丢，否则两端会来回覆盖
      // （版本号是逻辑计数，不比时钟；平局交给服务层判断）
      const from = String(msg.at || name || 'peer');
      const rev = Number(msg.rev) || 0;
      if (!rev) return;
      if (rev <= Number(authRevByOrigin.get(from) || 0)) return; // 同一来源的旧版本才丢
      authRevByOrigin.set(from, rev);
      if (typeof h.onAuthority === 'function') h.onAuthority(msg);
    }
    else if (msg.type === 'cursor-enter') {
      if (msg.edge === 'center') injector.place('center', 0.5, 0.5);
      else injector.place(msg.edge, msg.nx, msg.ny);
    }
    else if (msg.type === 'switch-target') {
      // 对端要切到某台设备，但它够不着某些屏 —— 本机把自己连着的屏也切到这个目标。
      // 只用自己的接口配置，不做跨机器的 index / 名字换算。
      const t = msg.target;
      if (!t) return;
      autoLockUntil = Date.now() + 1500;
      let p = null;
      try { p = typeof h.getSwitchPlan === 'function' ? h.getSwitchPlan(t) : null; } catch { /* ignore */ }
      if (p && p.plan && typeof h.onSwitchRequest === 'function') {
        Promise.resolve(h.onSwitchRequest({ target: t, input: p.plan, label: p.label || '' }))
          .catch(() => {});
      }
    }
    else if (msg.type === 'switch-monitor') {
      const t = msg.target;
      const monName = msg.name;
      if (!t || !monName) return;
      autoLockUntil = Date.now() + 1500;
      if (typeof h.onSwitchMonitorRequest === 'function') {
        h.onSwitchMonitorRequest({ name: monName, target: t, key: msg.key, port: msg.port || msg.input });
      }
    }
    else if (msg.type === 'ddc') {
      // 对端请求本机执行 DDC 切换（本机才是当前画面输出方）
      // index 有值表示只切某台显示器；input 是对象表示按显示器下发计划
      if (typeof h.onSwitchRequest === 'function') {
        h.onSwitchRequest({
          input: msg.input,
          label: msg.label,
          index: msg.index,
          monitors: msg.monitors,
          name: msg.name,
          from: name
        });
      } else {
        switchSource({ platform, command: cfg.monitor.command[platform], input: msg.input });
      }
    }
    else if (msg.type === 'active') {
      // 各端必须对「当前画面在哪台」保持一致，否则下一次切换会由错误的机器执行 DDC
      const t = msg.target;
      if (t && t !== activePeer && (t === myName || peers.has(t))) {
        activePeer = t;
        phantom = null;
        injector.releaseAll();
        notifyActive();
      }
      console.log(`[peer] 对端 ${name} 报告激活: ${msg.target}`);
    }
    else if (msg.type === 'arrange') {
      // 对端手动调过左右顺序：本机没手动调过就跟着改，保证「往左是哪台」两端一致
      const list = Array.isArray(msg.list) ? msg.list.filter((x) => typeof x === 'string' && x) : [];
      if (!list.length || ui('arrangeTouched', false)) return;
      cfg.ui.arrange = list;
      if (typeof h.onArrange === 'function') h.onArrange(arrangeOrder());
    }
    else if (msg.type === 'probe-ask') {
      // 对端在自动识别接口：问「这块屏现在显示的是我吗」，按本机证据回答
      const ans = typeof h.onProbe === 'function' ? h.onProbe(msg.key, msg.ports) : 'unknown';
      sendTo(name, { type: 'probe-answer', key: msg.key, ans });
    }
    else if (msg.type === 'probe-answer') {
      const w = probeWaiters.get(`${name}|${msg.key}`);
      if (w) w(msg.ans || 'unknown');
    }
  }

  function track(ws, name, peerPlatform, label) {
    peers.set(name, ws);
    const meta = peersMeta.get(name) || { name };
    meta.platform = peerPlatform || meta.platform || 'unknown';
    if (label) meta.label = label;
    peersMeta.set(name, meta);
    notifyPeers();

    // 交换屏幕尺寸与显示名：跨分辨率移动要靠它换算幻影指针
    try { ws.send(JSON.stringify(metaPayload())); } catch { /* ignore */ }
    // 顺手同步一次键鼠模式，新连上的设备立刻进入正确角色
    try { ws.send(JSON.stringify({ type: 'input-mode', mode: currentMode() })); } catch { /* ignore */ }
    try {
      ws.send(JSON.stringify({
        type: 'input-master',
        master: (cfg.ui && cfg.ui.inputMaster) || '',
        edgeSwitch: !!(cfg.ui && cfg.ui.edgeSwitch)
      }));
    } catch { /* ignore */ }
    // 接口配置也同步过去：在任一台配好接口，另一台就能直接切
    try {
      const ports = typeof h.getPorts === 'function' ? h.getPorts() : [];
      ws.send(JSON.stringify({ type: 'ports', list: ports }));
    } catch { /* ignore */ }
    // 「每块屏现在归谁」同步过去：后打开的软件一进来就对齐到局域网上已有的状态
    try {
      const a = typeof h.getAuthority === 'function' ? h.getAuthority() : null;
      if (a && a.screens && a.screens.length) ws.send(JSON.stringify({ type: 'authority', ...a }));
    } catch { /* ignore */ }

    ws.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data); } catch { return; }
      handleMessage(name, msg);
    });
    ws.on('close', () => {
      peers.delete(name);
      if (activePeer === name) { activePeer = myName; phantom = null; notifyActive(); }
      injector.releaseAll();
      if (cfg.ui && cfg.ui.inputMaster && cfg.ui.inputMaster === name) {
        console.warn(`[peer] 主控设备 ${name} 离线，自动回退到各用各的键鼠`);
        cfg.ui.inputMaster = '';
        cfg.shareInput = false;
        cfg.isHost = false;
        refreshInputMode();
        if (typeof h.onInputMaster === 'function') h.onInputMaster('', true);
        if (typeof h.onNotice === 'function') h.onNotice(`主控设备「${name}」已离线，已自动切回各用各的键鼠`);
      }
      notifyPeers();
    });
    ws.on('error', () => {});
  }

  /* ---------------- 剪贴板 / 文件 ---------------- */

  const clipboard = createClipboardSync({
    send: (m) => broadcast(m),
    isEnabled: () => cfg.clipboardSync,
    // Electron 原生剪贴板（进程内实现，最可靠）；没注入时才退回 clipboardy
    read: h.clipboard && h.clipboard.read,
    write: h.clipboard && h.clipboard.write,
    onError: (msg) => { if (typeof h.onNotice === 'function') h.onNotice(msg); }
  });

  const fileTransfer = createFileTransfer({
    send: (m, target) => {
      if (target && sendTo(target, m)) return;
      broadcast(m);
    },
    recvDir: () => (cfg.ui && cfg.ui.receiveDir) || path.join(os.homedir(), 'Desktop', 'SwitchScreen'),
    onUpdate: (list) => { if (typeof h.onFileUpdate === 'function') h.onFileUpdate(list); },
    shouldAccept: (payload) => {
      if (cfg.ui && cfg.ui.autoAccept) return true;
      if (typeof h.onAskIncoming === 'function') return h.onAskIncoming(payload);
      return true;
    }
  });

  /* ---------------- 键鼠模式与多设备共用 ----------------
   * 支持多设备模式：
   * 1. 各用各的键鼠（inputMaster = ''）：每台设备独立运行，不捕获、不转发、不注入
   * 2. 共用 [设备ID] 键鼠（inputMaster = masterId）：
   *    - 若本机即 masterId：本机为主控端（isHost=true），启动 capture，监听鼠标移动并按需转发至活动设备
   *    - 若本机不是 masterId：本机为受控端（isHost=false），不启动 capture，接收来自主控端的 input 消息并注入
   */

  function inputMaster() {
    return (cfg.ui && cfg.ui.inputMaster) || '';
  }

  function setInputMaster(masterId, edgeSwitch) {
    if (!cfg.ui) cfg.ui = {};
    const cleanMaster = typeof masterId === 'string' ? masterId.trim() : '';
    cfg.ui.inputMaster = cleanMaster;
    if (typeof edgeSwitch === 'boolean') cfg.ui.edgeSwitch = edgeSwitch;
    cfg.shareInput = !!cleanMaster;
    cfg.isHost = cleanMaster === myName;
    refreshInputMode();
    announceInputMaster();
    if (typeof h.onInputMaster === 'function') h.onInputMaster(cleanMaster, cfg.ui.edgeSwitch);
    return cleanMaster;
  }

  function announceInputMaster() {
    const master = inputMaster();
    const edgeSwitch = !!(cfg.ui && cfg.ui.edgeSwitch);
    broadcast({ type: 'input-master', master, edgeSwitch });
    return true;
  }

  function applyRemoteInputMaster(master, edgeSwitch) {
    if (!cfg.ui) cfg.ui = {};
    const cleanMaster = typeof master === 'string' ? master.trim() : '';
    cfg.ui.inputMaster = cleanMaster;
    if (typeof edgeSwitch === 'boolean') cfg.ui.edgeSwitch = edgeSwitch;
    cfg.shareInput = !!cleanMaster;
    cfg.isHost = cleanMaster === myName;
    refreshInputMode();
    if (typeof h.onInputMaster === 'function') h.onInputMaster(cleanMaster, cfg.ui.edgeSwitch);
  }

  function currentMode() {
    return inputMaster() ? (inputMaster() === myName ? 'local' : 'remote') : 'separate';
  }

  function setMode(next) {
    if (next === 'separate') setInputMaster('');
    else if (next === 'local') setInputMaster(myName);
  }

  function announceInputMode() {
    return announceInputMaster();
  }

  function applyRemoteInputMode(mode, from) {
    if (mode === 'separate') applyRemoteInputMaster('');
    else if (mode === 'local') applyRemoteInputMaster(from);
  }

  /* ---------------- 捕获启停 ---------------- */

  function refreshInputMode() {
    const master = inputMaster();
    const need = !!master && (master === myName);
    if (!master) {
      injector.releaseAll();
    }
    if (need && !capture) {
      try {
        capture = createCapture({
          getOptions: inputOptions,
          onKey,
          onMove: forwardMove,
          onWheel,
          onButton,
          onEdge: (info) => { edgeTo(info).catch(() => {}); },
          onHotkey: checkHotkey,
          onDebug: (line) => { if (typeof h.onInputDebug === 'function') h.onInputDebug(line); }
        });
        captureError = '';
        console.log(`[peer] 本机为主控端 (${myName})，键鼠全局捕获已启动`);
      } catch (e) {
        captureError = e.message;
        console.error('[peer] 键鼠捕获启动失败:', e.message);
      }
    } else if (!need) {
      if (capture) {
        try { capture.stop(); } catch { /* ignore */ }
        capture = null;
        console.log(`[peer] 本机非键鼠主控端，全局捕获已停止`);
      }
      captureError = '';
    }
  }

  /* ---------------- 启动 ---------------- */

  const wss = startServer(cfg.port, (ws, name, peerPlatform) => {
    track(ws, name, peerPlatform);
  });

  if (cfg.discover) {
    startDiscovery({
      port: cfg.port,
      peerName: myName,
      displayName: () => myLabel(),
      onPeer: ({ name, label, address, port, platform: remotePlatform }) => {
        if (peers.has(name)) return;
        // 字典序小的主动连，避免双向重复
        if (myName < name) {
          const ws = connectPeer(address, port, name, { selfName: myName, selfPlatform: platform });
          ws.on('open', () => track(ws, name, remotePlatform, label));
        }
      }
    });
  }

  refreshInputMode();

  console.log(`[peer] ${myName} 已启动，监听端口 ${cfg.port}，shareInput=${cfg.shareInput}，clipboardSync=${cfg.clipboardSync}`);
  return {
    triggerSwitch,
    switchTo: applySwitch,
    refreshInputMode,
    announceInputMode,
    setInputMaster,
    announceInputMaster,
    switchInputTo: (t) => {
      if (!cfg.isHost && cfg.ui && cfg.ui.inputMaster) {
        sendTo(cfg.ui.inputMaster, { type: 'switch-input', target: t });
      }
      return applySwitch(t, { inputOnly: true });
    },
    isCapturing: () => !!capture,
    listPeers,
    neighbors: neighborInfo,
    getArrange: arrangeOrder,
    setArrange,
    offerFiles: (paths, target) => fileTransfer.offerFiles(paths, target),
    cancelTransfer: (id) => fileTransfer.cancel(id),
    removeTransfer: (id) => fileTransfer.remove(id),
    clearTransfers: () => fileTransfer.clearDone(),
    sendText: (text, target) => fileTransfer.sendText(text, target),
    listTransfers: () => fileTransfer.list(),
    getActive: () => activePeer,
    getCaptureError: () => captureError,
    /** 让指定对端执行一次 DDC（单台显示器切换时用） */
    relayDdc: (target, payload) => sendTo(target, { type: 'ddc', ...payload }),
    /** 请求对端协同切换单块显示器 */
    sendMonitorSwitch: (name, target, extra) => sendToAny({ type: 'switch-monitor', name, target, ...(extra || {}) }),
    /** 手动切换后暂停自动穿越：避免鼠标一动就把画面又弹回去（切换优先） */
    pauseAutoSwitch: (ms) => {
      const v = Number(ms);
      autoLockUntil = Date.now() + (Number.isFinite(v) ? v : 1500);
    },
    /** 把本机的接口配置发给对端（用户改完接口时调用） */
    sendPorts: (list) => broadcast({ type: 'ports', list: list || [] }),
    /** 广播「每块屏现在归谁」：任意一台切换成功后，全局界面都跟着同步 */
    sendAuthority: (a) => {
      if (!a || !a.screens) return false;
      if (a.rev) authRevByOrigin.set(String(a.at || myName), Number(a.rev) || 0);
      broadcast({ type: 'authority', ...a });
      return true;
    },
    /** 改名后重新广播一次身份，其它设备立刻能看到新名字 */
    resendMeta: () => broadcast(metaPayload()),
    /**
     * 问某台设备「这块屏现在显示的是你吗」（自动识别接口时用）。
     * 对端答不上来（读不到输入源）就当 unknown，等超时。
     */
    askProbe: (target, key, timeout, ports) => askProbe(target, key, timeout, ports),
    getPhantom: () => phantom,
    stop: () => {
      if (capture) { try { capture.stop(); } catch { /* ignore */ } capture = null; }
      wss.close();
      clipboard.stop();
    }
  };
}

module.exports = { createPeer };
