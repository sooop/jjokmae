import fs from 'fs';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as mupdf from 'mupdf';
import { init as pdfiumInit } from '@embedpdf/pdfium';
import { PDFDocument, degrees } from 'pdf-lib';

const SCALE = 1.5;
const samples = fs.readdirSync('samples').filter(f => f.endsWith('.pdf'));
const results = [];
const t = () => performance.now();

// ---------- PDFium ----------
const wasmBinary = fs.readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
const pdfium = await pdfiumInit({ wasmBinary });
pdfium.PDFiumExt_Init();
const P = pdfium.pdfium;
function pdfiumLoad(bytes) {
  const ptr = P.wasmExports.malloc(bytes.length);
  P.HEAPU8.set(bytes, ptr);
  const doc = pdfium.FPDF_LoadMemDocument(ptr, bytes.length, '');
  return { doc, ptr };
}
function pdfiumRender(doc, idx) {
  const page = pdfium.FPDF_LoadPage(doc, idx);
  const w = Math.round(pdfium.FPDF_GetPageWidthF(page) * SCALE);
  const h = Math.round(pdfium.FPDF_GetPageHeightF(page) * SCALE);
  const bmp = pdfium.FPDFBitmap_Create(w, h, 0);
  pdfium.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
  pdfium.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, 0x10 /*LCD? no: FPDF_ANNOT=1*/ | 1);
  const buf = pdfium.FPDFBitmap_GetBuffer(bmp);
  const stride = pdfium.FPDFBitmap_GetStride(bmp);
  const src = P.HEAPU8.subarray(buf, buf + stride * h);
  const cv = createCanvas(w, h); const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = y * stride + x * 4, d = (y * w + x) * 4;
    img.data[d] = src[s + 2]; img.data[d + 1] = src[s + 1]; img.data[d + 2] = src[s]; img.data[d + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  pdfium.FPDFBitmap_Destroy(bmp); pdfium.FPDF_ClosePage(page);
  return cv.toBuffer('image/png');
}
function pdfiumSave(doc) {
  const chunks = [];
  const cb = P.addFunction((self, data, size) => { chunks.push(Buffer.from(P.HEAPU8.slice(data, data + size))); return 1; }, 'iiii');
  const fw = P.wasmExports.malloc(8);
  P.setValue(fw, 1, 'i32'); P.setValue(fw + 4, cb, 'i32');
  const ok = pdfium.FPDF_SaveAsCopy(doc, fw, 0);
  P.removeFunction(cb); P.wasmExports.free(fw);
  if (!ok) throw new Error('SaveAsCopy failed');
  return Buffer.concat(chunks);
}

// ---------- pdf.js ----------
async function pdfjsRender(bytes, idx) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, standardFontDataUrl: path.resolve('node_modules/pdfjs-dist/standard_fonts') + '/', cMapUrl: path.resolve('node_modules/pdfjs-dist/cmaps') + '/', cMapPacked: true, verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(idx + 1);
  const vp = page.getViewport({ scale: SCALE });
  const cv = createCanvas(Math.round(vp.width), Math.round(vp.height));
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, canvas: cv }).promise;
  const n = doc.numPages; await task.destroy();
  return { png: cv.toBuffer('image/png'), n };
}

// ---------- MuPDF ----------
function mupdfRender(doc, idx) {
  const page = doc.loadPage(idx);
  const pm = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false, true);
  return Buffer.from(pm.asPNG());
}

for (const s of samples) {
  const name = s.replace('.pdf', '');
  const bytes = fs.readFileSync(path.join('samples', s));
  const row = { sample: name, srcBytes: bytes.length };
  // PDFium
  try {
    let a = t(); const { doc } = pdfiumLoad(bytes);
    const n = pdfium.FPDF_GetPageCount(doc);
    fs.writeFileSync(`out/${name}.pdfium.png`, pdfiumRender(doc, 0));
    row.pdfium_render_ms = Math.round(t() - a);
    const pg = pdfium.FPDF_LoadPage(doc, 0); pdfium.FPDFPage_SetRotation(pg, 1); pdfium.FPDF_ClosePage(pg);
    pdfium.FPDFPage_Delete(doc, n - 1);
    a = t(); const out = pdfiumSave(doc); row.pdfium_save_ms = Math.round(t() - a);
    fs.writeFileSync(`out/${name}.pdfium.saved.pdf`, out); row.pdfium_saved_bytes = out.length;
  } catch (e) { row.pdfium_err = String(e).slice(0, 120); }
  // pdf.js (render only)
  try { let a = t(); const r = await pdfjsRender(bytes, 0); row.pdfjs_render_ms = Math.round(t() - a); fs.writeFileSync(`out/${name}.pdfjs.png`, r.png); } catch (e) { row.pdfjs_err = String(e).slice(0, 120); }
  // MuPDF
  try {
    let a = t(); const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
    fs.writeFileSync(`out/${name}.mupdf.png`, mupdfRender(doc, 0)); row.mupdf_render_ms = Math.round(t() - a);
    const pdoc = doc.asPDF(); const n = pdoc.countPages();
    pdoc.loadPage(0).getObject().put('Rotate', 90);
    pdoc.deletePage(n - 1);
    a = t(); const out = Buffer.from(pdoc.saveToBuffer('incremental=no').asUint8Array()); row.mupdf_save_ms = Math.round(t() - a);
    fs.writeFileSync(`out/${name}.mupdf.saved.pdf`, out); row.mupdf_saved_bytes = out.length;
  } catch (e) { row.mupdf_err = String(e).slice(0, 160); }
  // pdf-lib (edit/save only)
  try {
    let a = t(); const d = await PDFDocument.load(bytes); const n = d.getPageCount();
    d.getPage(0).setRotation(degrees(90)); d.removePage(n - 1);
    const out = Buffer.from(await d.save()); row.pdflib_save_ms = Math.round(t() - a);
    fs.writeFileSync(`out/${name}.pdflib.saved.pdf`, out); row.pdflib_saved_bytes = out.length;
  } catch (e) { row.pdflib_err = String(e).slice(0, 120); }
  results.push(row);
}
fs.writeFileSync('out/results.json', JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
