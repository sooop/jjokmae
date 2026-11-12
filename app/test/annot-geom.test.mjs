// 주석 편집 UI 의 순수 계산 시험. 실행: node --test test/annot-geom.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aspectRect, clampPoint, defaultStampRect, defaultTextBox, hasHangul, hitRects, jpegOrientation, keepInPage, memoRect, moveRect,
  normRect, preRotation, quadsRect, rectQuad, resizeRect, shiftQuads, sniffImage, cssPerPt, isEditable, isResizable,
} from '../src/lib/annot-geom.ts';

const PAGE = { width: 600, height: 800 };
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t, `${a} ~ ${b}`);

test('CSS px = pt × zoom × 96/72', () => {
  near(cssPerPt(1), 96 / 72);
  near(cssPerPt(2), 192 / 72);
});

test('normRect: 두 점 어느 방향이든 같은 사각형', () => {
  const r = normRect({ x: 50, y: 80 }, { x: 10, y: 20 });
  assert.deepEqual(r, { x: 10, y: 20, width: 40, height: 60 });
});

test('clampPoint·keepInPage·moveRect: 쪽 밖으로 나가지 않는다', () => {
  assert.deepEqual(clampPoint({ x: -5, y: 900 }, PAGE), { x: 0, y: 800 });
  assert.deepEqual(keepInPage({ x: 590, y: 790, width: 50, height: 30 }, PAGE), { x: 550, y: 770, width: 50, height: 30 });
  const r = moveRect({ x: 100, y: 100, width: 50, height: 40 }, -500, 1000, PAGE);
  assert.deepEqual(r, { x: 0, y: 760, width: 50, height: 40 });
});

test('resizeRect: 반대편 모서리가 고정되고 뒤집히면 최소 크기에서 멈춘다', () => {
  const r0 = { x: 100, y: 100, width: 100, height: 60 };
  assert.deepEqual(resizeRect(r0, 'se', 20, 10, PAGE), { x: 100, y: 100, width: 120, height: 70 });
  assert.deepEqual(resizeRect(r0, 'nw', 20, 10, PAGE), { x: 120, y: 110, width: 80, height: 50 });
  const flip = resizeRect(r0, 'se', -300, -300, PAGE);
  assert.equal(flip.x, 100);
  assert.equal(flip.width, 6);
  assert.equal(flip.height, 6);
  assert.deepEqual(resizeRect(r0, 'e', 30, 99, PAGE), { x: 100, y: 100, width: 130, height: 60 });
  assert.deepEqual(resizeRect(r0, 's', 99, 30, PAGE), { x: 100, y: 100, width: 100, height: 90 });
});

test('resizeRect: 비율 유지(이미지)', () => {
  const r0 = { x: 100, y: 100, width: 100, height: 50 }; // 2:1
  const a = resizeRect(r0, 'se', 40, 5, PAGE, true);
  near(a.width / a.height, 2);
  assert.equal(a.x, 100);
  assert.equal(a.y, 100);
  const b = resizeRect(r0, 'nw', -40, -5, PAGE, true);
  near(b.width / b.height, 2);
  near(b.x + b.width, 200);
  near(b.y + b.height, 150);
  // 쪽 밖으로 키우지 않는다
  const c = resizeRect(r0, 'se', 9999, 9999, PAGE, true);
  assert.ok(c.x + c.width <= PAGE.width + 1e-6 && c.y + c.height <= PAGE.height + 1e-6);
  near(c.width / c.height, 2, 1e-6);
});

test('aspectRect: 비율을 지키고 끈 방향의 사분면에 놓인다', () => {
  const a = aspectRect({ x: 100, y: 100 }, { x: 200, y: 110 }, 2, PAGE);
  near(a.width / a.height, 2);
  assert.equal(a.x, 100);
  const b = aspectRect({ x: 100, y: 100 }, { x: 50, y: 40 }, 2, PAGE);
  near(b.width / b.height, 2);
  near(b.x + b.width, 100);
  near(b.y + b.height, 100);
  const c = aspectRect({ x: 590, y: 790 }, { x: 1000, y: 1000 }, 2, PAGE);
  assert.ok(c.x + c.width <= PAGE.width + 1e-6 && c.y + c.height <= PAGE.height + 1e-6);
});

test('기본 크기: 이미지·텍스트 상자·메모', () => {
  const s = defaultStampRect({ x: 300, y: 400 }, 2, PAGE);
  near(s.width / s.height, 2);
  near(s.x + s.width / 2, 300);
  const t = defaultTextBox({ x: 590, y: 790 }, 12, PAGE);
  assert.ok(t.x + t.width <= PAGE.width && t.y + t.height <= PAGE.height);
  const m = memoRect({ x: 595, y: 100 }, PAGE);
  assert.equal(m.width, 20);
  assert.equal(m.x, 580);
});

test('quad·하이라이트 보조', () => {
  const q = [[10, 20, 50, 20, 10, 30, 50, 30], [10, 32, 40, 32, 10, 42, 40, 42]];
  assert.deepEqual(quadsRect(q), { x: 10, y: 20, width: 40, height: 22 });
  assert.deepEqual(rectQuad({ x: 1, y: 2, width: 3, height: 4 }), [1, 2, 4, 2, 1, 6, 4, 6]);
  assert.deepEqual(shiftQuads([[0, 0, 1, 0, 0, 1, 1, 1]], 5, 7), [[5, 7, 6, 7, 5, 8, 6, 8]]);
  const pieces = hitRects({ type: 'highlight', rect: quadsRect(q), quadPoints: q });
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces[1], { x: 10, y: 32, width: 30, height: 10 });
  assert.equal(hitRects({ type: 'square', rect: { x: 1, y: 1, width: 2, height: 2 } }).length, 1);
});

test('쪽 회전의 역방향으로 이미지를 미리 돌린다', () => {
  assert.equal(preRotation(0), 0);
  assert.equal(preRotation(90), 270);
  assert.equal(preRotation(180), 180);
  assert.equal(preRotation(270), 90);
});

test('종류 판정', () => {
  assert.equal(isEditable('other'), false);
  assert.equal(isEditable('highlight'), true);
  assert.equal(isResizable('text'), false);
  assert.equal(isResizable('stamp'), true);
  assert.equal(hasHangul('abc'), false);
  assert.equal(hasHangul('a가b'), true);
  assert.equal(hasHangul('ㄱ'), true);
});

test('이미지 판별: 확장자가 아니라 앞 바이트', () => {
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
  assert.equal(sniffImage(new TextEncoder().encode('not an image')), null);
});

test('JPEG EXIF Orientation 읽기', () => {
  // SOI + APP1(Exif, little endian, IFD0 1 항목: Orientation=6)
  const exif = [
    0x45, 0x78, 0x69, 0x66, 0, 0, // "Exif\0\0"
    0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, // TIFF 헤더, IFD 오프셋 8
    1, 0, // 항목 수
    0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, // tag 0x0112 SHORT count1 value 6
    0, 0, 0, 0,
  ];
  const len = exif.length + 2;
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...exif, 0xff, 0xda, 0, 2]);
  assert.equal(jpegOrientation(jpg), 6);
  assert.equal(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])), 1);
  assert.equal(jpegOrientation(new Uint8Array([1, 2, 3])), 1);
});
