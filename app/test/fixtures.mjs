// 시험용 PDF 생성(mupdf). 각 쪽에 식별 가능한 글자(예: 'PAGE-3')와 크기·회전을 준다.
import * as mupdf from 'mupdf';

/** specs: [{ w, h, text, rotate? }] → Uint8Array */
export function makePdf(specs) {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  for (const s of specs) {
    const contents = `BT /F1 36 Tf 20 ${Math.floor(s.h / 2)} Td (${s.text}) Tj ET`;
    const page = doc.addPage([0, 0, s.w, s.h], s.rotate ?? 0, { Font: { F1: font } }, contents);
    doc.insertPage(-1, page);
  }
  return doc.saveToBuffer('').asUint8Array().slice();
}

/** 5쪽 표본: 크기가 모두 다르고 3쪽은 원래 /Rotate 90 */
export const FIVE = [
  { w: 300, h: 400, text: 'PAGE-1' },
  { w: 310, h: 410, text: 'PAGE-2' },
  { w: 320, h: 420, text: 'PAGE-3', rotate: 90 },
  { w: 330, h: 430, text: 'PAGE-4' },
  { w: 340, h: 440, text: 'PAGE-5' },
];

/** mupdf 로 PDF 를 읽어 쪽별 { text, w, h, rotate } 를 돌려준다(검증용) */
export function inspect(bytes) {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf');
  const out = [];
  for (let i = 0; i < d.countPages(); i++) {
    const p = d.loadPage(i);
    const [x0, y0, x1, y1] = p.getBounds();
    const rot = p.getObject().getInheritable('Rotate');
    const text = p.toStructuredText('preserve-whitespace').asText().trim();
    out.push({ text, w: Math.round(x1 - x0), h: Math.round(y1 - y0), rotate: rot && rot.isNumber() ? rot.asNumber() : 0 });
  }
  return out;
}
