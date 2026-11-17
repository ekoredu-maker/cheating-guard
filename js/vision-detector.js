/**
 * CheatingGuard 제3·제4 탐지 엔진
 * - 촬영 표시등(발광점) 후보 추적 (규칙 기반)
 * - 렌즈 형태 후보 (규칙 기반 어두운 원형점)
 * - 외형 특징 육안 확인 체크리스트
 * - AI 모델 모듈 등록 구조 (검증된 모델이 없으면 비활성)
 */
import { toNormalized } from './optical-detector.js';

export const RESULT_KINDS = {
  rule: '규칙 기반 영상 분석',
  generic: '일반 객체 탐지 모델',
  glasses: '스마트 글라스 전용 AI 모델',
};

/** 외형 특징 체크리스트 (사용자 육안 확인) */
export const APPEARANCE_CHECKLIST = [
  { id: 'lens', text: '안경테 모서리(앞면 좌·우 끝)에 작은 원형 렌즈가 보인다' },
  { id: 'led', text: '렌즈 반대편 모서리에 작은 표시등(LED) 창이 보인다' },
  { id: 'temple', text: '안경다리가 일반 안경보다 눈에 띄게 두껍다' },
  { id: 'holes', text: '안경다리에 마이크·스피커용 작은 구멍이 있다' },
  { id: 'button', text: '안경다리 위·아래에 버튼 또는 터치 영역이 있다' },
  { id: 'port', text: '충전 단자 또는 충전 접점이 보인다' },
  { id: 'asym', text: '좌우 안경테 앞면 구조가 비대칭이다' },
  { id: 'model', text: '특정 스마트 글라스 모델의 로고·외형과 일치한다' },
];

export class LedTracker {
  constructor({ radius = 0.03, expireMs = 4000 } = {}) {
    this.radius = radius; this.expireMs = expireMs;
    this.tracks = []; this.frame = 0; this.nextId = 1;
  }
  reset() { this.tracks = []; this.frame = 0; }
  update(spots, t = Date.now()) {
    this.frame++;
    const used = new Set();
    for (const s of spots) {
      let best = null, bd = Infinity;
      for (const tr of this.tracks) {
        if (used.has(tr.id)) continue;
        const d = Math.hypot(tr.nx - s.nx, tr.ny - s.ny);
        if (d < this.radius && d < bd) { bd = d; best = tr; }
      }
      if (best) {
        used.add(best.id);
        if (!best.present) best.transitions++;
        best.present = true; best.seen++; best.lastSeen = t; best.lastFrame = this.frame;
        best.nx = best.nx * 0.7 + s.nx * 0.3; best.ny = best.ny * 0.7 + s.ny * 0.3;
        best.peak = Math.max(best.peak, s.peak); best.colors.push(s.colorName); best.last = s;
        if (best.colors.length > 20) best.colors.shift();
      } else {
        const tr = { id: this.nextId++, nx: s.nx, ny: s.ny, firstSeen: t, lastSeen: t, firstFrame: this.frame, lastFrame: this.frame, seen: 1, transitions: 0, present: true, peak: s.peak, colors: [s.colorName], last: s };
        this.tracks.push(tr); used.add(tr.id);
      }
    }
    for (const tr of this.tracks) {
      if (!used.has(tr.id) && tr.present) { tr.present = false; tr.transitions++; }
    }
    this.tracks = this.tracks.filter((tr) => t - tr.lastSeen <= this.expireMs);
    if (this.tracks.length > 80) this.tracks = this.tracks.sort((a, b) => b.seen - a.seen).slice(0, 80);
    return this.summary(t);
  }
  summary(t = Date.now()) {
    return this.tracks.map((tr) => {
      const frames = this.frame - tr.firstFrame + 1;
      const presence = tr.seen / frames;
      const duration = tr.lastSeen - tr.firstSeen;
      const blinking = tr.transitions >= 4 && tr.seen >= 4;
      const steady = duration >= 2000 && presence >= 0.7;
      const counts = {};
      for (const c of tr.colors) counts[c] = (counts[c] || 0) + 1;
      const colorName = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      return {
        id: tr.id, nx: tr.nx, ny: tr.ny, seen: tr.seen, frames, presence: +presence.toFixed(2),
        durationMs: duration, transitions: tr.transitions, blinking, steady,
        candidate: blinking || steady, present: tr.present, colorName, peak: tr.peak,
        sat: tr.last.sat, area: tr.last.area,
      };
    }).sort((a, b) => (b.candidate - a.candidate) || (b.seen - a.seen));
  }
}

/** 반사점과 자체 발광점 구분 시도 (확정 아님) */
export function emissionHint(led, reflections = []) {
  const near = reflections.some((r) => Math.hypot(r.nx - led.nx, r.ny - led.ny) < 0.03);
  if (near) return '플래시 반사점과 같은 위치 — 반사일 가능성';
  if (led.colorName !== '백색' && led.sat >= 0.4) return `${led.colorName} 발광점 — 자체 발광 가능성 (미확정)`;
  return '백색 점 — 반사와 발광 구분 불가';
}

export class VisionDetector {
  constructor(camera, proc) {
    this.cam = camera; this.proc = proc;
    this.led = new LedTracker();
    this.running = false; this._token = 0;
    this.roi = null; this.sensitivity = 'normal';
    this.leds = []; this.dark = null; this.checklist = {};
    this.onUpdate = () => {}; this.onStatus = () => {};
    this.lastQuality = null;
    this.frames = 0;
  }

  async startLed() {
    if (!this.cam.active) throw new Error('카메라가 실행되지 않았습니다.');
    this.stopLed();
    this.running = true; this.led.reset(); this.frames = 0;
    const token = ++this._token;
    this.onStatus('표시등 후보 추적 중 (플래시 사용 안 함)');
    (async () => {
      while (this.running && token === this._token) {
        const t0 = performance.now();
        try { await this.ledOnce(token); } catch (e) { this.onStatus('분석 오류: ' + (e.message || e)); }
        const rest = 200 - (performance.now() - t0);
        await new Promise((r) => setTimeout(r, Math.max(40, rest)));
      }
    })();
  }

  /** 프레임 하나를 처리 (통합 탐지에서도 사용) */
  async ledOnce(token, frame) {
    if (this.cam.torchOn) return null;
    const f = frame || this.cam.grab({ roi: this.roi, maxSide: 480 });
    if (!f) return null;
    const res = await this.proc.run('led', { rgba: f.data, w: f.w, h: f.h, params: { sensitivity: this.sensitivity } }, frame ? undefined : [f.data.buffer]);
    if (token != null && token !== this._token) return null;
    const spots = res.spots.map((s) => Object.assign({}, s, toNormalized(f.geom, s.x, s.y)));
    this.leds = this.led.update(spots);
    this.lastQuality = res.quality;
    this.frames++;
    this.onUpdate({ leds: this.leds, quality: res.quality });
    return this.leds;
  }

  stopLed() {
    const was = this.running;
    this.running = false; this._token++;
    if (was) this.onStatus('표시등 추적 정지됨');
  }

  async analyzeDark() {
    const f = this.cam.grab({ roi: this.roi, maxSide: 720 });
    if (!f) throw new Error('카메라가 실행되지 않았습니다.');
    const res = await this.proc.run('dark', { rgba: f.data, w: f.w, h: f.h, params: { sensitivity: this.sensitivity } });
    this.dark = { at: Date.now(), items: res.items.map((d) => Object.assign({}, d, toNormalized(f.geom, d.x, d.y))), quality: res.quality };
    return this.dark;
  }

  setCheck(id, value) { this.checklist[id] = value; }
  checklistSummary() {
    const yes = APPEARANCE_CHECKLIST.filter((c) => this.checklist[c.id] === 'yes');
    return { yesCount: yes.length, yes: yes.map((c) => c.text), answered: Object.keys(this.checklist).length };
  }

  evidence() {
    const cands = this.leds.filter((l) => l.candidate);
    return {
      ledRan: this.frames > 0,
      ledCandidates: cands,
      darkRan: !!this.dark,
      darkCount: this.dark ? this.dark.items.length : 0,
      visual: this.checklistSummary(),
    };
  }
}

/**
 * AI 모델 등록 구조.
 * 스마트 글라스 전용 모델은 validated(검증 데이터·성능 보고서 확인)가 true일 때만 활성화된다.
 * v1.0.0에는 어떤 AI 모델도 포함되어 있지 않다.
 */
export class ModelRegistry {
  constructor() { this.models = []; }
  register(def) {
    if (!def || !def.id || !RESULT_KINDS[def.kind]) throw new Error('잘못된 모델 정의');
    if (def.kind === 'glasses' && !def.validated) throw new Error('검증되지 않은 스마트 글라스 전용 모델은 활성화할 수 없습니다.');
    if (typeof def.run !== 'function') throw new Error('run 함수가 필요합니다.');
    this.models.push(def);
    return def;
  }
  get(kind) { return this.models.find((m) => m.kind === kind) || null; }
  status() {
    const g = this.get('glasses'), o = this.get('generic');
    return [
      { kind: 'rule', label: RESULT_KINDS.rule, state: '사용 중', detail: '반사점·발광점·어두운 원형점 규칙 기반 분석 (기기 내부 처리)' },
      { kind: 'generic', label: RESULT_KINDS.generic, state: o ? `탑재: ${o.name}` : '사용 안 함', detail: '일반 객체 탐지 모델은 스마트 글라스와 일반 안경을 정확히 구별하지 못하므로 판단 근거로 쓰지 않습니다.' },
      { kind: 'glasses', label: RESULT_KINDS.glasses, state: g ? `탑재: ${g.name} ${g.version || ''}` : '미탑재', detail: g ? (g.license || '') : '검증된 스마트 글라스 학습 데이터와 모델이 없어 비활성 상태입니다.' },
    ];
  }
}
