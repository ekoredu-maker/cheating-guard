import test from 'node:test';
import assert from 'node:assert/strict';
import { ReproTracker, opticalEnvironment, containRect } from '../../js/optical-detector.js';
import { LedTracker, emissionHint, ModelRegistry } from '../../js/vision-detector.js';

test('재현성: 같은 위치 3회 → 재현', () => {
  const t = new ReproTracker({ window: 5, need: 3 });
  t.update([{ nx: 0.5, ny: 0.5, featureScore: 60 }]);
  t.update([{ nx: 0.505, ny: 0.5, featureScore: 60 }]);
  let s = t.update([{ nx: 0.5, ny: 0.497, featureScore: 60 }]);
  assert.equal(s[0].reproducible, true);
  t.reset();
  t.update([{ nx: 0.2, ny: 0.2 }]); t.update([]); s = t.update([{ nx: 0.8, ny: 0.8 }]);
  assert.ok(s.every((x) => !x.reproducible));
});

test('측정 환경 평가', () => {
  assert.equal(opticalEnvironment({ brightness: 10, saturated: 0, sharpness: 50 }).state, 'poor');
  assert.equal(opticalEnvironment({ brightness: 100, saturated: 0, sharpness: 50 }, 'stable').state, 'good');
});

test('containRect', () => {
  const r = containRect(300, 400, 640, 480);
  assert.equal(r.w, 300); assert.ok(Math.abs(r.h - 225) < 1e-6);
});

test('표시등: 점멸 감지', () => {
  const t = new LedTracker();
  let now = 0, s;
  for (let i = 0; i < 12; i++) { now += 200; s = t.update(i % 2 ? [] : [{ nx: 0.3, ny: 0.3, peak: 250, colorName: '적색', sat: 0.8, area: 4 }], now); }
  assert.ok(s[0].blinking && s[0].candidate);
});

test('표시등: 지속 발광 감지 및 반사 구분 힌트', () => {
  const t = new LedTracker();
  let s;
  for (let i = 0; i <= 12; i++) s = t.update([{ nx: 0.6, ny: 0.4, peak: 250, colorName: '백색', sat: 0.1, area: 3 }], i * 200);
  assert.ok(s[0].steady);
  assert.match(emissionHint(s[0], [{ nx: 0.6, ny: 0.4 }]), /반사/);
  assert.match(emissionHint({ ...s[0], colorName: '적색', sat: 0.8 }, []), /자체 발광 가능성/);
});

test('검증되지 않은 스마트 글라스 AI 모델은 등록 거부', () => {
  const r = new ModelRegistry();
  assert.throws(() => r.register({ id: 'x', kind: 'glasses', validated: false, run: () => {} }));
  assert.equal(r.status().find((s) => s.kind === 'glasses').state, '미탑재');
});
