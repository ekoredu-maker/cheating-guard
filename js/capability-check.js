/**
 * CheatingGuard 스마트폰 기능 자동 진단
 * 각 항목은 'API 존재 여부(apiPresent)'와 '실제 작동 확인(works)'을 분리해 기록한다.
 * works: true(확인됨) / false(실패) / null(아직 확인 안 됨 — 권한·사용자 동작 필요)
 */
export const STATUS = {
  supported: '지원됨',
  permission: '권한 필요',
  experimental: '실험적 기능',
  unsupported: '미지원',
  error: '실행 오류',
};

const withTimeout = (p, ms = 2500) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

function entry(id, group, name, apiPresent, status, detail = '', works = null) {
  return { id, group, name, apiPresent: !!apiPresent, status, detail, works };
}

async function permState(name) {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return null;
    const r = await withTimeout(navigator.permissions.query({ name }), 1500);
    return r.state;
  } catch (_) { return null; }
}

function genericSensor(id, name, cls, perm, experimentalByDefault) {
  return async () => {
    const present = typeof window !== 'undefined' && cls in window;
    if (!present) return entry(id, '센서', name, false, 'unsupported', '이 브라우저에서 제공하지 않습니다.');
    const st = await permState(perm);
    if (st === 'denied') return entry(id, '센서', name, true, 'error', '권한이 거부되었습니다.', false);
    if (experimentalByDefault) return entry(id, '센서', name, true, 'experimental', 'Generic Sensor API (일부 브라우저 실험 기능)');
    return entry(id, '센서', name, true, st === 'granted' ? 'supported' : 'permission', st === 'granted' ? '권한 허용됨 (측정 시작 시 확인)' : '측정 시작 시 권한을 요청합니다.');
  };
}

export async function runCapabilityCheck() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const bt = nav.bluetooth;
  const BD = typeof BluetoothDevice !== 'undefined' ? BluetoothDevice.prototype : null;
  const md = nav.mediaDevices;
  const supportedConstraints = (md && md.getSupportedConstraints && md.getSupportedConstraints()) || {};
  const MST = typeof MediaStreamTrack !== 'undefined' ? MediaStreamTrack.prototype : null;

  const checks = [
    async () => {
      if (!bt) return entry('webBluetooth', '블루투스', 'Web Bluetooth API', false, 'unsupported', window.isSecureContext ? '이 브라우저에서 지원하지 않습니다 (iOS Safari 등).' : 'HTTPS 연결이 필요합니다.');
      let avail = null;
      try { avail = bt.getAvailability ? await withTimeout(bt.getAvailability(), 2000) : null; } catch (_) {}
      if (avail === false) return entry('webBluetooth', '블루투스', 'Web Bluetooth API', true, 'error', '블루투스 어댑터가 없거나 꺼져 있습니다.', false);
      return entry('webBluetooth', '블루투스', 'Web Bluetooth API', true, 'supported', avail ? '블루투스 사용 가능' : '사용 가능 여부 미확인', avail === true ? true : null);
    },
    async () => entry('btRequestDevice', '블루투스', 'Bluetooth requestDevice', bt && typeof bt.requestDevice === 'function', bt && bt.requestDevice ? 'permission' : 'unsupported', bt && bt.requestDevice ? '사용자가 선택창에서 기기를 고를 때만 작동합니다.' : ''),
    async () => entry('btRequestLEScan', '블루투스', 'Bluetooth requestLEScan', bt && typeof bt.requestLEScan === 'function', bt && bt.requestLEScan ? 'experimental' : 'unsupported', bt && bt.requestLEScan ? '실험적 기능 (Chrome 플래그 필요)' : '대부분의 브라우저에서 기본 비활성'),
    async () => entry('btWatchAds', '블루투스', 'Bluetooth watchAdvertisements', BD && typeof BD.watchAdvertisements === 'function', BD && BD.watchAdvertisements ? 'experimental' : 'unsupported', BD && BD.watchAdvertisements ? '실험적 기능 — 선택한 기기의 광고 패킷 수신' : ''),
    async () => entry('btGetDevices', '블루투스', 'Bluetooth getDevices', bt && typeof bt.getDevices === 'function', bt && bt.getDevices ? 'experimental' : 'unsupported', bt && bt.getDevices ? '권한을 허용했던 기기 목록 조회' : ''),
    async () => entry('btAdvEvent', '블루투스', 'Bluetooth advertisementreceived', BD && 'onadvertisementreceived' in BD, BD && 'onadvertisementreceived' in BD ? 'experimental' : 'unsupported', 'RSSI·제조사 데이터 수신 이벤트'),
    async () => {
      const p = md && typeof md.getUserMedia === 'function';
      if (!p) return entry('getUserMedia', '카메라', 'MediaDevices.getUserMedia', false, 'unsupported', window.isSecureContext ? '카메라 API 미지원' : 'HTTPS 연결이 필요합니다.');
      const st = await permState('camera');
      if (st === 'denied') return entry('getUserMedia', '카메라', 'MediaDevices.getUserMedia', true, 'error', '카메라 권한이 거부되었습니다.', false);
      return entry('getUserMedia', '카메라', 'MediaDevices.getUserMedia', true, st === 'granted' ? 'supported' : 'permission', st === 'granted' ? '카메라 권한 허용됨' : '카메라 시작 시 권한을 요청합니다.');
    },
    async () => {
      if (!md || !md.enumerateDevices) return entry('enumerateDevices', '카메라', 'MediaDevices.enumerateDevices', false, 'unsupported');
      try {
        const list = await withTimeout(md.enumerateDevices(), 2000);
        const n = list.filter((d) => d.kind === 'videoinput').length;
        return entry('enumerateDevices', '카메라', 'MediaDevices.enumerateDevices', true, 'supported', `카메라 ${n}개 확인${n ? '' : ' (권한 허용 전에는 표시되지 않을 수 있음)'}`, true);
      } catch (_) { return entry('enumerateDevices', '카메라', 'MediaDevices.enumerateDevices', true, 'error', '장치 목록 조회 실패', false); }
    },
    async () => entry('getCapabilities', '카메라', 'MediaStreamTrack.getCapabilities', MST && typeof MST.getCapabilities === 'function', MST && MST.getCapabilities ? 'supported' : 'unsupported', MST && MST.getCapabilities ? '카메라 시작 후 실제 기능 확인' : 'Firefox 등 일부 브라우저 미지원'),
    async () => entry('applyConstraints', '카메라', 'MediaStreamTrack.applyConstraints', MST && typeof MST.applyConstraints === 'function', MST && MST.applyConstraints ? 'supported' : 'unsupported'),
    async () => entry('imageCapture', '카메라', 'ImageCapture API', typeof window !== 'undefined' && 'ImageCapture' in window, 'ImageCapture' in window ? 'supported' : 'unsupported', 'ImageCapture' in window ? '' : 'Canvas 프레임 획득으로 대체'),
    ...[['torch', 'Torch (플래시)'], ['zoom', 'Zoom'], ['focusMode', 'Focus'], ['exposureMode', 'Exposure'], ['whiteBalanceMode', 'White Balance']].map(([k, label]) => async () => {
      const known = !!supportedConstraints[k];
      return entry('cam_' + k, '카메라', label, known, known ? 'permission' : 'unsupported', known ? '카메라 시작 후 기기 지원 여부를 확인합니다.' : '브라우저가 이 제약 조건을 알지 못합니다.');
    }),
    async () => {
      const p = typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
      const needPerm = p && typeof DeviceMotionEvent.requestPermission === 'function';
      return entry('deviceMotion', '센서', 'DeviceMotionEvent', p, !p ? 'unsupported' : needPerm ? 'permission' : 'supported', !p ? '' : needPerm ? '측정 시작 시 권한 요청 (iOS)' : '측정 시작 후 데이터 수신 여부 확인');
    },
    async () => {
      const p = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
      const needPerm = p && typeof DeviceOrientationEvent.requestPermission === 'function';
      return entry('deviceOrientation', '센서', 'DeviceOrientationEvent', p, !p ? 'unsupported' : needPerm ? 'permission' : 'supported');
    },
    genericSensor('accelerometer', 'Accelerometer', 'Accelerometer', 'accelerometer', false),
    genericSensor('gyroscope', 'Gyroscope', 'Gyroscope', 'gyroscope', false),
    genericSensor('magnetometer', 'Magnetometer', 'Magnetometer', 'magnetometer', true),
    genericSensor('ambientLight', 'AmbientLightSensor', 'AmbientLightSensor', 'ambient-light-sensor', true),
    async () => {
      if (typeof WebAssembly !== 'object') return entry('wasm', '연산', 'WebAssembly', false, 'unsupported');
      try {
        const ok = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        return entry('wasm', '연산', 'WebAssembly', true, ok ? 'supported' : 'error', ok ? '모듈 검증 성공' : '모듈 검증 실패', ok);
      } catch (_) { return entry('wasm', '연산', 'WebAssembly', true, 'error', '', false); }
    },
    async () => {
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        return entry('webgl', '연산', 'WebGL', !!gl, gl ? 'supported' : 'unsupported', gl ? (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 'WebGL 2' : 'WebGL 1') : '', !!gl);
      } catch (_) { return entry('webgl', '연산', 'WebGL', false, 'error', '', false); }
    },
    async () => {
      if (!nav.gpu) return entry('webgpu', '연산', 'WebGPU', false, 'unsupported');
      try {
        const a = await withTimeout(nav.gpu.requestAdapter(), 2500);
        return entry('webgpu', '연산', 'WebGPU', true, a ? 'supported' : 'error', a ? '어댑터 확인' : '어댑터를 얻지 못함', !!a);
      } catch (_) { return entry('webgpu', '연산', 'WebGPU', true, 'error', '어댑터 요청 실패', false); }
    },
    async () => {
      if (typeof indexedDB === 'undefined') return entry('indexedDB', '저장', 'IndexedDB', false, 'unsupported', '메모리 임시 저장으로 대체');
      try {
        await withTimeout(new Promise((res, rej) => { const r = indexedDB.open('cheatingguard-probe'); r.onsuccess = () => { r.result.close(); res(); }; r.onerror = () => rej(r.error); }), 2500);
        try { indexedDB.deleteDatabase('cheatingguard-probe'); } catch (_) {}
        return entry('indexedDB', '저장', 'IndexedDB', true, 'supported', '열기 성공', true);
      } catch (_) { return entry('indexedDB', '저장', 'IndexedDB', true, 'error', '열기 실패 (사생활 보호 모드 등) — 메모리 임시 저장으로 대체', false); }
    },
    async () => {
      const p = 'serviceWorker' in nav;
      if (!p) return entry('serviceWorker', '저장', 'Service Worker', false, 'unsupported', '오프라인 실행 불가');
      if (!window.isSecureContext) return entry('serviceWorker', '저장', 'Service Worker', true, 'error', 'HTTPS 연결이 필요합니다.', false);
      const reg = await withTimeout(nav.serviceWorker.getRegistration(), 2000).catch(() => null);
      return entry('serviceWorker', '저장', 'Service Worker', true, 'supported', reg ? (reg.active ? '등록·활성화됨' : '등록됨 (활성화 대기)') : '등록 진행 중', reg && reg.active ? true : null);
    },
    async () => {
      if (typeof caches === 'undefined') return entry('cacheStorage', '저장', 'Cache Storage', false, 'unsupported');
      try { await withTimeout(caches.keys(), 2000); return entry('cacheStorage', '저장', 'Cache Storage', true, 'supported', '', true); }
      catch (_) { return entry('cacheStorage', '저장', 'Cache Storage', true, 'error', '', false); }
    },
    async () => entry('wakeLock', '기타', 'Screen Wake Lock API', 'wakeLock' in nav, 'wakeLock' in nav ? 'supported' : 'unsupported', 'wakeLock' in nav ? '탐지 중 화면 꺼짐 방지 (실행 시 확인)' : '탐지 중 화면이 자동으로 꺼질 수 있습니다.'),
  ];

  const results = [];
  for (const fn of checks) {
    try { results.push(await fn()); }
    catch (e) { results.push(entry('err' + results.length, '기타', '진단 항목', false, 'error', '진단 중 오류')); }
  }
  return results;
}

/** 카메라 실행 후 실제 지원 여부로 갱신 */
export function updateCameraCapabilities(results, caps) {
  const map = { cam_torch: caps.torch, cam_zoom: caps.zoom, cam_focusMode: caps.focus, cam_exposureMode: caps.exposure, cam_whiteBalanceMode: caps.whiteBalance };
  for (const r of results) {
    if (!(r.id in map)) continue;
    const v = map[r.id];
    const ok = r.id === 'cam_zoom' ? !!v : r.id === 'cam_torch' ? !!v : Array.isArray(v) && v.length > 0;
    r.status = ok ? 'supported' : 'unsupported';
    r.works = ok;
    r.detail = ok
      ? (r.id === 'cam_zoom' ? `배율 ${v.min}~${v.max}` : r.id === 'cam_torch' ? '현재 카메라에서 플래시 제어 가능' : `모드: ${v.join(', ')}`)
      : '현재 카메라에서 지원하지 않습니다.';
  }
  const g = results.find((r) => r.id === 'getUserMedia');
  if (g) { g.status = 'supported'; g.works = true; g.detail = '카메라 실행 확인'; }
  return results;
}

export function updateEntry(results, id, patch) {
  const r = results.find((x) => x.id === id);
  if (r) Object.assign(r, patch);
  return results;
}

export function summarize(results) {
  const by = (id) => results.find((r) => r.id === id) || {};
  return {
    ble: by('btRequestDevice').apiPresent,
    bleAdvanced: by('btRequestLEScan').apiPresent || by('btWatchAds').apiPresent,
    camera: by('getUserMedia').apiPresent && by('getUserMedia').status !== 'error',
    torch: by('cam_torch').works === true ? true : by('cam_torch').works === false ? false : null,
    sw: by('serviceWorker').apiPresent,
  };
}
