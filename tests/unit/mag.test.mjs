import test from 'node:test';
import assert from 'node:assert/strict';
import { headingRate, signedDiff, MagAnomaly } from '../../js/mag-anomaly.js';

test('평평하게 놓은 휴대폰: z축 회전 = 방위 변화(반대 부호)', () => {
  assert.ok(Math.abs(headingRate({ alpha: 30, beta: 0, gamma: 0 }, 0, 0) + 30) < 1e-9);
});
test('세워 든 휴대폰(beta 90°): y축 회전이 방위 변화', () => {
  assert.ok(Math.abs(Math.abs(headingRate({ alpha: 0, beta: 0, gamma: 20 }, 90, 0)) - 20) < 1e-6);
});
test('부호 있는 각도 차', () => {
  assert.equal(signedDiff(10, 350), 20); assert.equal(signedDiff(350, 10), -20);
});

test('회전 없이 나침반만 바뀌면 이상 각도로 검출, 실제 회전은 이상 아님', () => {
  globalThis.performance = globalThis.performance || { now: () => Date.now() };
  const m = new MagAnomaly(null);
  let t = 1000; const realNow = performance.now; performance.now = () => t;
  const feed = (h, rr) => { m.rr = rr; m.rrAt = Date.now(); m._onOri({ absolute: true, alpha: (360 - h) % 360, beta: 0, gamma: 0 }); t += 50; };
  for (let i = 0; i < 20; i++) feed(100, { alpha: 0, beta: 0, gamma: 0 });
  assert.ok(m.dev < 2);
  // 실제로 30° 회전 (자이로도 회전을 알림): 이상 아님
  for (let i = 0; i < 20; i++) feed(100 + 1.5 * (i + 1), { alpha: -30, beta: 0, gamma: 0 });
  assert.ok(m.dev < 5, '회전을 이상으로 오인 ' + m.dev);
  // 회전 없이 자석 접근: 나침반만 25° 틀어짐
  for (let i = 0; i < 10; i++) feed(130 + 2.5 * (i + 1), { alpha: 0, beta: 0, gamma: 0 });
  assert.ok(m.dev >= 20, '자기 이상 미검출 ' + m.dev);
  assert.ok(m.events.length >= 1 && m.peak >= 20);
  performance.now = realNow;
});
