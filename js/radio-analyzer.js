/**
 * 칫팅가드 전파(블루투스) 분석 (v1.3.0)
 * - 기기 분류: 개인 휴대기기(휴대폰·이어폰 등) / 스마트 글라스 / 소형 IoT / 이름 없는 미확인 기기
 * - 의심 우선순위 점수: 규칙 기반 정렬용 점수 (확률 아님)
 * - 기준 상태(기준선) 대비 새로 나타난 기기
 * - 몸 가림 효과를 이용한 360° 회전 방향 추정 (제한적)
 * 모든 판단은 실제로 수신한 광고 정보만 사용하며, 기기 식별자는 저장하지 않는다.
 */

// Bluetooth SIG 할당 번호 (공개 목록으로 확인)
export const PERSONAL_COMPANIES = {
  0x004c: { name: 'Apple', label: '애플 기기(아이폰·에어팟·워치 등) 또는 iBeacon' },
  0x0075: { name: 'Samsung', label: '삼성 기기(휴대폰·버즈·워치 등)' },
  0x0006: { name: 'Microsoft', label: '마이크로소프트 기기(PC·주변기기 Swift Pair 등)' },
  0x00e0: { name: 'Google', label: '구글 기기·서비스' },
};
export const PERSONAL_SERVICES = {
  '0000fe2c-0000-1000-8000-00805f9b34fb': '구글 Fast Pair 기기(무선 이어폰·스피커 등)',
  '0000fd6f-0000-1000-8000-00805f9b34fb': '접촉 알림(휴대폰)',
};

export const CATEGORY = {
  glasses: { key: 'glasses', label: '스마트 글라스 관련', tone: 'alert' },
  iot: { key: 'iot', label: '소형 IoT 칩·플랫폼', tone: 'warn' },
  unknownNoName: { key: 'unknownNoName', label: '이름 없는 미확인 기기', tone: 'warn' },
  unknown: { key: 'unknown', label: '미확인 기기', tone: '' },
  personal: { key: 'personal', label: '개인 휴대기기', tone: 'muted' },
};

const lowerUuids = (u) => (u || []).map((x) => String(x).toLowerCase());

/** 기기 분류. view: BluetoothDetector.view() 결과, iot: spycam BLE 일치 목록 */
export function classifyDevice(view, iotMatches = []) {
  const cids = (view.companyIds || []).map((c) => parseInt(String(c.id).replace(/^0x/i, ''), 16));
  const uuids = lowerUuids(view.uuids);
  if ((view.matches || []).length) return { ...CATEGORY.glasses, detail: '스마트 글라스 데이터베이스와 일치' };
  if (iotMatches.length) return { ...CATEGORY.iot, detail: iotMatches[0].label };
  const pc = cids.map((c) => PERSONAL_COMPANIES[c]).find(Boolean);
  if (pc) return { ...CATEGORY.personal, detail: pc.label };
  const ps = uuids.map((u) => PERSONAL_SERVICES[u]).find(Boolean);
  if (ps) return { ...CATEGORY.personal, detail: ps };
  const noName = !view.name || view.name === '(이름 없음)';
  return noName ? { ...CATEGORY.unknownNoName, detail: '이름을 알리지 않는 기기' } : { ...CATEGORY.unknown, detail: '분류 정보 없음' };
}

/**
 * 의심 우선순위 점수 (정렬·강조용, 확률 아님)
 * ctx: { now, baselineAt, baselineKeys:Set, phoneStable:boolean|null }
 */
export function priorityScore(view, category, ctx = {}) {
  const now = ctx.now || Date.now();
  const reasons = [];
  let s = 0;
  if (category.key === 'glasses') { s += 40; reasons.push('스마트 글라스 식별정보 일치 +40'); }
  if (category.key === 'iot') { s += 25; reasons.push('소형 IoT 칩·플랫폼 +25'); }
  if (category.key === 'unknownNoName') { s += 15; reasons.push('이름 없는 미확인 기기 +15'); }
  if (category.key === 'unknown') { s += 5; reasons.push('미확인 기기 +5'); }
  if (category.key === 'personal') { s -= 30; reasons.push('개인 휴대기기 −30'); }
  const isNew = !!(ctx.baselineKeys && ctx.baselineAt && !ctx.baselineKeys.has(view.key) && view.firstSeen >= ctx.baselineAt);
  if (isNew) { s += 15; reasons.push('기준 상태 이후 새로 나타남 +15'); }
  const presence = (view.lastSeen - view.firstSeen) / 1000;
  const active = now - view.lastSeen < 15000;
  if (presence >= 120 && active) { s += 10; reasons.push(`${Math.round(presence / 60)}분 이상 계속 신호를 보냄(고정 기기 가능) +10`); }
  if (view.rssiFiltered != null && view.rssiFiltered >= -65) { s += 10; reasons.push(`가까운 강한 신호(${view.rssiFiltered} dBm) +10`); }
  return { score: Math.max(0, Math.min(100, s)), reasons, isNew, active, presenceSec: Math.round(presence) };
}

/** 목록 필터 */
export function filterDevices(items, opt = {}) {
  return items.filter((d) => {
    if (opt.hidePersonal && d.category.key === 'personal') return false;
    if (opt.onlyNew && !d.priority.isNew) return false;
    if (opt.nearOnly && !(d.rssiFiltered != null && d.rssiFiltered >= -70)) return false;
    if (opt.activeOnly && !d.priority.active) return false;
    return true;
  });
}

// ------------------------------------------------------------ 방위
export const COMPASS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
export function compassName(deg) {
  if (deg == null || !isFinite(deg)) return '-';
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** DeviceOrientation 이벤트 → 나침반 방위(0=북, 시계방향). 얻을 수 없으면 null */
export function headingFromEvent(e) {
  if (!e) return null;
  if (typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading)) return e.webkitCompassHeading;
  if (e.absolute && typeof e.alpha === 'number') return (360 - e.alpha + 360) % 360;
  return null;
}

export function angleDiff(a, b) { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; }

export class HeadingSensor {
  constructor() { this.heading = null; this.state = 'idle'; this._h = (e) => { const h = headingFromEvent(e); if (h != null) { this.heading = h; this.state = 'active'; this.at = Date.now(); } }; }
  async start() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') { this.state = 'denied'; return false; }
      }
    } catch (_) { this.state = 'denied'; return false; }
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) { this.state = 'unsupported'; return false; }
    window.addEventListener('deviceorientationabsolute', this._h);
    window.addEventListener('deviceorientation', this._h);
    this.state = 'waiting';
    setTimeout(() => { if (this.state === 'waiting') this.state = 'no-data'; }, 2500);
    return true;
  }
  stop() { try { window.removeEventListener('deviceorientationabsolute', this._h); window.removeEventListener('deviceorientation', this._h); } catch (_) {} if (this.state !== 'unsupported' && this.state !== 'denied') this.state = 'idle'; }
  get fresh() { return this.heading != null && Date.now() - (this.at || 0) < 1500; }
}

function median(a) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/**
 * 몸 가림 효과 기반 방향 추정.
 * 사용자가 휴대폰을 가슴 앞에 들고 제자리에서 한 바퀴 돌면, 몸이 전파원과 휴대폰 사이를 가릴 때 신호가 약해진다.
 * 신호가 가장 강한 방위가 대략적인 전파원 방향이다. 실내 반사로 크게 틀릴 수 있다.
 */
export class DirectionFinder {
  constructor(sectors = 12) { this.n = sectors; this.reset(); }
  reset() { this.samples = []; }
  add(heading, rssi, t = Date.now()) {
    if (heading == null || rssi == null || !isFinite(heading) || !isFinite(rssi) || rssi >= 0) return false;
    this.samples.push({ h: ((heading % 360) + 360) % 360, r: rssi, t });
    if (this.samples.length > 2000) this.samples.shift();
    return true;
  }
  result() {
    const w = 360 / this.n;
    const bins = Array.from({ length: this.n }, () => []);
    for (const s of this.samples) bins[Math.floor(s.h / w) % this.n].push(s.r);
    const med = bins.map((b) => (b.length ? median(b) : null));
    const covered = med.filter((m) => m != null).length;
    if (covered < 4) return { ready: false, coverage: covered, sectors: med, samples: this.samples.length };
    const vals = med.filter((m) => m != null);
    const mx = Math.max(...vals), mn = Math.min(...vals);
    const contrast = mx - mn;
    // 상위 섹터 가중 원형 평균
    let sx = 0, sy = 0;
    med.forEach((m, i) => {
      if (m == null) return;
      const wgt = Math.max(0, m - (mx - Math.max(3, contrast * 0.35)));
      const a = (i + 0.5) * w * Math.PI / 180;
      sx += wgt * Math.sin(a); sy += wgt * Math.cos(a);
    });
    let bearing = (Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360;
    if (!sx && !sy) bearing = (med.indexOf(mx) + 0.5) * w;
    let confidence = 'low';
    if (covered >= Math.ceil(this.n * 0.8) && contrast >= 8) confidence = 'high';
    else if (covered >= Math.ceil(this.n * 0.6) && contrast >= 5) confidence = 'medium';
    return { ready: true, bearing: Math.round(bearing), compass: compassName(bearing), contrast: +contrast.toFixed(1), coverage: covered, sectors: med, samples: this.samples.length, confidence, spread: confidence === 'high' ? 45 : confidence === 'medium' ? 60 : 90 };
  }
}

export const CONFIDENCE_LABEL = { high: '비교적 뚜렷함', medium: '보통', low: '불확실' };
