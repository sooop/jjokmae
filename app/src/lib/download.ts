// Blob + a[download] 로 내려받기. file:// 에서도 동작한다.

/** 이름 본체(접미사 '-편집.pdf' 등을 붙이기 전)의 최대 UTF-8 바이트 수. 파일 시스템 한도(255바이트)에서 접미사 몫을 남긴다 */
export const MAX_NAME_BYTES = 200;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** UTF-8 으로 max 바이트를 넘지 않게 코드 포인트 단위로 자른다 */
function clipBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = enc.encode(ch).length;
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

/**
 * 파일 이름에 쓸 수 없는 것을 바꾼다: 금지 문자 → '_', 끝의 점·공백 제거(Windows 가 떼어 버려 다른 이름이 된다),
 * Windows 예약어(CON, NUL, COM1 … 확장자가 붙어도 예약어) 앞에 '_', 길이 제한(UTF-8 200바이트).
 */
export const safeName = (s: string): string => {
  let t = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  t = clipBytes(t, MAX_NAME_BYTES).replace(/[. ]+$/, '').trim();
  if (!t || /^\.+$/.test(t)) return 'document';
  if (RESERVED.test(t)) t = `_${t}`;
  return t;
};

/** 'a.pdf' → 'a' */
export const baseName = (name: string) => safeName(name.replace(/\.pdf$/i, ''));

/** 저장 파일 이름: '<원본>-편집.pdf' */
export const editedName = (name: string) => `${baseName(name)}-편집.pdf`;

/**
 * 사용자가 입력한 저장 파일 이름을 정리한다: 금지 문자(\ / : * ? " < > | 와 제어 문자)는 제거, 확장자 .pdf 를 보정한다.
 * 비어 있거나(정리 뒤에도) 이름이 될 수 없으면 fallback 으로 돌아간다.
 */
export function normalizeSaveName(input: string, fallback: string): string {
  const stripped = input.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().replace(/\.pdf$/i, '').trim();
  if (!stripped || /^[. ]+$/.test(stripped)) return fallback;
  return `${safeName(stripped)}.pdf`;
}

/** 이름 변경 입력을 정리한다(normalizeSaveName 과 같은 규칙). 비었거나 이름이 될 수 없으면 null */
export function cleanName(input: string): string | null {
  return normalizeSaveName(input, '') || null;
}

export function downloadBytes(bytes: Uint8Array, filename: string, type = 'application/pdf'): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
