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
  const decimal = String(parseInt(hexValue, 16));
  const r = base === 'm1ddc'
    ? await run(tool, ['display', String(index), 'set', 'input', decimal])
    : await run(tool, ['-d', String(index), '-i', hexValue]);
  if (r.ok) return { ok: true, via: base };
  return { ok: false, via: base, error: r.err || '切换失败' };
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

module.exports = { listDisplays, setInput, labelOf, INPUT_LABELS, IS_WIN, IS_MAC };
