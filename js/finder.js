/**
 * 칫팅가드 찾기 모드 (v1.4.0)
 * 손전등 + 고해상도 렌즈 반사(글린트) 검출 → 흔들림 보정 추적 → 손전등 반응 확인 → 다각도 확인 → 다가가며 전파 변화 확인
 * 후보마다 '가능성 등급'(빨강 높음 / 주황 중간 / 노랑 낮음)을 매긴다. 등급은 규칙 기반이며 확률이 아니다.
 */
import { angleDiff } from './radio-analyzer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export const TIERS = {
  red: { key: 'red', rank: 3, label: '높음', color: '#ff3b3b' },
  orange: { key: 'orange', rank: 2, label: '중간', color: '#ff9f1a' },
  yellow: { key: 'yellow', rank: 1, label: '낮음', color: '#ffd60a' },
  none: { key: 'none', rank: 0, label: '관찰', color: '#9aa79f' },
  excluded: { key: 'excluded', rank: -1, label: '제외', color: '#6b7570' },
};

export const ANGLE_GOAL = 20;     // 다각도 확인 목표 (도)
const HFOV = 65;                   // 휴대폰 후면 카메라 가로 화각 근사 (도)

/** 후보 가능성 등급 (순수 함수) */
export function scoreCandidate(c, { torchSupported = true } = {}) {
  const reasons = [];
  let s = 0;
  const g = Math.min(30, Math.round((c.bestScore || 0) * 0.3)); s += g; reasons.push(`반사 모양·대비 +${g}`);
  const per = Math.min(15, Math.round((c.hits || 0) * 1.5)); s += per; reasons.push(`반복 관측 ${c.hits}회 +${per}`);
  const ty = c.torchYes || 0, tn = c.torchNo || 0;
  if (tn >= 2 && tn > ty) return { score: 0, tier: TIERS.excluded, reasons: [`손전등을 꺼도 밝음 ${tn}회 — 조명·표시등으로 판단해 제외`] };
  if (ty >= 2) { s += 30; reasons.push(`손전등 반응 ${ty}회 +30`); } else if (ty === 1) { s += 15; reasons.push('손전등 반응 1회 +15'); }
  const span = c.spanDeg || 0;
  if (span >= ANGLE_GOAL) { s += 20; reasons.push(`여러 각도(${Math.round(span)}°)에서 반복 +20`); } else if (span >= 10) { s += 10; reasons.push(`각도 변화 ${Math.round(span)}°에서 반복 +10`); }
  const radio = c.radio && c.radio.linked;
  if (radio) { s += 20; reasons.push(`다가갈 때 전파 신호 +${c.radio.delta} dB 증가 +20`); }
  s = Math.min(100, s);
  let tier = TIERS.none;
  const optStrong = torchSupported ? ty >= 2 : (c.hits >= 8);
  if (s >= 70 && optStrong && (span >= ANGLE_GOAL || radio)) tier = TIERS.red;
  else if (s >= 45 && (ty >= 1 || span >= ANGLE_GOAL || radio)) tier = TIERS.orange;
  else if (s >= 15 && ((c.hits || 0) >= 3 || ty >= 1)) tier = TIERS.yellow;
  return { score: s, tier, reasons };
}

/** 각도 범위: 관측 시점의 카메라 방향(pan/tilt, 방위) 사이 최대 각도 차 */
export function angleSpan(sightings) {
  let m = 0;
  for (let i = 0; i < sightings.length; i++) for (let j = i + 1; j < sightings.length; j++) {
    const a = sightings[i], b = sightings[j];
    let d = Math.hypot(a.px - b.px, a.py - b.py);
    if (a.h != null && b.h != null) d = Math.max(d, Math.hypot(angleDiff(a.h, b.h), (a.t ?? 0) - (b.t ?? 0)));
    if (d > m) m = d;
  }
  return Math.min(180, m);
}

/** 다가가기 전후 RSSI 변화로 전파원 연결 (순수 함수). series: [{key,name,samples:[{t,v}]}] */
export function linkRadio(series, t0, t1, win = 2500) {
  const rows = [];
  for (const d of series) {
    const a = d.samples.filter((s) => s.t >= t0 && s.t <= t0 + win).map((s) => s.v);
    const b = d.samples.filter((s) => s.t >= t1 - win && s.t <= t1).map((s) => s.v);
    if (a.length < 2 || b.length < 2) continue;
    rows.push({ key: d.key, name: d.name, before: median(a), after: median(b), delta: Math.round(median(b) - median(a)) });
  }
  rows.sort((x, y) => y.delta - x.delta);
  const best = rows[0], second = rows[1];
  const linked = !!(best && best.delta >= 8 && (!second || best.delta - second.delta >= 4));
  return { rows, best: best || null, linked };
}

export class Finder {
  constructor({ camera, proc, sensors, ble }) {
    this.cam = camera; this.proc = proc; this.sensors = sensors; this.ble = ble;
    this.opts = { sensitivity: 'high', darkExposure: false, torchConfirm: true, minTier: 'yellow', maxSide: 1280, sound: true };
    this.reset();
    this.ori = null;
    this._oriH = (e) => { if (e.alpha != null) this.ori = { a: e.alpha, b: e.beta, g: e.gamma, at: Date.now() }; };
    this.onUpdate = () => {}; this.onStatus = () => {}; this.onRed = () => {};
  }

  reset() {
    this.cands = []; this.nextId = 1; this.frames = 0; this.pan = { x: 0, y: 0 };
    this.locked = null; this.approach = null; this.lastConfirm = 0; this.torch = false; this.dark = false;
    this.quality = null; this.rejected = {}; this.redIds = new Set();
    this.diag = { frames: 0, fps: 0, res: '-', stats: null, torchDiff: null, diffRuns: 0, lastShift: 0 }; this._ft = [];
  }

  get running() { return !!this._running; }

  async start() {
    if (!this.cam.active) throw new Error('카메라가 실행되지 않았습니다.');
    const light = this.light;
    this.stop(true);
    this.reset();
    this.light = light;
    this._running = true;
    const token = this._token = (this._token || 0) + 1;
    try { await this.proc.run('glintReset', {}); } catch (_) {}
    // 빛 방식: light 어댑터(손전등 또는 화면 빛)가 주어지면 사용
    this.lightKind = this.light ? this.light.kind : (this.cam.hasTorch ? 'torch' : 'none');
    if (!this.light && this.cam.hasTorch) this.light = { kind: 'torch', set: (on) => this.cam.setTorch(on) };
    this.torch = this.light ? await this.light.set(true) : false;
    this.dark = this.opts.darkExposure ? await this.cam.setDarkExposure(true) : false;
    try { window.addEventListener('deviceorientation', this._oriH); } catch (_) {}
    this.started = Date.now();
    this.onStatus(this.lightKind === 'screen' ? '화면 빛 사용 중 · 화면 밝기를 최대로 하고 대상에 30cm~1.5m까지 다가가 천천히 비추세요'
      : this.torch ? '손전등 켜짐 · 방 불을 끄고 천천히 훑으세요' : '빛 제어가 안 됩니다 · 다른 휴대폰 손전등을 눈높이에서 비추며 훑으세요');
    (async () => {
      while (this._running && token === this._token && this.cam.active) {
        const t0 = performance.now();
        try { await this._frame(token); } catch (_) {}
        if (Date.now() - this.started > 300000 && this.torch) { this.onStatus('과열 방지를 위해 5분 후 자동 정지했습니다.'); this.stop(); break; }
        await sleep(Math.max(40, 230 - (performance.now() - t0)));
      }
    })();
  }

  stop(silent) {
    this._running = false; this._token = (this._token || 0) + 1;
    try { window.removeEventListener('deviceorientation', this._oriH); } catch (_) {}
    if (this.light && this.light.kind === 'screen') { try { this.light.set(false, true); } catch (_) {} }
    if (this.cam.active) {
      if (this.cam.torchOn) this.cam.setTorch(false);
      if (this.dark) this.cam.setDarkExposure(false);
    }
    this.torch = false; this.dark = false; this.light = null;
    if (this.approach && this.approach.active) this.approach.active = false;
    if (!silent) this.onUpdate();
  }

  _frame = async (token) => {
    const f = this.cam.grab({ maxSide: this.opts.maxSide });
    if (!f) return;
    const res = await this.proc.run('glint', { rgba: f.data, w: f.w, h: f.h, params: { sensitivity: this.opts.sensitivity }, streamKey: 'finder' }, [f.data.buffer]);
    if (token !== this._token) return;
    this.frames++;
    this.quality = res.quality; this.rejected = res.rejected;
    const now = performance.now(); this._ft.push(now); if (this._ft.length > 10) this._ft.shift();
    this.diag.fps = this._ft.length > 1 ? +((this._ft.length - 1) * 1000 / (now - this._ft[0])).toFixed(1) : 0;
    this.diag.frames = this.frames; this.diag.res = `${f.w}×${f.h}`; this.diag.stats = res.stats; this.diag.rejected = res.rejected;
    this.diag.lastShift = Math.round(Math.hypot(res.shift.dx, res.shift.dy));
    // 흔들림 보정: 화면 내용이 이동한 만큼 후보 위치를 옮기고, 카메라 회전 각도를 누적
    const dxn = res.shift.dx / f.w, dyn = res.shift.dy / f.h;
    for (const c of this.cands) { c.nx += dxn; c.ny += dyn; }
    this.pan.x -= dxn * HFOV; this.pan.y -= dyn * HFOV * (f.h / f.w);
    const glints = res.glints.map((g) => ({ ...g, nx: (g.x + 0.5) / f.w, ny: (g.y + 0.5) / f.h }));
    const used = new Set();
    const radius = res.shift.valid ? 0.02 : 0.04;
    for (const g of glints) {
      let best = null, bd = Infinity;
      for (const c of this.cands) {
        if (used.has(c.id)) continue;
        const d = Math.hypot(c.nx - g.nx, c.ny - g.ny);
        if (d < radius && d < bd) { bd = d; best = c; }
      }
      if (best) this._seen(best, g, used);
      else if (g.score >= 15 && this.cands.length < 80) {
        const c = { id: this.nextId++, nx: g.nx, ny: g.ny, hits: 0, lastFrame: 0, firstFrame: this.frames, bestScore: 0, peak: 0, area: 0, ratio: 0, torchYes: 0, torchNo: 0, sightings: [], spanDeg: 0, radio: null };
        this.cands.push(c); this._seen(c, g, used);
      }
    }
    // 오래 보이지 않은 후보 정리 (주황 이상은 더 오래 유지)
    this.cands = this.cands.filter((c) => {
      const age = this.frames - c.lastFrame;
      const keep = c.tier && c.tier.rank >= 2 ? 400 : (c.hits >= 3 || c.torchYes >= 1) ? 60 : 12;
      return age <= keep || (this.locked && this.locked === c.id);
    });
    for (const c of this.cands) {
      c.visible = this.frames - c.lastFrame <= 2 && c.nx >= 0 && c.nx <= 1 && c.ny >= 0 && c.ny <= 1;
      c.offscreen = c.nx < 0 || c.nx > 1 || c.ny < 0 || c.ny > 1;
      Object.assign(c, (({ score, tier, reasons }) => ({ score, tier, reasons }))(scoreCandidate(c, { torchSupported: this.torch })));
      if (c.tier.key === 'red' && !this.redIds.has(c.id)) { this.redIds.add(c.id); this.onRed(c); }
    }
    // 손전등 반응 확인 (보이는 후보를 한 번에)
    // 손전등 반응 확인 + 손전등 차분 탐색: 휴대폰이 잠깐 멈췄을 때 (후보가 있으면 2.2초, 없어도 3초마다)
    if (this.torch && this.opts.torchConfirm && this.sensors.motionState() !== 'moving' && this.diag.lastShift <= 12) {
      const targets = this.cands.filter((c) => c.visible && c.hits >= 2 && c.torchYes + c.torchNo < 4);
      const since = Date.now() - this.lastConfirm;
      const scr = this.lightKind === 'screen';
      if ((targets.length && since > (scr ? 1500 : 2200)) || since > (scr ? 1600 : 3000)) { this.lastConfirm = Date.now(); await this._confirm(targets, token); }
    }
    if (this.approach && this.approach.active) this._approachTick();
    this.onUpdate();
  };

  _seen(c, g, used) {
    used.add(c.id);
    c.nx = c.nx * 0.5 + g.nx * 0.5; c.ny = c.ny * 0.5 + g.ny * 0.5;
    c.hits++; c.lastFrame = this.frames;
    c.bestScore = Math.max(c.bestScore, g.score); c.peak = Math.max(c.peak, g.peak); c.area = g.area; c.ratio = Math.max(c.ratio, g.ratio); c.color = g.colorName;
    const o = this.ori && Date.now() - this.ori.at < 1000 ? this.ori : null;
    const sgt = { px: this.pan.x, py: this.pan.y, h: o ? o.a : null, t: o ? o.b : null };
    const last = c.sightings[c.sightings.length - 1];
    if (!last || Math.hypot(last.px - sgt.px, last.py - sgt.py) > 2 || (sgt.h != null && last.h != null && angleDiff(sgt.h, last.h) > 2)) {
      c.sightings.push(sgt); if (c.sightings.length > 40) c.sightings.splice(1, 1);
      c.spanDeg = angleSpan(c.sightings);
    }
  }

  async _confirm(targets, token) {
    const on = this.cam.grab({ maxSide: this.opts.maxSide });
    if (!on) return;
    const scr = this.lightKind === 'screen';
    await this.light.set(false);
    await sleep(scr ? 380 : 300);
    const off = token === this._token ? this.cam.grab({ maxSide: this.opts.maxSide }) : null;
    if (this._running && token === this._token) await this.light.set(true);
    await sleep(200);
    if (!off) return;
    const counted = new Set();
    for (const c of targets) {
      const a = peakNear(on, c.nx, c.ny), b = peakNear(off, c.nx, c.ny);
      if (a == null || b == null) continue;
      if (a - b >= Math.max(15, a * 0.3) && b <= a * 0.75) { c.torchYes++; counted.add(c.id); }
      else if (a >= 80 && b >= a * 0.85) c.torchNo++;
      c.lastTorch = { on: a, off: b };
    }
    // 차분 영상에서 손전등에만 반응하는 약한 반사를 새로 찾는다
    try {
      const d = await this.proc.run('torchDiff', { on: on.data, off: off.data, w: on.w, h: on.h, params: { sensitivity: this.opts.sensitivity } }, [on.data.buffer, off.data.buffer]);
      if (token !== this._token) return;
      this.diag.torchDiff = d.stats; this.diag.diffRuns++;
      for (const sp of d.spots) {
        const nx = (sp.x + 0.5) / on.w, ny = (sp.y + 0.5) / on.h;
        let best = null, bd = 0.02;
        for (const c of this.cands) { const dd = Math.hypot(c.nx - nx, c.ny - ny); if (dd < bd) { bd = dd; best = c; } }
        if (best) {
          if (!counted.has(best.id)) { best.torchYes++; counted.add(best.id); }
          best.hits++; best.lastFrame = this.frames; best.bestScore = Math.max(best.bestScore, sp.score);
        } else if (this.cands.length < 80) {
          const c = { id: this.nextId++, nx, ny, hits: 1, lastFrame: this.frames, firstFrame: this.frames, bestScore: sp.score, peak: sp.peak, area: sp.area, ratio: sp.ratio, torchYes: 1, torchNo: 0, sightings: [], spanDeg: 0, radio: null, fromDiff: true };
          this._seen(c, { nx, ny, score: sp.score, peak: sp.peak, area: sp.area, ratio: sp.ratio, colorName: '' }, new Set());
          c.hits = 1;
          this.cands.push(c);
        }
      }
    } catch (_) {}
  }

  lock(id) { this.locked = this.cands.some((c) => c.id === id) ? id : null; this.onUpdate(); }
  lockedCand() { return this.cands.find((c) => c.id === this.locked) || null; }

  /** 전파 신호를 받을 수 있는지 (선택 기기 광고 수신 또는 주변 스캔) */
  radioAvailable() {
    for (const r of this.ble.devices.values()) if (r.rssi.count > 0 && Date.now() - r.lastSeen < 10000) return true;
    return false;
  }

  startApproach() {
    const c = this.lockedCand();
    if (!c) throw new Error('먼저 후보를 선택하세요.');
    if (!this.radioAvailable()) throw new Error('수신 중인 블루투스 신호가 없습니다. 전파 탭에서 주변 스캔 또는 기기 추적을 먼저 시작하세요.');
    this.approach = { active: true, cand: c.id, t0: Date.now(), area0: c.area, peak0: c.peak, result: null };
    this.onStatus('후보를 화면 가운데 두고 천천히 다가가세요 (약 10~20초) · 도착하면 ‘도착’을 누르세요');
    this.onUpdate();
  }

  _approachTick() { if (Date.now() - this.approach.t0 > 30000) this.finishApproach(); }

  finishApproach() {
    const A = this.approach;
    if (!A || !A.active) return null;
    A.active = false;
    const t1 = Date.now();
    if (t1 - A.t0 < 5000) { A.result = { error: '다가가는 시간이 너무 짧습니다 (5초 이상)' }; this.onUpdate(); return A.result; }
    const series = [...this.ble.devices.values()].map((r) => ({ key: r.key, name: r.name || '(이름 없음)', samples: r.rssi.raw }));
    const L = linkRadio(series, A.t0, t1);
    const c = this.cands.find((x) => x.id === A.cand);
    A.result = L;
    if (c) {
      c.radio = { linked: L.linked, delta: L.best ? L.best.delta : 0, name: L.best ? L.best.name : null, key: L.best ? L.best.key : null };
      Object.assign(c, (({ score, tier, reasons }) => ({ score, tier, reasons }))(scoreCandidate(c, { torchSupported: this.torch })));
      if (c.tier.key === 'red' && !this.redIds.has(c.id)) { this.redIds.add(c.id); this.onRed(c); }
    }
    this.onStatus(L.linked ? `다가갈 때 ‘${L.best.name}’ 신호가 ${L.best.delta} dB 강해졌습니다 — 후보와 연결` : L.best ? `가장 큰 변화는 ‘${L.best.name}’ ${L.best.delta} dB — 연결 기준(8 dB 이상, 다른 기기보다 뚜렷) 미달` : '비교할 신호가 부족합니다');
    this.onUpdate();
    return L;
  }

  /** 안내 문구 */
  guide() {
    if (!this.running) return { step: 0, text: '방 불을 끄고 ‘찾기 시작’을 누르세요. 휴대폰을 눈높이에 들고 벽·천장·전자제품을 천천히 훑습니다.' };
    const L = this.lockedCand();
    if (this.approach && this.approach.active) return { step: 4, text: '후보를 화면 가운데 두고 천천히 다가가세요. 도착하면 ‘도착’을 누르세요.' };
    if (L) {
      if (L.offscreen) return { step: 3, text: '선택한 후보가 화면 밖에 있습니다. 화면에 다시 들어오게 하세요.' };
      if (this.torch && L.torchYes + L.torchNo === 0) return { step: 2, text: '휴대폰을 1~2초 고정하세요. 빛을 잠깐 꺼서 반응을 확인합니다.' };
      if (L.spanDeg < ANGLE_GOAL) return { step: 3, text: `후보를 화면에 둔 채 왼쪽·오른쪽·위로 한 걸음씩 움직이세요. 각도 ${Math.round(L.spanDeg)}°/${ANGLE_GOAL}°` };
      if (!L.radio) return { step: 4, text: '‘다가가며 전파 확인’을 누르고 후보 쪽으로 걸어가 보세요 (블루투스 신호 수신 시).' };
      return { step: 5, text: L.tier.key === 'red' ? '가능성 높은 후보입니다. 물건을 훼손하지 말고 사진으로 기록한 뒤 관리자에게 알리세요.' : '확인을 마쳤습니다. 다른 곳도 계속 훑어 보세요.' };
    }
    const top = this.cands.filter((c) => c.tier && c.tier.rank >= 1 && !c.offscreen).sort((a, b) => b.score - a.score)[0];
    if (top) return { step: 2, text: `${top.tier.label} 등급 후보가 있습니다. 원을 눌러 선택하면 단계별로 확인합니다.` };
    if (this.lightKind === 'screen') return { step: 1, text: '화면이 흰색·검은색으로 천천히 바뀌며 반사를 비교합니다. 대상에 30cm~1.5m까지 다가가 1~2초씩 멈추세요.' };
    return { step: 1, text: this.torch ? '천천히 훑다가 의심 위치에서 1~2초씩 멈추세요. 멈추면 손전등이 잠깐 깜빡이며 약한 반사까지 찾습니다.' : '천천히 훑는 중… 작은 반짝임을 찾고 있습니다.' };
  }

  counts() {
    const c = { red: 0, orange: 0, yellow: 0 };
    for (const x of this.cands) if (x.tier && c[x.tier.key] != null) c[x.tier.key]++;
    return c;
  }

  evidence() {
    const ranked = this.cands.filter((c) => c.tier && c.tier.rank >= 1).sort((a, b) => b.score - a.score);
    return { ran: this.frames > 0, frames: this.frames, torch: this.torch, light: this.lightKind, counts: this.counts(), best: ranked[0] || null, ranked: ranked.slice(0, 5) };
  }
}

/** 프레임에서 정규화 좌표 주변 최대 밝기 */
export function peakNear(frame, nx, ny, r = 5) {
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  const x = Math.round(nx * frame.w - 0.5), y = Math.round(ny * frame.h - 0.5);
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

/** 찾기 화면 오버레이 */
export function drawFinderOverlay(canvas, srcW, srcH, finder, minRank, pulse) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = canvas.clientWidth, bh = canvas.clientHeight;
  if (canvas.width !== Math.round(bw * dpr) || canvas.height !== Math.round(bh * dpr)) { canvas.width = Math.round(bw * dpr); canvas.height = Math.round(bh * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, bw, bh);
  const s = Math.min(bw / srcW, bh / srcH), rw = srcW * s, rh = srcH * s, ox = (bw - rw) / 2, oy = (bh - rh) / 2;
  // 중앙 조준선
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bw / 2 - 14, bh / 2); ctx.lineTo(bw / 2 + 14, bh / 2); ctx.moveTo(bw / 2, bh / 2 - 14); ctx.lineTo(bw / 2, bh / 2 + 14); ctx.stroke();
  ctx.font = '700 13px system-ui, sans-serif'; ctx.textBaseline = 'middle';
  const list = [...finder.cands].filter((c) => c.tier && (c.tier.rank >= minRank || c.id === finder.locked)).sort((a, b) => a.tier.rank - b.tier.rank);
  for (const c of list) {
    if (c.offscreen) continue;
    const x = ox + c.nx * rw, y = oy + c.ny * rh;
    const base = c.tier.key === 'red' ? 22 : c.tier.key === 'orange' ? 18 : 14;
    ctx.strokeStyle = c.tier.color; ctx.globalAlpha = c.visible ? 1 : 0.5;
    ctx.lineWidth = c.tier.key === 'red' ? 4 : 3;
    ctx.beginPath(); ctx.arc(x, y, base, 0, Math.PI * 2); ctx.stroke();
    if (c.tier.key === 'red') { ctx.lineWidth = 2; ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(pulse)); ctx.beginPath(); ctx.arc(x, y, base + 8 + 4 * Math.sin(pulse), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; }
    if (finder.locked === c.id) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.beginPath(); ctx.moveTo(x + a * (base + 12), y + b * (base + 4)); ctx.lineTo(x + a * (base + 12), y + b * (base + 12)); ctx.lineTo(x + a * (base + 4), y + b * (base + 12)); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    const label = `${c.id} ${c.tier.label}`;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; const tw = ctx.measureText(label).width;
    ctx.fillRect(x + base + 4, y - 10, tw + 8, 20);
    ctx.fillStyle = c.tier.color; ctx.fillText(label, x + base + 8, y);
  }
  // 화면 밖 선택 후보 방향 화살표
  const L = finder.lockedCand && finder.lockedCand();
  if (L && L.offscreen) {
    const ang = Math.atan2((L.ny - 0.5) * rh, (L.nx - 0.5) * rw);
    const R = Math.min(bw, bh) / 2 - 30;
    const x = bw / 2 + Math.cos(ang) * R, y = bh / 2 + Math.sin(ang) * R;
    ctx.fillStyle = L.tier.color;
    ctx.beginPath(); ctx.moveTo(x + Math.cos(ang) * 18, y + Math.sin(ang) * 18); ctx.lineTo(x + Math.cos(ang + 2.5) * 14, y + Math.sin(ang + 2.5) * 14); ctx.lineTo(x + Math.cos(ang - 2.5) * 14, y + Math.sin(ang - 2.5) * 14); ctx.fill();
  }
}
