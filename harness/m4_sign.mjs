// 항목4: 서명 PDF 증분 저장 (PDFium FPDF_INCREMENTAL / MuPDF incremental=yes)
import fs from 'fs';
import { newPdfium, mkHelpers, mupdf, qpdfCheck, pyVerify } from './lib2.mjs';
const base = fs.readFileSync('out2/fixtures/signed.pdf'); const PH = 841.89;
const pdfium = await newPdfium(); const H = mkHelpers(pdfium);
const out = { baseline: pyVerify('out2/fixtures/signed.pdf')[0], cases: {} };
const prefixOK = b => b.length >= base.length && Buffer.compare(b.subarray(0, base.length), base) === 0;
const setF = (ptr, arr) => arr.forEach((v, i) => H.P.setValue(ptr + i * 4, v, 'float'));
function pdfiumCase(edit, flags) {
  const noenv = edit.endsWith('_noenv'); edit = edit.replace('_noenv', ''); const { doc } = H.load(base); const env = noenv ? 0 : pdfium.PDFiumExt_InitFormFillEnvironment(doc, pdfium.PDFiumExt_OpenFormFillInfo());
  const page = pdfium.FPDF_LoadPage(doc, 0); if (env) pdfium.FORM_OnAfterLoadPage(page, env); const meta = { formEnv: !noenv };
  meta.sigCount = pdfium.FPDF_GetSignatureCount(doc);
  if (edit === 'annot') { const a = pdfium.FPDFPage_CreateAnnot(page, 1); const r = H.malloc(16); setF(r, [300, PH - 100, 320, PH - 120]); pdfium.FPDFAnnot_SetRect(a, r); pdfium.FPDFAnnot_SetColor(a, 0, 255, 200, 0, 255); pdfium.FPDFAnnot_SetStringValue(a, 'Contents', H.wstr('after-sign note')); pdfium.EPDFAnnot_GenerateAppearance(a); pdfium.FPDFPage_CloseAnnot(a); }
  if (edit === 'fill') {
    const n = pdfium.FPDFPage_GetAnnotCount(page);
    for (let i = 0; i < n; i++) { const a = pdfium.FPDFPage_GetAnnot(page, i); if (pdfium.FPDFAnnot_GetSubtype(a) !== 20) continue; const b = H.malloc(512); const l = pdfium.FPDFAnnot_GetFormFieldName(env, a, b, 512);
      if (H.readWide(b, l) === 'name') { pdfium.FORM_SetFocusedAnnot(env, a); pdfium.FORM_SelectAllText(env, page); pdfium.FORM_ReplaceSelection(env, page, H.wstr('Filled After Sign')); pdfium.FORM_ForceToKillFocus(env); } }
  }
  if (env) pdfium.FORM_OnBeforeClosePage(page, env);
  const bytes = H.save(doc, flags); return { bytes, meta };
}
function mupdfCase(edit, opts) {
  const doc = mupdf.Document.openDocument(base, 'application/pdf'); const pdoc = doc.asPDF(); const page = pdoc.loadPage(0); const meta = { canIncr: pdoc.canBeSavedIncrementally(), versions: pdoc.countVersions() };
  if (edit === 'annot') { const a = page.createAnnotation('Text'); a.setRect([300, 100, 320, 120]); a.setColor([1, 0.8, 0]); a.setContents('after-sign note'); a.update(); }
  if (edit === 'fill') { for (const w of page.getWidgets()) if (w.getName() === 'name') w.setTextValue('Filled After Sign'); }
  meta.unsaved = pdoc.hasUnsavedChanges();
  const bytes = Buffer.from(pdoc.saveToBuffer(opts).asUint8Array()); return { bytes, meta };
}
const plan = [
  ['pdfium', 'annot', 'incr', () => pdfiumCase('annot', 1)], ['pdfium', 'fill', 'incr', () => pdfiumCase('fill', 1)], ['pdfium', 'none', 'incr', () => pdfiumCase('none', 1)],
  ['pdfium', 'none_noenv', 'incr', () => pdfiumCase('none_noenv', 1)], ['pdfium', 'annot_noenv', 'incr', () => pdfiumCase('annot_noenv', 1)],
  ['pdfium', 'annot', 'full', () => pdfiumCase('annot', 0)], ['pdfium', 'none', 'full', () => pdfiumCase('none', 0)],
  ['mupdf', 'annot', 'incr', () => mupdfCase('annot', 'incremental=yes')], ['mupdf', 'fill', 'incr', () => mupdfCase('fill', 'incremental=yes')], ['mupdf', 'none', 'incr', () => mupdfCase('none', 'incremental=yes')],
  ['mupdf', 'annot', 'full', () => mupdfCase('annot', '')], ['mupdf', 'none', 'full', () => mupdfCase('none', '')],
];
const files = [];
for (const [eng, edit, mode, fn] of plan) {
  const k = `${eng}.${edit}.${mode}`; const C = out.cases[k] = {};
  try {
    const { bytes, meta } = fn(); const f = `out2/m4_sign.${k}.pdf`; fs.writeFileSync(f, bytes); files.push([k, f]);
    Object.assign(C, meta); C.bytes = bytes.length; C.origBytes = base.length; C.prefixPreserved = prefixOK(bytes); C.qpdf = qpdfCheck(f);
  } catch (e) { C.error = String(e).slice(0, 200); }
}
const ver = pyVerify(...files.map(f => f[1]));
files.forEach(([k], i) => { out.cases[k].verify = ver[i]; });
// 재로드해 PDFium 이 서명 수를 읽는지
for (const [k, f] of files) { try { const { doc } = H.load(fs.readFileSync(f)); const n = pdfium.FPDF_GetSignatureCount(doc); out.cases[k].pdfiumSigCount = n;
  if (n > 0) { const s = pdfium.FPDF_GetSignatureObject(doc, 0); const br = H.malloc(64); const c = pdfium.FPDFSignatureObj_GetByteRange(s, br, 4); out.cases[k].pdfiumByteRange = Array.from({ length: c }, (_, i) => H.P.getValue(br + i * 4, 'i32')); } } catch (e) { out.cases[k].pdfiumSigErr = String(e).slice(0, 80); } }
fs.writeFileSync('out2/m4_sign.json', JSON.stringify(out, null, 1));
for (const [k, c] of Object.entries(out.cases)) console.log(k, 'prefix=', c.prefixPreserved, 'bytes=', c.bytes, 'qpdf=', c.qpdf?.exit, 'sig=', JSON.stringify(c.verify?.sigs?.[0] ? { intact: c.verify.sigs[0].intact, valid: c.verify.sigs[0].valid, mod: c.verify.sigs[0].modification_level, cov: c.verify.sigs[0].coverage, br: c.verify.sigs[0].byte_range } : c.verify), c.error || '', 'pdfiumSig=', c.pdfiumSigCount, c.pdfiumByteRange);
console.log('baseline', JSON.stringify(out.baseline.sigs?.[0]));
