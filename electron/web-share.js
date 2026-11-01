'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { clipboard } = require('electron');
const { generateQrSvg } = require('./qrcode');
const logger = require('./logger');

let server = null;
let currentPort = 47749;
let currentIp = '127.0.0.1';
let isRunning = false;
let servicesRef = null;
let broadcastCallback = null;

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        const lowerName = name.toLowerCase();
        const isVirtual = /vethernet|wsl|docker|vmware|virtualbox|tailscale|zerotier|loopback|tap|tun/i.test(lowerName);
        candidates.push({ ip: net.address, isVirtual, name });
      }
    }
  }
  const nonVirtual = candidates.filter((c) => !c.isVirtual);
  if (nonVirtual.length > 0) return nonVirtual[0].ip;
  if (candidates.length > 0) return candidates[0].ip;
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

function buildWebHtml(pcName) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>SwitchScreen 快传 · ${pcName}</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b26;
      --card-border: rgba(255, 255, 255, 0.08);
      --text: #e6edf3;
      --text-sub: #8b949e;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --border-radius: 14px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 16px;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .container { width: 100%; max-width: 520px; }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 6px 20px;
    }
    .header-title { font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 20px;
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .badge::before { content: ""; width: 6px; height: 6px; background: currentColor; border-radius: 50%; }
    .card {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: var(--border-radius);
      padding: 18px;
      margin-bottom: 16px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
    }
    .card-title { font-size: 15px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 13px;
      background: var(--primary);
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      transition: 0.15s;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .upload-box {
      border: 2px dashed rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      padding: 28px 16px;
      text-align: center;
      cursor: pointer;
      transition: 0.16s;
      background: rgba(255, 255, 255, 0.02);
    }
    .upload-box:active { background: rgba(59, 130, 246, 0.08); border-color: var(--primary); }
    .upload-icon { font-size: 36px; margin-bottom: 6px; }
    .upload-text { font-size: 15px; font-weight: 600; color: #fff; }
    .upload-sub { font-size: 12px; color: var(--text-sub); margin-top: 4px; }
    .file-input { display: none; }
    textarea {
      width: 100%;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      color: #fff;
      padding: 12px;
      font-size: 14px;
      resize: vertical;
      min-height: 80px;
      outline: none;
      margin-bottom: 10px;
      font-family: inherit;
    }
    textarea:focus { border-color: var(--primary); }
    .progress-bar {
      width: 100%;
      height: 6px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
      margin-top: 10px;
      overflow: hidden;
      display: none;
    }
    .progress-fill { height: 100%; width: 0%; background: var(--primary); transition: width 0.1s; }
    .file-list { margin-top: 8px; max-height: 240px; overflow-y: auto; }
    .file-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 8px;
      margin-bottom: 6px;
      font-size: 13px;
    }
    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-right: 8px;
      flex: 1;
    }
    .file-size { color: var(--text-sub); font-size: 12px; white-space: nowrap; }
    .dl-btn {
      padding: 5px 12px;
      background: rgba(59, 130, 246, 0.15);
      color: var(--primary);
      border-radius: 6px;
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      margin-left: 10px;
    }
    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(20, 24, 33, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #fff;
      padding: 10px 18px;
      border-radius: 24px;
      font-size: 14px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      display: none;
      z-index: 100;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-title">⚡ SwitchScreen 快传</div>
      <div class="badge">已连接 ${pcName}</div>
    </div>

    <!-- 发送文件到电脑 -->
    <div class="card">
      <div class="card-title">📁 发送文件 / 照片到电脑</div>
      <div class="upload-box" id="uploadBox">
        <div class="upload-icon">📤</div>
        <div class="upload-text">点击选择照片、视频或文件</div>
        <div class="upload-sub">支持批量多选 · 局域网直传秒速送达</div>
      </div>
      <input type="file" id="fileInput" class="file-input" multiple>
      <div class="progress-bar" id="progressBar">
        <div class="progress-fill" id="progressFill"></div>
      </div>
    </div>

    <!-- 发送文字到电脑 -->
    <div class="card">
      <div class="card-title">📝 发送文本到电脑</div>
      <textarea id="textInput" placeholder="输入要发送的文本，电脑会自动写入剪贴板…"></textarea>
      <button class="btn" id="sendTextBtn">发送文字到电脑</button>
    </div>

    <!-- 从电脑下载文件 -->
    <div class="card">
      <div class="card-title">📥 电脑端接收的文件（点击下载）</div>
      <div class="file-list" id="fileList">
        <div style="color: var(--text-sub); font-size: 13px; text-align: center; padding: 12px;">正在加载文件列表…</div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 2400);
    }

    const uploadBox = document.getElementById('uploadBox');
    const fileInput = document.getElementById('fileInput');
    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');

    uploadBox.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      progressBar.style.display = 'block';

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          showToast('正在上传: ' + file.name + ' (' + (i + 1) + '/' + files.length + ')');
          await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name), true);
            xhr.upload.onprogress = (ev) => {
              if (ev.lengthComputable) {
                const percent = Math.round((ev.loaded / ev.total) * 100);
                progressFill.style.width = percent + '%';
              }
            };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) resolve();
              else reject(new Error('Upload failed'));
            };
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(file);
          });
        } catch (err) {
          showToast('上传失败: ' + file.name);
        }
      }
      progressBar.style.display = 'none';
      progressFill.style.width = '0%';
      fileInput.value = '';
      showToast('全部文件已成功送达电脑！');
      loadFiles();
    });

    const textInput = document.getElementById('textInput');
    const sendTextBtn = document.getElementById('sendTextBtn');
    sendTextBtn.addEventListener('click', async () => {
      const text = textInput.value.trim();
      if (!text) return;
      try {
        sendTextBtn.disabled = true;
        const res = await fetch('/api/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        if (res.ok) {
          textInput.value = '';
          showToast('文本已成功发送至电脑剪贴板！');
        } else {
          showToast('发送失败');
        }
      } catch (err) {
        showToast('发送出错');
      } finally {
        sendTextBtn.disabled = false;
      }
    });

    async function loadFiles() {
      try {
        const res = await fetch('/api/files');
        const list = await res.json();
        const box = document.getElementById('fileList');
        if (!list || !list.length) {
          box.innerHTML = '<div style="color: var(--text-sub); font-size: 13px; text-align: center; padding: 12px;">暂无文件</div>';
          return;
        }
        box.innerHTML = list.map(f => \`
          <div class="file-item">
            <span class="file-name" title="\${f.name}">\${f.name}</span>
            <span class="file-size">\${f.sizeStr}</span>
            <a class="dl-btn" href="/api/download?name=\${encodeURIComponent(f.name)}" download>下载</a>
          </div>
        \`).join('');
      } catch {}
    }
    loadFiles();
  </script>
</body>
</html>`;
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

  // 1. Web 页面
  if (req.method === 'GET' && pathname === '/') {
    const pcName = (servicesRef && servicesRef.cfg && servicesRef.cfg.ui && servicesRef.cfg.ui.displayName) || os.hostname();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildWebHtml(pcName));
    return;
  }

  // 2. 文件上传
  if (req.method === 'POST' && pathname === '/api/upload') {
    const rawName = urlObj.searchParams.get('name') || 'upload_' + Date.now();
    const filename = sanitizeFilename(rawName);
    const recvDir = getReceiveDir();
    const savePath = uniquePath(recvDir, filename);

    const writeStream = fs.createWriteStream(savePath);
    req.pipe(writeStream);

    writeStream.on('finish', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: path.basename(savePath) }));
      logger.info('WEB-SHARE', `Received file from mobile: ${path.basename(savePath)}`);
      if (servicesRef) {
        servicesRef.pushStatus(`手机网页端已传达文件：${path.basename(savePath)}`, 'ok');
      }
      if (broadcastCallback) broadcastCallback();
    });

    writeStream.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  // 3. 文本发送
  if (req.method === 'POST' && pathname === '/api/text') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const text = String(data.text || '').trim();
        if (text) {
          clipboard.writeText(text);
          if (servicesRef) {
            servicesRef.pushStatus(`已收到手机发送的文字并拷贝到剪贴板`, 'ok');
          }
          if (broadcastCallback) broadcastCallback();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 4. 文件列表查询
  if (req.method === 'GET' && pathname === '/api/files') {
    const recvDir = getReceiveDir();
    try {
      if (!fs.existsSync(recvDir)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      const files = fs.readdirSync(recvDir)
        .map((f) => {
          try {
            const st = fs.statSync(path.join(recvDir, f));
            return {
              name: f,
              size: st.size,
              sizeStr: formatBytes(st.size),
              mtime: st.mtimeMs
            };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 50);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
    }
    return;
  }

  // 5. 文件下载
  if (req.method === 'GET' && pathname === '/api/download') {
    const rawName = urlObj.searchParams.get('name') || '';
    const filename = path.basename(rawName);
    const recvDir = getReceiveDir();
    const filePath = path.join(recvDir, filename);

    if (!filename || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('文件不存在');
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`
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
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }

  currentIp = getLocalIp();
  currentPort = port;

  server = http.createServer(handleRequest);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && currentPort < 47760) {
      logger.warn('WEB-SHARE', `Port ${currentPort} in use, trying ${currentPort + 1}`);
      startServer(currentPort + 1);
    } else {
      logger.error('WEB-SHARE', `Server error: ${err.message}`);
      isRunning = false;
    }
  });

  server.listen(currentPort, '0.0.0.0', () => {
    isRunning = true;
    logger.info('WEB-SHARE', `Web share server running at http://${currentIp}:${currentPort}`);
    if (broadcastCallback) broadcastCallback();
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

function getShareInfo() {
  currentIp = getLocalIp();
  const url = `http://${currentIp}:${currentPort}`;
  let qrSvg = '';
  try {
    qrSvg = generateQrSvg(url, 2, '#1a1f2c', '#ffffff');
  } catch (e) {
    logger.warn('WEB-SHARE', `Failed to generate QR SVG: ${e.message}`);
  }
  return {
    enabled: isRunning,
    port: currentPort,
    ip: currentIp,
    url,
    qrSvg
  };
}

module.exports = {
  init: (services, broadcast) => {
    servicesRef = services;
    broadcastCallback = broadcast;
    // 默认自启 Web 快传服务
    startServer();
  },
  start: startServer,
  stop: stopServer,
  getShareInfo
};
