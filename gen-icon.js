// 生成标准的 512x512 PNG 与多尺寸复合 Windows .ico 应用图标
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function createPng(width, height) {
  const W = width, H = height;
  function px(x, y) {
    const r = Math.round(W * 0.1875);
    const inX = Math.min(x, W - 1 - x), inY = Math.min(y, H - 1 - y);
    if ((x < r && y < r && (r - inX) ** 2 + (r - inY) ** 2 > r * r) ||
        (x < r && y >= H - r && (r - inX) ** 2 + (r - (H - 1 - y)) ** 2 > r * r) ||
        (x >= W - r && y < r && (r - (W - 1 - x)) ** 2 + (r - inY) ** 2 > r * r) ||
        (x >= W - r && y >= H - r && (r - (W - 1 - x)) ** 2 + (r - (H - 1 - y)) ** 2 > r * r)) {
      return [0, 0, 0, 0]; // 透明圆角
    }
    // 主体科技蓝渐变
    const t = y / H;
    const R = Math.round(35 + t * 25);
    const G = Math.round(110 - t * 30);
    const B = Math.round(235 - t * 35);

    // 双屏重叠与切换箭头示意（高质感现代化图标）
    const normX = x / W;
    const normY = y / H;

    // 显示器外框 1 (左后)
    if (normX >= 0.22 && normX <= 0.62 && normY >= 0.22 && normY <= 0.58) {
      if (normX <= 0.25 || normX >= 0.59 || normY <= 0.25 || normY >= 0.55) return [180, 210, 255, 240];
      return [30, 60, 120, 220];
    }
    // 显示器外框 2 (右前)
    if (normX >= 0.38 && normX <= 0.78 && normY >= 0.42 && normY <= 0.78) {
      if (normX <= 0.41 || normX >= 0.75 || normY <= 0.45 || normY >= 0.75) return [255, 255, 255, 255];
      return [60, 130, 245, 255];
    }
    // 切换连接光带 (双向指示)
    if (normY >= 0.36 && normY <= 0.40 && normX >= 0.45 && normX <= 0.55) {
      return [255, 200, 80, 255];
    }

    return [R, G, B, 255];
  }

  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * (1 + W * 4) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    const c = crc32(Buffer.concat([t, data]));
    crc.writeUInt32BE(c >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  }
  function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 确保 build 目录存在
if (!fs.existsSync('build')) fs.mkdirSync('build', { recursive: true });

// 1. 生成 512x512 高清 PNG
const png512 = createPng(512, 512);
fs.writeFileSync('build/icon.png', png512);
console.log('已生成 build/icon.png 大小=', png512.length, '字节');

// 2. 生成包含多分辨率的 Windows .ico 图标 (256, 128, 64, 48, 32, 16)
const icoSizes = [256, 128, 64, 48, 32, 16];
const pngBuffers = icoSizes.map((size) => createPng(size, size));

const count = icoSizes.length;
const headerLen = 6;
const dirEntryLen = 16;
let dataOffset = headerLen + count * dirEntryLen;

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // Reserved
header.writeUInt16LE(1, 2); // 1 = ICO
header.writeUInt16LE(count, 4);

const entries = [];
for (let i = 0; i < count; i++) {
  const size = icoSizes[i];
  const pngBuf = pngBuffers[i];
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // bWidth
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // bHeight
  entry.writeUInt8(0, 2);                      // bColorCount
  entry.writeUInt8(0, 3);                      // bReserved
  entry.writeUInt16LE(1, 4);                   // wPlanes
  entry.writeUInt16LE(32, 6);                  // wBitCount
  entry.writeUInt32LE(pngBuf.length, 8);       // dwBytesInRes
  entry.writeUInt32LE(dataOffset, 12);         // dwImageOffset
  entries.push(entry);
  dataOffset += pngBuf.length;
}

const ico = Buffer.concat([header, ...entries, ...pngBuffers]);
fs.writeFileSync('build/icon.ico', ico);
console.log('已生成 build/icon.ico 大小=', ico.length, '字节');
