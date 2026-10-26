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
  0x0f: 'DP1', 0x10: 'DP2',
  0x11: 'HDMI1', 0x12: 'HDMI2', 0x13: 'HDMI3',
  0x1b: 'USB-C', 0x1a: 'USB-C2'
};

function labelOf(hex) {
  const n = parseInt(hex, 16);
  return INPUT_LABELS[n] || String(hex);
}

function run(cmd, args, timeout = 12000) {
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

async function winList() {
  const script = psScriptPath();
  if (!fs.existsSync(script)) {
    return { ok: false, via: 'dxva2', displays: [], error: 'DDC 脚本缺失' };
  }
  const r = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'list'
  ]);
  if (!r.ok) return { ok: false, via: 'dxva2', displays: [], error: r.err };

  const displays = [];
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.trim().match(/^MON=(\d+)\|([^|]*)\|(.*)$/);
    if (!m) continue;
    const index = Number(m[1]);
    displays.push({
      index,
      name: m[2] || `显示器 ${index + 1}`,
      currentInput: m[3] || '',
      currentInputLabel: m[3] ? labelOf(m[3]) : ''
    });
  }
  if (!displays.length) {
    return { ok: false, via: 'dxva2', displays: [], error: '未枚举到物理显示器' };
  }
  return { ok: true, via: 'dxva2', displays };
}

async function winSet(index, hexValue) {
  const script = psScriptPath();
  const r = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', 'set', '-Index', String(index), '-Value', String(parseInt(hexValue, 16))
  ]);
  const m = r.out.match(/SET=(True|False)/i);
  const ok = !!m && m[1].toLowerCase() === 'true';
  const errCode = (r.out.match(/ERR=(\d+)/) || [])[1];
  if (ok) return { ok: true, via: 'dxva2' };
  return {
    ok: false,
    via: 'dxva2',
    error: errCode === '31'
      ? '显示器拒绝了 DDC 指令（请在显示器菜单里开启 DDC/CI）'
      : (r.err || `设置失败${errCode ? `，错误码 ${errCode}` : ''}`)
  };
}

/**
 * Windows：一次 PowerShell 进程内按计划切换（每台显示器可以指向不同接口）。
 * plan: [{ index, value }]，value 为 "0x11" 形式的字符串。
 */
async function winSetPlan(plan) {
  const script = psScriptPath();
  const str = plan
    .filter((p) => typeof p.index === 'number')
    .map((p) => `${p.index}=${parseInt(p.value, 16)}`)
    .join(';');
  const r = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', 'setplan', '-Plan', str
  ]);
  const results = [];
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.trim().match(/^MON=(\d+)\|(True|False|SKIP)\|(\d+)$/i);
    if (!m) continue;
    const verdict = m[2].toUpperCase();
    if (verdict === 'SKIP') continue;
    const ok = verdict === 'TRUE';
    results.push({
      index: Number(m[1]),
      ok,
      via: 'dxva2',
      error: ok ? '' : (m[3] === '31' ? '显示器拒绝了 DDC 指令（请在显示器菜单里开启 DDC/CI）' : `设置失败，错误码 ${m[3]}`)
    });
  }
  return summarize(results, 'dxva2', r.err);
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
      const displays = lines.map((line, i) => ({
        index: i + 1,
        name: line.replace(/^\d+[.:)]\s*/, '') || `显示器 ${i + 1}`,
        currentInput: '',
        currentInputLabel: ''
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
 *   - "0x11" 字符串：所有显示器切到同一个接口；
 *   - { "0": "0x11", "1": "0x12" } 对象：按显示器 index 分别指定接口
 *     （多显示器各接不同端口时用，key 也接受 "ddc:0" 形式）。
 *
 * 顺序执行（并发读写 DDC 容易互相干扰），并统计成功/失败。
 */
async function setInputAll(target, opts) {
  const o = opts || {};
  const l = await listDisplays();
  const list = (l.displays || []).slice();
  if (!list.length) {
    return { ok: false, total: 0, success: 0, via: l.via, error: l.error || '未检测到显示器' };
  }

  const isMap = target && typeof target === 'object';
  const plan = [];
  for (const d of list) {
    let v = isMap ? (target[d.index] || target[`ddc:${d.index}`]) : target;
    if (!v) continue;
    plan.push({ index: d.index, name: d.name, value: v });
  }
  if (!plan.length) {
    return { ok: false, total: list.length, success: 0, via: l.via, error: '没有可用的接口配置' };
  }

  // Windows：一次性切完（单个 PowerShell 进程里只枚举一次，index 不会中途错位）
  if (IS_WIN) {
    const all = await winSetPlan(plan);
    if (all.total > 0) return all;
  }

  const results = [];
  for (const p of plan) {
    let idx = p.index;
    // macOS 的 index 是一次性的：切走一台后系统会把它从列表里摘掉，
    // 后面的序号整体前移，所以每切一台都按名字重新定位。
    if (IS_MAC && o.names && o.names[p.index]) {
      try {
        const fresh = await listDisplays();
        const hit = (fresh.displays || []).find((d) => sameName(d.name, o.names[p.index]));
        if (hit) idx = hit.index;
      } catch { /* ignore */ }
    }
    const r = await setInput(idx, p.value);
    results.push({ index: idx, name: p.name, ...r });
  }
  return summarize(results, l.via, '');
}

function sameName(a, b) {
  const x = String(a || '').toLowerCase().replace(/[\s\-_()（）]/g, '');
  const y = String(b || '').toLowerCase().replace(/[\s\-_()（）]/g, '');
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

module.exports = { listDisplays, setInput, setInputAll, labelOf, INPUT_LABELS, IS_WIN, IS_MAC };
