/**
 * CheatingGuard 경고 및 알림 (사용자 승인 시에만 동작)
 * 모드: sound(경고음+진동), vibrate(진동), silent(화면 표시만)
 */
export class Notifier {
  constructor() {
    this.enabled = false;
    this.mode = 'vibrate';
    this.cooldownMs = 60000;
    this.lastByKey = new Map();
    this.audio = null;
    this.onShow = () => {};
  }

  /** 사용자 동작 안에서 호출: 오디오 잠금 해제 */
  unlock() {
    try {
      if (!this.audio) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.audio = new AC();
      }
      if (this.audio && this.audio.state === 'suspended') this.audio.resume();
    } catch (_) { this.audio = null; }
  }

  beep() {
    const ctx = this.audio;
    if (!ctx) return false;
    try {
      const t = ctx.currentTime;
      for (let i = 0; i < 2; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 1320;
        g.gain.setValueAtTime(0.0001, t + i * 0.22);
        g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.22 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.22 + 0.16);
        o.connect(g).connect(ctx.destination);
        o.start(t + i * 0.22); o.stop(t + i * 0.22 + 0.18);
      }
      return true;
    } catch (_) { return false; }
  }

  vibrate(pattern = [120, 80, 120]) {
    try { return !!(navigator.vibrate && navigator.vibrate(pattern)); } catch (_) { return false; }
  }

  /** 동일 후보(key)에 대해서는 cooldown 동안 반복 경고하지 않는다 */
  notify(key, message, { repeat = false } = {}) {
    const now = Date.now();
    const last = this.lastByKey.get(key);
    if (last && now - last < this.cooldownMs) return false;
    this.lastByKey.set(key, now);
    this.onShow(message, repeat ? '반복 탐지' : '후보 발견');
    if (!this.enabled) return true;
    if (this.mode === 'sound') { this.beep(); this.vibrate(); }
    else if (this.mode === 'vibrate') this.vibrate();
    return true;
  }

  test() {
    this.unlock();
    if (this.mode === 'sound') { this.beep(); this.vibrate(); }
    else if (this.mode === 'vibrate') this.vibrate();
  }

  reset() { this.lastByKey.clear(); }
}
