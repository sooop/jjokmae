// 쪽 안에서 글자 찾기(순수 함수). 두 엔진이 같은 규칙으로 찾도록, 엔진은 글자 목록(글자·상자·줄 번호)만 뽑아 주고
// 맞추기는 여기서 한다.
// - 공백은 여러 개가 이어져도 하나로 본다(찾는 말도 같다).
// - 줄이 바뀌는 곳은 "있을 수도 없을 수도 있는 공백"이다: 두 줄에 걸친 구절은 공백을 넣어 찾아도, 한글처럼 공백 없이
//   줄이 넘어간 낱말을 붙여서 찾아도 맞는다.
// - 결과는 일치마다 줄 단위 quad([x1,y1,x2,y2,x3,y3,x4,y4] = 좌상·우상·좌하·우하, 쪽 공간) 목록이다.
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import).

/** 쪽의 글자 하나. 상자는 쪽 공간(왼쪽 위 원점). 면적이 없는 글자(공백·줄바꿈)는 box 가 null */
export interface TextChar {
  ch: string;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** 줄 번호(같은 줄의 글자는 같은 값) */
  line: number;
}

export interface SearchOptions {
  /** 대소문자를 구분한다(기본: 구분하지 않는다) */
  matchCase?: boolean;
}

interface Token {
  /** 글자(접은 것), ' ' = 공백, '' = 줄바꿈 자리(공백일 수도 아닐 수도) */
  t: string;
  /** chars 안의 번호(공백·줄바꿈 자리는 -1) */
  i: number;
}

const isSpace = (ch: string) => /^[\s ​﻿]*$/.test(ch);

/** 찾는 말을 토큰으로: 앞뒤 공백을 떼고, 이어진 공백은 하나로, 대소문자는 옵션대로 접는다 */
export function needleTokens(needle: string, matchCase: boolean): string[] {
  const out: string[] = [];
  for (const ch of Array.from(needle.normalize('NFC').trim())) {
    if (isSpace(ch)) {
      if (out[out.length - 1] !== ' ') out.push(' ');
    } else out.push(matchCase ? ch : ch.toLowerCase());
  }
  return out;
}

function textTokens(chars: TextChar[], matchCase: boolean): Token[] {
  const out: Token[] = [];
  let line = chars.length ? chars[0].line : 0;
  const last = () => (out.length ? out[out.length - 1].t : null);
  chars.forEach((c, i) => {
    if (c.line !== line) {
      line = c.line;
      // 줄이 바뀌었다: 앞이 이미 공백이면 그대로 두고, 아니면 "있을 수도 없을 수도 있는 공백"을 둔다
      if (out.length && last() !== ' ' && last() !== '') out.push({ t: '', i: -1 });
    }
    if (isSpace(c.ch)) {
      if (!out.length) return;
      if (last() === '') out[out.length - 1].t = ' ';
      else if (last() !== ' ') out.push({ t: ' ', i: -1 });
      return;
    }
    // 한 글자가 여러 코드 포인트로 올 수도 있다(합자 등): 코드 포인트마다 토큰을 만들고 같은 상자를 가리킨다
    for (const cp of Array.from(c.ch.normalize('NFC'))) out.push({ t: matchCase ? cp : cp.toLowerCase(), i });
  });
  return out;
}

/** start 에서 맞으면 일치가 끝난 다음 토큰 번호, 아니면 -1 */
function matchAt(T: Token[], N: string[], start: number): number {
  let i = start;
  let j = 0;
  while (j < N.length) {
    if (i >= T.length) return -1;
    const t = T[i].t;
    if (t === '') {
      // 줄바꿈 자리: 찾는 말이 공백이면 함께 넘기고, 아니면 없는 셈 친다
      if (N[j] === ' ') j++;
      i++;
      continue;
    }
    if (t !== N[j]) return -1;
    i++;
    j++;
  }
  return i;
}

/** 일치한 글자들의 상자를 줄 단위로 묶어 quad 로 만든다 */
function lineQuads(chars: TextChar[], idx: number[]): number[][] {
  const out: number[][] = [];
  let cur: { x0: number; y0: number; x1: number; y1: number; line: number } | null = null;
  const flush = () => {
    if (cur) out.push([cur.x0, cur.y0, cur.x1, cur.y0, cur.x0, cur.y1, cur.x1, cur.y1]);
    cur = null;
  };
  let prev = -1;
  for (const i of idx) {
    if (i === prev) continue;
    prev = i;
    const c = chars[i];
    const b = c.box;
    if (!b) continue;
    if (cur && cur.line === c.line) {
      cur.x0 = Math.min(cur.x0, b.x0);
      cur.y0 = Math.min(cur.y0, b.y0);
      cur.x1 = Math.max(cur.x1, b.x1);
      cur.y1 = Math.max(cur.y1, b.y1);
      continue;
    }
    flush();
    cur = { ...b, line: c.line };
  }
  flush();
  return out;
}

/** 쪽의 글자 목록에서 찾는 말이 나오는 곳을 읽기 순서대로 돌려준다(겹치지 않게). 일치마다 줄 단위 quad 목록 */
export function findInChars(chars: TextChar[], needle: string, opts: SearchOptions = {}, maxHits = 2000): number[][][] {
  const matchCase = !!opts.matchCase;
  const N = needleTokens(needle, matchCase);
  if (!N.length || !chars.length) return [];
  const T = textTokens(chars, matchCase);
  const hits: number[][][] = [];
  let i = 0;
  while (i < T.length && hits.length < maxHits) {
    if (T[i].t !== N[0]) {
      i++;
      continue;
    }
    const end = matchAt(T, N, i);
    if (end < 0) {
      i++;
      continue;
    }
    const idx: number[] = [];
    for (let k = i; k < end; k++) if (T[k].i >= 0) idx.push(T[k].i);
    const quads = lineQuads(chars, idx);
    if (quads.length) hits.push(quads);
    i = end;
  }
  return hits;
}
