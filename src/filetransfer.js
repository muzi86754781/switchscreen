'use strict';

/**
 * 局域网文件/文本传输（LANDrop 风格）。
 * 复用已有的 WebSocket 链路，协议全部是 JSON 文本消息：
 *   file-offer  {id, files:[{name,size}], total}
 *   file-accept {id}
 *   file-chunk  {id, data(base64)}
 *   file-done   {id}
 *   file-cancel {id, reason}
 *   text-send   {text}
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CHUNK = 256 * 1024;

function safeName(name) {
  // 保留子目录结构，但去掉 .. 与绝对路径
  const parts = String(name).split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..');
  return parts.join(path.sep) || `file-${Date.now()}`;
}

async function uniquePath(dir) {
  let p = dir;
  let i = 1;
  while (true) {
    try {
      await fsp.access(p);
      const ext = path.extname(dir);
      const base = dir.slice(0, dir.length - ext.length);
      p = `${base} (${i})${ext}`;
      i += 1;
    } catch {
      return p;
    }
  }
}

function createFileTransfer({ send, recvDir, onUpdate }) {
  const outgoing = new Map();
  const incoming = new Map();
  const records = new Map();

  function list() {
    return [...records.values()].sort((a, b) => b.at - a.at).slice(0, 20);
  }

  function emit() {
    if (typeof onUpdate === 'function') onUpdate(list());
  }

  function record(id, patch) {
    const r = records.get(id) || { id, at: Date.now() };
    Object.assign(r, patch, { at: Date.now() });
    records.set(id, r);
    emit();
    return r;
  }

  /* ---------------- 发送 ---------------- */

  async function collect(paths) {
    const files = [];
    for (const p of paths) {
      let st;
      try { st = await fsp.stat(p); } catch { continue; }
      if (st.isDirectory()) {
        const root = path.dirname(p);
        const walk = async (dir) => {
          let entries = [];
          try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) await walk(fp);
            else if (e.isFile()) {
              try {
                const s = await fsp.stat(fp);
                files.push({ path: fp, name: path.relative(root, fp), size: s.size });
              } catch { /* ignore */ }
            }
          }
        };
        await walk(p);
      } else if (st.isFile()) {
        files.push({ path: p, name: path.basename(p), size: st.size });
      }
    }
    return files;
  }

  async function offerFiles(paths, target) {
    const files = await collect(paths);
    if (!files.length) return { ok: false, error: '没有可发送的文件' };
    const id = crypto.randomBytes(6).toString('hex');
    const total = files.reduce((a, f) => a + f.size, 0);
    outgoing.set(id, { id, files, index: 0, sent: 0, total, canceled: false });
    record(id, {
      id,
      dir: 'out',
      name: files.length === 1 ? files[0].name : `${files[0].name} 等 ${files.length} 项`,
      size: total,
      done: 0,
      status: 'waiting',
      peer: target || ''
    });
    send({ type: 'file-offer', id, files: files.map((f) => ({ name: f.name, size: f.size })), total });
    return { ok: true, id };
  }

  async function pump(id) {
    const job = outgoing.get(id);
    if (!job || job.running) return;
    job.running = true;
    record(id, { status: 'sending' });
    try {
      while (job.index < job.files.length) {
        if (job.canceled) throw new Error('canceled');
        const f = job.files[job.index];
        const fd = await fsp.open(f.path, 'r');
        try {
          const buf = Buffer.alloc(CHUNK);
          let pos = 0;
          while (pos < f.size) {
            if (job.canceled) throw new Error('canceled');
            const want = Math.min(CHUNK, f.size - pos);
            const { bytesRead } = await fd.read(buf, 0, want, pos);
            if (!bytesRead) break;
            pos += bytesRead;
            job.sent += bytesRead;
            send({ type: 'file-chunk', id, data: buf.subarray(0, bytesRead).toString('base64') });
            record(id, { done: job.sent, status: 'sending' });
            // 让出事件循环，避免长时间占住 WS（键鼠/剪贴板消息还要走同一条链路）
            await new Promise((r) => setTimeout(r, 0));
          }
        } finally {
          await fd.close();
        }
        job.index += 1;
      }
      send({ type: 'file-done', id });
      record(id, { status: 'done', done: job.total });
    } catch (e) {
      if (job.canceled) {
        send({ type: 'file-cancel', id, reason: 'sender-canceled' });
        record(id, { status: 'canceled' });
      } else {
        record(id, { status: 'failed', error: e.message });
      }
    } finally {
      outgoing.delete(id);
    }
  }

  function cancel(id) {
    const job = outgoing.get(id);
    if (job) { job.canceled = true; return true; }
    const inJob = incoming.get(id);
    if (inJob) {
      try { inJob.fd && inJob.fd.close(); } catch { /* ignore */ }
      incoming.delete(id);
      record(id, { status: 'canceled' });
      return true;
    }
    return false;
  }

  /* ---------------- 接收 ---------------- */

  async function openCurrent(job) {
    const cur = job.files[job.index];
    const rel = safeName(cur.name);
    const full = path.join(recvDir(), rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const finalPath = await uniquePath(full);
    job.fd = await fsp.open(finalPath, 'w');
    job.curWritten = 0;
    job.currentPath = finalPath;
    if (!job.saved) job.saved = [];
    job.saved.push(finalPath);
  }

  async function onOffer(msg, from) {
    const id = msg.id;
    try { await fsp.mkdir(recvDir(), { recursive: true }); } catch { /* ignore */ }
    incoming.set(id, {
      id, from,
      files: msg.files || [],
      index: 0,
      curWritten: 0,
      received: 0,
      total: msg.total || 0,
      fd: null
    });
    record(id, {
      id,
      dir: 'in',
      name: (msg.files && msg.files.length === 1) ? msg.files[0].name : `${(msg.files && msg.files[0] && msg.files[0].name) || '文件'} 等 ${(msg.files || []).length} 项`,
      size: msg.total || 0,
      done: 0,
      status: 'receiving',
      peer: from
    });
    send({ type: 'file-accept', id });
  }

  async function writeBuf(job, id, buf) {
    if (job.finished) return;
    let bufPos = 0;
    while (bufPos < buf.length) {
      if (!job.fd) {
        if (job.index >= job.files.length) break;
        await openCurrent(job);
      }
      const cur = job.files[job.index];
      const remain = cur.size - job.curWritten;
      if (remain <= 0) {
        await job.fd.close();
        job.fd = null;
        job.index += 1;
        job.curWritten = 0;
        continue;
      }
      const take = Math.min(remain, buf.length - bufPos);
      await job.fd.write(buf.subarray(bufPos, bufPos + take));
      job.curWritten += take;
      bufPos += take;
      job.received += take;
      if (job.curWritten >= cur.size) {
        await job.fd.close();
        job.fd = null;
        job.index += 1;
        job.curWritten = 0;
      }
    }
    if (!job.finished) record(id, { done: job.received, status: 'receiving' });
  }

  /**
   * 接收分块。注意：写盘是异步的，必须按作业串行排队，
   * 否则 file-done 可能先于最后一块落盘到达，导致状态回退 / 文件写串。
   */
  function onChunk(msg) {
    const job = incoming.get(msg.id);
    if (!job) return;
    const buf = Buffer.from(msg.data, 'base64');
    job.chain = (job.chain || Promise.resolve())
      .then(() => writeBuf(job, msg.id, buf))
      .catch((e) => {
        job.finished = true;
        record(msg.id, { status: 'failed', error: e.message });
        incoming.delete(msg.id);
      });
  }

  function onDone(msg) {
    const job = incoming.get(msg.id);
    if (!job) return;
    job.chain = (job.chain || Promise.resolve())
      .then(async () => {
        job.finished = true;
        try { if (job.fd) await job.fd.close(); } catch { /* ignore */ }
        incoming.delete(msg.id);
        record(msg.id, {
          status: 'done',
          done: job.total,
          saved: job.saved || [],
          path: (job.saved && job.saved[0]) || ''
        });
      })
      .catch((e) => {
        record(msg.id, { status: 'failed', error: e.message });
        incoming.delete(msg.id);
      });
  }

  function onCancel(msg) {
    const job = incoming.get(msg.id);
    if (job) {
      try { job.fd && job.fd.close(); } catch { /* ignore */ }
      incoming.delete(msg.id);
    }
    record(msg.id, { status: 'canceled' });
  }

  /* ---------------- 消息入口 ---------------- */

  function handle(msg, from) {
    if (!msg) return false;
    switch (msg.type) {
      case 'file-offer': onOffer(msg, from); return true;
      case 'file-accept': pump(msg.id); return true;
      case 'file-chunk': onChunk(msg); return true;
      case 'file-done': onDone(msg); return true;
      case 'file-cancel': onCancel(msg); return true;
      default: return false;
    }
  }

  /** 发送一段文本（走 file 标签页的文本发送） */
  function sendText(text, target) {
    if (!text) return { ok: false };
    const id = crypto.randomBytes(6).toString('hex');
    send({ type: 'text-send', id, text });
    record(id, { id, dir: 'out', name: `文本 · ${text.slice(0, 24)}${text.length > 24 ? '…' : ''}`, size: Buffer.byteLength(text), done: Buffer.byteLength(text), status: 'done', peer: target || '', text });
    return { ok: true, id };
  }

  function onText(msg, from) {
    const size = Buffer.byteLength(msg.text || '');
    record(msg.id || crypto.randomBytes(6).toString('hex'), {
      dir: 'in',
      name: `文本 · ${(msg.text || '').slice(0, 24)}${(msg.text || '').length > 24 ? '…' : ''}`,
      size,
      done: size,
      status: 'done',
      peer: from,
      text: msg.text || ''
    });
  }

  return { offerFiles, cancel, handle, sendText, onText, list, records };
}

module.exports = { createFileTransfer };
