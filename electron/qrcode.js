'use strict';

const QRCode = require('qrcode');

/**
 * 使用标准 QRCode 库生成高兼容性、高识别率的 SVG 矢量二维码
 * 兼容 iOS 相机、微信扫一扫、华为/小米系统相机及各类扫码器
 *
 * @param {string} text - 要编码的 URL 或文本
 * @param {number} margin - 外边距模块数（默认 2）
 * @param {string} dark - 前景色（默认深黑 #1a1f2c）
 * @param {string} light - 背景色（默认纯白 #ffffff）
 * @returns {string} SVG 矢量代码字符串
 */
function generateQrSvg(text, margin = 2, dark = '#1a1f2c', light = '#ffffff') {
  if (!text) return '';
  let result = '';
  // QRCode.toString 在无外部 I/O 情况下通过回调函数同步返回 SVG 结果
  QRCode.toString(
    String(text),
    {
      type: 'svg',
      margin: typeof margin === 'number' ? margin : 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: dark || '#1a1f2c',
        light: light || '#ffffff'
      }
    },
    (err, svg) => {
      if (!err && svg) {
        result = svg;
      }
    }
  );
  return result;
}

module.exports = {
  generateQrSvg
};
