// 항목3: AcroForm 텍스트 필드 값 쓰기→저장→재로드→렌더
import fs from 'fs';
import { installFont, newPdfium, mkHelpers, mupdf, mupdfPng, qpdfCheck, regionDiff, pdfjsRender, SCALE } from './lib2.mjs';
const base = fs.readFileSync('out2/fixtures/form.pdf');
const PH = 841.89;
const VALUES = { name: 'Hello 123', memo: '홍길동 한글 값' };
const rects = { name: [120, PH - 749, 420, PH - 725], memo: [120, PH - 709, 420, PH - 685] }; // top-left pt
const pdfium = await newPdfium(); const H = mkHelpers(pdfium); const P = H.P;
const SFX = process.env.KOFONT ? '.kofont' : ''; if (process.env.KOFONT) installFont(pdfium, H, process.env.KOFONT);
const out = { variants: {} };
const withEnv = (bytes, fn) => {
  const { doc } = H.load(bytes); const info = pdfium.PDFiumExt_OpenFormFillInfo(); const env = pdfium.PDFiumExt_InitFormFillEnvironment(doc, info);
  const page = pdfium.FPDF_LoadPage(doc, 0); pdfium.FORM_OnAfterLoadPage(page, env);
  const r = fn({ doc, env, page }); return r;
};
function widgets({ env, page }) {
  const res = {}; const n = pdfium.FPDFPage_GetAnnotCount(page);
  for (let i = 0; i < n; i++) {
    const a = pdfium.FPDFPage_GetAnnot(page, i); if (pdfium.FPDFAnnot_GetSubtype(a) !== 20) { pdfium.FPDFPage_CloseAnnot(a); continue; }
    const b = H.malloc(1024); const l = pdfium.FPDFAnnot_GetFormFieldName(env, a, b, 1024); const name = H.readWide(b, l);
    res[name] = a;
  } return res;
}
const readVal = (env, a) => { const b = H.malloc(2048); const l = pdfium.FPDFAnnot_GetFormFieldValue(env, a, b, 2048); return H.readWide(b, l); };
function pdfiumVariant(method) {
  const log = {};
  return withEnv(base, ctx => {
    const w = widgets(ctx); log.fields = Object.keys(w);
    for (const [k, v] of Object.entries(VALUES)) {
      const a = w[k]; if (!a) { log[k] = 'field not found'; continue; }
      try {
        if (method === 'EPDF_SetFormFieldValue') { log[k + '_set'] = pdfium.EPDFAnnot_SetFormFieldValue(ctx.env, a, H.wstr(v)); log[k + '_genAP'] = pdfium.EPDFAnnot_GenerateFormFieldAP(a); }
        else if (method === 'FORM_ReplaceSelection') {
          log[k + '_focus'] = pdfium.FORM_SetFocusedAnnot(ctx.env, a); log[k + '_selAll'] = pdfium.FORM_SelectAllText(ctx.env, ctx.page);
          pdfium.FORM_ReplaceSelection(ctx.env, ctx.page, H.wstr(v)); log[k + '_kill'] = pdfium.FORM_ForceToKillFocus(ctx.env);
        } else if (method === 'SetStringValue_V') { log[k + '_set'] = pdfium.FPDFAnnot_SetStringValue(a, 'V', H.wstr(v)); log[k + '_genAP'] = pdfium.EPDFAnnot_GenerateFormFieldAP(a); }
        log[k + '_readBack'] = readVal(ctx.env, a);
      } catch (e) { log[k + '_err'] = String(e).slice(0, 120); }
    }
    pdfium.FORM_OnBeforeClosePage(ctx.page, ctx.env);
    return { bytes: H.save(ctx.doc), log };
  });
}
function pdfiumReadBack(bytes) {
  return withEnv(bytes, ctx => { const w = widgets(ctx); const r = {}; for (const k of Object.keys(w)) r[k] = readVal(ctx.env, w[k]); return r; });
}
function mupdfWrite() {
  const log = {}; const doc = mupdf.Document.openDocument(base, 'application/pdf'); const pdoc = doc.asPDF(); const page = pdoc.loadPage(0);
  const ws = page.getWidgets(); log.fields = ws.map(w => `${w.getName()}:${w.getFieldType()}`);
  for (const w of ws) { const v = VALUES[w.getName()]; if (v !== undefined) { try { log[w.getName() + '_set'] = w.setTextValue(v); log[w.getName() + '_readBack'] = w.getValue(); } catch (e) { log[w.getName() + '_err'] = String(e).slice(0, 120); } } }
  return { bytes: Buffer.from(pdoc.saveToBuffer('').asUint8Array()), log };
}
function mupdfReadBack(bytes) { const d = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF(); const r = {}; for (const w of d.loadPage(0).getWidgets()) r[w.getName()] = w.getValue(); return r; }
const needApp = bytes => { try { const d = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF(); const v = d.getTrailer().get('Root').get('AcroForm').get('NeedAppearances'); return v.isNull() ? null : v.toString(); } catch (e) { return 'err'; } };
const hasAP = bytes => { const d = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF(); return d.loadPage(0).getWidgets().map(w => `${w.getName()}:${!w.getObject().get('AP').isNull()}`); };

const renderers = {
  pdfium: b => { const { doc } = H.load(b); return H.render(doc, 0); },
  pdfium_ffl: b => withEnv(b, ctx => H.render(ctx.doc, 0, { formEnv: ctx.env })),
  mupdf: b => mupdfPng(mupdf.Document.openDocument(b, 'application/pdf'), 0),
  pdfjs: b => pdfjsRender(b),
};
const baseline = {}; for (const [k, f] of Object.entries(renderers)) baseline[k] = await f(base);
const variants = { 'pdfium.EPDF_SetFormFieldValue': () => pdfiumVariant('EPDF_SetFormFieldValue'), 'pdfium.FORM_ReplaceSelection': () => pdfiumVariant('FORM_ReplaceSelection'), 'pdfium.SetStringValue_V': () => pdfiumVariant('SetStringValue_V'), 'mupdf.setTextValue': mupdfWrite };
for (const [vn, fn] of Object.entries(variants)) {
  const V = out.variants[vn] = {};
  try {
    const { bytes, log } = fn(); const file = `out2/m3_form${SFX}.${vn}.pdf`; fs.writeFileSync(file, bytes);
    V.log = log; V.qpdf = qpdfCheck(file); V.needAppearances = needApp(bytes); V.widgetHasAP = hasAP(bytes);
    try { V.reloadPdfium = pdfiumReadBack(bytes); } catch (e) { V.reloadPdfium = String(e).slice(0, 100); }
    try { V.reloadMupdf = mupdfReadBack(bytes); } catch (e) { V.reloadMupdf = String(e).slice(0, 100); }
    V.visible = {};
    for (const [rn, rf] of Object.entries(renderers)) {
      let png; try { png = await rf(bytes); } catch (e) { V.visible[rn] = 'err ' + String(e).slice(0, 80); continue; }
      fs.writeFileSync(`out2/m3_form${SFX}.${vn}.by_${rn}.png`, png); V.visible[rn] = {};
      for (const [k, r] of Object.entries(rects)) V.visible[rn][k] = await regionDiff(baseline[rn], png, r.map(v => v * SCALE));
    }
  } catch (e) { V.error = String(e).slice(0, 200); }
}
fs.writeFileSync(`out2/m3_forms${SFX}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
