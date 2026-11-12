// 설정 저장·복원 시험(모드·저장 옵션 포함). 실행: cd app && node --test test/settings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, loadSettings, saveSettings } from '../src/lib/settings.ts';

const fake = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), m }; };

test('저장한 모드·저장 옵션은 다시 불러와도 유지된다(같은 저장소)', () => {
  globalThis.localStorage = fake();
  saveSettings({ ...defaultSettings, mode: 'organize', incremental: false, garbageCollect: true });
  const s = loadSettings();
  assert.equal(s.mode, 'organize');
  assert.equal(s.incremental, false);
  assert.equal(s.garbageCollect, true);
});

test('저장소가 비면 기본값(보기 모드·증분 켬·정리 끔)', () => {
  globalThis.localStorage = fake();
  const s = loadSettings();
  assert.deepEqual([s.mode, s.incremental, s.garbageCollect, s.flatten], ['view', true, false, false]);
});

test('저장소 접근이 막혀도 던지지 않고 기본값', () => {
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => saveSettings({ ...defaultSettings, mode: 'organize' }));
  assert.equal(loadSettings().mode, 'view');
});

test('잘못된 모드 값만 보기로 보정하고 올바른 값은 되돌리지 않는다', () => {
  globalThis.localStorage = fake();
  globalThis.localStorage.setItem('pdf-edit:settings', JSON.stringify({ mode: 'bogus', incremental: false }));
  const s = loadSettings();
  assert.equal(s.mode, 'view');
  assert.equal(s.incremental, false);
});
