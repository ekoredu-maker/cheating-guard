/**
 * 칫팅가드 Android 앱 네이티브 연결 (v1.6.0)
 * Android 앱(WebView)에서 실행될 때만 window.CGNative 가 존재한다. 웹 브라우저에서는 아무 일도 하지 않는다.
 * 네이티브 → 웹 이벤트: window.CGNativeEvent(type, data)
 */
const listeners = {};

export const Native = {
  get available() { return typeof window !== 'undefined' && !!window.CGNative; },
  info() {
    if (!this.available) return null;
    try { return JSON.parse(window.CGNative.info()); } catch (_) { return null; }
  },
  call(name, ...args) {
    if (!this.available || typeof window.CGNative[name] !== 'function') return { ok: false, error: 'unavailable' };
    try {
      const r = window.CGNative[name](...args);
      if (typeof r === 'string' && r.startsWith('{')) return JSON.parse(r);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  },
  on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  /** 스캔 권한 요청 → 결과(info) */
  requestPermissions(timeout = 30000) {
    return new Promise((resolve) => {
      if (!this.available) return resolve(null);
      let done = false;
      const fn = (info) => { if (!done) { done = true; resolve(info); } };
      this.on('perm', fn);
      this.call('requestPermissions');
      setTimeout(() => fn(this.info()), timeout);
    });
  },
  /** 필요한 권한이 없으면 요청 */
  async ensurePermissions() {
    const i = this.info();
    if (!i) return null;
    if (i.bleAllowed && i.wifiAllowed) return i;
    return (await this.requestPermissions()) || this.info();
  },
};

if (typeof window !== 'undefined') {
  window.CGNativeEvent = (type, data) => {
    for (const fn of listeners[type] || []) { try { fn(data); } catch (e) { console.warn('[CGNative]', type, e); } }
  };
}

export const NATIVE_ERRORS = {
  permission: '권한이 없습니다. 위치·근처 기기 권한을 허용해 주세요.',
  'bluetooth-off': '블루투스가 꺼져 있습니다. 블루투스를 켜 주세요.',
  'wifi-off': 'Wi-Fi가 꺼져 있습니다. Wi-Fi를 켜 주세요 (연결하지 않아도 됩니다).',
  'no-bluetooth': '이 기기는 블루투스를 지원하지 않습니다.',
  'no-wifi': '이 기기는 Wi-Fi를 지원하지 않습니다.',
  'no-sensor': '이 기기에는 자기장 센서가 없습니다.',
  'no-scanner': '블루투스 스캐너를 사용할 수 없습니다.',
  'start-failed': '스캔을 시작하지 못했습니다. 잠시 후 다시 시도하세요.',
  unavailable: 'Android 앱에서만 사용할 수 있습니다.',
};
export const nativeError = (e) => NATIVE_ERRORS[e] || '오류가 발생했습니다.';

// 블루투스 클래식 장치 분류 (Bluetooth SIG Class of Device)
const MAJOR = { 0x0100: '컴퓨터', 0x0200: '휴대폰', 0x0300: '네트워크', 0x0400: '오디오·영상', 0x0500: '주변기기', 0x0600: '영상 장치', 0x0700: '웨어러블', 0x0800: '장난감', 0x0900: '건강', 0x1f00: '미분류' };
const DEVICE = {
  0x0404: '헤드셋(이어폰)', 0x0408: '핸즈프리', 0x0418: '헤드폰', 0x0414: '스피커', 0x0420: '차량 오디오',
  0x0430: '비디오 카메라', 0x0434: '캠코더', 0x043c: '비디오 디스플레이·스피커', 0x0704: '손목시계', 0x0714: '안경',
};
export function classicCategory(major, device) {
  const d = DEVICE[device];
  const m = MAJOR[major] || '알 수 없음';
  let level = 0, note = '';
  if ([0x0404, 0x0408, 0x0418].includes(device)) { level = 2; note = '무선 이어폰·헤드셋 계열 — 귀 속 초소형 이어폰일 수 있음'; }
  else if ([0x0430, 0x0434].includes(device) || major === 0x0600) { level = 3; note = '카메라 계열 장치'; }
  else if (device === 0x0714) { level = 3; note = '안경형 장치'; }
  else if (major === 0x0400 || major === 0x0700) { level = 1; note = '오디오·웨어러블 장치'; }
  else if (major === 0x0200 || major === 0x0100) { level = 0; note = '휴대폰·컴퓨터'; }
  return { label: d ? `${m} · ${d}` : m, level, note };
}
