import test from 'node:test';
import assert from 'node:assert/strict';
import { RssiTracker, median, linearSlope, dataViewToHex } from '../../js/bluetooth-detector.js';

test('median / slope', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Math.abs(linearSlope([[0, 0], [1, 2], [2, 4]]) - 2) < 1e-9);
});

test('RSSI 이상치 제거와 EMA', () => {
  const t = new RssiTracker();
  const now = 1_000_000;
  for (let i = 0; i < 10; i++) t.push(-60 + (i % 2), now + i * 500);
  const before = t.ema;
  t.push(-20, now + 6000);            // 급격한 이상치
  assert.equal(t.outliers, 1);
  assert.ok(Math.abs(t.ema - before) < 1);
});

test('RSSI 무효값 무시', () => {
  const t = new RssiTracker();
  assert.equal(t.push(127), false);
  assert.equal(t.push(null), false);
  assert.equal(t.count, 0);
});

test('추세: 신호 증가 판정', () => {
  const t = new RssiTracker();
  const now = Date.now();
  for (let i = 0; i < 20; i++) t.push(-90 + i * 2, now - 9500 + i * 500);
  assert.equal(t.trend(now).state, '증가');
});

test('거리 추정은 기준값이 있을 때만', () => {
  const t = new RssiTracker();
  for (let i = 0; i < 8; i++) t.push(-60);
  assert.equal(t.distanceRange(), null);
  t.setBaseline();
  for (let i = 0; i < 20; i++) t.push(-80);
  const d = t.distanceRange();
  assert.ok(d.min > 1 && d.max > d.min);
});

test('dataViewToHex', () => {
  const dv = new DataView(new Uint8Array([0x4d, 0x45, 0x0a]).buffer);
  assert.equal(dataViewToHex(dv), '4D450A');
});
