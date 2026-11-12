// 외부 의존성 없는 최소 ZIP 작성기: 무압축(store) + CRC-32. 파일 이름은 UTF-8(플래그 비트 11).
// 한계: ZIP64 미지원(항목 65535개·4GiB 초과 불가 → 던진다).
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import).

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

let table: Uint32Array | null = null;

export function crc32(data: Uint8Array, seed = 0): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function makeZip(entries: ZipEntry[], when: Date = new Date()): Uint8Array {
  if (entries.length > 0xffff) throw new Error('ZIP 에 넣을 수 있는 파일 수(65535)를 넘었다');
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(when);
  const names = entries.map((e) => enc.encode(e.name));
  let total = 22;
  for (let i = 0; i < entries.length; i++) total += 30 + names[i].length + entries[i].data.length + 46 + names[i].length;
  if (total > 0xfffffffe) throw new Error('ZIP 크기가 4GiB 를 넘는다');

  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  let p = 0;
  const offsets: number[] = [];
  const crcs: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const { data } = entries[i];
    const crc = crc32(data);
    crcs.push(crc);
    offsets.push(p);
    v.setUint32(p, 0x04034b50, true);
    v.setUint16(p + 4, 20, true); // 필요한 버전
    v.setUint16(p + 6, 0x0800, true); // UTF-8 이름
    v.setUint16(p + 8, 0, true); // store
    v.setUint16(p + 10, time, true);
    v.setUint16(p + 12, date, true);
    v.setUint32(p + 14, crc, true);
    v.setUint32(p + 18, data.length, true);
    v.setUint32(p + 22, data.length, true);
    v.setUint16(p + 26, names[i].length, true);
    v.setUint16(p + 28, 0, true);
    out.set(names[i], p + 30);
    p += 30 + names[i].length;
    out.set(data, p);
    p += data.length;
  }
  const cdStart = p;
  for (let i = 0; i < entries.length; i++) {
    v.setUint32(p, 0x02014b50, true);
    v.setUint16(p + 4, 20, true); // 만든 버전
    v.setUint16(p + 6, 20, true);
    v.setUint16(p + 8, 0x0800, true);
    v.setUint16(p + 10, 0, true);
    v.setUint16(p + 12, time, true);
    v.setUint16(p + 14, date, true);
    v.setUint32(p + 16, crcs[i], true);
    v.setUint32(p + 20, entries[i].data.length, true);
    v.setUint32(p + 24, entries[i].data.length, true);
    v.setUint16(p + 28, names[i].length, true);
    // 30 추가 필드 길이, 32 주석 길이, 34 디스크 번호, 36 내부 속성, 38 외부 속성(4) = 0
    v.setUint32(p + 42, offsets[i], true);
    out.set(names[i], p + 46);
    p += 46 + names[i].length;
  }
  v.setUint32(p, 0x06054b50, true);
  v.setUint16(p + 8, entries.length, true);
  v.setUint16(p + 10, entries.length, true);
  v.setUint32(p + 12, p - cdStart, true);
  v.setUint32(p + 16, cdStart, true);
  return out;
}
