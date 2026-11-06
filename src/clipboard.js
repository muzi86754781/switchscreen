'use strict';

/**
 * 剪贴板跨机同步。
 * 轮询本地剪贴板，发现变化就把文本广播给对端；收到对端消息就写进本地剪贴板。
 * lastLocal / suppressUntil 用来避免「写入 → 又被轮询到 → 回传」的死循环。
 *
 * 读写优先用注入的 **Electron 原生 clipboard**（进程内实现，不依赖任何外部二进制）。
 * 以前这里一律用 clipboardy：它在 Windows 上要靠附带的可执行文件，
 * 打包进 asar 之后根本执行不了；而读失败的地方写的是 `catch { return; }`，
 * 错误被完全吞掉 —— 表现就是「A 电脑复制、B 电脑粘贴」一点反应都没有。
 * 现在读不到/写不进去会明确报一次错，不再静默。
 */

let clipboardyPromise = null;

function getClipboardy() {
  if (!clipboardyPromise) {
    clipboardyPromise = (async () => {
      try {
        return require('clipboardy');
      } catch {
        return await import('clipboardy');
      }
    })();
  }
  return clipboardyPromise;
}

function createClipboardSync({ send, isEnabled, read, write, pollMs = 350, onError, onLog } = {}) {
  let lastLocalKey = '';
  let suppressKey = '';
  let suppressUntilAt = 0;
  let primed = false;     // 第一轮只记录当前内容，别把开机时的旧剪贴板推给对端
  let complained = false;
  let pendingPayload = null; // 对端尚未连上时复制的内容，待对端连上后自动补发

  function log(msg) {
    if (typeof onLog === 'function') {
      try { onLog(msg); } catch { /* ignore */ }
    }
  }

  function fail(where, e) {
    const msg = `[剪贴板同步] ${where}失败：${(e && e.message) || e}`;
    if (!complained) {
      complained = true;
      console.error(msg);
      if (typeof onError === 'function') onError(msg);
    } else {
      console.warn(msg);
    }
  }

  function normalizeReadResult(raw) {
    if (!raw) return { key: '', text: '', image: '', getImageDataUrl: null };
    if (typeof raw === 'string') {
      return { key: raw ? `text:${raw}` : '', text: raw, image: '', getImageDataUrl: null };
    }
    if (typeof raw === 'object') {
      const text = typeof raw.text === 'string' ? raw.text : '';
      const imageKey = typeof raw.imageKey === 'string' ? raw.imageKey : '';
      const image = typeof raw.image === 'string' ? raw.image : '';
      const getImageDataUrl = typeof raw.getImageDataUrl === 'function' ? raw.getImageDataUrl : null;
      if (text) {
        return { key: `text:${text}`, text, image: '', getImageDataUrl: null };
      }
      if (imageKey || image) {
        return {
          key: `img:${imageKey || image.slice(0, 128)}`,
          text: '',
          image,
          getImageDataUrl
        };
      }
    }
    return { key: '', text: '', image: '', getImageDataUrl: null };
  }

  async function readCurrent() {
    if (typeof read === 'function') {
      return normalizeReadResult(await read());
    }
    const clipboardy = await getClipboardy();
    const t = String((await clipboardy.read()) || '');
    return normalizeReadResult(t);
  }

  async function tick() {
    if (!isEnabled()) return;
    let cur;
    try {
      cur = await readCurrent();
    } catch (e) {
      fail('读取', e);
      return;
    }

    // 第一轮只记录当前内容，别把开机时剪贴板里的旧东西推给对端。
    // 空剪贴板也算「初始状态」—— 否则用户第一次复制会被当成旧内容吃掉。
    if (!primed) {
      primed = true;
      lastLocalKey = cur.key;
      return;
    }

    // 如果剪贴板被清空或变成不可同步内容，必须同步更新 lastLocalKey，
    // 否则用户稍后再次复制与之前相同的一段文本时，会因 key === lastLocalKey 被误判为未变化而漏发！
    if (!cur.key) {
      lastLocalKey = '';
      return;
    }

    if (cur.key === suppressKey && Date.now() < suppressUntilAt) {
      return;
    }

    if (cur.key === lastLocalKey) {
      // 如果之前复制时还没有对端在线，现在对端在线了，把挂起的内容补发出去
      if (pendingPayload) {
        const sent = send(pendingPayload);
        if (sent !== false) {
          log(`Delivered pending clipboard payload (${pendingPayload.image ? 'image' : `text len=${(pendingPayload.text || '').length}`})`);
          pendingPayload = null;
        }
      }
      return;
    }

    lastLocalKey = cur.key;
    let payload = null;
    if (cur.text) {
      payload = { type: 'clipboard', text: cur.text };
    } else if (cur.image || cur.getImageDataUrl) {
      let dataUrl = cur.image;
      if (!dataUrl && cur.getImageDataUrl) {
        try { dataUrl = cur.getImageDataUrl() || ''; } catch { dataUrl = ''; }
      }
      if (dataUrl) {
        payload = { type: 'clipboard', text: '', image: dataUrl, imageKey: cur.key };
      }
    }

    if (!payload) return;

    const sent = send(payload);
    if (sent === false) {
      pendingPayload = payload;
      log(`Clipboard changed locally (${payload.image ? 'image' : `text len=${(payload.text || '').length}`}), queued for peer connection`);
    } else {
      pendingPayload = null;
      log(`Clipboard synced to peer (${payload.image ? 'image' : `text len=${(payload.text || '').length}`})`);
    }
  }

  function onRemoteClipboard(msgOrText) {
    if (!isEnabled() || !msgOrText) return;
    const isObj = typeof msgOrText === 'object';
    const text = isObj ? String(msgOrText.text || '') : String(msgOrText || '');
    const image = isObj ? String(msgOrText.image || '') : '';
    const imageKey = isObj ? String(msgOrText.imageKey || '') : '';

    if (!text && !image) return;

    const remoteKey = text ? `text:${text}` : (imageKey || `img:${image.slice(0, 128)}`);
    suppressKey = remoteKey;
    suppressUntilAt = Date.now() + 1800;
    lastLocalKey = remoteKey;
    pendingPayload = null;

    try {
      if (typeof write === 'function') {
        const updatedKey = write(isObj ? { text, image, imageKey: remoteKey } : text);
        if (typeof updatedKey === 'string' && updatedKey) {
          suppressKey = updatedKey;
          lastLocalKey = updatedKey;
        }
        log(`Clipboard received from peer and written (${image ? 'image' : `text len=${text.length}`})`);
      } else if (text) {
        getClipboardy()
          .then((clipboardy) => clipboardy.write(text))
          .catch((e) => fail('写入', e));
      }
    } catch (e) {
      fail('写入', e);
    }
  }

  function flush() {
    return tick();
  }

  const timer = setInterval(tick, pollMs);
  return { onRemoteClipboard, tick, flush, stop: () => clearInterval(timer) };
}

module.exports = { createClipboardSync };
