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

function createClipboardSync({ send, isEnabled, read, write, pollMs = 500, onError } = {}) {
  let lastLocal = '';
  let suppressUntil = ''; // 本机即将写入的内容，写入后短期内忽略相同值
  let primed = false;     // 第一轮只记录当前内容，别把开机时的旧剪贴板推给对端
  let complained = false;

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

  async function tick() {
    if (!isEnabled()) return;
    let text = '';
    try {
      if (typeof read === 'function') {
        text = String(read() || '');
      } else {
        const clipboardy = await getClipboardy();
        text = String(await clipboardy.read());
      }
    } catch (e) {
      fail('读取', e);
      return;
    }
    // 第一轮只记录当前内容，别把开机时剪贴板里的旧东西推给对端。
    // 空剪贴板也算「初始状态」—— 否则用户第一次复制会被当成旧内容吃掉。
    if (!primed) { primed = true; lastLocal = text; return; }
    if (!text) return;
    if (text === lastLocal || text === suppressUntil) return;
    lastLocal = text;
    send({ type: 'clipboard', text });
  }

  function onRemoteClipboard(text) {
    if (!isEnabled() || !text) return;
    suppressUntil = text;
    lastLocal = text;
    try {
      if (typeof write === 'function') {
        write(text);
      } else {
        getClipboardy()
          .then((clipboardy) => clipboardy.write(text))
          .catch((e) => fail('写入', e));
      }
    } catch (e) {
      fail('写入', e);
    }
    // 1 秒后解除抑制，避免和下一轮轮询冲突
    setTimeout(() => { if (suppressUntil === text) suppressUntil = ''; }, 1000);
  }

  const timer = setInterval(tick, pollMs);
  return { onRemoteClipboard, tick, stop: () => clearInterval(timer) };
}

module.exports = { createClipboardSync };
