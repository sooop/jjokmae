// 항목2: 주석 추가→저장→qpdf→재로드→렌더 (PDFium / MuPDF)
import fs from 'fs';
import { installFont, newPdfium, mkHelpers, mupdf, mupdfPng, qpdfCheck, regionDiff, pdfjsRender, SCALE, toU8 } from './lib2.mjs';
const base = fs.readFileSync('samples/ko_embedded.pdf');
const PH = 841.8897705078125;
const specs = [
  { key: 'Highlight', pdfium: 9, rect: [60, 120, 330, 142], color: [255, 235, 0], contents: 'Highlight note 하이라이트' },
  { key: 'Square', pdfium: 5, rect: [60, 200, 260, 260], color: [255, 0, 0], contents: 'Square note' },
  { key: 'Text', pdfium: 1, rect: [350, 120, 370, 140], color: [255, 200, 0], contents: '메모 note 한글' },
  { key: 'FreeText', pdfium: 3, rect: [60, 300, 330, 340], color: [0, 0, 0], contents: 'FreeText Latin ABC' },
  { key: 'FreeTextKo', pdfium: 3, rect: [60, 370, 330, 410], color: [0, 0, 0], contents: '한글 프리텍스트 가나다' },
];
const out = { specs: specs.map(s => s.key), engines: {} };
const pdfium = await newPdfium(); const H = mkHelpers(pdfium); const P = H.P;
const SFX = process.env.KOFONT ? '.kofont' : ''; if (process.env.KOFONT) installFont(pdfium, H, process.env.KOFONT);
const SUB = { 1: 'Text', 2: 'Link', 3: 'FreeText', 4: 'Line', 5: 'Square', 6: 'Circle', 9: 'Highlight', 10: 'Underline', 13: 'Stamp' };
const setF = (ptr, arr) => arr.forEach((v, i) => P.setValue(ptr + i * 4, v, 'float'));

// ---------- PDFium 쓰기 ----------
function pdfiumWrite() {
  const log = {}; const { doc } = H.load(base); const page = pdfium.FPDF_LoadPage(doc, 0);
  for (const s of specs) {
    const L = {}; log[s.key] = L;
    try {
      let a = pdfium.FPDFPage_CreateAnnot(page, s.pdfium); L.FPDFPage_CreateAnnot = !!a;
      if (!a) { a = pdfium.EPDFPage_CreateAnnot(page, s.pdfium); L.EPDFPage_CreateAnnot = !!a; }
      if (!a) { L.result = '생성 실패'; continue; }
      const [x0, y0, x1, y1] = s.rect; const r = H.malloc(16); setF(r, [x0, PH - y0, x1, PH - y1]); L.setRect = pdfium.FPDFAnnot_SetRect(a, r);
      const [R, G, B] = s.color;
      if (s.key !== 'FreeText' && s.key !== 'FreeTextKo') L.setColor = pdfium.FPDFAnnot_SetColor(a, 0, R, G, B, s.key === 'Highlight' ? 120 : 255);
      if (s.key === 'Highlight') { const q = H.malloc(32); setF(q, [x0, PH - y0, x1, PH - y0, x0, PH - y1, x1, PH - y1]); L.attachPoints = pdfium.FPDFAnnot_AppendAttachmentPoints(a, q); }
      if (s.key === 'Square') { L.setBorder = pdfium.FPDFAnnot_SetBorder(a, 0, 0, 2); }
      L.setContents = pdfium.FPDFAnnot_SetStringValue(a, 'Contents', H.wstr(s.contents));
      if (s.key.startsWith('FreeText')) { L.setDA = pdfium.FPDFAnnot_SetStringValue(a, 'DA', H.wstr('/Helv 12 Tf 0 g')); }
      L.hasAP_before = pdfium.EPDFAnnot_HasAppearanceStream(a, 0);
      L.genAP = pdfium.EPDFAnnot_GenerateAppearance(a);
      L.hasAP_after = pdfium.EPDFAnnot_HasAppearanceStream(a, 0);
      pdfium.FPDFPage_CloseAnnot(a);
    } catch (e) { L.error = String(e).slice(0, 150); }
  }
  pdfium.FPDF_ClosePage(page);
  const bytes = H.save(doc); pdfium.FPDF_CloseDocument(doc);
  return { bytes, log };
}
// ---------- MuPDF 쓰기 ----------
function mupdfWrite() {
  const log = {}; const doc = mupdf.Document.openDocument(base, 'application/pdf'); const pdoc = doc.asPDF(); const page = pdoc.loadPage(0);
  for (const s of specs) {
    const L = {}; log[s.key] = L;
    try {
      const a = page.createAnnotation(s.key === 'FreeTextKo' ? 'FreeText' : s.key); const [x0, y0, x1, y1] = s.rect;
      const col = s.color.map(v => v / 255);
      if (s.key === 'Highlight') { a.setQuadPoints([[x0, y0, x1, y0, x0, y1, x1, y1]]); a.setColor(col); }
      else { a.setRect([x0, y0, x1, y1]); }
      if (s.key === 'Square') { a.setColor(col); a.setBorderWidth(2); }
      if (s.key === 'Text') { a.setColor(col); }
      if (s.key.startsWith('FreeText')) a.setDefaultAppearance('Helv', 12, [0, 0, 0]);
      a.setContents(s.contents);
      L.update = a.update();
      L.hasAP = !a.getObject().get('AP').isNull();
    } catch (e) { L.error = String(e).slice(0, 150); }
  }
  const bytes = Buffer.from(pdoc.saveToBuffer('').asUint8Array());
  return { bytes, log };
}
// ---------- 읽기 ----------
function pdfiumRead(bytes) {
  const { doc } = H.load(bytes); const page = pdfium.FPDF_LoadPage(doc, 0); const n = pdfium.FPDFPage_GetAnnotCount(page); const res = [];
  for (let i = 0; i < n; i++) {
    const a = pdfium.FPDFPage_GetAnnot(page, i); const st = pdfium.FPDFAnnot_GetSubtype(a);
    const buf = H.malloc(2048); const len = pdfium.FPDFAnnot_GetStringValue(a, 'Contents', buf, 2048);
    res.push({ subtype: SUB[st] || st, contents: len > 2 ? H.readWide(buf, len) : '', hasAP: pdfium.EPDFAnnot_HasAppearanceStream(a, 0) }); pdfium.FPDFPage_CloseAnnot(a);
  }
  pdfium.FPDF_ClosePage(page); pdfium.FPDF_CloseDocument(doc); return res;
}
function mupdfRead(bytes) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf'); const page = doc.asPDF().loadPage(0);
  return page.getAnnotations().map(a => ({ subtype: a.getType(), contents: a.getContents(), hasAP: !a.getObject().get('AP').isNull() }));
}
// ---------- 렌더 ----------
const renderers = {
  pdfium: b => { const { doc } = H.load(b); return H.render(doc, 0); },
  mupdf: b => mupdfPng(mupdf.Document.openDocument(b, 'application/pdf'), 0),
  pdfjs: b => pdfjsRender(b),
};
const baseline = {}; for (const [k, f] of Object.entries(renderers)) baseline[k] = await f(base);
for (const [eng, writer] of [['pdfium', pdfiumWrite], ['mupdf', mupdfWrite]]) {
  const E = out.engines[eng] = {};
  const { bytes, log } = writer(); const file = `out2/m2_annot${SFX}.${eng}.pdf`; fs.writeFileSync(file, bytes);
  E.writeLog = log; E.bytes = bytes.length; E.qpdf = qpdfCheck(file);
  try { E.readByPdfium = pdfiumRead(bytes); } catch (e) { E.readByPdfium = String(e).slice(0, 100); }
  try { E.readByMupdf = mupdfRead(bytes); } catch (e) { E.readByMupdf = String(e).slice(0, 100); }
  E.visible = {};
  for (const [rn, rf] of Object.entries(renderers)) {
    let png; try { png = await rf(bytes); } catch (e) { E.visible[rn] = 'render error ' + String(e).slice(0, 80); continue; }
    fs.writeFileSync(`out2/m2_annot${SFX}.${eng}.rendered_by_${rn}.png`, png);
    E.visible[rn] = {}; for (const s of specs) E.visible[rn][s.key] = await regionDiff(baseline[rn], png, s.rect.map(v => v * SCALE));
  }
}
fs.writeFileSync(`out2/m2_annots${SFX}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
