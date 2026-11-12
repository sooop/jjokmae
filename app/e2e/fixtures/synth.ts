// 시험용 PDF 생성(mupdf). 각 쪽에 식별 가능한 글자(예: 'PAGE-3')와 크기·회전을 준다.
import zlib from 'node:zlib';
import * as mupdf from 'mupdf';

export interface PageSpec { w: number; h: number; text: string; rotate?: number }
export interface PageInfo { text: string; w: number; h: number; rotate: number }


export function makePdf(specs: PageSpec[]): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  for (const s of specs) {
    const contents = `BT /F1 36 Tf 20 ${Math.floor(s.h / 2)} Td (${s.text}) Tj ET`;
    const page = doc.addPage([0, 0, s.w, s.h], (s.rotate ?? 0) as 0 | 90 | 180 | 270, { Font: { F1: font } }, contents);
    doc.insertPage(-1, page);
  }
  return doc.saveToBuffer('').asUint8Array().slice();
}

/** 5쪽 표본: 크기가 모두 다르고 3쪽은 원래 /Rotate 90 */
export const FIVE: PageSpec[] = [
  { w: 300, h: 400, text: 'PAGE-1' },
  { w: 310, h: 410, text: 'PAGE-2' },
  { w: 320, h: 420, text: 'PAGE-3', rotate: 90 },
  { w: 330, h: 430, text: 'PAGE-4' },
  { w: 340, h: 440, text: 'PAGE-5' },
];

/** mupdf 로 PDF 를 읽어 쪽별 { text, w, h, rotate } 를 돌려준다(검증용) */
export function inspect(bytes: Uint8Array): PageInfo[] {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf');
  const out: PageInfo[] = [];
  for (let i = 0; i < d.countPages(); i++) {
    const p = d.loadPage(i) as mupdf.PDFPage;
    const [x0, y0, x1, y1] = p.getBounds();
    const rot = p.getObject().getInheritable('Rotate');
    const text = p.toStructuredText('preserve-whitespace').asText().trim();
    out.push({ text, w: Math.round(x1 - x0), h: Math.round(y1 - y0), rotate: rot && rot.isNumber() ? rot.asNumber() : 0 });
  }
  return out;
}

// ---- 비대칭 시험 이미지(PNG) ----
/** 비대칭 시험 이미지(PNG): 왼쪽 빨강 / 오른쪽 파랑, 위쪽 가운데에 노랑 표식. w×h */
export function makePng(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      let c = x < w / 2 ? [220, 20, 20] : [20, 20, 220];
      if (y < h * 0.2 && x > w * 0.4 && x < w * 0.6) c = [240, 220, 0];
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  }
  const t: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  const crc = (buf: Buffer) => { let r = 0xffffffff; for (const x of buf) r = t[(r ^ x) & 0xff] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}


// ---- 양식 종류별 시험 PDF ----
export function buildFormPdf(): Uint8Array {
  const objs: string[] = [];
  const add = (n: number, body: string) => { objs[n] = body; };
  const stream = (dict: string, data: string) => `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;
  add(1, '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R 7 0 R 10 0 R 11 0 R 14 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 4 0 R >> >> /NeedAppearances true >> >>');
  add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /Helv 4 0 R >> >> /Annots [5 0 R 6 0 R 8 0 R 9 0 R 10 0 R 11 0 R 14 0 R] >>');
  add(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  add(5, '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [100 700 300 720] /DA (/Helv 12 Tf 0 g) /F 4 /P 3 0 R /MK << /BC [0] >> >>');
  add(6, '<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /Rect [100 650 120 670] /V /Off /AS /Off /F 4 /P 3 0 R /MK << /BC [0] /CA (4) >> /DA (/ZaDb 0 Tf 0 g) /AP << /N << /Yes 12 0 R /Off 13 0 R >> >> >>');
  add(7, '<< /FT /Btn /Ff 32768 /T (color) /Kids [8 0 R 9 0 R] /V /Off >>');
  add(8, '<< /Type /Annot /Subtype /Widget /Parent 7 0 R /Rect [100 600 120 620] /AS /Off /F 4 /P 3 0 R /MK << /BC [0] /CA (l) >> /DA (/ZaDb 0 Tf 0 g) /AP << /N << /red 12 0 R /Off 13 0 R >> >> >>');
  add(9, '<< /Type /Annot /Subtype /Widget /Parent 7 0 R /Rect [140 600 160 620] /AS /Off /F 4 /P 3 0 R /MK << /BC [0] /CA (l) >> /DA (/ZaDb 0 Tf 0 g) /AP << /N << /blue 12 0 R /Off 13 0 R >> >> >>');
  add(10, '<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (city) /Opt [(Seoul) (Busan) (Daegu)] /V (Seoul) /Rect [100 560 250 580] /DA (/Helv 12 Tf 0 g) /F 4 /P 3 0 R /MK << /BC [0] >> >>');
  add(11, '<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 2097152 /T (langs) /Opt [(ko) (en) (ja)] /Rect [100 480 200 540] /DA (/Helv 12 Tf 0 g) /F 4 /P 3 0 R /MK << /BC [0] >> >>');
  add(12, stream('/Type /XObject /Subtype /Form /BBox [0 0 20 20]', '0 0 20 20 re 0 0 1 rg f'));
  add(13, stream('/Type /XObject /Subtype /Form /BBox [0 0 20 20]', ''));
  add(14, '<< /Type /Annot /Subtype /Widget /FT /Tx /T (readonly) /Ff 1 /V (fixed) /Rect [100 400 300 420] /DA (/Helv 12 Tf 0 g) /F 4 /P 3 0 R /MK << /BC [0] >> >>');
  let out = '%PDF-1.7\n'; const offs: number[] = [];
  for (let i = 1; i < objs.length; i++) { offs[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const x = out.length; out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** 쪽 /Rotate 를 바꾼 사본(1쪽만 바꾼다). 회전된 쪽의 주석 좌표 시험용 */
export function withRotate(src: Uint8Array, rot: number): Uint8Array {
  const doc = mupdf.Document.openDocument(src, 'application/pdf').asPDF()!;
  (doc.loadPage(0) as mupdf.PDFPage).getObject().put('Rotate', rot);
  return doc.saveToBuffer('').asUint8Array().slice();
}

/** 샘플 PDF 를 이어 붙여 n쪽 문서를 만든다(스크롤 가상화·동시 캔버스 수 시험용) */
export function makeBig(sources: Uint8Array[], n: number): Uint8Array {
  const srcs = sources.map((b) => mupdf.Document.openDocument(b, 'application/pdf').asPDF()!);
  const dest = new mupdf.PDFDocument();
  let count = 0;
  while (count < n) {
    const s = srcs[count % srcs.length];
    const pc = s.countPages();
    for (let p = 0; p < pc && count < n; p++) {
      dest.graftPage(-1, s, p);
      count++;
    }
  }
  return dest.saveToBuffer('garbage=compact').asUint8Array().slice();
}

/** docA/docB/docC 같은 "<태그>-<번호>" 식별 문서 */
export function makeTagged(tag: string, pages: number, base: number): Uint8Array {
  return makePdf(Array.from({ length: pages }, (_, i) => ({ w: 300 + base + i * 7, h: 400 + i * 5, text: `${tag}-${i + 1}` })));
}
