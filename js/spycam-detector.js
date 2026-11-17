/**
 * CheatingGuard 몰래카메라·소형 전자기기 탐지 (v1.1.0)
 * - 렌즈 반사 스윕: 손전등을 켠 채 방을 훑으며 작은 재귀반사점을 찾는다
 * - 적외선(IR) LED 탐색: 전면 카메라로 야간용 IR LED 발광점을 찾는다
 * - Wi-Fi 이름 점검: 사용자가 휴대폰 Wi-Fi 목록에서 본 이름을 입력하면 카메라 핫스팟 이름 규칙과 비교
 *   (브라우저는 Wi-Fi 목록을 직접 읽을 수 없다)
 * - 블루투스 신호 추적: 선택한 기기의 RSSI로 가까워짐/멀어짐을 표시
 * - 자기장 탐색: 지원 기기에서만, 참고용
 */
import { ReproTracker, toNormalized, opticalEnvironment } from './optical-detector.js';
import { LedTracker } from './vision-detector.js';
import { parseCompanyId, normalizeUuid, hex16 } from './database.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SPY_SCORE_NOTE = '점검 근거 점수는 규칙 기반 가중치의 합으로, 실제 확률이 아닙니다.';
export const IR_COLORS = new Set(['자주색', '백색', '청색']);

// ------------------------------------------------------------ Wi-Fi 이름 점검 (순수 함수)
export function parseSsidList(text) {
  return [...new Set(String(text || '').split(/[\r\n,;\t]+/).map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 64))].slice(0, 300);
}

export function compilePatterns(db) {
  return (db.wifiSsidPatterns || []).map((p) => {
    try { return Object.assign({}, p, { re: new RegExp(p.pattern, p.flags || '') }); } catch (_) { return null; }
  }).filter(Boolean).sort((a, b) => b.pattern.length - a.pattern.length);
}

/** SSID 목록을 패턴과 비교. SSID마다 가장 구체적인 패턴 하나만 반환 */
export function matchSsids(db, ssids) {
  const pats = compilePatterns(db);
  const out = [];
  for (const ssid of ssids) {
    const p = pats.find((x) => x.re.test(ssid));
    if (p) out.push({ ssid, id: p.id, app: p.app, deviceType: p.deviceType, verified: !!p.verified, level: p.level, example: p.example, sources: p.sources || [] });
  }
  return out;
}

// ------------------------------------------------------------ BLE IoT 분류 (순수 함수)
export function matchBleIot(db, adv) {
  const out = [];
  for (const cid of adv.companyIds || []) {
    const c = (db.bleCompanyIdentifiers || []).find((x) => parseCompanyId(x.id) === cid);
    if (c) out.push({ type: 'company', label: `제조사 식별번호 ${hex16(cid)} (${c.name}) — ${c.category}`, verified: !!c.verified, weight: 5, note: c.note });
  }
  const advU = (adv.uuids || []).map(normalizeUuid).filter(Boolean);
  for (const s of db.bleServiceUuids || []) {
    const u = normalizeUuid(s.uuid);
    if (u && advU.includes(u)) out.push({ type: 'uuid', label: `서비스 UUID ${s.name} — ${s.category}`, verified: !!s.verified, weight: 8, note: s.note });
  }
  const name = String(adv.name || '').toLowerCase();
  for (const k of db.bleNameKeywords || []) {
    if (k.text && name.includes(String(k.text).toLowerCase())) out.push({ type: 'name', label: `기기명에 '${k.text}' 포함 — ${k.category || ''}`, verified: !!k.verified, weight: k.verified ? 15 : 5, note: k.note });
  }
  return out;
}

/** RSSI → 0~1 막대 비율 (-100 dBm=0, -40 dBm=1) */
export function rssiLevel(rssi) {
  if (rssi == null || !isFinite(rssi)) return 0;
  return Math.max(0, Math.min(1, (rssi + 100) / 60));
}

/** 신호 비율 → 탐지음 간격(ms): 강할수록 빠름 */
export function beepInterval(level) { return Math.round(1500 - 1350 * Math.max(0, Math.min(1, level))); }

// ------------------------------------------------------------ 종합 점검 판단 (순수 함수)
export const SPY_LEVELS = {
  unavailable: { key: 'unavailable', label: '점검 전', tone: 'muted' },
  none: { key: 'none', label: '의심 근거 없음', tone: 'muted' },
  review: { key: 'review', label: '추가 확인 필요', tone: 'warn' },
  suspect: { key: 'suspect', label: '의심 지점 있음', tone: 'alert' },
};

export function evaluateSpycam(input) {
  const I = Object.assign({ lens: {}, ir: {}, wifi: {}, ble: {}, mag: {} }, input || {});
  const evidence = [], notes = [SPY_SCORE_NOTE], modules = [];
  let score = 0, strong = false;

  if (I.lens.ran) {
    const rep = I.lens.reproducible || [];
    modules.push({ name: '렌즈 반사 스윕', state: '측정함', detail: `${I.lens.frames || 0}프레임 · 반복 확인된 반사점 ${rep.length}개${I.lens.torch ? '' : ' (손전등 없이 측정)'}` });
    const conf = rep.filter((t) => t.confirm && t.confirm.responsive);
    const notResp = rep.filter((t) => t.confirm && !t.confirm.responsive);
    const unk = rep.filter((t) => !t.confirm);
    if (conf.length) {
      score += 35; strong = true;
      evidence.push({ source: '렌즈 반사', text: `손전등을 끄면 사라지는 반복 반사점 ${conf.length}개 (렌즈형 반사 특징)`, points: 35, note: '나사·유리 장식도 같은 반응을 보일 수 있습니다. 표시된 위치의 물건을 직접 살펴보세요.' });
    } else if (unk.length) {
      const p = I.lens.torch ? 20 : 15;
      score += p;
      evidence.push({ source: '렌즈 반사', text: `반복 확인된 작은 반사점 ${unk.length}개 (손전등 반응 미확인)`, points: p, note: '휴대폰을 고정하면 손전등 반응 확인이 자동으로 진행됩니다.' });
    }
    if (notResp.length) evidence.push({ source: '렌즈 반사', text: `손전등과 무관하게 밝은 점 ${notResp.length}개 제외 (자체 발광·주변 조명 반사)`, points: 0, note: '오탐 제거' });
  }
  if (I.ir.ran) {
    const c = I.ir.candidates || [];
    modules.push({ name: '적외선 LED 탐색', state: '측정함', detail: `발광점 후보 ${c.length}개 · 이 카메라의 적외선 감지 ${I.ir.irVisible === true ? '확인됨' : I.ir.irVisible === false ? '안 됨' : '미확인'}` });
    if (I.ir.irVisible === false) notes.push('이 카메라는 리모컨 적외선을 감지하지 못했습니다. 적외선 LED 탐색 결과를 신뢰하기 어렵습니다.');
    if (c.length) {
      const p = I.ir.irVisible === true ? 20 : 10;
      score += p;
      evidence.push({ source: '적외선', text: `지속·점멸하는 ${[...new Set(c.map((x) => x.colorName))].join('·')} 발광점 ${c.length}개`, points: p, note: '어두운 곳에서 보이는 보라·흰색 점은 야간 촬영용 적외선 LED일 수 있습니다. 전자기기 표시등일 수도 있습니다.' });
    }
  }
  if (I.wifi.ran) {
    const m = I.wifi.matches || [];
    modules.push({ name: 'Wi-Fi 이름 점검', state: '점검함', detail: `입력 ${I.wifi.count || 0}개 · 카메라 이름 규칙 일치 ${m.length}개` });
    for (const x of m) {
      const p = x.verified ? 40 : 15;
      score += p; strong = strong || x.verified;
      evidence.push({ source: 'Wi-Fi', text: `'${x.ssid}' — ${x.app} 카메라의 직접 연결 Wi-Fi 이름 규칙과 일치`, points: p, note: x.verified ? '정상 설치된 카메라일 수도 있습니다. 관리자에게 확인하세요.' : '확인 수준이 낮은 규칙입니다.' });
    }
  }
  if (I.ble.ran) {
    const d = I.ble.devices || [];
    modules.push({ name: '블루투스', state: '측정함', detail: `소형 IoT 기기 관련 일치 ${d.length}대` });
    for (const x of d) {
      const p = Math.min(10, x.matches.reduce((s, m) => s + m.weight, 0));
      score += p;
      evidence.push({ source: '블루투스', text: `${x.name || '(이름 없음)'}: ${x.matches.map((m) => m.label).join(' / ')}`, points: p, note: '많은 일반 전자기기도 같은 칩·플랫폼을 씁니다.' });
    }
  }
  if (I.mag.ran) {
    modules.push({ name: '자기장 탐색', state: '측정함', detail: I.mag.maxDelta != null ? `기준 대비 최대 변화 ${I.mag.maxDelta.toFixed(1)} µT (참고용)` : '기준값 없음' });
    if (I.mag.maxDelta != null && Math.abs(I.mag.maxDelta) >= 20) evidence.push({ source: '자기장', text: `국소 자기장 변화 ${I.mag.maxDelta.toFixed(1)} µT`, points: 0, note: '스피커·자석·철제 구조물에서도 생깁니다. 점수에 반영하지 않습니다.' });
  }

  score = Math.min(100, score);
  const anyRan = modules.length > 0;
  let level;
  if (!anyRan) level = SPY_LEVELS.unavailable;
  else if (strong && score >= 30) level = SPY_LEVELS.suspect;
  else if (evidence.some((e) => e.points > 0)) level = SPY_LEVELS.review;
  else level = SPY_LEVELS.none;
  if (level === SPY_LEVELS.none) notes.push('의심 근거가 없다는 것이 몰래카메라가 없다는 뜻은 아닙니다. 유선·전원 꺼짐·공유기 연결 상태 카메라는 무선 점검으로 찾기 어렵습니다.');
  if (level.key === 'suspect' || level.key === 'review') notes.push('의심 물건을 함부로 분해하거나 훼손하지 말고, 사진으로 기록한 뒤 관리자 또는 경찰(112)에 알리세요.');
  return { level: level.label, levelKey: level.key, tone: level.tone, score, evidence, notes, modules };
}

// ------------------------------------------------------------ 측정 모듈
export class SpycamDetector {
  constructor({ camera, proc, ble, sensors, heading = null }) {
    this.cam = camera; this.proc = proc; this.ble = ble; this.sensors = sensors; this.heading = heading;
    this.confirm = new Map();      // 렌즈 후보 id → 손전등 반응 확인 결과
    this.headings = new Map();     // 'lens:id' | 'ir:id' → 발견 당시 나침반 방위
    this._lastConfirm = 0;
    this.db = { wifiSsidPatterns: [], bleCompanyIdentifiers: [], bleServiceUuids: [], hidingSpots: [] };
    this.loadError = null;
    this.sensitivity = 'normal';
    this.roi = null;
    // 렌즈 스윕
    this.lensTracker = new ReproTracker({ window: 4, need: 2, radius: 0.03 });
    this.lens = null; this.lensFrames = 0; this.lensRunning = false; this.lensTorch = false; this.lensStarted = 0;
    this.lensMaxMs = 180000;
    // 적외선
    this.irTracker = new LedTracker({ radius: 0.03, expireMs: 4000 });
    this.ir = []; this.irFrames = 0; this.irRunning = false; this.irVisible = null; this.irTest = false;
    // Wi-Fi
    this.wifi = null;
    // 블루투스 추적
    this.trackKey = null;
    // 자기장
    this.magMaxDelta = null; this.magRan = false;
    this._token = 0;
    this.onUpdate = () => {}; this.onStatus = () => {};
  }

  async load(url = 'data/spycam-db.json') {
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!Array.isArray(j.wifiSsidPatterns)) throw new Error('형식 오류');
      this.db = j; this.loadError = null;
    } catch (_) {
      this.loadError = '몰래카메라 점검 데이터를 불러오지 못했습니다.';
    }
    return this;
  }

  /** 블루투스 선택창에 포함할 추가 식별자 */
  extraCompanyIds() { return (this.db.bleCompanyIdentifiers || []).map((c) => parseCompanyId(c.id)).filter((x) => x != null); }
  extraUuids() { return (this.db.bleServiceUuids || []).map((s) => normalizeUuid(s.uuid)).filter(Boolean); }

  // ---- 렌즈 반사 스윕
  async startLensSweep() {
    if (!this.cam.active) throw new Error('카메라가 실행되지 않았습니다.');
    this.stopAll(true);
    const token = ++this._token;
    this.lensRunning = true; this.lensTracker.reset(); this.lensFrames = 0; this.lens = null; this.lensStarted = Date.now();
    this.confirm.clear();
    this.lensTorch = this.cam.hasTorch ? await this.cam.setTorch(true) : false;
    this.onStatus(this.lensTorch ? '손전등을 켠 채 천천히 방을 훑어 주세요. 작은 반짝임이 반복되면 표시합니다.' : '이 기기는 손전등 제어가 안 됩니다. 다른 휴대폰 손전등을 비추면서 천천히 훑어 주세요.');
    (async () => {
      while (this.lensRunning && token === this._token && this.cam.active) {
        const t0 = performance.now();
        if (Date.now() - this.lensStarted > this.lensMaxMs) { await this.stopLensSweep(); this.onStatus('과열 방지를 위해 3분 후 손전등과 스윕을 자동 정지했습니다.'); break; }
        try {
          const f = this.cam.grab({ roi: this.roi, maxSide: 640 });
          if (f) {
            const res = await this.proc.run('spots', { rgba: f.data, w: f.w, h: f.h, params: { sensitivity: this.sensitivity } }, [f.data.buffer]);
            if (token !== this._token) break;
            const items = res.candidates.map((c) => Object.assign({}, c, toNormalized(f.geom, c.x, c.y)));
            const tracks = this.lensTracker.update(items);
            this.lensFrames++;
            this._tagHeadings('lens', tracks.filter((t) => t.reproducible));
            if (this.lensTorch && Date.now() - this._lastConfirm > 2500 && this.sensors.motionState() !== 'moving') {
              const t = tracks.find((x) => x.hits >= 2 && x.seenNow && !this.confirm.has(x.id));
              if (t) { this._lastConfirm = Date.now(); await this._confirmTorch(t, token); }
            }
            this.lens = { tracks, quality: res.quality, env: opticalEnvironment(res.quality, this.sensors.motionState()), rejectedCount: res.rejectedCount };
            this.onUpdate('lens');
          }
        } catch (_) {}
        await sleep(Math.max(60, 260 - (performance.now() - t0)));
      }
    })();
  }

  /** 손전등을 잠깐 끄고 같은 위치의 밝기를 비교: 손전등에 반응하는 반사인지 확인 (자체 발광·주변광 반사 제외) */
  async _confirmTorch(track, token) {
    const on = this.cam.grab({ roi: this.roi, maxSide: 640 });
    if (!on) return;
    await this.cam.setTorch(false);
    await sleep(320);
    const off = token === this._token ? this.cam.grab({ roi: this.roi, maxSide: 640 }) : null;
    if (this.lensRunning && token === this._token) await this.cam.setTorch(true);
    if (!off) return;
    const onP = localPeak(on, track.nx, track.ny), offP = localPeak(off, track.nx, track.ny);
    if (onP == null || offP == null) return;
    const responsive = onP - offP >= 45 && offP <= onP * 0.75;
    this.confirm.set(track.id, { responsive, onPeak: onP, offPeak: offP, at: Date.now() });
  }

  _tagHeadings(kind, items) {
    if (!this.heading || !this.heading.fresh) return;
    for (const t of items) { const k = kind + ':' + t.id; if (!this.headings.has(k)) this.headings.set(k, Math.round(this.heading.heading)); }
  }

  async stopLensSweep() {
    this.lensRunning = false;
    if (this.cam.torchOn) await this.cam.setTorch(false);
  }

  // ---- 적외선 LED
  /** 전면 카메라(적외선 차단 필터가 약한 경우가 많음)로 전환 */
  async useFrontCamera() {
    this.cam.deviceId = null; this.cam.facing = 'user';
    await this.cam.start();
  }

  async startIrScan({ test = false } = {}) {
    if (!this.cam.active) throw new Error('카메라가 실행되지 않았습니다.');
    this.stopAll(true);
    const token = ++this._token;
    this.irRunning = true; this.irTest = test; this.irTracker.reset(); this.irFrames = 0; this.ir = [];
    this.onStatus(test ? '리모컨을 카메라 렌즈에 향하게 하고 버튼을 여러 번 누르세요.' : '방을 어둡게 하고 천천히 훑어 주세요. 보라·흰색 점이 계속 보이면 표시합니다.');
    const testStart = Date.now();
    (async () => {
      while (this.irRunning && token === this._token && this.cam.active) {
        const t0 = performance.now();
        try {
          const f = this.cam.grab({ roi: this.roi, maxSide: 480 });
          if (f) {
            const res = await this.proc.run('led', { rgba: f.data, w: f.w, h: f.h, params: { sensitivity: test ? 'high' : this.sensitivity } }, [f.data.buffer]);
            if (token !== this._token) break;
            const spots = res.spots.map((s) => Object.assign({}, s, toNormalized(f.geom, s.x, s.y)));
            this.ir = this.irTracker.update(spots);
            this.irFrames++;
            if (!test) this._tagHeadings('ir', this.ir.filter((l) => l.candidate));
            if (test) {
              if (this.ir.some((l) => l.blinking || (l.seen >= 3 && l.transitions >= 2))) {
                this.irVisible = true; this.irRunning = false;
                this.onStatus('적외선이 보입니다. 이 카메라로 적외선 LED 탐색을 할 수 있습니다.');
              } else if (Date.now() - testStart > 15000) {
                this.irVisible = false; this.irRunning = false;
                this.onStatus('15초 동안 리모컨 빛을 감지하지 못했습니다. 다른 카메라(전면/후면)로 다시 시험해 보세요.');
              }
            }
            this.onUpdate('ir');
          }
        } catch (_) {}
        await sleep(Math.max(40, 200 - (performance.now() - t0)));
      }
    })();
  }

  stopIrScan() { this.irRunning = false; }

  irCandidates() { return this.irTest ? [] : this.ir.filter((l) => l.candidate && IR_COLORS.has(l.colorName)); }

  // ---- Wi-Fi
  checkWifi(text) {
    const ssids = parseSsidList(text);
    this.wifi = { count: ssids.length, matches: matchSsids(this.db, ssids), at: Date.now() };
    this.onUpdate('wifi');
    return this.wifi;
  }

  // ---- 블루투스
  bleIotDevices() {
    const out = [];
    for (const rec of this.ble.devices.values()) {
      const m = matchBleIot(this.db, { name: rec.name, companyIds: [...rec.companyIds], uuids: [...rec.uuids] });
      if (m.length) out.push({ key: rec.key, name: rec.name, matches: m });
    }
    return out;
  }

  trackedView() {
    if (!this.trackKey) return null;
    const rec = this.ble.devices.get(this.trackKey);
    return rec ? this.ble.view(rec) : null;
  }

  // ---- 자기장
  noteMag() {
    const d = this.sensors.mag.delta;
    if (d != null) { this.magRan = true; if (this.magMaxDelta == null || Math.abs(d) > Math.abs(this.magMaxDelta)) this.magMaxDelta = d; }
  }

  stopAll(keepCamera) {
    this._token++;
    this.lensRunning = false; this.irRunning = false;
    if (this.cam.torchOn) this.cam.setTorch(false);
    if (!keepCamera) this.cam.facing = 'environment';
  }

  evidence() {
    const lensTracks = this.lens ? this.lens.tracks : [];
    return {
      lens: { ran: this.lensFrames > 0, frames: this.lensFrames, torch: this.lensTorch, reproducible: lensTracks.filter((t) => t.reproducible).map((t) => Object.assign({}, t, { confirm: this.confirm.get(t.id) || null, heading: this.headings.get('lens:' + t.id) })) },
      ir: { ran: this.irFrames > 0 && !this.irTest, candidates: this.irCandidates().map((l) => Object.assign({}, l, { heading: this.headings.get('ir:' + l.id) })), irVisible: this.irVisible },
      wifi: { ran: !!this.wifi, count: this.wifi ? this.wifi.count : 0, matches: this.wifi ? this.wifi.matches : [] },
      ble: { ran: this.ble.devices.size > 0, devices: this.bleIotDevices() },
      mag: { ran: this.magRan, maxDelta: this.magMaxDelta },
    };
  }

  evaluate() { return evaluateSpycam(this.evidence()); }
}

/** 프레임에서 정규화 좌표 주변(반경 r px)의 최대 밝기 */
export function localPeak(frame, nx, ny, r = 4) {
  const g = frame.geom;
  const x = Math.round((nx * g.vw - g.sx) / (g.sw / g.w)), y = Math.round((ny * g.vh - g.sy) / (g.sh / g.h));
  if (x < 0 || y < 0 || x >= frame.w || y >= frame.h) return null;
  let m = 0;
  for (let yy = Math.max(0, y - r); yy <= Math.min(frame.h - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(frame.w - 1, x + r); xx++) {
      const j = (yy * frame.w + xx) * 4;
      const v = (frame.data[j] * 77 + frame.data[j + 1] * 150 + frame.data[j + 2] * 29) >> 8;
      if (v > m) m = v;
    }
  }
  return m;
}
