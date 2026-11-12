// 항목5: MuPDF 저장 garbage 옵션으로 삭제 페이지 객체 정리 (scan.pdf, PDFium 비교)
import fs from 'fs';
import { newPdfium, mkHelpers, mupdf, qpdfCheck } from './lib2.mjs';
import { spawnSync } from 'child_process';
const base = fs.readFileSync('samples/scan.pdf');
const pdfium = await newPdfium(); const H = mkHelpers(pdfium);
const npages = f => spawnSync('qpdf', ['--show-npages', f], { encoding: 'utf8' }).stdout.trim();
const nobj = f => { const j = JSON.parse(spawnSync('qpdf', ['--json', '--json-key=qpdf', f], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout); return Object.keys(j.qpdf[1]).filter(k => k.startsWith('obj:')).length; };
const out = { srcBytes: base.length, srcPages: npages('samples/scan.pdf'), srcObjs: nobj('samples/scan.pdf'), rows: [] };
const optList = ['', 'garbage=compact', 'garbage=deduplicate', 'garbage=compact,compress', 'garbage=deduplicate,compress,clean', 'incremental=yes', 'garbage=bogus'];
for (const del of [0, 1]) for (const opt of optList) {
  const row = { deleted: del, opts: opt || '(none)' };
  try {
    const doc = mupdf.Document.openDocument(base, 'application/pdf').asPDF(); for (let i = 0; i < del; i++) doc.deletePage(doc.countPages() - 1);
    const b = Buffer.from(doc.saveToBuffer(opt).asUint8Array()); const f = `out2/m5_scan.mupdf.del${del}.${(opt || 'none').replace(/[=,]/g, '_')}.pdf`; fs.writeFileSync(f, b);
    row.bytes = b.length; row.pages = npages(f); row.objs = nobj(f); row.qpdfExit = qpdfCheck(f).exit;
  } catch (e) { row.error = String(e).slice(0, 120); }
  out.rows.push(row);
}
for (const del of [0, 1]) {
  const { doc } = H.load(base); const n = pdfium.FPDF_GetPageCount(doc); for (let i = 0; i < del; i++) pdfium.FPDFPage_Delete(doc, n - 1 - i);
  const b = H.save(doc, 0); const f = `out2/m5_scan.pdfium.del${del}.pdf`; fs.writeFileSync(f, b);
  out.rows.push({ engine: 'pdfium', deleted: del, opts: 'FPDF_SaveAsCopy(0)', bytes: b.length, pages: npages(f), objs: nobj(f), qpdfExit: qpdfCheck(f).exit });
}
fs.writeFileSync('out2/m5_garbage.json', JSON.stringify(out, null, 1));
console.log(out.srcBytes, out.srcPages, out.srcObjs); for (const r of out.rows) console.log(JSON.stringify(r));
