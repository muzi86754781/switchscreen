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
 *   getSwitchPlan(target) -> { localPlan, relays, label }  （由 GUI 侧计算每块屏的接口）
 *   onSwitchRequest({target, input, label}) -> Promise<{ok}>
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

  const injector = createInjector();

  function ui(k, dflt) {
    const v = cfg.ui && cfg.ui[k];
    return v === undefined || v === null ? dflt : v;
  }

  function myLabel() {
    return (cfg.ui && cfg.ui.displayName) || myName;
  }

  function metaPayload() {
    return { type: 'meta', platform, screen: localScreenSize(), name: myName, displayName: myLabel() };
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
        screen: m.screen || null
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

    if (typeof h.getSwitchPlan === 'function') {
      try { plan = h.getSwitchPlan(target); } catch (e) { console.warn('[peer] 计算切换计划失败:', e.message); }
    }

    activePeer = target;

    if (plan) {
      label = plan.label || '';
      if (plan.localPlan && typeof h.onSwitchRequest === 'function') {
        try {
          // 等 DDC 真正执行完，把结果回传给界面（否则界面永远停在「切换中」）
          detail = await h.onSwitchRequest({ target, input: plan.localPlan, label });
          result = detail && detail.ok === false ? 'failed' : 'sent';
        } catch (e) {
          detail = { ok: false, error: e.message };
          result = 'failed';
        }
      }
      // 有些屏当前显示的是别的机器 —— DDC 必须由那台机器发，转给它执行
      const relays = plan.relays || [];
      for (const r of relays) {
        if (sendTo(r.to, { type: 'ddc', input: r.plan, label })) {
          if (result === 'skipped') result = 'relayed';
        }
      }
      if (result === 'skipped') result = relays.length ? 'relayed' : 'screen-kept';
      if (!plan.total) result = 'no-input';
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

    // DDC 明确失败时，画面其实没换，键鼠焦点也不该留在对端
    if (result === 'failed' && prev !== target) activePeer = prev;

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
    if (typeof h.onSwitch === 'function') h.onSwitch({ target, label, result, detail, edge: o.edge || null });
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
    if (!peers.has(activePeer) || activePeer === myName) {
      return {
        forwarding: false,
        selfPlatform: platform,
        peerPlatform: 'unknown',
        modMap: ui('modMap', 'cmd-ctrl'),
        edgeSwitch: !!ui('edgeSwitch', true) && peers.size > 0,
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

    if (!ui('edgeSwitch', true)) return;
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
    if (busy) return;
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
      if (msg.screen && msg.screen.width) meta.screen = msg.screen;
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
    else if (msg.type === 'cursor-enter') {
      if (msg.edge === 'center') injector.place('center', 0.5, 0.5);
      else injector.place(msg.edge, msg.nx, msg.ny);
    }
    else if (msg.type === 'ddc') {
      // 对端请求本机执行 DDC 切换（本机才是当前画面输出方）
      // index 有值表示只切某台显示器；input 是对象表示按显示器下发计划
      if (typeof h.onSwitchRequest === 'function') {
        h.onSwitchRequest({ input: msg.input, label: msg.label, index: msg.index, from: name });
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
    isEnabled: () => cfg.clipboardSync
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
          const ws = connectPeer(address, port, name);
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
    listPeers,
    offerFiles: (paths, target) => fileTransfer.offerFiles(paths, target),
    cancelTransfer: (id) => fileTransfer.cancel(id),
    sendText: (text, target) => fileTransfer.sendText(text, target),
    listTransfers: () => fileTransfer.list(),
    getActive: () => activePeer,
    getCaptureError: () => captureError,
    /** 让指定对端执行一次 DDC（单台显示器切换时用） */
    relayDdc: (target, payload) => sendTo(target, { type: 'ddc', ...payload }),
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
