'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { shell } = require('electron');

const LOG_DIR = path.join(os.homedir(), '.switchscreen', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'switchscreen.log');
const OLD_LOG_FILE = path.join(LOG_DIR, 'switchscreen.old.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

const recentLogs = [];
const MAX_RECENT = 500;

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch (e) {
    console.error('[logger] Failed to create log directory:', e.message);
  }
}

function rotateIfNeeded() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const st = fs.statSync(LOG_FILE);
      if (st.size >= MAX_LOG_SIZE) {
        if (fs.existsSync(OLD_LOG_FILE)) {
          fs.unlinkSync(OLD_LOG_FILE);
        }
        fs.renameSync(LOG_FILE, OLD_LOG_FILE);
      }
    }
  } catch (e) {
    console.error('[logger] Rotation failed:', e.message);
  }
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function timestamp() {
  const d = new Date();
  const yr = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const hr = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const se = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);
  return `${yr}-${mo}-${da} ${hr}:${mi}:${se}.${ms}`;
}

function formatArg(arg) {
  if (arg === undefined) return '';
  if (arg === null) return 'null';
  if (arg instanceof Error) {
    return `${arg.message}\n${arg.stack || ''}`;
  }
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function writeLog(level, tag, msg, extra) {
  const ts = timestamp();
  const tagStr = tag ? `[${tag}]` : '';
  let line = `[${ts}] [${level}] ${tagStr} ${formatArg(msg)}`;
  if (extra !== undefined) {
    line += ` | ${formatArg(extra)}`;
  }

  // Console output
  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }

  // In-memory buffer
  recentLogs.push(line);
  if (recentLogs.length > MAX_RECENT) {
    recentLogs.shift();
  }

  // File output
  try {
    ensureDir();
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    console.error('[logger] Write failed:', e.message);
  }
}

const logger = {
  debug: (tag, msg, extra) => writeLog('DEBUG', tag, msg, extra),
  info: (tag, msg, extra) => writeLog('INFO', tag, msg, extra),
  warn: (tag, msg, extra) => writeLog('WARN', tag, msg, extra),
  error: (tag, msg, extra) => writeLog('ERROR', tag, msg, extra),

  getLogPath: () => LOG_FILE,
  getLogDir: () => LOG_DIR,

  getRecentLogs: (limit = 100) => {
    return recentLogs.slice(-limit);
  },

  openLogFile: async () => {
    ensureDir();
    if (!fs.existsSync(LOG_FILE)) {
      try {
        fs.writeFileSync(LOG_FILE, `[${timestamp()}] [INFO] [INIT] SwitchScreen log file created\n`, 'utf8');
      } catch { /* ignore */ }
    }
    if (shell && typeof shell.openPath === 'function') {
      return shell.openPath(LOG_FILE);
    }
    return '';
  },

  openLogDir: async () => {
    ensureDir();
    if (shell && typeof shell.openPath === 'function') {
      return shell.openPath(LOG_DIR);
    }
    return '';
  }
};

module.exports = logger;
