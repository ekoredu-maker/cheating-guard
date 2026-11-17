/**
 * 칫팅가드 자석·배터리·전자기기 근접 스캔 (v1.5.0, 실험적)
 * 브라우저가 자기장 센서 값을 직접 주지 않아도, 나침반 방위는 자기장 센서로 계산된다.
 * 휴대폰을 돌리지 않았는데(자이로) 나침반 방위만 바뀌면 → 근처 자석·철·전자기기가 자기장을 휘게 한 것이다.
 *   이상 각도 = 나침반 방위 변화 − 자이로로 계산한 회전량
 * 스피커 자석(이어폰), 철 케이스 배터리, 모터·코일이 있는 전자기기에 2~5cm 거리에서 반응할 수 있다.
 * 자기장 센서(Magnetometer API)가 있으면 µT 값을 직접 쓴다.
 */
import { headingFromEvent, angleDiff } from './radio-analyzer.js';

const D2R = Math.PI / 180;

/** 기기 좌표의 회전 속도(rotationRate) → 지구 수직축 기준 회전 속도(도/초). 나침반 방위 증가 방향(시계)으로 반환 */
export function headingRate(rr, beta, gamma) {
  if (!rr || beta == null || gamma == null) return null;
  const b = beta * D2R, g = gamma * D2R;
  const wx = rr.beta || 0, wy = rr.gamma || 0, wz = rr.alpha || 0;
  const yaw = -Math.cos(b) * Math.sin(g) * wx + Math.sin(b) * wy + Math.cos(b) * Math.cos(g) * wz;
  return -yaw;
}

/** 부호 있는 각도 차 (a - b, -180~180) */
export function signedDiff(a, b) { return ((a - b) % 360 + 540) % 360 - 180; }

export class MagAnomaly {
  constructor(sensors) {
    this.sensors = sensors;
    this.state = 'idle';
    this.reset();
    this._o = (e) => this._onOri(e);
    this._m = (e) => { this.rr = e.rotationRate; this.rrAt = Date.now(); };
    this.onUpdate = () => {};
  }
  reset() { this.gyroH = null; this.lastT = null; this.offset = null; this.dev = 0; this.peak = 0; this.events = []; this.ori = null; this.rotating = false; this.samples = 0; }

  async start() {
    try {
      for (const E of [typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : null, typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : null]) {
        if (E && typeof E.requestPermission === 'function') { const r = await E.requestPermission(); if (r !== 'granted') { this.state = 'denied'; return false; } }
      }
    } catch (_) { this.state = 'denied'; return false; }
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) { this.state = 'unsupported'; return false; }
    this.reset();
    // 자기장 센서가 직접 지원되면 함께 사용
    this.useMag = false;
    if (this.sensors && this.sensors.startMagnetometer()) this.useMag = true;
    window.addEventListener('deviceorientationabsolute', this._o);
    window.addEventListener('deviceorientation', this._o);
    window.addEventListener('devicemotion', this._m);
    this.state = 'waiting';
    setTimeout(() => { if (this.state === 'waiting') { this.state = 'no-data'; this.onUpdate(); } }, 3000);
    return true;
  }

  stop() {
    try { window.removeEventListener('deviceorientationabsolute', this._o); window.removeEventListener('deviceorientation', this._o); window.removeEventListener('devicemotion', this._m); } catch (_) {}
    if (this.state === 'active' || this.state === 'waiting') this.state = 'idle';
    if (this.useMag && this.sensors) this.sensors.stop();
  }

  /** 지금 위치를 기준(이상 0)으로 */
  rebase() { this.offset = null; this.peak = 0; this.dev = 0; this.onUpdate(); }

  _onOri(e) {
    const h = headingFromEvent(e);
    if (h == null || e.beta == null) return;
    const now = performance.now();
    const rate = headingRate(this.rr, e.beta, e.gamma);
    const fresh = this.rrAt && Date.now() - this.rrAt < 500;
    if (this.gyroH == null || !fresh || rate == null) { this.gyroH = h; this.lastT = now; if (!fresh) { this.state = 'no-gyro'; this.onUpdate(); } return; }
    const dt = Math.min(0.2, (now - this.lastT) / 1000);
    this.lastT = now;
    this.gyroH = (this.gyroH + rate * dt + 360) % 360;
    const rotSpeed = Math.abs(rate);
    this.rotating = rotSpeed > 60;
    const diff = signedDiff(h, this.gyroH);
    if (this.offset == null) this.offset = diff;
    // 자이로 누적 오차는 아주 천천히 보정 (약 30초 시상수), 큰 이상은 보정하지 않음
    const d = signedDiff(diff, this.offset);
    if (Math.abs(d) < 4) this.offset = this.offset + d * 0.006;
    this.dev = this.rotating ? this.dev : Math.abs(d);
    this.samples++;
    this.state = 'active';
    if (!this.rotating && this.dev > this.peak) this.peak = this.dev;
    if (!this.rotating && this.dev >= 15) {
      const last = this.events[this.events.length - 1];
      if (!last || Date.now() - last.t > 1500) this.events.push({ t: Date.now(), dev: Math.round(this.dev) });
      else if (this.dev > last.dev) last.dev = Math.round(this.dev);
      if (this.events.length > 30) this.events.shift();
    }
    this.onUpdate();
  }

  /** 자기장 센서 직접 값 (있을 때) */
  magDelta() { const m = this.sensors && this.sensors.mag; return m && m.state === 'active' && m.delta != null ? m.delta : null; }

  level() {
    const md = this.magDelta();
    if (md != null) return Math.min(1, Math.abs(md) / 60);
    return Math.min(1, this.dev / 45);
  }

  evidence() {
    return { ran: this.samples > 0 || this.magDelta() != null, peak: Math.round(this.peak), events: this.events.length, magDelta: this.magDelta() };
  }
}

export { angleDiff };
