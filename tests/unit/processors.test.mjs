import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFlashDiff, analyzeSpots, analyzeLed, analyzeDark } from '../../js/processors.js';
import { makeImage, disk, rect, shift, scale } from './helpers.mjs';

const W = 320, H = 240;
function scene() {
  const d = makeImage(W, H, 70, 5, 3);
  rect(d, W, 60, 100, 200, 6, 30);   // 안경테(어두운 막대)
  rect(d, W, 60, 100, 6, 50, 30);
  return d;
}

test('플래시 차분: 작은 원형 재귀반사점을 후보로 검출', () => {
  const off = scene();
  const on = scale(scene(), 1.15);
  disk(on, W, 70, 104, 3, 255);          // 렌즈 반사(플래시에서만 밝아짐)
  const off2 = scene();
  const r = analyzeFlashDiff({ off, on, off2, w: W, h: H, params: { sensitivity: 'normal' } });
  assert.ok(r.candidates.length >= 1, '후보 없음');
  const c = r.candidates[0];
  assert.ok(Math.abs(c.x - 70) <= 2 && Math.abs(c.y - 104) <= 2, `위치 ${c.x},${c.y}`);
  assert.ok(r.quality.gain > 1.05);
});

test('플래시 차분: 넓은 평면 반사(안경알)는 제외', () => {
  const off = scene(); const on = scene(); const off2 = scene();
  rect(on, W, 150, 60, 70, 50, 250);
  const r = analyzeFlashDiff({ off, on, off2, w: W, h: H });
  assert.equal(r.candidates.filter((c) => c.x > 150 && c.x < 220 && c.y > 60 && c.y < 110).length, 0);
  assert.ok(r.rejectedCount >= 1);
});

test('플래시 차분: 길쭉한 금속테 반사는 제외', () => {
  const off = scene(); const on = scene(); const off2 = scene();
  rect(on, W, 100, 160, 40, 3, 250);
  const r = analyzeFlashDiff({ off, on, off2, w: W, h: H });
  assert.equal(r.candidates.filter((c) => c.y > 155 && c.y < 168).length, 0);
});

test('플래시 차분: 플래시 전부터 포화된 광원은 제외', () => {
  const off = scene(); disk(off, W, 250, 50, 3, 255);
  const on = scene(); disk(on, W, 250, 50, 5, 255);
  const off2 = scene(); disk(off2, W, 250, 50, 3, 255);
  const r = analyzeFlashDiff({ off, on, off2, w: W, h: H });
  assert.equal(r.candidates.filter((c) => Math.hypot(c.x - 250, c.y - 50) < 8).length, 0);
});

test('플래시 차분: 손떨림(평행이동)에도 거짓 후보가 거의 없음', () => {
  const base = scene();
  for (let k = 0; k < 20; k++) disk(base, W, 20 + k * 14, 200, 2, 160);
  const off = base, on = shift(base, W, H, 2, 1), off2 = shift(base, W, H, -1, 1);
  const r = analyzeFlashDiff({ off, on, off2, w: W, h: H });
  assert.ok(r.candidates.length <= 1, '거짓 후보 ' + r.candidates.length);
});

test('일반 영상: 작은 밝은 점 검출', () => {
  const d = scene(); disk(d, W, 200, 120, 3, 250);
  const r = analyzeSpots({ rgba: d, w: W, h: H });
  assert.ok(r.candidates.some((c) => Math.hypot(c.x - 200, c.y - 120) < 3));
});

test('표시등: 적색 발광점 색상 판정', () => {
  const d = scene(); disk(d, W, 100, 60, 3, 0, [255, 30, 30]);
  const r = analyzeLed({ rgba: d, w: W, h: H });
  const s = r.spots.find((p) => Math.hypot(p.x - 100, p.y - 60) < 3);
  assert.ok(s, '발광점 없음'); assert.equal(s.colorName, '적색');
});

test('렌즈 형태: 어두운 원형점 검출', () => {
  const d = makeImage(W, H, 160, 4, 9); disk(d, W, 160, 120, 5, 20);
  const r = analyzeDark({ rgba: d, w: W, h: H });
  assert.ok(r.items.some((p) => Math.hypot(p.x - 160, p.y - 120) < 3));
});

test('빈 장면에서는 후보 없음', () => {
  const r = analyzeSpots({ rgba: makeImage(W, H, 90, 3, 5), w: W, h: H });
  assert.equal(r.candidates.length, 0);
});
