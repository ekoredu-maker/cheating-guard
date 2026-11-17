/**
 * CheatingGuard 스마트 글라스 데이터베이스
 * 기본 데이터(data/glasses-db.json, 읽기 전용)와 사용자 추가 데이터(IndexedDB)를 분리 관리한다.
 */
import { storage } from './storage.js';

export const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

export function parseCompanyId(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    const n = s.startsWith('0x') ? parseInt(s.slice(2), 16) : /^[0-9a-f]{4}$/.test(s) ? parseInt(s, 16) : NaN;
    if (Number.isInteger(n) && n >= 0 && n <= 0xffff) return n;
  }
  return null;
}

export function hex16(n) { return '0x' + n.toString(16).toUpperCase().padStart(4, '0'); }

export function normalizeUuid(u) {
  if (typeof u === 'number') return '0000' + u.toString(16).padStart(4, '0') + BASE_UUID_SUFFIX;
  if (typeof u !== 'string') return null;
  const s = u.trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(s)) return '0000' + s + BASE_UUID_SUFFIX;
  if (/^[0-9a-f]{8}$/.test(s)) return s + BASE_UUID_SUFFIX;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return s;
  return null;
}

export const compact = (s) => String(s || '').toLowerCase().replace(/[\s\-_.·]/g, '');

const TRI = ['yes', 'no', 'unknown'];
const GENERIC_TOKENS = new Set(['meta', 'smart', 'glass', 'glasses', 'ai', 'pro', 'air', 'one', 'lite', 'plus', 'max', 'series', '기타']);

/** 단일 모델 항목 검증 */
export function validateEntry(e) {
  const errors = [];
  if (!e || typeof e !== 'object') return ['항목이 객체가 아닙니다'];
  if (!e.id || typeof e.id !== 'string') errors.push('id 누락');
  if (!e.model || typeof e.model !== 'string') errors.push('model(모델명) 누락');
  for (const k of ['camera', 'microphone', 'display', 'recordingLed']) {
    if (e[k] != null && !TRI.includes(e[k])) errors.push(`${k} 값은 yes/no/unknown 중 하나여야 합니다`);
  }
  for (const c of e.companyIds || []) if (parseCompanyId(c) == null) errors.push(`잘못된 제조사 ID: ${c}`);
  for (const u of e.serviceUuids || []) if (!normalizeUuid(typeof u === 'object' ? u.uuid : u)) errors.push(`잘못된 UUID: ${JSON.stringify(u)}`);
  if (e.aliases && !Array.isArray(e.aliases)) errors.push('aliases는 배열이어야 합니다');
  return errors;
}

export function validateDb(json) {
  const errors = [];
  if (!json || typeof json !== 'object') return { ok: false, errors: ['JSON 객체가 아닙니다'] };
  if (!Array.isArray(json.models)) errors.push('models 배열이 없습니다');
  else json.models.forEach((m, i) => { for (const e of validateEntry(m)) errors.push(`models[${i}]: ${e}`); });
  for (const c of json.companyIdentifiers || []) if (parseCompanyId(c.id) == null) errors.push(`companyIdentifiers: 잘못된 ID ${c.id}`);
  for (const s of json.serviceUuids || []) if (!normalizeUuid(s.uuid)) errors.push(`serviceUuids: 잘못된 UUID ${s.uuid}`);
  return { ok: errors.length === 0, errors };
}

/**
 * 광고/선택 기기 정보와 DB 비교 (순수 함수)
 * adv: { name, companyIds:number[], uuids:string[], manufacturerData:{[cid]: hexString} }
 * 반환: 일치 근거 목록. weight는 '탐지 근거 점수'용 가중치이며 확률이 아니다.
 */
export function matchAdvertisement(data, adv) {
  const out = [];
  const name = compact(adv.name);
  const models = data.models || [];
  const byId = (id) => models.find((m) => m.id === id);
  const cameraOf = (ids) => {
    const ms = ids.map(byId).filter(Boolean);
    if (!ms.length) return 'unknown';
    if (ms.some((m) => m.camera === 'yes')) return ms.every((m) => m.camera === 'yes') ? 'yes' : 'mixed';
    return ms.every((m) => m.camera === 'no') ? 'no' : 'unknown';
  };

  if (name) {
    const aliasHits = new Map(), brandHits = new Map();
    for (const m of models) {
      let aliasMatched = false;
      for (const a of m.aliases || []) {
        const text = typeof a === 'string' ? a : a.text;
        const t = compact(text);
        if (t.length >= 4 && name.includes(t)) {
          aliasMatched = true;
          const verified = typeof a === 'object' && !!a.verified;
          const key = t + (verified ? ':v' : ':u');
          const h = aliasHits.get(key) || { text, verified, models: [] };
          h.models.push(m.id); aliasHits.set(key, h);
        }
      }
      const mt = compact(m.model);
      if (mt.length >= 5 && name.includes(mt)) {
        out.push({ type: 'model-name', label: `기기명에 모델명 '${m.model}' 문자열 포함`, weight: 25, verified: false, models: [m.id], camera: cameraOf([m.id]) });
      } else if (!aliasMatched) {
        const bt = compact(m.brand);
        if (bt.length >= 4 && !GENERIC_TOKENS.has(bt) && name.includes(bt)) {
          const h = brandHits.get(bt) || { brand: m.brand, models: [] };
          h.models.push(m.id); brandHits.set(bt, h);
        }
      }
    }
    for (const h of aliasHits.values()) {
      const names = h.models.map((id) => (byId(id) || {}).model).join(', ');
      out.push({ type: 'alias', label: `기기명 '${adv.name}'에 ${h.verified ? '확인된' : '미검증'} 별칭 '${h.text}' 포함 (${names})`, weight: h.verified ? 40 : 15, verified: h.verified, models: h.models, camera: cameraOf(h.models) });
    }
    for (const h of brandHits.values()) {
      out.push({ type: 'brand', label: `기기명에 브랜드명 '${h.brand}' 포함 (같은 브랜드의 다른 기기일 수 있음)`, weight: 10, verified: false, models: h.models, camera: cameraOf(h.models) });
    }
  }

  for (const cid of adv.companyIds || []) {
    const c = (data.companyIdentifiers || []).find((x) => parseCompanyId(x.id) === cid);
    if (!c) continue;
    const ids = models.filter((m) => (m.companyIds || []).some((x) => parseCompanyId(x) === cid)).map((m) => m.id);
    out.push({
      type: 'company', label: `제조사 식별번호 ${hex16(cid)} (${c.name}) 일치`, weight: c.specificity === 'low' ? 8 : 25,
      verified: !!c.verified, models: ids, camera: cameraOf(ids), note: c.note || '같은 제조사의 다른 전자기기(VR 헤드셋 등)일 수 있습니다.',
    });
    for (const m of models) {
      for (const fp of m.adFingerprints || []) {
        if (parseCompanyId(fp.companyId) !== cid) continue;
        const d = (adv.manufacturerData || {})[cid];
        const pre = String(fp.dataPrefix || '').replace(/\s/g, '').toLowerCase();
        if (d && pre && d.replace(/\s/g, '').toLowerCase().startsWith(pre)) {
          out.push({ type: 'fingerprint', label: `${m.model} 광고 패킷 지문 일치${fp.verified ? '' : ' (미검증 지문)'}`, weight: fp.verified ? 35 : 10, verified: !!fp.verified, models: [m.id], camera: cameraOf([m.id]) });
        }
      }
    }
  }

  const advUuids = (adv.uuids || []).map(normalizeUuid).filter(Boolean);
  for (const u of advUuids) {
    const s = (data.serviceUuids || []).find((x) => normalizeUuid(x.uuid) === u);
    if (!s) continue;
    const ids = models.filter((m) => (m.serviceUuids || []).some((x) => normalizeUuid(typeof x === 'object' ? x.uuid : x) === u)).map((m) => m.id);
    out.push({ type: 'uuid', label: `서비스 UUID ${u} (${s.name}) 일치`, weight: s.verified ? 35 : 15, verified: !!s.verified, models: ids, camera: cameraOf(ids), note: s.note });
  }
  return out;
}

export class GlassesDB {
  constructor() {
    this.base = null;
    this.user = [];
    this.loadError = null;
  }

  async load(url = 'data/glasses-db.json') {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const v = validateDb(json);
      if (!v.ok) throw new Error('기본 데이터베이스 형식 오류: ' + v.errors.slice(0, 3).join(', '));
      this.base = json;
      this.loadError = null;
    } catch (e) {
      this.loadError = '기본 데이터베이스를 불러오지 못했습니다. 인터넷 연결 후 다시 실행해 주세요.';
      this.base = { models: [], companyIdentifiers: [], serviceUuids: [], dbVersion: '로드 실패' };
    }
    await this.loadUser();
    return this;
  }

  async loadUser() {
    try {
      const all = await storage.getAll('userDevices');
      this.user = all.filter((e) => validateEntry(e).length === 0);
    } catch (_) { this.user = []; }
  }

  get version() { return this.base ? this.base.dbVersion : '-'; }

  /** 기본 + 사용자 병합 데이터 */
  get data() {
    const b = this.base || { models: [], companyIdentifiers: [], serviceUuids: [] };
    const userCompanies = [], userUuids = [];
    for (const m of this.user) {
      for (const c of m.companyIds || []) {
        const id = parseCompanyId(c);
        if (id != null && !b.companyIdentifiers.some((x) => parseCompanyId(x.id) === id) && !userCompanies.some((x) => x.id === hex16(id))) {
          userCompanies.push({ id: hex16(id), name: `${m.manufacturer || m.brand || '사용자 등록'} (사용자 등록)`, verified: false, note: '사용자가 추가한 식별번호입니다.' });
        }
      }
      for (const u of m.serviceUuids || []) {
        const nu = normalizeUuid(typeof u === 'object' ? u.uuid : u);
        if (nu && !b.serviceUuids.some((x) => normalizeUuid(x.uuid) === nu) && !userUuids.some((x) => x.uuid === nu)) {
          userUuids.push({ uuid: nu, name: `${m.model} (사용자 등록)`, verified: false });
        }
      }
    }
    return {
      models: [...b.models.map((m) => Object.assign({ origin: 'base' }, m)), ...this.user.map((m) => Object.assign({}, m, { origin: 'user' }))],
      companyIdentifiers: [...b.companyIdentifiers, ...userCompanies],
      serviceUuids: [...b.serviceUuids, ...userUuids],
    };
  }

  companyIdNumbers() { return [...new Set(this.data.companyIdentifiers.map((c) => parseCompanyId(c.id)).filter((x) => x != null))]; }
  serviceUuidList() { return [...new Set(this.data.serviceUuids.map((s) => normalizeUuid(s.uuid)).filter(Boolean))]; }
  companyName(cid) { const c = this.data.companyIdentifiers.find((x) => parseCompanyId(x.id) === cid); return c ? c.name : null; }

  match(adv) { return matchAdvertisement(this.data, adv); }

  search(q) {
    const t = compact(q);
    const list = this.data.models;
    if (!t) return list;
    return list.filter((m) => compact([m.manufacturer, m.brand, m.model, ...(m.aliases || []).map((a) => a.text || a)].join(' ')).includes(t));
  }

  async addOrUpdate(entry) {
    const e = Object.assign({}, entry);
    if (!e.id) e.id = 'user-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (!e.id.startsWith('user-')) e.id = 'user-' + e.id;
    e.updated = new Date().toISOString().slice(0, 10);
    const errs = validateEntry(e);
    if (errs.length) throw new Error(errs.join(', '));
    await storage.put('userDevices', e);
    await this.loadUser();
    return e;
  }

  async remove(id) {
    if (!String(id).startsWith('user-')) throw new Error('기본 데이터는 삭제할 수 없습니다. 사용자 추가 항목만 삭제할 수 있습니다.');
    await storage.delete('userDevices', id);
    await this.loadUser();
  }

  exportJSON(includeBase = false) {
    return JSON.stringify({
      app: 'CheatingGuard', kind: includeBase ? 'full' : 'user-devices', schema: 1,
      baseDbVersion: this.version, exported: new Date().toISOString(),
      models: includeBase ? this.data.models : this.user,
    }, null, 2);
  }

  /** 사용자 데이터 가져오기. 잘못된 파일은 거부하고 기존 데이터는 유지한다. */
  async importJSON(text) {
    let json;
    try { json = JSON.parse(text); } catch (_) { throw new Error('올바른 JSON 파일이 아닙니다.'); }
    const models = Array.isArray(json) ? json : json && json.models;
    if (!Array.isArray(models)) throw new Error('models 배열을 찾을 수 없습니다.');
    if (models.length > 2000) throw new Error('항목이 너무 많습니다 (최대 2000개).');
    const bad = [];
    models.forEach((m, i) => { const e = validateEntry(m); if (e.length) bad.push(`${i + 1}번째: ${e[0]}`); });
    if (bad.length) throw new Error('형식 오류 ' + bad.length + '건 — ' + bad.slice(0, 3).join('; '));
    let n = 0;
    for (const m of models) {
      if (m.origin === 'base') continue;
      const e = Object.assign({}, m); delete e.origin;
      if (!String(e.id).startsWith('user-')) e.id = 'user-' + e.id;
      await storage.put('userDevices', e); n++;
    }
    await this.loadUser();
    return n;
  }
}
