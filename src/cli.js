#!/usr/bin/env node
'use strict';

const { createPeer } = require('./peer');
const { loadConfig, saveConfig, setPeerInput } = require('./config');

function cmdStart() {
  createPeer();
}

function cmdRecordHotkey() {
  const { uIOhook } = require('uiohook-napi');
  console.log('按下你想设为「切换电脑」的快捷键组合（含修饰键）…');
  let done = false;
  uIOhook.on('keydown', (e) => {
    if (done) return;
    done = true;
    const cfg = loadConfig();
    cfg.switchHotkey = {
      keycode: e.keycode,
      ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey
    };
    saveConfig(cfg);
    console.log('已保存快捷键:', JSON.stringify(cfg.switchHotkey));
    uIOhook.stop();
    process.exit(0);
  });
  uIOhook.start();
}

function cmdConfig(args) {
  if (args[0] === 'set-peer-input' && args[1] && args[2]) {
    setPeerInput(args[1], args[2]);
    console.log(`已记录对端 ${args[1]} 的显示器输入源 = ${args[2]}`);
    return;
  }
  const cfg = loadConfig();
  console.log(JSON.stringify(cfg, null, 2));
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'start') cmdStart();
  else if (cmd === 'record-hotkey') cmdRecordHotkey();
  else if (cmd === 'config') cmdConfig(args);
  else {
    console.log(`SwitchScreen 用法:
  switchscreen start              启动（两台都要跑）
  switchscreen record-hotkey      交互录制切换快捷键
  switchscreen config             查看当前配置
  switchscreen config set-peer-input <对端名> <输入源值>   记录对端显示器输入口
`);
  }
}

main();
