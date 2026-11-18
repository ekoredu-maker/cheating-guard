/**
 * CheatingGuard 제5 탐지 엔진: 보조 센서 분석
 * - 자기장: 참고용 측정값만 제공 (스마트 글라스 식별 근거로 사용하지 않음)
 * - 자이로/가속도: 흔들림 감지 → 영상 분석 품질 평가
 * - 조도: 광학 탐지 환경 평가
 */
export class SensorHub {
  constructor() {
    this.motion = { state: 'idle', receiving: false, rot: null, acc: null, shake: null, stable: null, error: null };
    this.mag = { state: 'idle', x: null, y: null, z: null, total: null, baseline: null, delta: null, error: null, samples: [] };
    this.light = { state: 'idle', lux: null, error: null };
    this._motionHandler = (e) => this._onMotion(e);
    this._magSensor = null; this._lightSensor = null;
    this.onUpdate = () => {};
    this._lastEmit = 0;
  }

  /** iOS 13+ 등에서 필요한 동작 센서 권한 요청 (사용자 동작 안에서 호출해야 함) */
  async requestMotionPermission() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const r = await DeviceMotionEvent.requestPermission();
        return r === 'granted';
      }
      return true;
    } catch (_) { return false; }
  }

  async startMotion() {
    if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) { this.motion.state = 'unsupported'; return false; }
    const ok = await this.requestMotionPermission();
    if (!ok) { this.motion.state = 'denied'; this.motion.error = '동작 센서 권한이 거부되었습니다.'; return false; }
    window.removeEventListener('devicemotion', this._motionHandler);
    window.addEventListener('devicemotion', this._motionHandler);
    this.motion.state = 'waiting';
    setTimeout(() => { if (!this.motion.receiving && this.motion.state === 'waiting') { this.motion.state = 'no-data'; this._emit(true); } }, 2500);
    return true;
  }

  _onMotion(e) {
    const r = e.rotationRate, a = e.acceleration;
    let rot = null, acc = null;
    if (r && r.alpha != null) rot = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
    if (a && a.x != null) acc = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    if (rot == null && acc == null) return;
    this.motion.receiving = true; this.motion.state = 'active';
    this.motion.rot = rot; this.motion.acc = acc;
    const k = 0.15;
    const level = (rot != null ? rot / 20 : 0) + (acc != null ? acc / 0.8 : 0);
    this.motion.shake = this.motion.shake == null ? level : this.motion.shake + k * (level - this.motion.shake);
    this.motion.stable = this.motion.shake < 1;
    this._emit();
  }

  /** Android 앱 자기장 센서 값 (µT) */
  ingestNativeMag(d) {
    const total = Math.hypot(d.x, d.y, d.z);
    Object.assign(this.mag, { state: 'active', x: d.x, y: d.y, z: d.z, total, native: true });
    this.mag.samples.push(total); if (this.mag.samples.length > 30) this.mag.samples.shift();
    this.mag.delta = this.mag.baseline != null ? total - this.mag.baseline : null;
    this._emit();
  }

  startMagnetometer() {
    if (typeof window !== 'undefined' && window.CGNative) {
      try { const r = JSON.parse(window.CGNative.startMag()); if (r.ok) { this.mag.state = 'waiting'; this._nativeMag = true; return true; } } catch (_) {}
    }
    if (typeof window === 'undefined' || !('Magnetometer' in window)) { this.mag.state = 'unsupported'; return false; }
    try {
      const s = new window.Magnetometer({ frequency: 10 });
      s.addEventListener('reading', () => {
        const { x, y, z } = s;
        if (x == null) return;
        const total = Math.hypot(x, y, z);
        Object.assign(this.mag, { state: 'active', x, y, z, total });
        this.mag.samples.push(total); if (this.mag.samples.length > 30) this.mag.samples.shift();
        this.mag.delta = this.mag.baseline != null ? total - this.mag.baseline : null;
        this._emit();
      });
      s.addEventListener('error', (ev) => {
        const n = ev.error && ev.error.name;
        this.mag.state = n === 'NotAllowedError' ? 'denied' : n === 'NotReadableError' ? 'error' : 'unsupported';
        this.mag.error = n === 'NotAllowedError' ? '자기장 센서 권한이 거부되었습니다.' : '자기장 센서를 사용할 수 없습니다.';
        this._emit(true);
      });
      s.start();
      this._magSensor = s; this.mag.state = 'waiting';
      return true;
    } catch (e) {
      this.mag.state = 'error'; this.mag.error = '자기장 센서를 시작하지 못했습니다.';
      return false;
    }
  }

  setMagBaseline() {
    const s = this.mag.samples;
    if (!s.length) return null;
    this.mag.baseline = s.reduce((a, b) => a + b, 0) / s.length;
    this.mag.delta = this.mag.total != null ? this.mag.total - this.mag.baseline : null;
    this._emit(true);
    return this.mag.baseline;
  }

  startLight() {
    if (typeof window === 'undefined' || !('AmbientLightSensor' in window)) { this.light.state = 'unsupported'; return false; }
    try {
      const s = new window.AmbientLightSensor({ frequency: 2 });
      s.addEventListener('reading', () => { this.light.lux = s.illuminance; this.light.state = 'active'; this._emit(); });
      s.addEventListener('error', (ev) => {
        this.light.state = ev.error && ev.error.name === 'NotAllowedError' ? 'denied' : 'unsupported';
        this.light.error = '조도 센서를 사용할 수 없습니다.';
        this._emit(true);
      });
      s.start();
      this._lightSensor = s; this.light.state = 'waiting';
      return true;
    } catch (_) { this.light.state = 'error'; return false; }
  }

  async startAll() {
    await this.startMotion();
    this.startMagnetometer();
    this.startLight();
    this._emit(true);
  }

  stop() {
    try { window.removeEventListener('devicemotion', this._motionHandler); } catch (_) {}
    try { this._magSensor && this._magSensor.stop(); } catch (_) {}
    if (this._nativeMag) { try { window.CGNative.stopMag(); } catch (_) {} this._nativeMag = false; }
    try { this._lightSensor && this._lightSensor.stop(); } catch (_) {}
    this._magSensor = null; this._lightSensor = null;
    for (const o of [this.motion, this.mag, this.light]) if (o.state === 'active' || o.state === 'waiting') o.state = 'idle';
    this.motion.receiving = false;
    this._emit(true);
  }

  motionState() {
    if (!this.motion.receiving) return 'unknown';
    return this.motion.stable ? 'stable' : 'moving';
  }

  lightState() {
    const l = this.light.lux;
    if (l == null) return 'unknown';
    if (l < 10) return 'dark';
    if (l > 5000) return 'bright';
    return 'ok';
  }

  environment() {
    const issues = [];
    if (this.motionState() === 'moving') issues.push('스마트폰 흔들림이 큽니다 (거치하거나 두 손으로 고정하세요)');
    const ls = this.lightState();
    if (ls === 'dark') issues.push('주변 조도가 매우 낮습니다');
    if (ls === 'bright') issues.push('주변이 매우 밝아 플래시 반사 대비가 낮을 수 있습니다');
    return { motion: this.motionState(), light: ls, lux: this.light.lux, issues };
  }

  _emit(force) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 250) return;
    this._lastEmit = now;
    this.onUpdate(this);
  }
}
