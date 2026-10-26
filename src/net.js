'use strict';

const dgram = require('dgram');
const os = require('os');
const WebSocket = require('ws');

/**
 * 局域网发现 + WebSocket 传输层。
 *
 * 设计：每台机器既广播自己，也监听别人的广播。为避免两台之间建立两条 WS 链路，
 * 只有「本机 peerName 字典序小于对端」时才作为 WS 客户端主动连，否则等待对方连。
 */

function startDiscovery({ port, peerName, displayName, onPeer }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const MAGIC = 'SWITCHSCREEN_DISCOVER';
  // 同一个对端不去抖：60s 内只通知一次，超时后允许重新发现（对端重启/断线重连要靠它）
  const seen = new Map();

  socket.on('error', (e) => console.error('[discover] udp error', e.message));

  socket.on('message', (msg, rinfo) => {
    let pkt;
    try { pkt = JSON.parse(msg.toString()); } catch { return; }
    if (!pkt || pkt.magic !== MAGIC) return;
    if (pkt.name === peerName) return; // 自己
    const key = `${pkt.name}@${rinfo.address}`;
    const last = seen.get(key) || 0;
    if (Date.now() - last < 60000) return;
    seen.set(key, Date.now());
    onPeer({
      name: pkt.name,
      label: pkt.displayName || '',
      address: rinfo.address,
      port: pkt.port,
      platform: pkt.platform || 'unknown'
    });
  });

  socket.bind(port, () => {
    socket.setBroadcast(true);
    const beacon = () => {
      const dn = typeof displayName === 'function' ? displayName() : (displayName || '');
      const payload = Buffer.from(JSON.stringify({
        magic: MAGIC, name: peerName, displayName: dn, port, platform: os.platform()
      }));
      socket.send(payload, 0, payload.length, port, '255.255.255.255', () => {});
    };
    beacon();
    setInterval(beacon, 3000);
  });

  return socket;
}

/**
 * 建立一条到对端的 WebSocket 控制/输入链路。
 *
 * 注意：握手头里必须放「自己的」name/platform，对端靠它认人。
 * （早期版本误把对端名字填进去，导致对端把本机登记成自己，设备列表里
 * 永远只有一台机器，这也是「共用键鼠切不过去」的根源之一。）
 *
 * @param {string} address 对端地址
 * @param {number} port    对端端口
 * @param {string} name    对端 peerName（仅用于日志）
 * @param {{selfName?:string, selfPlatform?:string}} [self] 自己的身份
 * @returns WebSocket
 */
function connectPeer(address, port, name, self) {
  const s = self || {};
  const ws = new WebSocket(`ws://${address}:${port}`, {
    headers: {
      'x-peer-name': encodeURIComponent(s.selfName || os.hostname()),
      'x-peer-platform': s.selfPlatform || os.platform()
    }
  });
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
    // 对端在握手头里放了它自己的名字（经过 encodeURIComponent，避免主机名带中文时
    // Node 直接拒绝非法 header 字符）
    const raw = String(req.headers['x-peer-name'] || 'unknown');
    let name = raw;
    try { name = decodeURIComponent(raw); } catch { name = raw; }
    const platform = (req.headers['x-peer-platform'] || 'unknown');
    console.log(`[net] 对端连入: ${name} / ${platform} (${req.socket.remoteAddress})`);
    onConnection(ws, name, platform);
  });
  wss.on('error', (e) => console.error('[net] ws server error:', e.message));
  return wss;
}

module.exports = { startDiscovery, connectPeer, startServer };
