import fs from 'fs';
import { createCanvas } from '@napi-rs/canvas';
import { init as pdfiumInit } from '@embedpdf/pdfium';
import * as mupdf from 'mupdf';
export { mupdf };
export const SCALE = 1.5;
export const wasmBinary = fs.readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
export async function newPdfium() {
  const pdfium = await pdfiumInit({ wasmBinary });
  pdfium.PDFiumExt_Init();
  return pdfium;
}
export function mkHelpers(pdfium) {
  const P = pdfium.pdfium;
  const malloc = n => P.wasmExports.malloc(n);
  const free = p => P.wasmExports.free(p);
  const load = bytes => {
    const ptr = malloc(bytes.length); P.HEAPU8.set(bytes, ptr);
    const doc = pdfium.FPDF_LoadMemDocument(ptr, bytes.length, '');
    if (!doc) throw new Error('load failed err=' + pdfium.FPDF_GetLastError());
    return { doc, ptr };
  };
  const cstr = s => { const b = Buffer.from(s + '\0', 'utf8'); const p = malloc(b.length); P.HEAPU8.set(b, p); return p; };
  // UTF-16LE NUL-terminated (FPDF_WIDESTRING)
  const wstr = s => { const b = Buffer.from(s + '\0', 'utf16le'); const p = malloc(b.length); P.HEAPU8.set(b, p); return p; };
  const readWide = (ptr, bytes) => Buffer.from(P.HEAPU8.slice(ptr, ptr + bytes)).toString('utf16le').replace(/\0.*$/s, '');
  const save = (doc, flags = 0) => {
    const chunks = [];
    const cb = P.addFunction((self, data, size) => { chunks.push(Buffer.from(P.HEAPU8.slice(data, data + size))); return 1; }, 'iiii');
    const fw = malloc(8); P.setValue(fw, 1, 'i32'); P.setValue(fw + 4, cb, 'i32');
    const ok = pdfium.FPDF_SaveAsCopy(doc, fw, flags);
    P.removeFunction(cb); free(fw);
    if (!ok) throw new Error('SaveAsCopy failed');
    return Buffer.concat(chunks);
  };
  const render = (doc, idx, { formEnv = 0, scale = SCALE } = {}) => {
    const page = pdfium.FPDF_LoadPage(doc, idx);
    const w = Math.round(pdfium.FPDF_GetPageWidthF(page) * scale), h = Math.round(pdfium.FPDF_GetPageHeightF(page) * scale);
    const bmp = pdfium.FPDFBitmap_Create(w, h, 0);
    pdfium.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
    pdfium.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, 1 /*FPDF_ANNOT*/);
    if (formEnv) pdfium.FPDF_FFLDraw(formEnv, bmp, page, 0, 0, w, h, 0, 1);
    const buf = pdfium.FPDFBitmap_GetBuffer(bmp), stride = pdfium.FPDFBitmap_GetStride(bmp);
    const src = P.HEAPU8.subarray(buf, buf + stride * h);
    const cv = createCanvas(w, h), ctx = cv.getContext('2d'), img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = y * stride + x * 4, d = (y * w + x) * 4;
      img.data[d] = src[s + 2]; img.data[d + 1] = src[s + 1]; img.data[d + 2] = src[s]; img.data[d + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    pdfium.FPDFBitmap_Destroy(bmp); pdfium.FPDF_ClosePage(page);
    return cv.toBuffer('image/png');
  };
  return { P, malloc, free, load, cstr, wstr, readWide, save, render };
}
export const mupdfPng = (doc, idx = 0, scale = SCALE) =>
  Buffer.from(doc.loadPage(idx).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true).asPNG());

// ---- 공용 측정 도구 ----
import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import { loadImage } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
export async function pixels(png) { const im = await loadImage(png); const cv = createCanvas(im.width, im.height); const c = cv.getContext('2d'); c.drawImage(im, 0, 0); return { w: im.width, h: im.height, d: c.getImageData(0, 0, im.width, im.height).data }; }
// 두 PNG의 사각형 영역(px) 안에서 달라진 화소 수
export async function regionDiff(pngA, pngB, [x0, y0, x1, y1]) {
  const a = await pixels(pngA), b = await pixels(pngB); let n = 0;
  if (a.w !== b.w || a.h !== b.h) return -1;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(a.h, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(a.w, Math.ceil(x1)); x++) {
    const i = (y * a.w + x) * 4; if (Math.abs(a.d[i] - b.d[i]) + Math.abs(a.d[i + 1] - b.d[i + 1]) + Math.abs(a.d[i + 2] - b.d[i + 2]) > 30) n++; }
  return n;
}
export function qpdfCheck(file) {
  const r = spawnSync('qpdf', ['--check', file], { encoding: 'utf8' });
  return { exit: r.status, ok: r.status === 0 || r.status === 3 && false, out: (r.stdout + r.stderr).split('\n').filter(l => /error|warning|No syntax|WARNING/i.test(l)).slice(0, 4).join(' | ') };
}
export function pyVerify(...files) {
  const r = spawnSync('.venv/Scripts/python', ['verify_sig.py', ...files], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return [{ error: 'verify parse fail ' + r.stderr.slice(-200) }]; }
}
export async function pdfjsRender(bytes, idx = 0, scale = SCALE) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, standardFontDataUrl: path.resolve('node_modules/pdfjs-dist/standard_fonts') + '/', cMapUrl: path.resolve('node_modules/pdfjs-dist/cmaps') + '/', cMapPacked: true, verbosity: 0 });
  const doc = await task.promise; const page = await doc.getPage(idx + 1); const vp = page.getViewport({ scale });
  const cv = createCanvas(Math.round(vp.width), Math.round(vp.height));
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, canvas: cv }).promise;
  await task.destroy(); return cv.toBuffer('image/png');
}
export const toU8 = b => new Uint8Array(b.buffer, b.byteOffset, b.length);

// PDFium 에 한글 시스템 폰트 훅 설치 (항목1 m1_font.mjs 와 같은 로직)
export function installFont(pdfium, H, fontPath, face = 'Malgun Gothic') {
  const P = H.P, fontBytes = fs.readFileSync(fontPath); const readC = p => { let s = ''; for (let c; (c = P.HEAPU8[p++]); ) s += String.fromCharCode(c); return s; };
  const info = H.malloc(36), fn = {};
  fn.release = P.addFunction(() => {}, 'vi');
  fn.enum = P.addFunction((self, mapper) => { pdfium.FPDF_AddInstalledFont(mapper, H.cstr(face), 129); }, 'vii');
  fn.map = P.addFunction((self, w, it, cs, pf, f) => (cs === 129 ? 1 : 0), 'iiiiiiii');
  fn.get = P.addFunction((self, f) => (/malgun|noto/i.test(readC(f)) ? 1 : 0), 'iii');
  fn.data = P.addFunction((self, h, table, buf, size) => {
    if (table === 0) { if (buf && size >= fontBytes.length) P.HEAPU8.set(fontBytes, buf); return fontBytes.length; }
    const nt = fontBytes.readUInt16BE(4);
    for (let i = 0; i < nt; i++) { const o = 12 + i * 16; const tg = fontBytes.readUInt32BE(o); const sw = ((tg & 255) << 24 | (tg >> 8 & 255) << 16 | (tg >> 16 & 255) << 8 | tg >>> 24) >>> 0;
      if (tg === table || sw === table) { const off = fontBytes.readUInt32BE(o + 8), len = fontBytes.readUInt32BE(o + 12); if (buf && size >= len) P.HEAPU8.set(fontBytes.subarray(off, off + len), buf); return len; } }
    return 0; }, 'iiiiii');
  fn.name = P.addFunction((self, h, buf, size) => { const b = Buffer.from(face + '\0'); if (buf && size >= b.length) P.HEAPU8.set(b, buf); return b.length; }, 'iiiii');
  fn.cs = P.addFunction(() => 129, 'iii'); fn.del = P.addFunction(() => {}, 'vii');
  P.setValue(info, 1, 'i32'); [fn.release, fn.enum, fn.map, fn.get, fn.data, fn.name, fn.cs, fn.del].forEach((f, i) => P.setValue(info + 4 + i * 4, f, 'i32'));
  pdfium.FPDF_SetSystemFontInfo(info);
}
