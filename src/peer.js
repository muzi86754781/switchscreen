'use strict';

const { startDiscovery, connectPeer, startServer } = require('./net');
const { createClipboardSync } = require('./clipboard');
const { switchSource, getPlatform } = require('./monitor');
const { startCapture, injectEvent } = require('./input');
const { loadConfig } = require('./config');

/**
 * 编排层：把发现 / 传输 / 剪贴板 / 切换 / 输入 串成状态机。
 *
 * 状态：activePeer = 当前显示器显示的机器（= 当前用键鼠控制的对象）。
 * 初始为本机。切换快捷键在 [本机, 对端...] 之间循环。
 *
 * hooks（可选，供 GUI 订阅）：
 *   onPeers(names[])   —— 已连接对端变化
 *   onActive(name)     —— 当前被控机器变化
 *   onSwitch({target, input, result}) —— 一次切换动作的结果
 */
function createPeer(userConfig, hooks) {
  const cfg = userConfig || loadConfig();
  const h = hooks || {};
  const myName = cfg.peerName;
  const platform = getPlatform();

  const peers = new Map(); // name -> ws
  const peersMeta = new Map(); // name -> { name, platform }
  let activePeer = myName;  // 当前被控制的机器
  let captureHandle = null;
  let captureError = '';

  function notifyPeers() {
    if (typeof h.onPeers === 'function') h.onPeers(listPeers());
  }
  function listPeers() {
    return [...peers.keys()].map((n) => peersMeta.get(n) || { name: n, platform: 'unknown' });
  }
  function notifyActive() {
    if (typeof h.onActive === 'function') h.onActive(activePeer);
  }

  // 发送消息到当前激活的对端
  function send(msg) {
    const ws = peers.get(activePeer);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  // 广播给所有已连对端
  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of peers.values()) if (ws.readyState === 1) ws.send(s);
  }
  // 发给指定对端
  function sendTo(name, msg) {
    const ws = peers.get(name);
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
    return false;
  }

  // ---- 切换逻辑 ----
  function applySwitch(target) {
    const prev = activePeer;
    activePeer = target;
    const input = target === myName ? cfg.selfInput : cfg.peers[target];
    let result = 'skipped';

    if (input) {
      // DDC 指令必须由「显示器当前正在显示的那台机器」发出。
      // 若当前画面在对端，就把指令转给它执行；否则本机执行。
      if (prev !== myName && prev !== target) {
        const label = target === myName
          ? (cfg.ui && cfg.ui.localInputLabel)
          : (cfg.ui && cfg.ui.remoteInputLabel);
        if (sendTo(prev, { type: 'ddc', input, label })) {
          result = 'relayed';
          console.log(`[peer] 已请求 ${prev} 执行 DDC 切换 -> ${input}`);
        } else {
          result = 'peers-gone';
        }
      }
      if (result === 'skipped') {
        result = 'sent';
        if (typeof h.onSwitchRequest === 'function') {
          h.onSwitchRequest({
            target,
            input,
            label: target === myName ? (cfg.ui && cfg.ui.localInputLabel) : (cfg.ui && cfg.ui.remoteInputLabel)
          });
        } else {
          switchSource({ platform, command: (cfg.monitor.command[platform]), input });
        }
      }
    } else if (target !== myName) {
      result = 'no-input';
      console.warn(`[peer] 未配置对端 ${target} 的显示器输入源（config.peers[${target}]）`);
    }
    broadcast({ type: 'active', target });
    notifyActive();
    if (typeof h.onSwitch === 'function') h.onSwitch({ target, input, result });
    console.log(`[peer] 已切换到: ${target} (${result})`);
    return result;
  }

  function triggerSwitch() {
    const order = [myName, ...[...peers.keys()]];
    const idx = order.indexOf(activePeer);
    const next = order[(idx + 1) % order.length];
    return applySwitch(next);
  }

  function checkHotkey(e) {
    const hk = cfg.switchHotkey;
    if (e.keycode === hk.keycode &&
        !!e.ctrlKey === !!hk.ctrl && !!e.altKey === !!hk.alt &&
        !!e.shiftKey === !!hk.shift && !!e.metaKey === !!hk.meta) {
      triggerSwitch();
    }
  }

  // ---- 输入捕获回调（主机）----
  function onInputEvent(ev) {
    // 仅当开启共用键鼠、且当前控制的是对端时，才转发
    if (!cfg.shareInput) return;
    if (activePeer === myName) return;
    send({ type: 'input', ev });
  }
  onInputEvent._hotkey = checkHotkey;

  // ---- 收到对端消息 ----
  function handleMessage(name, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'clipboard') clipboard.onRemoteClipboard(msg.text);
    else if (msg.type === 'input') injectEvent(msg.ev);
    else if (msg.type === 'ddc') {
      // 对端请求本机执行 DDC 切换（本机才是当前画面输出方）
      if (typeof h.onSwitchRequest === 'function') {
        h.onSwitchRequest({ input: msg.input, label: msg.label, from: name });
      } else {
        switchSource({ platform, command: cfg.monitor.command[platform], input: msg.input });
      }
    }
    else if (msg.type === 'active') console.log(`[peer] 对端 ${name} 报告激活: ${msg.target}`);
  }

  // ---- 剪贴板同步 ----
  const clipboard = createClipboardSync({
    send: (m) => broadcast(m),
    isEnabled: () => cfg.clipboardSync
  });

  // ---- 输入捕获的按需启停（界面切换模式时用）----
  function refreshInputMode() {
    const shouldCapture = !!(cfg.shareInput && cfg.isHost);
    if (shouldCapture && !captureHandle) {
      try {
        captureHandle = startCapture({
          onEvent: onInputEvent,
          isActive: () => cfg.shareInput && activePeer !== myName
        });
        captureError = '';
      } catch (e) {
        captureError = e.message;
        console.error('[peer] 键鼠捕获启动失败:', e.message);
      }
    } else if (!shouldCapture && captureHandle) {
      try { captureHandle.stop(); } catch { /* ignore */ }
      captureHandle = null;
    }
  }

  // ---- 启动 ----
  const wss = startServer(cfg.port, (ws, name, platform) => {
    peers.set(name, ws);
    peersMeta.set(name, { name, platform: platform || 'unknown' });
    notifyPeers();
    ws.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data); } catch { return; }
      handleMessage(name, msg);
    });
    ws.on('close', () => { peers.delete(name); peersMeta.delete(name); notifyPeers(); });
  });

  if (cfg.discover) {
    startDiscovery({
      port: cfg.port, peerName: myName,
      onPeer: ({ name, address, port, platform }) => {
        if (peers.has(name)) return;
        // 字典序小的主动连，避免双向重复
        if (myName < name) {
          const ws = connectPeer(address, port, name);
          ws.on('message', (data) => {
            let msg = null;
            try { msg = JSON.parse(data); } catch { return; }
            handleMessage(name, msg);
          });
          ws.on('open', () => {
            peers.set(name, ws);
            peersMeta.set(name, { name, platform: platform || 'unknown' });
            notifyPeers();
          });
          ws.on('error', () => {});
          ws.on('close', () => { peers.delete(name); peersMeta.delete(name); notifyPeers(); });
        }
      }
    });
  }

  // 主机：捕获并转发键鼠
  refreshInputMode();

  console.log(`[peer] ${myName} 已启动，监听端口 ${cfg.port}，shareInput=${cfg.shareInput}，clipboardSync=${cfg.clipboardSync}`);
  return {
    triggerSwitch,
    switchTo: applySwitch,
    refreshInputMode,
    listPeers,
    getActive: () => activePeer,
    getCaptureError: () => captureError,
    stop: () => {
      if (captureHandle) { try { captureHandle.stop(); } catch { /* ignore */ } captureHandle = null; }
      wss.close();
      clipboard.stop();
    }
  };
}

module.exports = { createPeer };
