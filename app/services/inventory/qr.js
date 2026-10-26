import bwipjs from 'bwip-js';

/** QR code as an SVG string (self-contained, safe to inline in PDF HTML). */
export const qrSvg = (text, { scale = 3 } = {}) =>
  bwipjs.toSVG({ bcid: 'qrcode', text: String(text), scale, eclevel: 'M' });

/** Linear/2D barcode as an SVG string. bcid e.g. 'code128', 'ean13', 'datamatrix'. */
export const barcodeSvg = (code, bcid = 'code128') =>
  bwipjs.toSVG({ bcid, text: String(code), scale: 2, height: 10, includetext: true });
