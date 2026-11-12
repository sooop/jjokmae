// 양식 시험용 PDF 조립기(여러 시험 파일이 공유한다).
const stream = (dict, data) => `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;

/** objs[1..] 를 xref 가 있는 PDF 로 직렬화(1=Catalog). 암호화 없음 */
export function assemble(objs) {
  let out = '%PDF-1.7\n';
  const offs = [];
  for (let i = 1; i < objs.length; i++) {
    offs[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const x = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/**
 * 라디오 그룹 하나('grp', 켜짐 값 a/b/c 위젯 3개)와 체크박스 하나('chk', 켜짐 값 Yes)가 있는 1쪽 PDF.
 * 위젯 사각형: a=[100 600 120 620], b=[140 600 160 620], c=[180 600 200 620].
 */
export function buildRadioPdf() {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 4 0 R >> >> >> >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /Helv 4 0 R >> >> /Annots [6 0 R 7 0 R 8 0 R 9 0 R] >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objs[5] = '<< /FT /Btn /Ff 32768 /T (grp) /Kids [7 0 R 8 0 R 9 0 R] /V /Off >>';
  objs[6] = '<< /Type /Annot /Subtype /Widget /FT /Btn /T (chk) /Rect [100 650 120 670] /V /Off /AS /Off /F 4 /P 3 0 R /MK << /BC [0] /CA (4) >> /DA (/ZaDb 0 Tf 0 g) /AP << /N << /Yes 10 0 R /Off 11 0 R >> >> >>';
  const w = (rect, on) =>
    `<< /Type /Annot /Subtype /Widget /Parent 5 0 R /Rect [${rect}] /AS /Off /F 4 /P 3 0 R /MK << /BC [0] /CA (l) >> /DA (/ZaDb 0 Tf 0 g) /AP << /N << /${on} 10 0 R /Off 11 0 R >> >> >>`;
  objs[7] = w('100 600 120 620', 'a');
  objs[8] = w('140 600 160 620', 'b');
  objs[9] = w('180 600 200 620', 'c');
  objs[10] = stream('/Type /XObject /Subtype /Form /BBox [0 0 20 20]', '0 0 20 20 re 0 0 1 rg f');
  objs[11] = stream('/Type /XObject /Subtype /Form /BBox [0 0 20 20]', '');
  return assemble(objs);
}
