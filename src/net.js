'use strict';

const dgram = require('dgram');
const WebSocket = require('ws');

/**
 * 局域网发现 + WebSocket 传输层。
 *
 * 设计：每台机器既广播自己，也监听别人的广播。为避免两台之间建立两条 WS 链路，
 * 只有「本机 peerName 字典序小于对端」时才作为 WS 客户端主动连，否则等待对方连。
 */

function startDiscovery({ port, peerName, onPeer }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const MAGIC = 'SWITCHSCREEN_DISCOVER';
  const seen = new Set();

  socket.on('error', (e) => console.error('[discover] udp error', e.message));

  socket.on('message', (msg, rinfo) => {
    let pkt;
    try { pkt = JSON.parse(msg.toString()); } catch { return; }
    if (!pkt || pkt.magic !== MAGIC) return;
    if (pkt.name === peerName) return; // 自己
    const key = `${pkt.name}@${rinfo.address}`;
    if (seen.has(key)) return;
    seen.add(key);
    onPeer({ name: pkt.name, address: rinfo.address, port: pkt.port });
  });

  socket.bind(port, () => {
    socket.setBroadcast(true);
    const beacon = () => {
      const payload = Buffer.from(JSON.stringify({ magic: MAGIC, name: peerName, port }));
      socket.send(payload, 0, payload.length, port, '255.255.255.255', () => {});
    };
    beacon();
    setInterval(beacon, 3000);
  });

  return socket;
}

/**
 * 建立一条到对端的 WebSocket 控制/输入链路。
 * @returns WebSocket
 */
function connectPeer(address, port, name) {
  const ws = new WebSocket(`ws://${address}:${port}`);
  ws.on('open', () => console.log(`[net] 已连到对端 ${name} (${address}:${port})`));
  ws.on('error', (e) => console.error(`[net] 连接 ${name} 失败:`, e.message));
  return ws;
}

/**
 * 启动 WebSocket 服务端，等待对端连入。
 * @returns WebSocket.Server
 */
function startServer(port, onConnection) {
  const wss = new WebSocket.Server({ port });
  wss.on('connection', (ws, req) => {
    const name = (req.headers['x-peer-name'] || 'unknown');
    console.log(`[net] 对端连入: ${name} (${req.socket.remoteAddress})`);
    onConnection(ws, name);
  });
  return wss;
}

module.exports = { startDiscovery, connectPeer, startServer };
