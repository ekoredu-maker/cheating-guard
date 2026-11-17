import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDb, validateEntry, matchAdvertisement, parseCompanyId, normalizeUuid } from '../../js/database.js';

const data = JSON.parse(readFileSync(new URL('../../data/glasses-db.json', import.meta.url)));

test('기본 데이터베이스 형식 검증', () => {
  const v = validateDb(data);
  assert.ok(v.ok, v.errors.join('\n'));
  const ids = data.models.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, '중복 id');
});

test('모든 모델에 검증 수준과 카메라 여부 기록', () => {
  for (const m of data.models) {
    assert.ok(['yes', 'no', 'unknown'].includes(m.camera), m.id);
    assert.ok(m.bleLevel, m.id);
    assert.ok('specVerification' in m, m.id);
  }
  assert.ok(data.models.some((m) => m.camera === 'no'), '카메라 없는 스마트 글라스 구분');
});

test('parseCompanyId / normalizeUuid', () => {
  assert.equal(parseCompanyId('0x01AB'), 0x01ab);
  assert.equal(parseCompanyId('xyz'), null);
  assert.equal(normalizeUuid('feaa'), '0000feaa-0000-1000-8000-00805f9b34fb');
  assert.equal(normalizeUuid('bad'), null);
});

test('기기명 별칭 일치 (Ray-Ban)', () => {
  const m = matchAdvertisement(data, { name: 'Ray-Ban Meta 1A2B', companyIds: [] });
  const a = m.find((x) => x.type === 'alias' && x.verified);
  assert.ok(a, '별칭 일치 없음');
  assert.equal(a.camera, 'yes');
});

test('제조사 ID만 일치하면 제조사 수준 근거', () => {
  const m = matchAdvertisement(data, { name: 'Quest 3', companyIds: [0x058e] });
  const c = m.find((x) => x.type === 'company');
  assert.ok(c); assert.match(c.note, /VR/);
  assert.ok(!m.some((x) => x.type === 'alias'));
});

test('Jieli 칩 ID는 낮은 가중치', () => {
  const m = matchAdvertisement(data, { name: 'Earbuds', companyIds: [0x05d6] });
  assert.ok(m[0].weight < 10);
});

test('HeyCyan 서비스 UUID 일치', () => {
  const m = matchAdvertisement(data, { name: '', uuids: ['7905FFF0-B5CE-4E99-A40F-4B1E122D00D0'] });
  assert.ok(m.some((x) => x.type === 'uuid' && x.camera === 'yes'));
});

test('관련 없는 기기는 일치 없음', () => {
  assert.equal(matchAdvertisement(data, { name: 'Galaxy Buds2', companyIds: [0x0075] }).length, 0);
});

test('잘못된 사용자 항목 거부', () => {
  assert.ok(validateEntry({ id: 'x' }).length > 0);
  assert.ok(validateEntry({ id: 'x', model: 'A', companyIds: ['zz'] }).length > 0);
  assert.equal(validateEntry({ id: 'x', model: 'A', camera: 'yes' }).length, 0);
});
