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
 */
function createPeer(userConfig) {
  const cfg = userConfig || loadConfig();
  const myName = cfg.peerName;
  const platform = getPlatform();

  const peers = new Map(); // name -> ws
  let activePeer = myName;  // 当前被控制的机器

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

  // ---- 切换逻辑 ----
  function applySwitch(target) {
    activePeer = target;
    const input = target === myName ? cfg.selfInput : cfg.peers[target];
    if (input) {
      switchSource({ platform, command: (cfg.monitor.command[platform]), input });
    } else if (target !== myName) {
      console.warn(`[peer] 未配置对端 ${target} 的显示器输入源（config.peers[${target}]）`);
    }
    broadcast({ type: 'active', target });
    console.log(`[peer] 已切换到: ${target}`);
  }

  function triggerSwitch() {
    const order = [myName, ...[...peers.keys()]];
    const idx = order.indexOf(activePeer);
    const next = order[(idx + 1) % order.length];
    applySwitch(next);
  }

  function checkHotkey(e) {
    const h = cfg.switchHotkey;
    if (e.keycode === h.keycode &&
        !!e.ctrlKey === !!h.ctrl && !!e.altKey === !!h.alt &&
        !!e.shiftKey === !!h.shift && !!e.metaKey === !!h.meta) {
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
    if (msg.type === 'clipboard') clipboard.onRemoteClipboard(msg.text);
    else if (msg.type === 'input') injectEvent(msg.ev);
    else if (msg.type === 'active') console.log(`[peer] 对端 ${name} 报告激活: ${msg.target}`);
  }

  // ---- 剪贴板同步 ----
  const clipboard = createClipboardSync({
    send: (m) => broadcast(m),
    isEnabled: () => cfg.clipboardSync
  });

  // ---- 启动 ----
  const wss = startServer(cfg.port, (ws, name) => {
    peers.set(name, ws);
    ws.on('message', (data) => handleMessage(name, JSON.parse(data)));
    ws.on('close', () => peers.delete(name));
  });

  if (cfg.discover) {
    startDiscovery({
      port: cfg.port, peerName: myName,
      onPeer: ({ name, address, port }) => {
        if (peers.has(name)) return;
        // 字典序小的主动连，避免双向重复
        if (myName < name) {
          const ws = connectPeer(address, port, name);
          ws.on('message', (data) => handleMessage(name, JSON.parse(data)));
          ws.on('open', () => peers.set(name, ws));
          ws.on('close', () => peers.delete(name));
        }
      }
    });
  }

  // 主机：捕获并转发键鼠
  if (cfg.isHost) {
    startCapture({ onEvent: onInputEvent, isActive: () => cfg.shareInput && activePeer !== myName });
  }

  console.log(`[peer] ${myName} 已启动，监听端口 ${cfg.port}，shareInput=${cfg.shareInput}，clipboardSync=${cfg.clipboardSync}`);
  return {
    triggerSwitch, switchTo: applySwitch,
    stop: () => { wss.close(); clipboard.stop(); }
  };
}

module.exports = { createPeer };
