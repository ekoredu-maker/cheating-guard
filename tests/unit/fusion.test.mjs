import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../../js/fusion-engine.js';

const sup = { ble: true, camera: true, torch: true };
const strongBle = { ran: true, devices: [{ name: 'Ray-Ban Meta', matches: [{ type: 'alias', label: 'x', weight: 40, verified: true, camera: 'yes', models: ['m'] }] }] };
const companyBle = { ran: true, devices: [{ name: 'Quest', matches: [{ type: 'company', label: 'c', weight: 25, verified: true, camera: 'mixed', models: [] }] }] };
const rep = { ran: true, mode: 'flash', cycles: 4, reproducible: [{ hits: 3, observed: 4, featureScore: 70 }], pending: [], env: { issues: [] } };

test('아무것도 실행하지 않으면 분석 불가', () => {
  assert.equal(evaluate({ support: sup }).levelKey, 'unavailable');
});

test('측정했지만 근거가 없으면 미탐지 + 부재 아님 안내', () => {
  const r = evaluate({ support: sup, optical: { ran: true, mode: 'spots', reproducible: [], pending: [], env: { issues: [] } } });
  assert.equal(r.levelKey, 'none');
  assert.ok(r.notes.some((n) => n.includes('없다는 뜻이 아닙니다')));
});

test('환경 불량 구분', () => {
  const r = evaluate({ support: sup, optical: { ran: true, reproducible: [], pending: [], env: { issues: ['어두움'] } } });
  assert.equal(r.levelKey, 'poor');
});

test('미지원과 측정 결과 불일치를 구분', () => {
  const r = evaluate({ support: { ble: false, camera: true }, optical: rep });
  assert.equal(r.modules.find((m) => m.name === '블루투스').state, '미지원');
});

test('제조사 ID만 일치 → 스마트 글라스 후보', () => {
  assert.equal(evaluate({ support: sup, ble: companyBle }).levelKey, 'candidate');
});

test('검증된 별칭 + 카메라 모델 → 카메라 탑재형 의심', () => {
  assert.equal(evaluate({ support: sup, ble: strongBle }).levelKey, 'camera');
});

test('같은 대상 확인 없이 무선·광학 합산 안 함', () => {
  const a = evaluate({ support: sup, ble: strongBle, optical: rep, sameTarget: false });
  const b = evaluate({ support: sup, ble: strongBle, optical: rep, sameTarget: true });
  assert.notEqual(a.levelKey, 'combined');
  assert.equal(b.levelKey, 'combined');
  assert.equal(a.score, Math.max(a.scoreParts.ble, a.scoreParts.optical + a.scoreParts.visual));
  assert.ok(b.score > a.score);
});

test('광학 재현 단독은 추가 확인 필요', () => {
  assert.equal(evaluate({ support: sup, optical: rep }).levelKey, 'review');
});

test('점수는 확률이 아님을 명시하고 100을 넘지 않음', () => {
  const r = evaluate({ support: sup, ble: strongBle, optical: rep, sameTarget: true, vision: { ledRan: true, ledCandidates: [{ colorName: '백색' }], visual: { yesCount: 8, yes: [] } } });
  assert.ok(r.score <= 100);
  assert.match(r.scoreNote, /확률이 아닙니다/);
  assert.ok(!JSON.stringify(r).match(/\d+\s*%/), '퍼센트 확률 표시 금지');
});
