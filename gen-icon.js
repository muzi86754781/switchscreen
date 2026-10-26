// 生成一张有效的 256x256 蓝色圆角方块 PNG，作为应用图标（避免损坏 PNG 导致 electron-builder 失败）
const zlib = require('zlib');
const fs = require('fs');

const W = 512, H = 512;
// RGBA 像素：蓝紫渐变底色 + 白色屏形图案（按 256 基准放大 2 倍，满足 macOS ICNS ≥512 要求）
function px(x, y) {
  // 圆角外框裁剪（r=96 对应 256 基准的 48）
  const r = 96;
  const inX = Math.min(x, W - 1 - x), inY = Math.min(y, H - 1 - y);
  if ((x < r && y < r && (r - inX) ** 2 + (r - inY) ** 2 > r * r) ||
      (x < r && y >= H - r && (r - inX) ** 2 + (r - (H - 1 - y)) ** 2 > r * r) ||
      (x >= W - r && y < r && (r - (W - 1 - x)) ** 2 + (r - inY) ** 2 > r * r) ||
      (x >= W - r && y >= H - r && (r - (W - 1 - x)) ** 2 + (r - (H - 1 - y)) ** 2 > r * r)) {
    return [0, 0, 0, 0]; // 透明
  }
  // 主体渐变（顶部浅蓝 -> 底部深蓝）
  const t = y / H;
  const R = Math.round(60 + t * 20);
  const G = Math.round(130 - t * 40);
  const B = Math.round(230 - t * 30);
  // 中心白色“屏幕”矩形（256 基准 70/56/186/172 放大 2 倍）
  const cx0 = 140, cy0 = 112, cx1 = 372, cy1 = 344;
  if (x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1) return [245, 248, 255, 255];
  return [R, G, B, 255];
}

const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter type 0
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
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync('build/icon.png', png);
console.log('已生成 build/icon.png 大小=', png.length, '字节');
