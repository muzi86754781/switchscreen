'use strict';

/**
 * 剪贴板跨机同步。
 * 思路：轮询本地剪贴板，发现变化就把文本广播给对端；收到对端剪贴板消息就写本地。
 * 用 lastLocal / 注入守卫避免「写入 → 又被轮询到 → 回传」的死循环。
 *
 * clipboardy v3+ 是纯 ESM 包，Electron 主进程(CommonJS)不能直接 require，
 * 这里做懒加载兼容：优先 require(CJS 版)，失败则动态 import(ESM 版)。
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

function createClipboardSync({ send, isEnabled, pollMs = 500 }) {
  let lastLocal = '';
  let suppressUntil = ''; // 本机即将写入的内容，写入后短期内忽略相同值

  async function tick() {
    if (!isEnabled()) return;
    let text;
    try {
      const clipboardy = await getClipboardy();
      text = await clipboardy.read();
    } catch { return; }
    if (text && text !== lastLocal && text !== suppressUntil) {
      lastLocal = text;
      send({ type: 'clipboard', text });
    }
  }

  function onRemoteClipboard(text) {
    if (!isEnabled()) return;
    suppressUntil = text;
    lastLocal = text;
    getClipboardy()
      .then((clipboardy) => clipboardy.write(text))
      .catch((e) => console.error('[clipboard] 写入失败', e.message));
    // 1 秒后解除抑制，避免和下一轮轮询冲突
    setTimeout(() => { if (suppressUntil === text) suppressUntil = ''; }, 1000);
  }

  const timer = setInterval(tick, pollMs);
  return { onRemoteClipboard, stop: () => clearInterval(timer) };
}

module.exports = { createClipboardSync };
