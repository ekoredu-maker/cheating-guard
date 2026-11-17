/**
 * CheatingGuard 제2 탐지 엔진: 광학적 카메라 렌즈 반사 탐지
 * - CameraManager: 카메라 스트림, 플래시(torch), 줌, 초점 제어 및 프레임 획득
 * - ProcessingClient: Web Worker 영상 분석 (실패 시 메인 스레드 대체 실행)
 * - OpticalDetector: 플래시 ON/OFF 차분, 일반 영상 반사점, 정지 영상 분석, 재현성 추적
 */
import { run as runLocal } from './processors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ProcessingClient {
  constructor() {
    this.worker = null;
    this.verified = false;
    this.seq = 0;
    this.pending = new Map();
    this.mode = 'main';
    try {
      this.worker = new Worker(new URL('./vision-worker.js', import.meta.url), { type: 'module' });
      this.mode = 'worker';
      this.worker.onmessage = (e) => {
        const { id, ok, result, error } = e.data || {};
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        ok ? p.resolve(result) : p.reject(new Error(error));
      };
      this.worker.onerror = () => this._fallback();
      this._post('ping', {}).then(() => { this.verified = true; }).catch(() => this._fallback());
    } catch (_) {
      this._fallback();
    }
  }
  _fallback() {
    if (this.worker) { try { this.worker.terminate(); } catch (_) {} }
    this.worker = null;
    this.mode = 'main';
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.retryLocal(); }
    this.pending.clear();
  }
  _post(cmd, payload, transfer) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const retryLocal = () => { try { resolve(runLocal(cmd, payload)); } catch (e) { reject(e); } };
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('분석 시간 초과')); }, 15000);
      this.pending.set(id, { resolve, reject, timer, retryLocal });
      this.worker.postMessage({ id, cmd, payload }, transfer || []);
    });
  }
  run(cmd, payload, transfer) {
    if (this.worker) return this._post(cmd, payload, this.verified ? transfer : undefined);
    return new Promise((resolve, reject) => {
      setTimeout(() => { try { resolve(runLocal(cmd, payload)); } catch (e) { reject(e); } }, 0);
    });
  }
  get label() { return this.mode === 'worker' ? 'Web Worker' : '메인 스레드'; }
}

export class CameraError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function describeCameraError(e) {
  const name = e && e.name;
  if (e && e.code === 'unsupported') return '이 브라우저는 카메라 기능(getUserMedia)을 지원하지 않습니다.';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '카메라 권한이 거부되었습니다. 브라우저 주소창의 사이트 설정에서 카메라 권한을 허용해 주세요.';
  if (name === 'NotReadableError' || name === 'AbortError') return '카메라를 열 수 없습니다. 다른 앱에서 카메라를 사용 중인지 확인해 주세요.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '사용할 수 있는 카메라를 찾지 못했습니다.';
  return '카메라 실행 중 오류가 발생했습니다.';
}

export class CameraManager {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.caps = {};
    this.settings = {};
    this.torchOn = false;
    this.facing = 'environment';
    this.deviceId = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.listeners = new Set();
    this.busy = false;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(type, detail) { for (const fn of this.listeners) { try { fn(type, detail); } catch (_) {} } }
  get active() { return !!(this.track && this.track.readyState === 'live'); }
  get hasTorch() { return !!(this.caps && this.caps.torch); }
  get zoomRange() {
    const z = this.caps && this.caps.zoom;
    return z && typeof z.max === 'number' && z.max > z.min ? { min: z.min, max: z.max, step: z.step || 0.1 } : null;
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new CameraError('unsupported', 'getUserMedia 미지원');
    if (this.busy) return;
    this.busy = true;
    try {
      await this.stop(true);
      const base = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } };
      const video = this.deviceId ? Object.assign({ deviceId: { exact: this.deviceId } }, base)
        : Object.assign({ facingMode: { ideal: this.facing } }, base);
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (e) {
        if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') && this.deviceId) {
          this.deviceId = null;
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: this.facing } }, audio: false });
        } else if (e && e.name === 'OverconstrainedError') {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } else throw e;
      }
      this.stream = stream;
      this.track = stream.getVideoTracks()[0];
      this.track.addEventListener('ended', () => { this._cleanup(); this._emit('ended'); });
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.setAttribute('playsinline', '');
      try { await this.video.play(); } catch (_) {}
      await this._waitForFrames();
      this.caps = (this.track.getCapabilities && this.track.getCapabilities()) || {};
      this.settings = (this.track.getSettings && this.track.getSettings()) || {};
      if (this.caps.focusMode && this.caps.focusMode.includes('continuous')) await this.apply({ focusMode: 'continuous' });
      if (this.caps.exposureMode && this.caps.exposureMode.includes('continuous')) await this.apply({ exposureMode: 'continuous' });
      if (this.caps.whiteBalanceMode && this.caps.whiteBalanceMode.includes('continuous')) await this.apply({ whiteBalanceMode: 'continuous' });
      this.torchOn = false;
      this._emit('started', this.info());
    } finally {
      this.busy = false;
    }
  }

  _waitForFrames(timeout = 4000) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const check = () => {
        if (this.video.videoWidth > 0 && this.video.readyState >= 2) return resolve(true);
        if (performance.now() - t0 > timeout) return resolve(false);
        setTimeout(check, 50);
      };
      check();
    });
  }

  info() {
    return {
      label: this.track ? this.track.label : '',
      width: this.video.videoWidth, height: this.video.videoHeight,
      facing: this.settings.facingMode || this.facing,
      torch: this.hasTorch, zoom: this.zoomRange,
      focus: (this.caps.focusMode || []).slice(), exposure: (this.caps.exposureMode || []).slice(),
      whiteBalance: (this.caps.whiteBalanceMode || []).slice(),
    };
  }

  async apply(c) {
    if (!this.track || !this.track.applyConstraints) return false;
    try {
      await this.track.applyConstraints({ advanced: [c] });
      this.settings = (this.track.getSettings && this.track.getSettings()) || this.settings;
      return true;
    } catch (_) { return false; }
  }

  async setTorch(on) {
    if (!this.active || !this.hasTorch) return false;
    if (this.torchOn === on) return true;
    const ok = await this.apply({ torch: on });
    if (ok) this.torchOn = on;
    this._emit('torch', this.torchOn);
    return ok;
  }

  async setZoom(v) {
    const z = this.zoomRange;
    if (!z) return false;
    return this.apply({ zoom: Math.min(z.max, Math.max(z.min, v)) });
  }

  async switchCamera() {
    let cams = [];
    try { cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch (_) {}
    if (cams.length > 1) {
      const curId = this.settings.deviceId;
      const idx = cams.findIndex((c) => c.deviceId === curId);
      this.deviceId = cams[(idx + 1) % cams.length].deviceId;
    } else {
      this.deviceId = null;
      this.facing = this.facing === 'environment' ? 'user' : 'environment';
    }
    await this.start();
  }

  _cleanup() {
    if (this.stream) for (const t of this.stream.getTracks()) { try { t.stop(); } catch (_) {} }
    this.stream = null; this.track = null; this.torchOn = false;
    if (this.video) { try { this.video.pause(); } catch (_) {} this.video.srcObject = null; }
  }

  async stop(silent) {
    const was = this.active;
    if (this.torchOn) { try { await this.track.applyConstraints({ advanced: [{ torch: false }] }); } catch (_) {} }
    this._cleanup();
    if (was && !silent) this._emit('stopped');
  }

  /** 현재 프레임 획득. roi: 정규화 좌표 {x,y,w,h} */
  grab({ roi = null, maxSide = 640 } = {}) {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!this.active || !vw || !vh) return null;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (roi) {
      sx = Math.round(roi.x * vw); sy = Math.round(roi.y * vh);
      sw = Math.max(16, Math.round(roi.w * vw)); sh = Math.max(16, Math.round(roi.h * vh));
      sw = Math.min(sw, vw - sx); sh = Math.min(sh, vh - sy);
    }
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(8, Math.round(sw * scale)), h = Math.max(8, Math.round(sh * scale));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    return { data: img.data, w, h, geom: { sx, sy, sw, sh, vw, vh, w, h } };
  }
}

/** 이미지 원본(정지 영상·사진)에서 프레임 획득 */
export function grabFromSource(src, srcW, srcH, roi, maxSide = 900) {
  let sx = 0, sy = 0, sw = srcW, sh = srcH;
  if (roi) { sx = Math.round(roi.x * srcW); sy = Math.round(roi.y * srcH); sw = Math.round(roi.w * srcW); sh = Math.round(roi.h * srcH); }
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(8, Math.round(sw * scale)), h = Math.max(8, Math.round(sh * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h, geom: { sx, sy, sw, sh, vw: srcW, vh: srcH, w, h } };
}

/** 처리 좌표 → 전체 프레임 정규화 좌표 */
export function toNormalized(geom, x, y) {
  return { nx: (geom.sx + (x + 0.5) * (geom.sw / geom.w)) / geom.vw, ny: (geom.sy + (y + 0.5) * (geom.sh / geom.h)) / geom.vh };
}

/** 프레임 간 위치 기반 재현성 추적 */
export class ReproTracker {
  constructor({ window = 5, need = 3, radius = 0.03 } = {}) {
    this.window = window; this.need = need; this.radius = radius;
    this.tracks = []; this.round = 0; this.nextId = 1;
  }
  reset() { this.tracks = []; this.round = 0; }
  update(items) {
    this.round++;
    const used = new Set();
    for (const it of items) {
      let best = null, bd = Infinity;
      for (const t of this.tracks) {
        if (used.has(t.id)) continue;
        const d = Math.hypot(t.nx - it.nx, t.ny - it.ny);
        if (d < this.radius && d < bd) { bd = d; best = t; }
      }
      if (best) {
        used.add(best.id);
        best.nx = best.nx * 0.6 + it.nx * 0.4; best.ny = best.ny * 0.6 + it.ny * 0.4;
        best.rounds.push(this.round); best.last = it;
        best.scoreSum += it.featureScore || 0; best.n++;
      } else {
        const t = { id: this.nextId++, nx: it.nx, ny: it.ny, rounds: [this.round], first: this.round, last: it, scoreSum: it.featureScore || 0, n: 1 };
        this.tracks.push(t); used.add(t.id);
      }
    }
    const minRound = this.round - this.window + 1;
    for (const t of this.tracks) t.rounds = t.rounds.filter((r) => r >= minRound);
    this.tracks = this.tracks.filter((t) => t.rounds.length > 0);
    return this.summary();
  }
  summary() {
    const observed = Math.min(this.round, this.window);
    return this.tracks.map((t) => ({
      id: t.id, nx: t.nx, ny: t.ny, hits: t.rounds.length, observed,
      reproducible: observed >= this.need && t.rounds.length >= this.need,
      pending: observed < this.need,
      seenNow: t.rounds[t.rounds.length - 1] === this.round,
      featureScore: Math.round(t.scoreSum / t.n), last: t.last,
    })).sort((a, b) => (b.reproducible - a.reproducible) || (b.hits - a.hits) || (b.featureScore - a.featureScore));
  }
}

export function opticalEnvironment(q, motionState) {
  const issues = [];
  if (!q) return { state: 'unknown', issues };
  if (q.brightness < 25) issues.push('주변이 너무 어둡습니다');
  if (q.brightness > 225 || q.saturated > 0.12) issues.push('과다 노출 영역이 많습니다');
  if (q.sharpness < 12) issues.push('초점이 흐리거나 질감이 거의 없는 장면입니다');
  if (q.shiftPx != null && q.shiftPx >= 6) issues.push('측정 중 화면이 크게 움직였습니다');
  if (q.flashEffect != null && q.flashEffect < 0.02 && q.brightness > 140) issues.push('플래시 효과가 거의 없습니다 (주변이 밝거나 대상이 멂)');
  if (motionState === 'moving') issues.push('스마트폰이 흔들리고 있습니다');
  return { state: issues.length ? 'poor' : 'good', issues };
}

export class OpticalDetector {
  constructor(camera, proc) {
    this.cam = camera;
    this.proc = proc;
    this.roi = null;
    this.sensitivity = 'normal';
    this.mode = null;
    this.running = false;
    this.flashTracker = new ReproTracker({ window: 5, need: 3, radius: 0.03 });
    this.spotTracker = new ReproTracker({ window: 6, need: 4, radius: 0.02 });
    this.last = null;
    this.still = null;
    this.cycles = 0;
    this.onUpdate = () => {};
    this.onStatus = () => {};
    this.motionState = () => 'unknown';
    this._loopToken = 0;
  }

  get tracks() {
    if (this.mode === 'flash') return this.flashTracker.summary();
    if (this.mode === 'spots') return this.spotTracker.summary();
    return [];
  }

  async startFlash() {
    if (!this.cam.active) throw new Error('카메라가 실행되지 않았습니다.');
    if (!this.cam.hasTorch) throw new Error('이 기기 또는 브라우저에서는 플래시 제어를 지원하지 않습니다.');
    await this.stop();
    this.mode = 'flash'; this.running = true; this.cycles = 0;
    this.flashTracker.reset();
    const token = ++this._loopToken;
    this.onStatus('플래시 차분 분석 중 · 스마트폰을 고정해 주세요');
    (async () => {
      while (this.running && token === this._loopToken) {
        const t0 = performance.now();
        try { await this.flashCycle(token); } catch (e) { this.onStatus('분석 오류: ' + (e.message || e)); await sleep(800); }
        const rest = 1700 - (performance.now() - t0);
        if (rest > 0) await sleep(rest);
      }
    })();
  }

  async flashCycle(token) {
    const cam = this.cam;
    const alive = () => this.running && token === this._loopToken && cam.active;
    await cam.setTorch(false);
    await sleep(350);
    if (!alive()) return;
    const off = cam.grab({ roi: this.roi });
    if (!off) return;
    const ok = await cam.setTorch(true);
    if (!ok) { this.onStatus('플래시를 켤 수 없습니다'); return; }
    await sleep(650);
    if (!alive()) { await cam.setTorch(false); return; }
    const on = cam.grab({ roi: this.roi });
    await cam.setTorch(false);
    await sleep(450);
    if (!alive() || !on) return;
    const off2 = cam.grab({ roi: this.roi });
    if (!off2) return;
    const res = await this.proc.run('flashDiff',
      { off: off.data, on: on.data, off2: off2.data, w: off.w, h: off.h, params: { sensitivity: this.sensitivity } },
      [off.data.buffer, on.data.buffer, off2.data.buffer]);
    if (!alive()) return;
    this.cycles++;
    this._ingest(res, off.geom, this.flashTracker);
  }

  async startSpots() {
    if (!this.cam.active) throw new Error('카메라가 실행되지 않았습니다.');
    await this.stop();
    this.mode = 'spots'; this.running = true; this.cycles = 0;
    this.spotTracker.reset();
    const token = ++this._loopToken;
    this.onStatus('일반 영상 반사점 분석 중');
    (async () => {
      while (this.running && token === this._loopToken) {
        const t0 = performance.now();
        try { await this.spotOnce(token); } catch (e) { this.onStatus('분석 오류: ' + (e.message || e)); }
        const rest = 450 - (performance.now() - t0);
        await sleep(Math.max(60, rest));
      }
    })();
  }

  async spotOnce(token) {
    const f = this.cam.grab({ roi: this.roi });
    if (!f) return null;
    const res = await this.proc.run('spots', { rgba: f.data, w: f.w, h: f.h, params: { sensitivity: this.sensitivity } }, [f.data.buffer]);
    if (token != null && (!this.running || token !== this._loopToken)) return null;
    this.cycles++;
    this._ingest(res, f.geom, this.spotTracker);
    return res;
  }

  _ingest(res, geom, tracker) {
    const items = res.candidates.map((c) => Object.assign({}, c, toNormalized(geom, c.x, c.y), { nr: c.radius * (geom.sw / geom.w) / geom.vw }));
    const rejected = (res.rejected || []).map((c) => Object.assign({}, c, toNormalized(geom, c.x, c.y)));
    const tracks = tracker.update(items);
    const env = opticalEnvironment(res.quality, this.motionState());
    this.last = { mode: res.mode, at: Date.now(), cycles: this.cycles, items, rejected, rejectedCount: res.rejectedCount, quality: res.quality, env, tracks, threshold: res.threshold };
    this.onUpdate(this.last);
  }

  /** 정지 영상 1회 분석 (반사점 + 렌즈 형태 후보) */
  async analyzeStill(source, srcW, srcH) {
    const f = grabFromSource(source, srcW, srcH, this.roi);
    const copy = new Uint8ClampedArray(f.data);
    const spots = await this.proc.run('spots', { rgba: f.data, w: f.w, h: f.h, params: { sensitivity: this.sensitivity } });
    const dark = await this.proc.run('dark', { rgba: copy, w: f.w, h: f.h, params: { sensitivity: this.sensitivity } });
    const items = spots.candidates.map((c) => Object.assign({}, c, toNormalized(f.geom, c.x, c.y)));
    const darkItems = dark.items.map((c) => Object.assign({}, c, toNormalized(f.geom, c.x, c.y)));
    this.still = { at: Date.now(), items, rejected: spots.rejected.map((c) => Object.assign({}, c, toNormalized(f.geom, c.x, c.y))), rejectedCount: spots.rejectedCount, dark: darkItems, quality: spots.quality, env: opticalEnvironment(spots.quality, 'unknown') };
    return this.still;
  }

  async stop() {
    this.running = false;
    this._loopToken++;
    if (this.cam.torchOn) await this.cam.setTorch(false);
    if (this.mode) this.onStatus('분석 정지됨');
    this.mode = null;
  }

  /** 융합 엔진용 요약 */
  evidence() {
    const tr = this.mode === 'flash' ? this.flashTracker.summary() : this.mode === 'spots' ? this.spotTracker.summary() : (this.last ? this.last.tracks : []);
    const mode = this.mode || (this.last && this.last.mode) || null;
    return {
      ran: !!this.last || !!this.still,
      mode,
      cycles: this.cycles,
      reproducible: tr.filter((t) => t.reproducible),
      pending: tr.filter((t) => !t.reproducible),
      stillCount: this.still ? this.still.items.length : 0,
      quality: this.last ? this.last.quality : (this.still ? this.still.quality : null),
      env: this.last ? this.last.env : (this.still ? this.still.env : { state: 'unknown', issues: [] }),
    };
  }
}

/** 표시 영역(object-fit: contain) 계산 */
export function containRect(boxW, boxH, srcW, srcH) {
  if (!srcW || !srcH) return { x: 0, y: 0, w: boxW, h: boxH };
  const s = Math.min(boxW / srcW, boxH / srcH);
  const w = srcW * s, h = srcH * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/** 오버레이 그리기 */
export function drawOverlay(canvas, srcW, srcH, layers) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = canvas.clientWidth, bh = canvas.clientHeight;
  if (canvas.width !== Math.round(bw * dpr) || canvas.height !== Math.round(bh * dpr)) {
    canvas.width = Math.round(bw * dpr); canvas.height = Math.round(bh * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, bw, bh);
  const r = containRect(bw, bh, srcW, srcH);
  const P = (nx, ny) => [r.x + nx * r.w, r.y + ny * r.h];
  if (layers.roi) {
    const [x, y] = P(layers.roi.x, layers.roi.y);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, layers.roi.w * r.w, layers.roi.h * r.h); ctx.setLineDash([]);
  }
  ctx.font = '600 12px system-ui, sans-serif';
  for (const t of layers.tracks || []) {
    const [x, y] = P(t.nx, t.ny);
    const rad = Math.max(9, (t.last && t.last.nr ? t.last.nr * r.w : 0) + 7);
    ctx.lineWidth = t.reproducible ? 3 : 2;
    ctx.strokeStyle = t.reproducible ? '#3dff9a' : 'rgba(255,214,10,0.9)';
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(`${t.reproducible ? '재현' : '후보'} ${t.hits}/${t.observed}`, x + rad + 3, y - 3);
  }
  for (const c of layers.items || []) {
    const [x, y] = P(c.nx, c.ny);
    ctx.strokeStyle = '#3dff9a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke();
  }
  for (const c of layers.rejected || []) {
    const [x, y] = P(c.nx, c.ny);
    ctx.strokeStyle = 'rgba(160,160,160,0.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
  }
  for (const d of layers.dark || []) {
    const [x, y] = P(d.nx, d.ny);
    ctx.strokeStyle = '#ff6bd5'; ctx.lineWidth = 2;
    ctx.strokeRect(x - 10, y - 10, 20, 20);
  }
  for (const l of layers.leds || []) {
    const [x, y] = P(l.nx, l.ny);
    ctx.strokeStyle = l.candidate ? '#38d6ff' : 'rgba(56,214,255,0.5)'; ctx.lineWidth = l.candidate ? 3 : 1.5;
    ctx.beginPath(); ctx.moveTo(x, y - 12); ctx.lineTo(x + 12, y); ctx.lineTo(x, y + 12); ctx.lineTo(x - 12, y); ctx.closePath(); ctx.stroke();
    if (l.candidate) { ctx.fillStyle = '#38d6ff'; ctx.fillText('표시등 후보', x + 14, y + 4); }
  }
}
