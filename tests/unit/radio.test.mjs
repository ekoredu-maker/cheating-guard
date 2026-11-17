import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDevice, priorityScore, filterDevices, DirectionFinder, headingFromEvent, compassName, angleDiff } from '../../js/radio-analyzer.js';
import { buildReview } from '../../js/integrated-review.js';

const base = { key: 'k', name: '', companyIds: [], uuids: [], matches: [], firstSeen: 0, lastSeen: 0, rssiFiltered: null };
const v = (o) => Object.assign({}, base, o);

test('개인 휴대기기 분류 (애플·삼성·Fast Pair)', () => {
  assert.equal(classifyDevice(v({ companyIds: [{ id: '0x004C' }] })).key, 'personal');
  assert.equal(classifyDevice(v({ companyIds: [{ id: '0x0075' }] })).key, 'personal');
  assert.equal(classifyDevice(v({ uuids: ['0000fe2c-0000-1000-8000-00805f9b34fb'] })).key, 'personal');
});

test('스마트 글라스 > IoT > 이름 없는 기기 우선 분류', () => {
  assert.equal(classifyDevice(v({ matches: [{}], companyIds: [{ id: '0x004C' }] })).key, 'glasses');
  assert.equal(classifyDevice(v({ name: 'X' }), [{ label: 'iot' }]).key, 'iot');
  assert.equal(classifyDevice(v({ name: '' })).key, 'unknownNoName');
  assert.equal(classifyDevice(v({ name: 'Speaker' })).key, 'unknown');
});

test('우선순위: 신규·고정·근거리 가점, 개인기기 감점', () => {
  const now = 1_000_000;
  const d = v({ key: 'n', firstSeen: now - 200000, lastSeen: now - 1000, rssiFiltered: -55 });
  const c = classifyDevice(d);
  const p = priorityScore(d, c, { now, baselineKeys: new Set(['old']), baselineAt: now - 300000 });
  assert.ok(p.isNew && p.score >= 50, JSON.stringify(p));
  const per = v({ companyIds: [{ id: '0x004C' }], firstSeen: now, lastSeen: now });
  assert.equal(priorityScore(per, classifyDevice(per), { now }).score, 0);
});

test('목록 필터', () => {
  const items = [
    { category: { key: 'personal' }, priority: { isNew: false }, rssiFiltered: -50 },
    { category: { key: 'unknown' }, priority: { isNew: true }, rssiFiltered: -80 },
    { category: { key: 'iot' }, priority: { isNew: true }, rssiFiltered: -60 },
  ];
  assert.equal(filterDevices(items, { hidePersonal: true }).length, 2);
  assert.equal(filterDevices(items, { hidePersonal: true, nearOnly: true }).length, 1);
  assert.equal(filterDevices(items, { onlyNew: true }).length, 2);
});

test('방향 추정: 몸 가림 모델에서 전파원 방위 복원', () => {
  for (const src of [60, 200, 330]) {
    const f = new DirectionFinder(12);
    let seed = src;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let h = 0; h < 360; h += 4) {
      const shadow = angleDiff(h, src) > 90 ? -12 * Math.min(1, (angleDiff(h, src) - 90) / 60) : 0;
      f.add(h, -58 + shadow + (rnd() - 0.5) * 4);
    }
    const r = f.result();
    assert.ok(r.ready && angleDiff(r.bearing, src) <= 30, `src ${src} → ${r.bearing}`);
    assert.notEqual(r.confidence, 'low');
  }
});

test('방향 추정: 구간 부족·신호 차이 없음이면 불확실', () => {
  const f = new DirectionFinder(12);
  for (let h = 0; h < 90; h += 5) f.add(h, -60);
  assert.equal(f.result().ready, false);
  const g = new DirectionFinder(12);
  for (let h = 0; h < 360; h += 5) g.add(h, -60 + (h % 2));
  assert.equal(g.result().confidence, 'low');
});

test('나침반 변환', () => {
  assert.equal(headingFromEvent({ webkitCompassHeading: 45 }), 45);
  assert.equal(headingFromEvent({ absolute: true, alpha: 90 }), 270);
  assert.equal(headingFromEvent({ absolute: false, alpha: 90 }), null);
  assert.equal(compassName(44), '북동'); assert.equal(compassName(359), '북');
});

const gl = (rank, levelKey = 'review') => ({ rank, levelKey, envIssues: [] });
test('종합 점검: 전파 방향과 빛 후보 방향 일치 시 복수 근거 일치', () => {
  const r = buildReview({
    glasses: gl(1, 'none'), spy: { levelKey: 'review' },
    support: { camera: true, ble: true, bleRssi: true, heading: true },
    spyEv: { lens: { ran: true, reproducible: [{ heading: 70, confirm: { responsive: true } }] }, ir: {}, wifi: {}, ble: {} },
    radio: { ran: true, items: [{ name: 'X', category: { key: 'unknownNoName', label: '이름 없음' }, priority: { score: 30 } }], direction: { ready: true, bearing: 60, compass: '북동', spread: 60, contrast: 9, confidence: 'medium' }, targetName: 'X' },
  });
  assert.equal(r.rank, 6);
  assert.equal(r.matches.length, 1);
  assert.ok(r.factors.find((f) => f.name === '신호 방향').status === 'found');
});

test('종합 점검: 방향이 다르면 일치로 보지 않음, 미실행 요인은 다음 단계 안내', () => {
  const r = buildReview({
    glasses: gl(0, 'unavailable'), spy: { levelKey: 'unavailable' },
    support: { camera: true, ble: true, bleRssi: true, heading: true },
    spyEv: { lens: { ran: true, reproducible: [{ heading: 250, confirm: { responsive: true } }] }, ir: {}, wifi: {}, ble: {} },
    radio: { ran: true, items: [], direction: { ready: true, bearing: 60, compass: '북동', spread: 60, contrast: 9, confidence: 'medium' } },
  });
  assert.equal(r.matches.length, 0);
  assert.ok(r.steps.some((s) => s.includes('Wi-Fi')));
  assert.ok(!JSON.stringify(r).match(/\d+\s*%/));
});

test('종합 점검: 미지원은 미실행과 구분', () => {
  const r = buildReview({ support: { camera: true, ble: false, bleRssi: false, heading: false } });
  assert.equal(r.factors.find((f) => f.name === '블루투스 식별').status, 'unsupported');
  assert.equal(r.factors.find((f) => f.name === '렌즈 반사').status, 'notrun');
  assert.equal(r.overall, '점검 전');
});
