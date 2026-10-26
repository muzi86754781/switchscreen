'use strict';

/**
 * 原生 DDC/CI 层：直接读写显示器 VCP 0x60（输入源），不依赖用户手动安装工具。
 *
 * Windows：调用系统自带的 dxva2.dll（通过 PowerShell + 内嵌 C# P/Invoke），零外部依赖。
 * macOS  ：使用随包分发的 m1ddc（Apple Silicon）或 ddcctl（Intel），找不到再回退 PATH。
 *
 * 输入源编号沿用 VESA 标准值（十进制 = 十六进制）：
 *   0x0f(15) DP1 · 0x10(16) DP2 · 0x11(17) HDMI1 · 0x12(18) HDMI2 · 0x1b(27) USB-C
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const INPUT_LABELS = {
  0x01: 'VGA', 0x03: 'DVI', 0x04: 'DVI2',
  0x0f: 'DP1', 0x10: 'DP2',
  0x11: 'HDMI1', 0x12: 'HDMI2', 0x13: 'HDMI3',
  0x1b: 'USB-C', 0x1a: 'USB-C2'
};

function labelOf(hex) {
  const n = parseInt(hex, 16);
  return INPUT_LABELS[n] || String(hex);
}

/** Win32 错误码 → 人能看懂的话（直接甩「错误码 203」等于没说） */
function winErrText(code) {
  const c = Number(code);
  if (c === 31) return '显示器拒绝了 DDC 指令（请在显示器菜单里开启 DDC/CI）';
  if (c === 5) return '系统拒绝访问显示器（可能被安全软件拦截）';
  if (c === 6) return '显示器句柄已失效（切换过程中系统重排了显示拓扑）';
  if (c === 87) return '接口参数不被显示器接受';
  if (c === 1168) return '找不到这块显示器';
  return `设置失败${c ? `，错误码 ${c}` : ''}`;
}

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: String(stdout || ''),
        err: err ? (stderr || err.message) : '',
        code: err && err.code ? err.code : 0
      });
    });
  });
}

/* ---------------- Windows：DXVA2 ---------------- */

function psScriptPath() {
  const p = path.join(__dirname, 'win-ddc.ps1');
  // 打包后文件在 app.asar.unpacked 里才能被 PowerShell 读取
  return p.includes(`app.asar${path.sep}`) ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : p;
}

function psArgs(script, extra) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script].concat(extra);
}

async function winList() {
  const script = psScriptPath();
  if (!fs.existsSync(script)) {
    return { ok: false, via: 'dxva2', displays: [], error: 'DDC 脚本缺失' };
  }
  const r = await run('powershell.exe', psArgs(script, ['-Action', 'list']));
  if (!r.ok) return { ok: false, via: 'dxva2', displays: [], error: r.err };

  const displays = [];
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.trim().match(/^MON=(\d+)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/);
    if (!m) continue;
    const index = Number(m[1]);
    const hex = m[3] || '';
    // 第五段是面板硬件 ID（METRO\DELA0A4\…），用它和 WMI 的 InstanceName 精确配对
    const hw = m[5] || '';
    const hwid = (hw.match(/MONITOR\\([^\\]+)/i) || [])[1] || '';
    displays.push({
      index,
      name: m[2] || `显示器 ${index + 1}`,
      currentInput: hex,
      currentInputLabel: hex ? labelOf(hex) : '',
      hwid
    });
  }
  if (!displays.length) {
    return { ok: false, via: 'dxva2', displays: [], error: '未枚举到物理显示器' };
  }
  return { ok: true, via: 'dxva2', displays };
}

/**
 * Windows：在同一个 PowerShell 进程里按计划切换。
 *
 * plan 是字符串：
 *   "*=17"          所有当前枚举到的显示器（不依赖 index，最稳）
 *   "0=17;1=18"     按 index 指定接口（各屏接的端口不同时用）
 *
 * 脚本内部会「同时下发 → 校验 → 用新句柄重试」，因为第一块屏切走后
 * Windows 立刻重排显示拓扑，串行写会让后面几块屏静默失败。
 */
async function winApply(planStr) {
  const script = psScriptPath();
  const r = await run('powershell.exe', psArgs(script, ['-Action', 'setplan', '-Plan', planStr]));
  const results = [];
  let count = 0;
  for (const line of r.out.split(/\r?\n/)) {
    const t = line.trim();
    const c = t.match(/^COUNT=(\d+)$/);
    if (c) { count = Number(c[1]); continue; }
    const m = t.match(/^MON=(\d+)\|(True|False|SKIP|GONE)\|(\d+)$/i);
    if (!m) continue;
    const verdict = m[2].toUpperCase();
    if (verdict === 'SKIP') continue;
    if (verdict === 'GONE') {
      results.push({ index: Number(m[1]), ok: false, via: 'dxva2', error: '这块显示器已经不在本机（可能已切走）' });
      continue;
    }
    const ok = verdict === 'TRUE';
    results.push({ index: Number(m[1]), ok, via: 'dxva2', error: ok ? '' : winErrText(m[3]) });
  }
  const sum = summarize(results, 'dxva2', r.err);
  sum.enumerated = count;
  return sum;
}

/** 单块显示器切换（index 来自 listDisplays 的枚举顺序） */
async function winSet(index, hexValue) {
  return winApply(`${index}=${parseInt(hexValue, 16)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 所有显示器切到同一接口。
 *
 * 内部已经「同时下发 + 校验 + 重试」；这里再补一层外部重试：
 * 切完之后系统还会重排一次显示拓扑，隔一会儿再发一遍 "*"，
 * 此时枚举到的正好是「还没切走的那几块屏」，等于对着失败的那几块重试。
 */
async function winApplyAll(hexValue) {
  const plan = `*=${parseInt(hexValue, 16)}`;
  let r = await winApply(plan);
  for (let i = 0; i < 2 && (!r.ok || r.partial); i += 1) {
    await sleep(700);
    const again = await winApply(plan);
    if (again.ok && !again.partial) {
      // 第二次把剩下的都切走了：总数按两次里最大的算（第一次已经切走的不再枚举）
      const total = Math.max(r.total, again.total);
      return { ...again, ok: true, partial: false, total, success: total, error: '' };
    }
    if (again.ok) {
      r = { ...again, total: Math.max(r.total, again.total), partial: true, error: again.error || r.error };
    } else if (!r.ok) {
      r = { ...r, error: r.error || again.error };
    }
  }
  return r;
}

function summarize(results, via, fallbackError) {
  const okList = results.filter((x) => x.ok);
  const failList = results.filter((x) => !x.ok);
  return {
    ok: okList.length > 0,
    partial: okList.length > 0 && failList.length > 0,
    total: results.length,
    success: okList.length,
    via,
    results,
    error: failList.length ? failList[0].error : (fallbackError || '')
  };
}

/* ---------------- macOS：m1ddc / ddcctl ---------------- */

function toolPath(names) {
  // 1) 随包分发的 tools 目录  2) 常见安装路径
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'tools') : '',
    '/usr/local/bin',
    '/opt/homebrew/bin'
  ].filter(Boolean);
  for (const name of names) {
    for (const root of roots) {
      const p = path.join(root, name);
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
  }
  return '';
}

async function which(cmd) {
  const r = await run('/usr/bin/which', [cmd], 6000);
  return r.ok ? r.out.trim() : '';
}

async function macTool() {
  const bundled = toolPath(['m1ddc', 'ddcctl']);
  if (bundled) return bundled;
  const m1 = await which('m1ddc');
  if (m1) return m1;
  return await which('ddcctl');
}

/**
 * macOS 上读「当前输入源」（VCP 0x60）。
 * 之前这里直接把 currentInput 写死成空字符串 —— 结果 Mac 端永远判不出
 * 「这块屏现在在显示谁」，界面上任何电脑、任何显示器都不会被选中。
 * m1ddc 支持 `display <n> get input`；ddcctl 没有读接口，读不到就老实返回空。
 */
async function macReadInput(tool, index) {
  if (path.basename(tool) !== 'm1ddc') return '';
  try {
    const r = await run(tool, ['display', String(index), 'get', 'input'], 5000);
    if (!r.ok) return '';
    const blob = `${r.out || ''}\n${r.err || ''}`;
    // 参数不被支持时 m1ddc 会打印用法，别把用法里的数字当输入源
    if (/usage|error|invalid|unknown/i.test(blob)) return '';
    const hex = blob.match(/0x([0-9a-f]{1,4})/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      if (n > 0) return '0x' + n.toString(16).padStart(2, '0');
    }
    // 有的版本直接打印十进制（17 = HDMI1）
    const dec = blob.match(/(?:^|\s)(\d{1,3})(?:\s|$)/);
    if (dec) {
      const n = parseInt(dec[1], 10);
      if (n > 0) return '0x' + n.toString(16).padStart(2, '0');
    }
  } catch { /* 读不到就算了，绝不能因此拖慢启动 */ }
  return '';
}

async function macList() {
  const tool = await macTool();
  if (!tool) {
    return { ok: false, via: 'none', displays: [], error: '未找到 m1ddc/ddcctl' };
  }
  const base = path.basename(tool);
  if (base === 'm1ddc') {
    const r = await run(tool, ['display', 'list']);
    if (r.ok) {
      const lines = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const displays = await Promise.all(lines.map(async (line, i) => {
        const hex = await macReadInput(tool, i + 1);
        // m1ddc 的输出形如「[1] DELL U2414H (XXXXXXXX)」：序号和括号尾巴都要剥掉，
        // 只留下真实型号名 —— 它是跨机器认屏（稳定键 / 接口同步）的依据
        const name = line
          .replace(/^\[\d+\]\s*/, '')
          .replace(/^\d+[.:)]\s*/, '')
          .replace(/\s*\([^)]*\)\s*$/, '')
          .trim();
        return {
          index: i + 1,
          name: name || `显示器 ${i + 1}`,
          currentInput: hex,
          currentInputLabel: hex ? labelOf(hex) : ''
        };
      }));
      if (displays.length) return { ok: true, via: 'm1ddc', displays };
    }
    return { ok: false, via: 'm1ddc', displays: [], error: r.err || 'm1ddc 未返回显示器列表' };
  }
  // ddcctl 无稳定 list 输出，按 1..2 探测
  return {
    ok: true,
    via: 'ddcctl',
    displays: [
      { index: 1, name: '显示器 1', currentInput: '', currentInputLabel: '' },
      { index: 2, name: '显示器 2', currentInput: '', currentInputLabel: '' }
    ]
  };
}

async function macSet(index, hexValue) {
  const tool = await macTool();
  if (!tool) return { ok: false, via: 'none', error: '未找到 m1ddc/ddcctl' };
  const base = path.basename(tool);
  // ddcctl 的 -i 只接受 1-18 的十进制值，传 0x11 会被判为参数错误（打印 Usage）
  const decimal = String(parseInt(hexValue, 16));
  const r = base === 'm1ddc'
    ? await run(tool, ['display', String(index), 'set', 'input', decimal])
    : await run(tool, ['-d', String(index), '-i', decimal]);

  const blob = `${r.out}\n${r.err}`;
  if (/Usage:\s*ddcctl/i.test(blob)) {
    return {
      ok: false,
      via: base,
      error: `ddcctl 参数被拒绝（输入源必须是 1-18 的十进制，当前值 ${hexValue} → ${decimal}）`
    };
  }
  if (r.ok) return { ok: true, via: base };
  return { ok: false, via: base, error: (r.err || r.out || '切换失败').trim().slice(0, 200) };
}

function sameName(a, b) {
  const x = String(a || '').toLowerCase().replace(/[\s\-_()（）]/g, '');
  const y = String(b || '').toLowerCase().replace(/[\s\-_()（）]/g, '');
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * macOS 上「切走一台后序号整体前移」，所以每次都重新枚举、按名字定位；
 * 写失败或写完还在列表里（没走）就再试一轮。
 */
async function macSetAll(plan, names) {
  const label = (p) => (names && names[p.index]) || p.name || '';
  let queue = plan.map((p) => ({ value: p.value, name: label(p), index: p.index }));
  const results = [];
  const seen = new Set();

  for (let round = 0; round < 3 && queue.length; round++) {
    if (round) await new Promise((r) => setTimeout(r, 500));
    const next = [];
    for (const item of queue) {
      let idx = null;
      try {
        const fresh = await macList();
        const list = fresh.displays || [];
        const hit = list.find((d) => sameName(d.name, item.name));
        if (hit) idx = hit.index;
      } catch { /* ignore */ }
      if (idx === null) {
        // 名字匹配不到：退回原来的序号
        idx = item.index;
      }
      const r = await macSet(idx, item.value);
      if (r.ok) {
        if (!seen.has(item.name)) { seen.add(item.name); results.push({ index: idx, name: item.name, ...r }); }
      } else if (round === 2 || item.name === '') {
        if (!seen.has(item.name)) { seen.add(item.name); results.push({ index: idx, name: item.name, ...r }); }
      } else {
        next.push({ ...item, index: idx }); // 再试一次
      }
    }
    queue = next;
  }

  const tool = await macTool();
  return summarize(results, tool ? path.basename(tool) : 'none', '');
}

/* ---------------- 对外接口 ---------------- */

async function listDisplays() {
  if (IS_WIN) return winList();
  if (IS_MAC) return macList();
  return { ok: false, via: 'none', displays: [], error: `不支持的平台：${process.platform}` };
}

async function setInput(index, hexValue) {
  if (IS_WIN) return winSet(index, hexValue);
  if (IS_MAC) return macSet(index, hexValue);
  return { ok: false, via: 'none', error: `不支持的平台：${process.platform}` };
}

/**
 * 把所有检测到的显示器一起切到目标输入源。
 *
 * target 可以是：
 *   - "0x11" 字符串：所有显示器切到同一个接口（Windows 用 "*"，不依赖 index）；
 *   - { "0": "0x11", "1": "0x12" } 对象：按显示器 index 分别指定接口
 *     （多显示器各接不同端口时用，key 也接受 "ddc:0" 形式）。
 *
 * opts.names: { index: 显示器名 }，macOS 上用来在序号错位后重新定位。
 */
async function setInputAll(target, opts) {
  const o = opts || {};
  const isMap = target && typeof target === 'object';

  // Windows 的统一接口不需要先枚举：直接告诉脚本「所有屏」，这样
  // 中途有显示器增减也不会切错屏，还省掉一次 PowerShell 启动
  if (IS_WIN && !isMap && target) {
    const all = await winApplyAll(target);
    if (all.total > 0) return all;
  }

  const l = await listDisplays();
  const list = (l.displays || []).slice();

  if (!list.length) {
    return { ok: false, total: 0, success: 0, via: l.via, error: l.error || '未检测到显示器' };
  }

  const plan = [];
  for (const d of list) {
    // Mac 自带屏没有 DDC，跟着一起切只会每次都报「部分失败」
    if (IS_MAC && !isMap && /built-?in|内建|color lcd/i.test(d.name || '')) continue;
    let v = isMap ? (target[d.index] || target[`ddc:${d.index}`]) : target;
    if (!v) continue;
    plan.push({ index: d.index, name: d.name, value: v });
  }
  if (!plan.length) {
    return { ok: false, total: list.length, success: 0, via: l.via, error: '没有可用的接口配置' };
  }

  if (IS_WIN) {
    const str = plan.map((p) => `${p.index}=${parseInt(p.value, 16)}`).join(';');
    const all = await winApply(str);
    if (all.total > 0) return all;
  }

  if (IS_MAC) {
    const r = await macSetAll(plan, o.names || {});
    if (r.total > 0) return r;
  }

  const results = [];
  for (const p of plan) {
    const r = await setInput(p.index, p.value);
    results.push({ index: p.index, name: p.name, ...r });
  }
  return summarize(results, l.via, '');
}

module.exports = { listDisplays, setInput, setInputAll, labelOf, INPUT_LABELS, IS_WIN, IS_MAC };
