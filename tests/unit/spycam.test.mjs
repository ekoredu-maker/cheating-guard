import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSsidList, matchSsids, matchBleIot, evaluateSpycam, rssiLevel, beepInterval, compilePatterns } from '../../js/spycam-detector.js';

const db = JSON.parse(readFileSync(new URL('../../data/spycam-db.json', import.meta.url)));

test('모든 SSID 규칙이 정규식으로 컴파일되고 출처가 있음', () => {
  const p = compilePatterns(db);
  assert.equal(p.length, db.wifiSsidPatterns.length);
  const ids = new Set(db.sources.map((s) => s.id));
  for (const r of db.wifiSsidPatterns) for (const s of r.sources) assert.ok(ids.has(s), r.id + ' 출처 ' + s);
});

test('SSID 목록 파싱 (줄·쉼표, 중복 제거)', () => {
  assert.deepEqual(parseSsidList('a\nb, a ;c\n\n'), ['a', 'b', 'c']);
});

test('카메라 핫스팟 이름 일치와 가장 구체적인 규칙 선택', () => {
  const m = matchSsids(db, ['MV28604495', 'IPC_AP_99', 'IPC_1234', 'BCCQ1a2b', 'Care-AB12', 'robot_1', 'iptime', 'MVGUEST', 'MV12', 'KT_GiGA_5G']);
  const by = Object.fromEntries(m.map((x) => [x.ssid, x.id]));
  assert.equal(by['MV28604495'], 'v380-mv');
  assert.equal(by['IPC_AP_99'], 'zosi-ipc-ap');
  assert.equal(by['IPC_1234'], 'icsee-ipc');
  assert.equal(by['BCCQ1a2b'], 'jxlcam-bccq');
  assert.equal(by['Care-AB12'], 'lookcam-care');
  assert.equal(by['robot_1'], 'icsee-robot');
  for (const x of ['iptime', 'MVGUEST', 'MV12', 'KT_GiGA_5G']) assert.ok(!(x in by), x);
});

test('BLE IoT 분류는 낮은 가중치', () => {
  const m = matchBleIot(db, { name: 'X', companyIds: [0x05d6], uuids: ['a201'] });
  assert.equal(m.length, 2);
  assert.ok(m.every((x) => x.weight <= 10));
});

test('점검 판단: 미실행 / 근거 없음 / 의심', () => {
  assert.equal(evaluateSpycam({}).levelKey, 'unavailable');
  const none = evaluateSpycam({ wifi: { ran: true, count: 3, matches: [] } });
  assert.equal(none.levelKey, 'none');
  assert.ok(none.notes.some((n) => n.includes('없다는 뜻은 아닙니다')));
  const sus = evaluateSpycam({ wifi: { ran: true, count: 1, matches: [{ ssid: 'MV1', app: 'V380', verified: true }] } });
  assert.equal(sus.levelKey, 'suspect');
  const lensNoTorch = evaluateSpycam({ lens: { ran: true, frames: 10, torch: false, reproducible: [{}] } });
  assert.equal(lensNoTorch.levelKey, 'review');
  const magOnly = evaluateSpycam({ mag: { ran: true, maxDelta: 50 } });
  assert.equal(magOnly.levelKey, 'none', '자기장만으로 의심 판정 금지');
  assert.match(sus.notes[0], /확률이 아닙니다/);
});

test('신호 막대·탐지음 간격', () => {
  assert.equal(rssiLevel(-100), 0); assert.equal(rssiLevel(-40), 1); assert.equal(rssiLevel(null), 0);
  assert.ok(beepInterval(1) < beepInterval(0));
});
