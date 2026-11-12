// 항목1: PDFium 한글 시스템 폰트 등록
import fs from 'fs';
import { newPdfium, mkHelpers } from './lib2.mjs';
const FONT = process.argv[2] || 'C:/Windows/Fonts/malgun.ttf';
const tag = process.argv[3] || 'malgun';
const pdfium = await newPdfium(); const H = mkHelpers(pdfium); const P = H.P;
const log = [];
const def = pdfium.FPDF_GetDefaultSystemFontInfo();
log.push('FPDF_GetDefaultSystemFontInfo -> ' + def);
const fontBytes = fs.readFileSync(FONT);
const FACE = tag === 'malgun' ? 'Malgun Gothic' : 'Noto Sans KR';
const readC = p => { let s = ''; for (let c; (c = P.HEAPU8[p++]); ) s += String.fromCharCode(c); return s; };
const info = H.malloc(36);
const fn = {};
fn.release = P.addFunction(() => {}, 'vi');
fn.enum = P.addFunction((self, mapper) => { log.push('EnumFonts'); const n = H.cstr(FACE); pdfium.FPDF_AddInstalledFont(mapper, n, 129); }, 'vii');
fn.map = P.addFunction((self, weight, italic, charset, pitch, face, exact) => {
  const f = face ? readC(face) : ''; log.push(`MapFont w=${weight} it=${italic} cs=${charset} face=${f}`);
  return charset === 129 || /gothic|myeong|batang|gulim|dotum|hy/i.test(f) ? 1 : 0; }, 'iiiiiiii');
fn.get = P.addFunction((self, face) => { log.push('GetFont ' + readC(face)); return /malgun|noto/i.test(readC(face)) ? 1 : 0; }, 'iii');
fn.data = P.addFunction((self, h, table, buf, size) => {
  if (table === 0) { if (buf && size >= fontBytes.length) P.HEAPU8.set(fontBytes, buf); return fontBytes.length; }
  const nt = fontBytes.readUInt16BE(4);
  for (let i = 0; i < nt; i++) { const o = 12 + i * 16; const tg = fontBytes.readUInt32BE(o); // PDFium passes table tag as big-endian-packed uint
    const swapped = ((tg & 255) << 24 | (tg >> 8 & 255) << 16 | (tg >> 16 & 255) << 8 | tg >>> 24) >>> 0;
    if (tg === table || swapped === table) { const off = fontBytes.readUInt32BE(o + 8), len = fontBytes.readUInt32BE(o + 12);
      if (buf && size >= len) P.HEAPU8.set(fontBytes.subarray(off, off + len), buf); return len; } }
  return 0; }, 'iiiiii');
fn.name = P.addFunction((self, h, buf, size) => { const b = Buffer.from(FACE + '\0'); if (buf && size >= b.length) P.HEAPU8.set(b, buf); return b.length; }, 'iiiii');
fn.cs = P.addFunction(() => 129, 'iii');
fn.del = P.addFunction(() => {}, 'vii');
P.setValue(info, 1, 'i32');
[fn.release, fn.enum, fn.map, fn.get, fn.data, fn.name, fn.cs, fn.del].forEach((f, i) => P.setValue(info + 4 + i * 4, f, 'i32'));
pdfium.FPDF_SetSystemFontInfo(info);
const bytes = fs.readFileSync('samples/ko_nonembedded.pdf');
const { doc } = H.load(bytes);
fs.writeFileSync(`out2/m1_ko_nonembedded.pdfium.${tag}.png`, H.render(doc, 0));
fs.writeFileSync(`out2/m1_log.${tag}.txt`, [...new Set(log)].join('\n'));
console.log(tag, [...new Set(log)].slice(0, 15).join('\n'));
