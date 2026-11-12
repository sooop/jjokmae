// Blob + a[download] 로 내려받기. file:// 에서도 동작한다.

/** 파일 이름에 쓸 수 없는 문자를 바꾼다 */
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'document';

/** 'a.pdf' → 'a' */
export const baseName = (name: string) => safeName(name.replace(/\.pdf$/i, ''));

/** 저장 파일 이름: '<원본>-편집.pdf' */
export const editedName = (name: string) => `${baseName(name)}-편집.pdf`;

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
