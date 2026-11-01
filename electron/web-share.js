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

const sharedFilesToPhone = new Map();
let sharedTextToPhone = null;
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
      padding: 14px 16px 36px;
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
      padding: 10px 4px 16px;
    }
    .header-title { font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .badge {
      font-size: 11px;
      padding: 3px 9px;
      border-radius: 20px;
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .badge::before { content: ""; width: 6px; height: 6px; background: currentColor; border-radius: 50%; box-shadow: 0 0 6px currentColor; }
    .card {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: var(--border-radius);
      padding: 16px 18px;
      margin-bottom: 14px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
    }
    .card-highlight {
      border-color: rgba(59, 130, 246, 0.35);
      background: linear-gradient(180deg, rgba(22, 27, 38, 0.98), rgba(18, 23, 34, 0.98));
    }
    .card-title { font-size: 14.5px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
    .card-title-left { display: flex; align-items: center; gap: 7px; }
    .live-tag {
      font-size: 10px;
      color: #60a5fa;
      background: rgba(59, 130, 246, 0.15);
      padding: 1px 6px;
      border-radius: 10px;
      font-weight: 500;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 12px;
      background: var(--primary);
      color: #fff;
      font-size: 14.5px;
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
      padding: 24px 16px;
      text-align: center;
      cursor: pointer;
      transition: 0.16s;
      background: rgba(255, 255, 255, 0.02);
    }
    .upload-box:active { background: rgba(59, 130, 246, 0.08); border-color: var(--primary); }
    .upload-icon { font-size: 32px; margin-bottom: 4px; }
    .upload-text { font-size: 14.5px; font-weight: 600; color: #fff; }
    .upload-sub { font-size: 11.5px; color: var(--text-sub); margin-top: 4px; }
    .file-input { display: none; }
    textarea {
      width: 100%;
      background: rgba(0, 0, 0, 0.28);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      color: #fff;
      padding: 11px;
      font-size: 13.5px;
      resize: vertical;
      min-height: 80px;
      outline: none;
      margin-bottom: 10px;
      font-family: inherit;
      line-height: 1.5;
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
    .file-list { margin-top: 4px; max-height: 280px; overflow-y: auto; }
    .file-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 9px;
      margin-bottom: 7px;
      font-size: 13px;
    }
    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
      color: #f0f4fc;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .file-size { color: var(--text-sub); font-size: 11.5px; margin-top: 2px; }
    .dl-btn {
      padding: 6px 14px;
      background: linear-gradient(180deg, #3b82f6, #2563eb);
      color: #ffffff;
      border-radius: 7px;
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      margin-left: 10px;
      box-shadow: 0 2px 8px rgba(37, 99, 235, 0.35);
    }
    .dl-btn:active { opacity: 0.85; }
    .pc-text-box {
      background: rgba(59, 130, 246, 0.09);
      border: 1px solid rgba(59, 130, 246, 0.28);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 12px;
    }
    .pc-text-head {
      font-size: 11.5px;
      color: #93c5fd;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 7px;
      font-weight: 600;
    }
    .pc-text-body {
      font-size: 14px;
      color: #ffffff;
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.55;
      margin-bottom: 10px;
      max-height: 180px;
      overflow-y: auto;
      user-select: text;
    }
    .btn-copy {
      padding: 9px 12px;
      font-size: 13px;
      background: rgba(16, 185, 129, 0.2);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #34d399;
      border-radius: 8px;
      width: 100%;
      cursor: pointer;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .btn-copy:active { background: rgba(16, 185, 129, 0.3); }
    .toast {
      position: fixed;
      top: 18px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(17, 24, 39, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.16);
      color: #fff;
      padding: 10px 20px;
      border-radius: 24px;
      font-size: 13.5px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      display: none;
      z-index: 100;
      white-space: nowrap;
      text-align: center;
    }
    /* 移动端发送选项卡与目标选择 */
    .m-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 10px;
    }
    .m-tab-btn {
      flex: 1;
      appearance: none;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: var(--text-sub);
      font-size: 13.5px;
      font-weight: 500;
      padding: 9px 10px;
      border-radius: 9px;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .m-tab-btn.is-active {
      background: rgba(59, 130, 246, 0.2);
      border-color: rgba(96, 165, 250, 0.6);
      color: #93c5fd;
      font-weight: 600;
    }
    .m-target-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      font-size: 12.5px;
      color: var(--text-sub);
    }
    .m-target-select {
      appearance: none;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.16);
      color: #93c5fd;
      border-radius: 7px;
      font-size: 12px;
      padding: 6px 10px;
      outline: none;
      max-width: 220px;
      cursor: pointer;
    }
    .sender-tag {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(59, 130, 246, 0.15);
      border: 1px solid rgba(59, 130, 246, 0.35);
      color: #93c5fd;
      font-weight: 500;
      margin-left: 5px;
      display: inline-block;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-title">⚡ SwitchScreen 快传</div>
      <div class="badge">已连接 ${pcName}</div>
    </div>

    <!-- 1. 接收区（来自电脑与其它手机） -->
    <div class="card card-highlight">
      <div class="card-title">
        <div class="card-title-left">
          <span>📥 接收区（来自电脑与其它手机）</span>
        </div>
        <span class="live-tag">● 实时同步</span>
      </div>

      <!-- 收到的文本 -->
      <div id="pcTextBox" class="pc-text-box" style="display: none;">
        <div class="pc-text-head">
          <div><span>📝 收到的文字</span><span id="pcTextSender" class="sender-tag">来自 电脑</span></div>
          <span id="pcTextTime">刚刚</span>
        </div>
        <div id="pcTextContent" class="pc-text-body"></div>
        <button type="button" class="btn-copy" id="copyPcTextBtn">📋 一键复制到手机剪贴板</button>
      </div>

      <!-- 收到的文件列表 -->
      <div class="file-list" id="pcFileList">
        <div style="color: var(--text-sub); font-size: 12.5px; text-align: center; padding: 12px;">暂未收到文件（支持电脑发来或其它手机互传）</div>
      </div>
    </div>

    <!-- 2. 发送区（选项卡切换发送文件/发送文本，支持发给电脑与手机互传） -->
    <div class="card">
      <div class="m-tabs">
        <button type="button" class="m-tab-btn is-active" id="mTabFile">📤 发送照片 / 文件</button>
        <button type="button" class="m-tab-btn" id="mTabText">📝 发送文本</button>
      </div>

      <div class="m-target-row">
        <span>发送给：</span>
        <select class="m-target-select" id="mTargetSelect">
          <option value="all">📢 电脑与全部手机 (互传)</option>
          <option value="pc">💻 仅电脑</option>
        </select>
      </div>

      <!-- 选项卡 1：发送文件 -->
      <div id="mPaneFile">
        <div class="upload-box" id="uploadBox">
          <div class="upload-icon">📁</div>
          <div class="upload-text">点击选择照片、视频或文件</div>
          <div class="upload-sub">支持批量多选 · 局域网直传 · 电脑及目标手机立即收到</div>
        </div>
        <input type="file" id="fileInput" class="file-input" multiple>
        <div class="progress-bar" id="progressBar">
          <div class="progress-fill" id="progressFill"></div>
        </div>
      </div>

      <!-- 选项卡 2：发送文本 -->
      <div id="mPaneText" style="display: none;">
        <textarea id="textInput" placeholder="输入文字，点击发送即可送达目标设备…"></textarea>
        <button class="btn" id="sendTextBtn">发送文字</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    function detectDeviceName() {
      var ua = navigator.userAgent || "";
      if (/iPad/i.test(ua)) return "iPad";
      if (/iPhone/i.test(ua)) return "iPhone";
      if (/Huawei|Honor/i.test(ua)) return "华为手机";
      if (/Xiaomi|Redmi/i.test(ua)) return "小米手机";
      if (/OPPO/i.test(ua)) return "OPPO手机";
      if (/vivo/i.test(ua)) return "vivo手机";
      if (/Android/i.test(ua)) return "Android手机";
      if (/Macintosh/i.test(ua)) return "Mac网页端";
      if (/Windows/i.test(ua)) return "Win网页端";
      return "手机设备";
    }
    var myClientId = "";
    try {
      myClientId = localStorage.getItem("ss_ws_cid");
      if (!myClientId) {
        myClientId = "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
        localStorage.setItem("ss_ws_cid", myClientId);
      }
    } catch (e) {
      myClientId = "c_" + Date.now().toString(36);
    }
    var myDeviceName = detectDeviceName();

    // 选项卡切换
    var mTabFile = document.getElementById("mTabFile");
    var mTabText = document.getElementById("mTabText");
    var mPaneFile = document.getElementById("mPaneFile");
    var mPaneText = document.getElementById("mPaneText");
    mTabFile.addEventListener("click", function() {
      mTabFile.classList.add("is-active");
      mTabText.classList.remove("is-active");
      mPaneFile.style.display = "block";
      mPaneText.style.display = "none";
    });
    mTabText.addEventListener("click", function() {
      mTabText.classList.add("is-active");
      mTabFile.classList.remove("is-active");
      mPaneText.style.display = "block";
      mPaneFile.style.display = "none";
    });

    function showToast(msg) {
      var t = document.getElementById("toast");
      t.innerText = msg;
      t.style.display = "block";
      clearTimeout(window.__toastTimer);
      window.__toastTimer = setTimeout(function() { t.style.display = "none"; }, 2600);
    }

    async function copyText(str) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(str);
          showToast("已复制到手机剪贴板！");
          return;
        }
      } catch (e) {}
      var ta = document.createElement("textarea");
      ta.value = str;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("已复制到手机剪贴板！");
    }

    // 上传文件
    var uploadBox = document.getElementById("uploadBox");
    var fileInput = document.getElementById("fileInput");
    var progressBar = document.getElementById("progressBar");
    var progressFill = document.getElementById("progressFill");
    var mTargetSelect = document.getElementById("mTargetSelect");

    uploadBox.addEventListener("click", function() { fileInput.click(); });

    fileInput.addEventListener("change", async function(e) {
      var files = Array.from(e.target.files || []);
      if (!files.length) return;
      progressBar.style.display = "block";
      var targetVal = (mTargetSelect && mTargetSelect.value) || "all";
      var targetName = (mTargetSelect && mTargetSelect.options[mTargetSelect.selectedIndex]) ? mTargetSelect.options[mTargetSelect.selectedIndex].text : "";

      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        try {
          showToast("正在上传: " + file.name + " (" + (i + 1) + "/" + files.length + ")");
          await new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            var url = "/api/upload?name=" + encodeURIComponent(file.name) +
                      "&cid=" + encodeURIComponent(myClientId) +
                      "&deviceName=" + encodeURIComponent(myDeviceName) +
                      "&target=" + encodeURIComponent(targetVal) +
                      "&targetName=" + encodeURIComponent(targetName);
            xhr.open("POST", url, true);
            xhr.upload.onprogress = function(ev) {
              if (ev.lengthComputable) {
                var percent = Math.round((ev.loaded / ev.total) * 100);
                progressFill.style.width = percent + "%";
              }
            };
            xhr.onload = function() {
              if (xhr.status >= 200 && xhr.status < 300) resolve();
              else reject(new Error("Upload failed"));
            };
            xhr.onerror = function() { reject(new Error("Network error")); };
            xhr.send(file);
          });
        } catch (err) {
          showToast("上传失败: " + file.name);
        }
      }
      progressBar.style.display = "none";
      progressFill.style.width = "0%";
      fileInput.value = "";
      showToast("文件已全部成功送达目标！");
      pollPcContent();
    });

    // 发送文字
    var textInput = document.getElementById("textInput");
    var sendTextBtn = document.getElementById("sendTextBtn");
    sendTextBtn.addEventListener("click", async function() {
      var text = textInput.value.trim();
      if (!text) return;
      var targetVal = (mTargetSelect && mTargetSelect.value) || "all";
      var targetName = (mTargetSelect && mTargetSelect.options[mTargetSelect.selectedIndex]) ? mTargetSelect.options[mTargetSelect.selectedIndex].text : "";
      try {
        sendTextBtn.disabled = true;
        var res = await fetch("/api/text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: text,
            cid: myClientId,
            deviceName: myDeviceName,
            target: targetVal,
            targetName: targetName
          })
        });
        if (res.ok) {
          textInput.value = "";
          showToast("文字已成功发送至目标！");
        } else {
          showToast("发送失败");
        }
      } catch (err) {
        showToast("发送出错，请检查Wi-Fi连接");
      } finally {
        sendTextBtn.disabled = false;
      }
    });

    // 复制收到的文字
    var pcTextBox = document.getElementById("pcTextBox");
    var pcTextContent = document.getElementById("pcTextContent");
    var pcTextSender = document.getElementById("pcTextSender");
    var copyPcTextBtn = document.getElementById("copyPcTextBtn");
    copyPcTextBtn.addEventListener("click", function() {
      if (pcTextContent.textContent) copyText(pcTextContent.textContent);
    });

    // 轮询内容
    var pcFileList = document.getElementById("pcFileList");
    var lastSeenTextId = null;
    var lastSeenFileCount = 0;
    var initialPoll = true;

    async function pollPcContent() {
      try {
        var res = await fetch("/api/poll?cid=" + encodeURIComponent(myClientId) + "&name=" + encodeURIComponent(myDeviceName));
        if (!res.ok) return;
        var data = await res.json();

        // 更新在线目标设备选择下拉框
        if (mTargetSelect && Array.isArray(data.clients)) {
          var otherClients = data.clients.filter(function(c) { return c.id !== myClientId; });
          var curVal = mTargetSelect.value || "all";
          var html = '<option value="all">📢 电脑与全部手机 (互传)</option><option value="pc">💻 仅电脑</option>';
          for (var k = 0; k < otherClients.length; k++) {
            var oc = otherClients[k];
            html += '<option value="' + oc.id + '">📱 ' + oc.name + ' (' + oc.ip + ')</option>';
          }
          if (mTargetSelect.dataset.lastHtml !== html) {
            mTargetSelect.innerHTML = html;
            mTargetSelect.dataset.lastHtml = html;
            mTargetSelect.value = curVal;
          }
        }

        // 文本更新（排除自己发的）
        if (data.text && data.text.text && data.text.fromId !== myClientId) {
          pcTextBox.style.display = "block";
          pcTextContent.textContent = data.text.text;
          if (pcTextSender) {
            pcTextSender.textContent = "来自 " + (data.text.fromName || (data.text.fromId ? "手机" : "电脑"));
          }
          if (!initialPoll && lastSeenTextId && lastSeenTextId !== data.text.id) {
            showToast("收到来自【" + (data.text.fromName || "电脑") + "】的新文字！");
            if (navigator.vibrate) navigator.vibrate(100);
          }
          lastSeenTextId = data.text.id;
        }

        // 文件更新（排除自己发的）
        var files = (data.files || []).filter(function(f) { return f.fromId !== myClientId; });
        if (files.length > 0) {
          if (!initialPoll && files.length > lastSeenFileCount) {
            showToast("收到新发来的文件！");
            if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
          }
          lastSeenFileCount = files.length;
          pcFileList.innerHTML = files.map(function(f) {
            var fromTag = '<span class="sender-tag">来自 ' + (f.fromName || (f.fromId ? "手机" : "电脑")) + '</span>';
            return '<div class="file-item">' +
              '<div style="flex: 1; min-width: 0; margin-right: 8px;">' +
                '<div class="file-name" title="' + f.name + '">' + f.name + fromTag + '</div>' +
                '<div class="file-size">' + f.sizeStr + '</div>' +
              '</div>' +
              '<a class="dl-btn" href="/api/download?id=' + encodeURIComponent(f.id) + '" download="' + encodeURIComponent(f.name) + '">⬇️ 下载保存</a>' +
            '</div>';
          }).join("");
        } else {
          pcFileList.innerHTML = '<div style="color: var(--text-sub); font-size: 12.5px; text-align: center; padding: 12px;">暂未收到文件（支持电脑发来或其它手机互传）</div>';
        }
        initialPoll = false;
      } catch (e) {}
    }

    setInterval(pollPcContent, 2000);
    pollPcContent();
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

    const filesForClient = Array.from(sharedFilesToPhone.values()).filter(f => {
      const isNotFromSelf = f.fromId !== cid;
      const isTargeted = !f.target || f.target === 'all' || f.target === cid;
      return isNotFromSelf && isTargeted;
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      text: textForClient,
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

    const recvDir = getReceiveDir();
    const savePath = uniquePath(recvDir, filename);

    const writeStream = fs.createWriteStream(savePath);
    req.pipe(writeStream);

    writeStream.on('finish', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: path.basename(savePath) }));

      const finalName = path.basename(savePath);
      let fileSize = 0;
      try { fileSize = fs.statSync(savePath).size; } catch {}
      logger.info('WEB-SHARE', `Received file from ${deviceName}: ${finalName} (${fileSize} bytes, target: ${target})`);

      // 若发送目标包含手机（非仅发电脑），加入 sharedFilesToPhone 供其它手机下载
      if (target !== 'pc') {
        const shareId = 'ws_p2p_f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        sharedFilesToPhone.set(shareId, {
          id: shareId,
          name: finalName,
          originalPath: savePath,
          size: fileSize,
          sizeStr: formatBytes(fileSize),
          target: target || 'all',
          targetName: targetName,
          fromId: cid,
          fromName: deviceName,
          at: Date.now()
        });
      }

      let peerLabel = `${deviceName} (${ip})`;
      if (target === 'all') {
        peerLabel = `${deviceName} (互传全部)`;
      } else if (target !== 'pc' && targetName) {
        peerLabel = `${deviceName} ➔ ${targetName.replace(/^📱\s*/, '')}`;
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
          path: savePath,
          at: Date.now()
        });
      }

      if (servicesRef && servicesRef.pushStatus) {
        servicesRef.pushStatus(`来自【${deviceName}】的文件已送达：${finalName}`, 'ok');
      }

      if (notifyCallback) {
        notifyCallback(`收到来自 ${deviceName} 的文件`, `${finalName} (${formatBytes(fileSize)})`);
      }

      if (broadcastCallback) broadcastCallback();
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
    req.on('end', () => {
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
          if (clipboard) {
            try { clipboard.writeText(text); } catch {}
          }
          const textPreview = text.length > 24 ? text.slice(0, 24) + '…' : text;

          // 若目标包含手机，设置 sharedTextToPhone 供其它手机复制
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
          }

          let peerLabel = `${deviceName} (${ip})`;
          if (target === 'all') {
            peerLabel = `${deviceName} (互传全部)`;
          } else if (target !== 'pc' && targetName) {
            peerLabel = `${deviceName} ➔ ${targetName.replace(/^📱\s*/, '')}`;
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

          if (servicesRef && servicesRef.pushStatus) {
            servicesRef.pushStatus(`已收到【${deviceName}】发送的文字并拷贝到剪贴板`, 'ok');
          }

          if (notifyCallback) {
            notifyCallback(`收到来自 ${deviceName} 的文字`, `已写入剪贴板：${text.slice(0, 60)}`);
          }

          if (broadcastCallback) broadcastCallback();
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

    try {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
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
  init: (services, broadcast, notify) => {
    servicesRef = services;
    broadcastCallback = broadcast;
    notifyCallback = notify;
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

