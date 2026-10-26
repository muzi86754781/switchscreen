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
  let authorityRev = 0;          // 已收到的「每块屏归谁」快照版本，旧的丢弃

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
    return { type: 'meta', platform, screen: localScreenSize(), name: myName, displayName: myLabel(), bootAt: BOOT_AT };
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
    for (const id of [myName, ...peers.keys()]) if (!raw.includes(id)) raw.push(id);
    return raw;
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
    // 由鼠标推边缘触发的切换不加锁，否则无缝移动会「走到头就卡住」。
    if (!o.edge) autoLockUntil = Date.now() + 1500;

    // 鼠标跨设备流动只切「键鼠控制权」，不动显示器 ——
    // 屏幕怎么分是用户在「设备与显示器」里手动切的，边缘穿越不能去改它。
    if (o.edge) {
      plan = null;
    } else if (typeof h.getSwitchPlan === 'function') {
      try { plan = h.getSwitchPlan(target); } catch (e) { console.warn('[peer] 计算切换计划失败:', e.message); }
    }

    activePeer = target;

    if (o.edge) {
      // 边缘流动：只切键鼠控制权，不动显示器（也不通知对端切屏）
      result = 'sent';
    } else if (plan) {
      label = plan.label || '';
      const hadPlan = !!plan.plan;
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
      // 有几块屏本机够不着（没接这根线 / 本机 DDC 不可用）时，请对端补一刀：
      // 对端同样只切它自己连着的屏，用的是它自己的接口配置，不做 index/名字换算
      const blind = plan.unreachable > 0 && plan.total > 0;
      if (blind && sendToAny({ type: 'switch-target', target })) {
        if (result !== 'sent') result = 'relayed';
      }
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

    // DDC 明确失败、或者对端根本没配接口时，画面其实没换，键鼠焦点也不该留在对端
    // （否则本机指针被「拉回中心」，看着就像鼠标卡住动不了）
    if ((result === 'failed' || result === 'no-input') && prev !== target) activePeer = prev;

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
      if (o.edge.side === 'right') moveLocalCursor(6, ny * lscr.height);
      else if (o.edge.side === 'left') moveLocalCursor(lscr.width - 16, ny * lscr.height);
    } else {
      phantom = null;
    }

    notifyActive();
    if (typeof h.onSwitch === 'function') {
      h.onSwitch({ target, label, result, detail, edge: o.edge || null, missing: (plan && plan.missing) || [] });
    }
    console.log(`[peer] 已切换到: ${target} (${result})`);
    return result;
  }

  function enterPoint(scr, side, nx, ny) {
    if (side === 'right') return { x: 1, y: Math.round(ny * scr.height) };
    if (side === 'left') return { x: scr.width - 2, y: Math.round(ny * scr.height) };
    if (side === 'bottom') return { x: Math.round(nx * scr.width), y: 1 };
    if (side === 'top') return { x: Math.round(nx * scr.width), y: scr.height - 2 };
    return { x: Math.round(scr.width / 2), y: Math.round(scr.height / 2) };
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
    if (activePeer === myName || !isPeerReady(activePeer)) {
      return {
        forwarding: false,
        selfPlatform: platform,
        peerPlatform: 'unknown',
        modMap: ui('modMap', 'cmd-ctrl'),
        edgeSwitch: !!ui('edgeSwitch', true) && peers.size > 0 && Date.now() >= autoLockUntil,
        screen: localScreenSize()
      };
    }
    const meta = peersMeta.get(activePeer);
    return {
      forwarding: !!(cfg.shareInput && cfg.isHost),
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
      meta.platform = msg.platform || meta.platform || 'unknown';
      if (msg.screen && msg.screen.width) {
        meta.screen = msg.screen;
        // 注入端按对端的桌面范围算虚拟指针，多显示器时不会顶死在主屏边界
        if (typeof injector.setScreen === 'function') injector.setScreen(msg.screen);
      }
      if (msg.displayName) meta.label = msg.displayName;
      peersMeta.set(name, meta);
      if (meta.label !== before) notifyPeers();
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
    else if (msg.type === 'ports') {
      // 对端的接口配置：按显示器名字合并，只补本机还没设的
      if (typeof h.onPorts === 'function') h.onPorts(msg.list);
    }
    else if (msg.type === 'authority') {
      // 对端发来的「每块屏现在归谁」：新开的软件靠它对齐到局域网里已有的状态，
      // 任意一台切换之后也靠它让所有界面保持一致 —— 旧的直接丢，否则两端会来回覆盖
      if (!msg.rev || msg.rev <= authorityRev) return;
      authorityRev = msg.rev;
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

  /* ---------------- 键鼠模式同步 ----------------
   * 「共用谁的键鼠」是个两端必须一致的状态：
   *   本机 local（用我的键鼠）  ⇄  对端 remote（只接收操作）
   *   本机 remote（用对端键鼠） ⇄  对端 local（对端捕获并转发）
   * 以前只改本机配置，对端仍按自己的模式跑，于是「选了共用 A 的键鼠，
   * 但没有一台在转发」，鼠标自然出不去。 */

  function currentMode() {
    return (cfg.ui && cfg.ui.inputMode) || 'separate';
  }

  // 本机当前模式是「用户在界面上选的」还是「跟着对端变的」
  let modeFromPeer = false;

  function setMode(next) {
    if (!cfg.ui) cfg.ui = {};
    if (cfg.ui.inputMode === next) {
      refreshInputMode();
      return;
    }
    cfg.ui.inputMode = next;
    cfg.shareInput = next !== 'separate';
    cfg.isHost = next !== 'remote';
    if (typeof h.onInputMode === 'function') h.onInputMode(next);
    refreshInputMode();
  }

  /** 把本机的键鼠模式广播出去，让对端切到镜像角色 */
  function announceInputMode(mode) {
    const m = mode || currentMode();
    modeFromPeer = false; // 这是用户自己选的
    broadcast({ type: 'input-mode', mode: m });
  }

  /** 收到对端的模式：对端的角色是镜像；两边都想当主机时按名字决定谁让步 */
  function applyRemoteInputMode(mode, from) {
    if (mode !== 'separate' && mode !== 'local' && mode !== 'remote') return;
    const desired = mode === 'local' ? 'remote' : mode === 'remote' ? 'local' : 'separate';
    const cur = currentMode();
    if (cur === desired) { modeFromPeer = true; return; }
    // 两边都想当同一个角色才是真冲突；只有本机是用户亲自选的才坚持，否则跟随对端
    const conflict = cur === mode;
    if (conflict && !modeFromPeer && myName < from) return;
    setMode(desired);
    modeFromPeer = true;
    console.log(`[peer] 跟随 ${from} 的键鼠模式 → ${desired}`);
  }

  /* ---------------- 捕获启停 ---------------- */

  function refreshInputMode() {
    const need = !!(cfg.shareInput && cfg.isHost);
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
      } catch (e) {
        captureError = e.message;
        console.error('[peer] 键鼠捕获启动失败:', e.message);
      }
    } else if (!need && capture) {
      try { capture.stop(); } catch { /* ignore */ }
      capture = null;
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
      displayName: myLabel(),
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
    listPeers,
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
      authorityRev = Math.max(authorityRev, Number(a.rev) || 0);
      broadcast({ type: 'authority', ...a });
      return true;
    },
    /** 改名后重新广播一次身份，其它设备立刻能看到新名字 */
    resendMeta: () => broadcast(metaPayload()),
    getPhantom: () => phantom,
    stop: () => {
      if (capture) { try { capture.stop(); } catch { /* ignore */ } capture = null; }
      wss.close();
      clipboard.stop();
    }
  };
}

module.exports = { createPeer };
