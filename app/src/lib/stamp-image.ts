// 서명 이미지 준비: 파일 → 검증 → (쪽 회전·EXIF 방향 반영해) 엔진에 넘길 바이트.
// 엔진은 이미지 스탬프를 쪽 /Rotate 와 함께 돌려 그리므로, 쪽 회전의 역방향으로 미리 돌려 넘긴다(annot-geom.preRotation).
import type { Rotation, StampImage } from '../engine/adapter';
import { jpegOrientation, preRotation, sniffImage, type ImageKind } from './annot-geom';

/** 한 변 상한(px). 넘으면 줄인다 */
export const MAX_SIDE = 2000;
export const MAX_BYTES = 20 * 1024 * 1024;

export interface PreparedImage {
  name: string;
  bytes: Uint8Array;
  mime: ImageKind;
  /** EXIF 방향을 적용한 뒤의 보이는 크기(px) */
  width: number;
  height: number;
  /** 미리보기용 object URL */
  url: string;
}

export class StampFileError extends Error {}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (file.size > MAX_BYTES) throw new StampFileError('이미지가 너무 큽니다(20MB 이하만 쓸 수 있습니다).');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffImage(bytes);
  if (!mime) throw new StampFileError('PNG 또는 JPEG 이미지만 넣을 수 있습니다.');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { imageOrientation: 'from-image' });
  } catch {
    throw new StampFileError('이미지를 읽지 못했습니다. 다른 파일을 선택해 주세요.');
  }
  const out: PreparedImage = {
    name: file.name,
    bytes,
    mime,
    width: bmp.width,
    height: bmp.height,
    url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })),
  };
  bmp.close();
  return out;
}

export function releaseImage(img: PreparedImage | null) {
  if (img) URL.revokeObjectURL(img.url);
}

/**
 * 엔진에 넘길 이미지. pageRotation 의 역방향으로 돌리고, EXIF 방향을 구워 넣으며, 너무 크면 줄인다.
 * 돌릴 것도 줄일 것도 없으면 원본 바이트를 그대로 쓴다.
 */
export async function stampFor(img: PreparedImage, pageRotation: Rotation): Promise<StampImage> {
  const rot = preRotation(pageRotation);
  const exif = img.mime === 'image/jpeg' ? jpegOrientation(img.bytes) : 1;
  const long = Math.max(img.width, img.height);
  const scale = long > MAX_SIDE ? MAX_SIDE / long : 1;
  if (rot === 0 && exif === 1 && scale === 1) return { bytes: img.bytes, mime: img.mime };

  const bmp = await createImageBitmap(new Blob([img.bytes as BlobPart], { type: img.mime }), { imageOrientation: 'from-image' });
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const swap = rot === 90 || rot === 270;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('캔버스를 만들 수 없다');
  // 중심으로 옮겨 시계 방향으로 rot 도 돌린 뒤 그린다
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
  bmp.close();
  const mime = img.mime;
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, mime === 'image/jpeg' ? 0.92 : undefined));
  if (!blob) throw new Error('이미지를 변환하지 못했다');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime };
}
