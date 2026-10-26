'use strict';

const { exec } = require('child_process');
const os = require('os');

/**
 * 用 DDC/CI 把显示器输入源切到指定值。
 * 命令模板来自 config.monitor.command[platform]，{input} 替换为目标机的输入源值。
 *
 * 常见输入源值（因显示器而异，请用 ddcutil capabilities 查询）：
 *   0x11 = HDMI1, 0x12 = HDMI2, 0x13 = HDMI3, 0x0f = DisplayPort1, 0x10 = DisplayPort2
 */

function switchSource({ platform, command, input }) {
  if (!command) {
    console.warn('[monitor] 未配置切换命令，跳过（请在 config.monitor.command 填写）');
    return;
  }
  const cmd = command.replace('{input}', input || '');
  console.log(`[monitor] 执行: ${cmd}`);
  exec(cmd, (err, stdout, stderr) => {
    if (err) console.error('[monitor] 切换失败:', err.message, stderr);
    else console.log('[monitor] 已切换');
  });
}

function getPlatform() {
  return os.platform(); // 'win32' | 'darwin' | 'linux'
}

module.exports = { switchSource, getPlatform };
