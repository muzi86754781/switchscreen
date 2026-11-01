'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
let clipboard = null;
if (process.versions && process.versions.electron) {
  try {
    clipboard = require('electron').clipboard;
  } catch {}
}
const { generateQrSvg } = require('./qrcode');
const logger = require('./logger');

let server = null;
let currentPort = 47749;
let currentIp = '127.0.0.1';
let isRunning = false;
let servicesRef = null;
let broadcastCallback = null;
let notifyCallback = null;
let askIncomingCallback = null;
let showIncomingTextCallback = null;

const sharedFilesToPhone = new Map();
let sharedTextToPhone = null;
const sharedTextsList = [];
const activeClients = new Map();

function recordClientActive(id, name, ip, ua) {
  if (!id) return;
  const now = Date.now();
  const existing = activeClients.get(id);
  const isNew = !existing || (now - existing.lastSeen > 12000);
  activeClients.set(id, {
    id,
    name: name || (existing ? existing.name : '手机'),
    ip: ip || (existing ? existing.ip : ''),
    ua: ua || (existing ? existing.ua : ''),
    lastSeen: now
  });
  if (isNew && broadcastCallback) {
    try { broadcastCallback(); } catch {}
  }
}

function getOnlineClients() {
  const now = Date.now();
  const list = [];
  for (const [id, c] of activeClients.entries()) {
    if (now - c.lastSeen < 10000) {
      list.push({
        id: c.id,
        name: c.name,
        ip: c.ip,
        label: `${c.name} (${c.ip})`
      });
    } else if (now - c.lastSeen > 60000) {
      activeClients.delete(id);
    }
  }
  return list;
}

function addSharedFiles(filePaths, target = 'all') {
  const online = getOnlineClients();
  let targetName = '所有已连手机';
  if (target && target !== 'all') {
    const found = online.find(c => c.id === target);
    if (found) targetName = found.name;
  }
  const added = [];
  for (const fp of filePaths || []) {
    try {
      if (fs.existsSync(fp)) {
        const st = fs.statSync(fp);
        if (st.isFile()) {
          const id = 'ws_out_f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          const name = path.basename(fp);
          const item = {
            id,
            fromId: 'pc',
            fromName: '电脑',
            target: target || 'all',
            targetName,
            name,
            originalPath: fp,
            size: st.size,
            sizeStr: formatBytes(st.size),
            at: Date.now()
          };
          sharedFilesToPhone.set(id, item);
          added.push(item);

          if (servicesRef && servicesRef.addWebShareTransfer) {
            servicesRef.addWebShareTransfer({
              id,
              dir: 'out',
              name,
              size: st.size,
              done: st.size,
              status: 'done',
              peer: (target === 'all' || !target) ? (online.length > 1 ? `全部手机(${online.length}台)` : '手机网页端') : targetName,
              path: fp,
              at: Date.now()
            });
          }
        }
      }
    } catch {}
  }
  if (broadcastCallback) broadcastCallback();
  return added;
}

function addSharedText(text, target = 'all') {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const online = getOnlineClients();
  let targetName = '所有已连手机';
  if (target && target !== 'all') {
    const found = online.find(c => c.id === target);
    if (found) targetName = found.name;
  }
  const id = 'ws_out_t_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  sharedTextToPhone = {
    id,
    fromId: 'pc',
    fromName: '电脑',
    target: target || 'all',
    targetName,
    text: clean,
    at: Date.now()
  };
  sharedTextsList.unshift(sharedTextToPhone);
  if (sharedTextsList.length > 30) sharedTextsList.pop();
  if (servicesRef && servicesRef.addWebShareTransfer) {
    servicesRef.addWebShareTransfer({
      id,
      dir: 'out',
      name: `文本 · ${clean.slice(0, 24)}${clean.length > 24 ? '…' : ''}`,
      size: Buffer.byteLength(clean, 'utf8'),
      done: Buffer.byteLength(clean, 'utf8'),
      status: 'done',
      peer: (target === 'all' || !target) ? (online.length > 1 ? `全部手机(${online.length}台)` : '手机网页端') : targetName,
      text: clean,
      at: Date.now()
    });
  }
  if (broadcastCallback) broadcastCallback();
  return sharedTextToPhone;
}

function isVirtualOrProxy(name, ip) {
  const lowerName = String(name || '').toLowerCase();
  // 1. 过滤 Clash / 代理软件特有的 Fake-IP 网段 (198.18.0.0/15)
  if (/^198\.(18|19)\./.test(ip)) return true;
  // 2. 过滤回环与无效地址
  if (/^127\.|^169\.254\./.test(ip)) return true;
  // 3. 过滤常见的虚拟网卡与代理软件网卡名称
  if (/meta|mihomo|clash|sing-?box|neko|surge|shadowrocket|vethernet|wsl|docker|vmware|virtualbox|tailscale|zerotier|loopback|tap|tun|wireguard/i.test(lowerName)) {
    return true;
  }
  return false;
}

function getAvailableInterfaces() {
  const interfaces = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        const isVirt = isVirtualOrProxy(name, net.address);
        let score = 0;
        if (!isVirt) {
          const isWifi = /wlan|wi-?fi|wireless|无线/i.test(name);
          const isEth = /eth|以太网|ethernet|en\d/i.test(name);
          const typeBonus = isWifi ? 30 : (isEth ? 20 : 10);

          if (net.address.startsWith('192.168.')) score = 100 + typeBonus;
          else if (/^172\.20\.10\./.test(net.address)) score = 95 + typeBonus; // iPhone 热点网段
          else if (net.address.startsWith('10.')) score = 80 + typeBonus;
          else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(net.address)) score = 60 + typeBonus;
          else score = 40 + typeBonus;
        }
        list.push({
          name,
          ip: net.address,
          isVirtual: isVirt,
          score,
          label: `${name} (${net.address})${isVirt ? ' (虚拟网卡)' : ''}`
        });
      }
    }
  }
  list.sort((a, b) => b.score - a.score);
  if (list.length > 0 && list[0].score > 0) {
    list[0].label += ' [推荐]';
    list[0].isRecommended = true;
  }
  return list;
}

function getLocalIp() {
  const list = getAvailableInterfaces();
  const valid = list.find(i => !i.isVirtual && i.score > 0);
  if (valid) return valid.ip;
  if (list.length > 0) return list[0].ip;
  return '127.0.0.1';
}

function getReceiveDir() {
  if (servicesRef && servicesRef.cfg && servicesRef.cfg.ui && servicesRef.cfg.ui.receiveDir) {
    return servicesRef.cfg.ui.receiveDir;
  }
  const base = path.join(os.homedir(), 'Desktop');
  return path.join(base, 'SwitchScreen', 'clipboard', 'received');
}

function sanitizeFilename(name) {
  let clean = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return clean || 'file_' + Date.now();
}

function uniquePath(dir, filename) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, filename);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let i = 1;
  while (fs.existsSync(path.join(dir, `${base} (${i})${ext}`))) {
    i++;
  }
  return path.join(dir, `${base} (${i})${ext}`);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

let cachedWebHtmlTemplate = '';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildWebHtml(pcName) {
  if (!cachedWebHtmlTemplate) {
    const templatePath = path.join(__dirname, 'web-share-template.html');
    try {
      cachedWebHtmlTemplate = fs.readFileSync(templatePath, 'utf8');
    } catch (e) {
      console.error('[WEB-SHARE] Failed to read web-share-template.html:', e.message);
    }
  }
  const cleanName = escapeHtml(pcName || '我的电脑');
  return (cachedWebHtmlTemplate || '').replace(/\{\{PC_NAME\}\}/g, cleanName);
}

function handleRequest(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // CORS 支持
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 赞赏码静态图片
  if (req.method === 'GET' && (pathname === '/assets/sponsor_qr.jpg' || pathname === '/sponsor_qr.jpg')) {
    const qrPath = path.join(__dirname, 'renderer', 'assets', 'sponsor_qr.jpg');
    if (fs.existsSync(qrPath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(qrPath).pipe(res);
      return;
    }
  }

  // 1. Web 页面
  if (req.method === 'GET' && pathname === '/') {
    const pcName = (servicesRef && servicesRef.cfg && servicesRef.cfg.ui && servicesRef.cfg.ui.displayName) || os.hostname();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildWebHtml(pcName));
    return;
  }

  // 2. 手机轮询电脑发来的内容（文字 + 文件）
  if (req.method === 'GET' && pathname === '/api/poll') {
    const rawIp = req.socket.remoteAddress || '';
    const ip = rawIp.replace(/^.*:/, '') || '127.0.0.1';
    const cid = urlObj.searchParams.get('cid') || ('ip_' + ip);
    const name = urlObj.searchParams.get('name') || '手机';
    const ua = req.headers['user-agent'] || '';

    recordClientActive(cid, name, ip, ua);
    const onlineClients = getOnlineClients();

    let textForClient = null;
    if (sharedTextToPhone) {
      const isNotFromSelf = sharedTextToPhone.fromId !== cid;
      const isTargeted = !sharedTextToPhone.target || sharedTextToPhone.target === 'all' || sharedTextToPhone.target === cid;
      if (isNotFromSelf && isTargeted) {
        textForClient = sharedTextToPhone;
      }
    }

    const textsForClient = sharedTextsList.filter(t => {
      const isNotFromSelf = t.fromId !== cid;
      const isTargeted = !t.target || t.target === 'all' || t.target === cid;
      return isNotFromSelf && isTargeted;
    });

    const filesForClient = Array.from(sharedFilesToPhone.values()).filter(f => {
      const isNotFromSelf = f.fromId !== cid;
      const isTargeted = !f.target || f.target === 'all' || f.target === cid;
      return isNotFromSelf && isTargeted;
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      text: textForClient,
      texts: textsForClient,
      files: filesForClient,
      clients: onlineClients
    }));
    return;
  }

  // 3. 文件上传（手机发送到电脑 / 手机间互传）
  if (req.method === 'POST' && pathname === '/api/upload') {
    const rawName = urlObj.searchParams.get('name') || 'upload_' + Date.now();
    const filename = sanitizeFilename(rawName);
    const rawIp = req.socket.remoteAddress || '';
    const ip = rawIp.replace(/^.*:/, '') || '127.0.0.1';
    const cid = urlObj.searchParams.get('cid') || ('ip_' + ip);
    const deviceName = urlObj.searchParams.get('deviceName') || '手机';
    const target = urlObj.searchParams.get('target') || 'all';
    const targetName = urlObj.searchParams.get('targetName') || '';

    recordClientActive(cid, deviceName, ip);

    const autoAccept = !!(servicesRef && servicesRef.cfg && servicesRef.cfg.ui && servicesRef.cfg.ui.autoAccept);
    const recvDir = getReceiveDir();
    // 未开启免确认时，先保存为 .pending 临时文件，避免未同意接收就直接出现在目录中
    const tempName = autoAccept ? filename : (filename + '.' + Date.now() + '.pending');
    const savePath = uniquePath(recvDir, tempName);

    const writeStream = fs.createWriteStream(savePath);
    req.pipe(writeStream);

    writeStream.on('finish', async () => {
      let fileSize = 0;
      try { fileSize = fs.statSync(savePath).size; } catch {}
      logger.info('WEB-SHARE', `Received file stream from ${deviceName}: ${filename} (${fileSize} bytes, target: ${target})`);

      let finalPath = savePath;
      let finalName = filename;
      let accepted = true;

      if (autoAccept) {
        finalName = path.basename(savePath);
        if (askIncomingCallback) {
          askIncomingCallback({ name: finalName, from: deviceName, total: fileSize, count: 1 }, true);
        } else if (notifyCallback) {
          notifyCallback(`收到来自 ${deviceName} 的文件`, `${finalName} (${formatBytes(fileSize)})`);
        }
      } else {
        if (askIncomingCallback) {
          accepted = await askIncomingCallback({ name: filename, from: deviceName, total: fileSize, count: 1 }, false);
        }
        if (accepted) {
          finalPath = uniquePath(recvDir, filename);
          try {
            fs.renameSync(savePath, finalPath);
            finalName = path.basename(finalPath);
          } catch (e) {
            finalPath = savePath;
            finalName = path.basename(savePath);
          }
        } else {
          try { fs.unlinkSync(savePath); } catch {}
        }
      }

      let peerLabel = `${deviceName} (${ip})`;
      if (target === 'all') {
        peerLabel = `${deviceName} (互传全部)`;
      } else if (target !== 'pc' && targetName) {
        peerLabel = `${deviceName} ➔ ${targetName.replace(/^📱\s*/, '')}`;
      }

      if (accepted) {
        if (target !== 'pc') {
          const shareId = 'ws_p2p_f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          sharedFilesToPhone.set(shareId, {
            id: shareId,
            name: finalName,
            originalPath: finalPath,
            size: fileSize,
            sizeStr: formatBytes(fileSize),
            target: target || 'all',
            targetName: targetName,
            fromId: cid,
            fromName: deviceName,
            at: Date.now()
          });
        }

        if (servicesRef && servicesRef.addWebShareTransfer) {
          servicesRef.addWebShareTransfer({
            id: 'ws_in_f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            dir: 'in',
            name: finalName,
            size: fileSize,
            done: fileSize,
            status: 'done',
            peer: peerLabel,
            path: finalPath,
            at: Date.now()
          });
        }

        if (servicesRef && servicesRef.pushStatus) {
          servicesRef.pushStatus(`来自【${deviceName}】的文件已送达：${finalName}`, 'ok');
        }

        if (broadcastCallback) broadcastCallback();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: finalName }));
      } else {
        if (servicesRef && servicesRef.addWebShareTransfer) {
          servicesRef.addWebShareTransfer({
            id: 'ws_in_f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            dir: 'in',
            name: filename,
            size: fileSize,
            done: 0,
            status: 'rejected',
            peer: peerLabel,
            path: '',
            at: Date.now()
          });
        }

        if (servicesRef && servicesRef.pushStatus) {
          servicesRef.pushStatus(`已取消来自【${deviceName}】的文件：${filename}`, 'info');
        }

        if (broadcastCallback) broadcastCallback();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '电脑端已取消/拒绝接收' }));
      }
    });

    writeStream.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  // 4. 文本发送（手机发送到电脑 / 手机间互传）
  if (req.method === 'POST' && pathname === '/api/text') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const text = String(data.text || '').trim();
        const rawIp = req.socket.remoteAddress || '';
        const ip = rawIp.replace(/^.*:/, '') || '127.0.0.1';
        const cid = data.cid || ('ip_' + ip);
        const deviceName = data.deviceName || '手机';
        const target = data.target || 'all';
        const targetName = data.targetName || '';
        recordClientActive(cid, deviceName, ip);

        if (text) {
          const autoAccept = !!(servicesRef && servicesRef.cfg && servicesRef.cfg.ui && servicesRef.cfg.ui.autoAccept);
          const textPreview = text.length > 24 ? text.slice(0, 24) + '…' : text;

          let peerLabel = `${deviceName} (${ip})`;
          if (target === 'all') {
            peerLabel = `${deviceName} (互传全部)`;
          } else if (target !== 'pc' && targetName) {
            peerLabel = `${deviceName} ➔ ${targetName.replace(/^📱\s*/, '')}`;
          }

          let accepted = true;
          if (autoAccept) {
            if (showIncomingTextCallback) {
              await showIncomingTextCallback({ text, from: deviceName });
            } else {
              if (clipboard) {
                try { clipboard.writeText(text); } catch {}
              }
              if (servicesRef && servicesRef.pushStatus) {
                servicesRef.pushStatus(`已收到【${deviceName}】发送的文字并拷贝到剪贴板`, 'ok');
              }
              if (notifyCallback) {
                notifyCallback(`收到来自 ${deviceName} 的文字`, text.slice(0, 60));
              }
            }
          } else {
            if (showIncomingTextCallback) {
              accepted = await showIncomingTextCallback({ text, from: deviceName });
            }
          }

          if (accepted) {
            if (target !== 'pc') {
              sharedTextToPhone = {
                id: 'ws_p2p_t_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                text: text,
                target: target || 'all',
                targetName: targetName,
                fromId: cid,
                fromName: deviceName,
                at: Date.now()
              };
              sharedTextsList.unshift(sharedTextToPhone);
              if (sharedTextsList.length > 30) sharedTextsList.pop();
            }

            if (servicesRef && servicesRef.addWebShareTransfer) {
              servicesRef.addWebShareTransfer({
                id: 'ws_in_t_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                dir: 'in',
                name: `文本 · ${textPreview}`,
                size: Buffer.byteLength(text, 'utf8'),
                done: Buffer.byteLength(text, 'utf8'),
                status: 'done',
                peer: peerLabel,
                text,
                at: Date.now()
              });
            }

            if (broadcastCallback) broadcastCallback();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            if (servicesRef && servicesRef.addWebShareTransfer) {
              servicesRef.addWebShareTransfer({
                id: 'ws_in_t_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                dir: 'in',
                name: `文本 · ${textPreview}`,
                size: Buffer.byteLength(text, 'utf8'),
                done: 0,
                status: 'rejected',
                peer: peerLabel,
                text,
                at: Date.now()
              });
            }

            if (broadcastCallback) broadcastCallback();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: '电脑端已取消/拒绝接收' }));
          }
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 5. 电脑发送给手机的文件下载
  if (req.method === 'GET' && pathname === '/api/download') {
    const id = urlObj.searchParams.get('id');
    let filePath = '';
    let filename = '';
    let fileSize = 0;

    if (id && sharedFilesToPhone.has(id)) {
      const item = sharedFilesToPhone.get(id);
      filePath = item.originalPath;
      filename = item.name;
      fileSize = item.size;
    } else {
      const rawName = urlObj.searchParams.get('name') || '';
      filename = path.basename(rawName);
      const recvDir = getReceiveDir();
      filePath = path.join(recvDir, filename);
      try { fileSize = fs.statSync(filePath).size; } catch {}
    }

    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('文件不存在或已被移除');
      return;
    }

    const isInline = urlObj.searchParams.get('inline') === '1';
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    const mimeMap = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      heic: 'image/heic',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
      mp3: 'audio/mpeg',
      pdf: 'application/pdf',
      txt: 'text/plain; charset=utf-8'
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';
    const dispType = isInline ? 'inline' : 'attachment';

    try {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileSize,
        'Content-Disposition': `${dispType}; filename*=UTF-8''${encodeURIComponent(filename)}`
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('下载出错: ' + e.message);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

function startServer(port = 47749) {
  return new Promise((resolve) => {
    if (server) {
      try { server.close(); } catch {}
      server = null;
    }

    currentIp = userChosenIp || getLocalIp();
    currentPort = port;

    server = http.createServer(handleRequest);

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && currentPort < 47760) {
        logger.warn('WEB-SHARE', `Port ${currentPort} in use, trying ${currentPort + 1}`);
        resolve(startServer(currentPort + 1));
      } else {
        logger.error('WEB-SHARE', `Server error: ${err.message}`);
        isRunning = false;
        if (broadcastCallback) broadcastCallback();
        resolve(false);
      }
    });

    server.listen(currentPort, '0.0.0.0', () => {
      isRunning = true;
      logger.info('WEB-SHARE', `Web share server running at http://${currentIp}:${currentPort}`);
      if (broadcastCallback) broadcastCallback();
      resolve(true);
    });
  });
}

function stopServer() {
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
  isRunning = false;
  logger.info('WEB-SHARE', 'Web share server stopped');
  if (broadcastCallback) broadcastCallback();
}

let userChosenIp = '';

function setChosenIp(ip) {
  userChosenIp = ip;
  if (broadcastCallback) broadcastCallback();
}

function getShareInfo() {
  const ifaces = getAvailableInterfaces();
  const recommended = ifaces.find(i => !i.isVirtual && i.score > 0) || ifaces[0];
  const recommendedIp = recommended ? recommended.ip : '127.0.0.1';

  // 优先用用户手动选定的有效 IP，否则默认选中推荐的第一名物理网卡 IP
  if (userChosenIp && ifaces.some(i => i.ip === userChosenIp)) {
    currentIp = userChosenIp;
  } else {
    currentIp = recommendedIp;
  }
  const url = `http://${currentIp}:${currentPort}`;
  const localUrl = `http://127.0.0.1:${currentPort}`;
  let qrSvg = '';
  if (isRunning) {
    try {
      qrSvg = generateQrSvg(url, 2, '#1a1f2c', '#ffffff');
    } catch (e) {
      logger.warn('WEB-SHARE', `Failed to generate QR SVG: ${e.message}`);
    }
  }
  const onlineClients = getOnlineClients();
  return {
    enabled: isRunning,
    port: currentPort,
    ip: currentIp,
    recommendedIp,
    url: isRunning ? url : '',
    localUrl: isRunning ? localUrl : '',
    interfaces: ifaces,
    qrSvg,
    clients: onlineClients,
    clientCount: onlineClients.length
  };
}

module.exports = {
  init: (services, broadcast, notify, askIncoming, showIncomingText) => {
    servicesRef = services;
    broadcastCallback = broadcast;
    notifyCallback = notify;
    askIncomingCallback = askIncoming;
    showIncomingTextCallback = showIncomingText;
    // 默认自启 Web 快传服务
    startServer();
  },
  start: startServer,
  stop: stopServer,
  setChosenIp,
  getShareInfo,
  addSharedFiles,
  addSharedText
};

