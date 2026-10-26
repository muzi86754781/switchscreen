'use strict';

const os = require('os');
const path = require('path');
const { startDiscovery, connectPeer, startServer } = require('./net');
const { createClipboardSync } = require('./clipboard');
const { createFileTransfer } = require('./filetransfer');
const { switchSource, getPlatform } = require('./monitor');
const { createCapture, createInjector, moveLocalCursor, localScreenSize } = require('./input');
const { loadConfig } = require('./config');

/**
 * 编排层：把发现 / 传输 / 剪贴板 / 切换 / 键鼠 串成状态机。
 *
 * 状态：activePeer = 当前显示器显示的机器（= 当前用键鼠控制的对象），初始为本机。
 *
 * 键鼠共用采用「相对位移 + 幻影指针」模型：
 *   - 接物理键鼠的一端（host）捕获事件，鼠标只发相对位移，两端分辨率不同也一致；
 *   - host 另外维护一个「对端指针位置」的幻影坐标，用来判断指针是否顶到对端屏幕
 *     的另一侧边缘 —— 顶到了就把画面切回本机，形成真正意义上的无缝穿梭；
 *   - 修饰键在发送前按两端平台做语义映射（⌘ ⇄ Ctrl），见 keymap.js。
 *
 * hooks（可选，供 GUI 订阅）：
 *   onPeers(list) / onActive(name) / onSwitch({...}) / onFileUpdate / onAskIncoming
 *   onText({text, from}) / onInputError(line) / onEdgeSwitch({...})
 */
function createPeer(userConfig, hooks) {
  const cfg = userConfig || loadConfig();
  const h = hooks || {};
  const myName = cfg.peerName;
  const platform = getPlatform();

  const peers = new Map();       // name -> ws
  const peersMeta = new Map();   // name -> { name, platform, screen }
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

  function notifyPeers() {
    if (typeof h.onPeers === 'function') h.onPeers(listPeers());
  }
  function listPeers() {
    return [...peers.keys()].map((n) => peersMeta.get(n) || { name: n, platform: 'unknown' });
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

  /* ---------------- 目标接口计算 ---------------- */

  /**
   * 计算「切到 target 时，显示器应该去的接口」。
   * 返回：字符串（所有显示器同一个接口）或 map（{ "0": "0x12", "1": "0x11" }）。
   */
  function inputForTarget(target) {
    const role = target === myName ? 'local' : 'remote';
    const per = (cfg.ui && cfg.ui.perMonitor) || {};
    const keys = Object.keys(per);
    if (keys.length) {
      const map = {};
      for (const k of keys) {
        const v = per[k] && per[k][role];
        // 空字符串 = 这台显示器在这个方向上「不切」
        if (v) map[k.replace(/^ddc:/, '')] = v;
      }
      return map;
    }
    return target === myName ? cfg.selfInput : cfg.peers[target];
  }

  function labelForTarget(target) {
    if (target === myName) return (cfg.ui && cfg.ui.localInputLabel) || cfg.selfInput || '';
    return (cfg.ui && cfg.ui.remoteInputLabel) || cfg.peers[target] || '';
  }

  /* ---------------- 切换 ---------------- */

  /** 两端都要把还按着的修饰键松掉，否则切完会「一直按着 ⌘」 */
  function resetInputState() {
    broadcast({ type: 'input-reset' });
    injector.releaseAll();
    phantom = null;
  }

  /**
   * @param {string} target 目标机器名
   * @param {{edge?:{side:string,nx:number,ny:number}, silent?:boolean}} [opts]
   */
  async function applySwitch(target, opts) {
    const o = opts || {};
    const prev = activePeer;
    const raw = inputForTarget(target);
    const isMap = raw && typeof raw === 'object';
    const hasTarget = isMap ? Object.keys(raw).length > 0 : !!raw;
    const input = raw;
    const label = labelForTarget(target);
    let result = 'skipped';
    let detail = null;

    activePeer = target;

    if (hasTarget) {
      // DDC 指令必须由「显示器当前正在显示的那台机器」发出。
      // 若当前画面在对端，就把指令转给它执行；否则本机执行。
      if (prev !== myName && prev !== target) {
        if (sendTo(prev, { type: 'ddc', input, label })) {
          result = 'relayed';
          console.log(`[peer] 已请求 ${prev} 执行 DDC 切换 -> ${JSON.stringify(input)}`);
        } else {
          result = 'peers-gone';
        }
      }
      if (result === 'skipped') {
        result = 'sent';
        if (typeof h.onSwitchRequest === 'function') {
          // 等 DDC 真正执行完，把结果回传给界面（否则界面永远停在「切换中」）
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
    } else if (isMap) {
      result = 'screen-kept'; // 所有显示器都设成「不切」：只切键鼠焦点
    } else if (target !== myName) {
      result = 'no-input';
      console.warn(`[peer] 未配置对端 ${target} 的显示器输入源（config.peers[${target}]）`);
    }

    // DDC 明确失败时，画面其实没换，键鼠焦点也不该留在对端
    if (result === 'failed' && prev !== target) activePeer = prev;

    resetInputState();

    // 告诉对端「现在画面在哪台」
    broadcast({ type: 'active', target: activePeer });

    // 进入对端：把对端指针放到穿越进来的那条边上
    if (activePeer !== myName) {
      const meta = peersMeta.get(activePeer);
      const scr = (meta && meta.screen) || localScreenSize();
      const edge = (o.edge && o.edge.side) || ui('edgeSide', 'right');
      const nx = o.edge ? o.edge.nx : 0.5;
      const ny = o.edge ? o.edge.ny : 0.5;
      if (o.edge) {
        sendTo(activePeer, { type: 'cursor-enter', edge, nx, ny });
        phantom = enterPoint(scr, edge, nx, ny);
      } else {
        phantom = { x: Math.round(scr.width / 2), y: Math.round(scr.height / 2) };
        sendTo(activePeer, { type: 'cursor-enter', edge: 'center', nx: 0.5, ny: 0.5 });
      }
    } else {
      phantom = null;
    }

    notifyActive();
    if (typeof h.onSwitch === 'function') h.onSwitch({ target, input, label, result, detail, edge: o.edge || null });
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
    const order = [myName, ...[...peers.keys()]];
    const idx = order.indexOf(activePeer);
    const next = order[(idx + 1) % order.length];
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
        edgeSide: ui('edgeSide', 'right'),
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
      edgeSide: ui('edgeSide', 'right'),
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

    const before = { x: phantom.x, y: phantom.y };
    phantom.x += sx;
    phantom.y += sy;

    send({ type: 'input', ev: { kind: 'move', dx: sx, dy: sy } });

    // 幻影指针越过对端屏幕另一侧 → 说明用户想回到本机
    const side = ui('edgeSide', 'right');
    if (!ui('edgeSwitch', true) || side === 'off') return;
    let back = false;
    if (side === 'right' && phantom.x < 0) back = true;
    else if (side === 'left' && phantom.x > scr.width - 1) back = true;
    else if (side === 'bottom' && phantom.y < 0) back = true;
    else if (side === 'top' && phantom.y > scr.height - 1) back = true;
    if (!back) return;

    phantom = before;
    returnToLocal(before, scr, side).catch(() => {});
  }

  /** 从对端穿回本机：切屏 + 把本机指针放到对应的边上 */
  async function returnToLocal(pos, remoteScr, side) {
    if (busy) return;
    busy = true;
    try {
      await applySwitch(myName);
      const lscr = localScreenSize();
      const nx = Math.max(0, Math.min(1, pos.x / Math.max(1, remoteScr.width)));
      const ny = Math.max(0, Math.min(1, pos.y / Math.max(1, remoteScr.height)));
      if (side === 'right') moveLocalCursor(lscr.width - 16, ny * lscr.height);
      else if (side === 'left') moveLocalCursor(6, ny * lscr.height);
      else if (side === 'bottom') moveLocalCursor(nx * lscr.width, lscr.height - 16);
      else if (side === 'top') moveLocalCursor(nx * lscr.width, 6);
      if (typeof h.onEdgeSwitch === 'function') h.onEdgeSwitch({ to: myName, side });
    } finally {
      busy = false;
    }
  }

  /** 指针推到本机边缘：切到对端并把指针放到对侧 */
  async function edgeToPeer(info) {
    if (busy) return;
    const target = [...peers.keys()][0];
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
      meta.platform = msg.platform || meta.platform || 'unknown';
      if (msg.screen && msg.screen.width) meta.screen = msg.screen;
      peersMeta.set(name, meta);
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
      // index 有值表示只切某台显示器
      if (typeof h.onSwitchRequest === 'function') {
        h.onSwitchRequest({ input: msg.input, label: msg.label, index: msg.index, from: name });
      } else {
        switchSource({ platform, command: cfg.monitor.command[platform], input: msg.input });
      }
    }
    else if (msg.type === 'active') {
      // 两端必须对「当前画面在哪台」保持一致，否则下一次切换会由错误的机器执行 DDC
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

  function track(ws, name, peerPlatform) {
    peers.set(name, ws);
    const meta = peersMeta.get(name) || { name };
    meta.platform = peerPlatform || meta.platform || 'unknown';
    peersMeta.set(name, meta);
    notifyPeers();

    // 交换屏幕尺寸：跨分辨率移动要靠它换算幻影指针
    try {
      ws.send(JSON.stringify({ type: 'meta', platform, screen: localScreenSize() }));
    } catch { /* ignore */ }

    ws.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data); } catch { return; }
      handleMessage(name, msg);
    });
    ws.on('close', () => {
      peers.delete(name);
      peersMeta.delete(name);
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
          onEdge: (info) => { edgeToPeer(info).catch(() => {}); },
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
      port: cfg.port, peerName: myName,
      onPeer: ({ name, address, port, platform: remotePlatform }) => {
        if (peers.has(name)) return;
        // 字典序小的主动连，避免双向重复
        if (myName < name) {
          const ws = connectPeer(address, port, name);
          ws.on('open', () => track(ws, name, remotePlatform));
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
    getPhantom: () => phantom,
    stop: () => {
      if (capture) { try { capture.stop(); } catch { /* ignore */ } capture = null; }
      wss.close();
      clipboard.stop();
    }
  };
}

module.exports = { createPeer };
