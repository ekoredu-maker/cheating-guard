/**
 * CheatingGuard 제1 탐지 엔진: 블루투스(Web Bluetooth) 탐지
 * - requestDevice: 사용자가 선택창에서 고른 기기만 접근 가능 (주변 기기 전체 목록을 얻을 수 없음)
 * - watchAdvertisements / requestLEScan: 실험적 기능. 지원 브라우저에서만 활성화
 * - 기기 식별자(device.id), MAC 주소는 저장하지 않는다 (메모리에서만 사용)
 */
import { hex16 } from './database.js';
import { Native } from './native-bridge.js';

export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mad(a, med = median(a)) { return median(a.map((v) => Math.abs(v - med))); }

export function linearSlope(points) {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const d = n * sxx - sx * sx;
  return d ? (n * sxy - sx * sy) / d : 0;
}

/** RSSI 신호 분석: 이상치 제거 → 이동 중앙값 → 지수 이동 평균 → 추세 */
export class RssiTracker {
  constructor({ window = 9, medianN = 5, alpha = 0.3, keepMs = 120000 } = {}) {
    this.window = window; this.medianN = medianN; this.alpha = alpha; this.keepMs = keepMs;
    this.raw = []; this.inliers = []; this.history = []; this.ema = null; this.baseline = null; this.outliers = 0;
  }
  push(rssi, t = Date.now()) {
    if (typeof rssi !== 'number' || !isFinite(rssi) || rssi >= 0 || rssi < -127) return false;
    this.raw.push({ t, v: rssi });
    const recent = this.raw.slice(-this.window).map((s) => s.v);
    const m = median(recent);
    const dev = 1.4826 * mad(recent, m);
    const isOutlier = recent.length >= 5 && Math.abs(rssi - m) > Math.max(6, 3 * dev);
    if (isOutlier) this.outliers++;
    else this.inliers.push(rssi);
    if (this.inliers.length > 50) this.inliers.shift();
    const filtered = median(this.inliers.slice(-this.medianN));
    if (isFinite(filtered)) this.ema = this.ema == null ? filtered : this.ema + this.alpha * (filtered - this.ema);
    this.history.push({ t, raw: rssi, ema: this.ema, outlier: isOutlier });
    const cut = t - this.keepMs;
    while (this.history.length && this.history[0].t < cut) this.history.shift();
    while (this.raw.length > 200) this.raw.shift();
    return !isOutlier;
  }
  get last() { return this.raw.length ? this.raw[this.raw.length - 1].v : null; }
  get count() { return this.raw.length; }
  /** 최근 10초 EMA 기울기 (dB/s) */
  trend(now = Date.now()) {
    const pts = this.history.filter((h) => h.ema != null && now - h.t <= 10000).map((h) => [(h.t - now) / 1000, h.ema]);
    if (pts.length < 5) return { state: '판단 보류', slope: null };
    const s = linearSlope(pts);
    const state = Math.abs(s) < 0.3 ? '안정' : s > 0 ? '증가' : '감소';
    return { state, slope: +s.toFixed(2) };
  }
  setBaseline() { if (this.ema != null) this.baseline = +this.ema.toFixed(1); return this.baseline; }
  /** 1m 기준값이 있을 때만 제한적 거리 범위 추정 (경로손실지수 2~3 가정) */
  distanceRange() {
    if (this.baseline == null || this.ema == null) return null;
    const d = (n) => Math.pow(10, (this.baseline - this.ema) / (10 * n));
    const a = d(3), b = d(2);
    return { min: +Math.min(a, b).toFixed(1), max: +Math.max(a, b).toFixed(1) };
  }
}

export function dataViewToHex(dv, max = 31) {
  if (!dv) return '';
  const n = Math.min(dv.byteLength, max);
  let s = '';
  for (let i = 0; i < n; i++) s += dv.getUint8(i).toString(16).padStart(2, '0').toUpperCase();
  return s;
}

export function describeBleError(e) {
  const n = e && e.name;
  if (n === 'NotFoundError') return '기기 선택이 취소되었거나 표시된 기기가 없습니다.';
  if (n === 'SecurityError' || n === 'NotAllowedError') return '블루투스 권한이 거부되었거나 보안 정책으로 차단되었습니다.';
  if (n === 'NotSupportedError') return '이 브라우저에서 지원하지 않는 블루투스 기능입니다.';
  if (n === 'InvalidStateError') return '블루투스가 꺼져 있거나 사용할 수 없는 상태입니다.';
  if (e && /bluetooth adapter|adapter not available|Bluetooth is not available/i.test(e.message || '')) return '블루투스 어댑터를 사용할 수 없습니다. 휴대폰 블루투스가 켜져 있는지 확인해 주세요.';
  return '블루투스 작업 중 오류가 발생했습니다.';
}

export class BluetoothDetector {
  constructor(db) {
    this.db = db;
    this.devices = new Map();
    this.scan = null;
    this.onUpdate = () => {};
    this.onStatus = () => {};
    this._advHandler = (ev) => this._onAdv(ev, '광고 스캔');
    this.maxDevices = 200;
    this.extraCompanyIds = () => [];
    this.extraUuids = () => [];
  }

  support() {
    if (Native.available) {
      const i = Native.info() || {};
      return { api: !!i.ble, requestDevice: false, leScan: !!i.ble, watchAds: false, getDevices: false, native: true };
    }
    const bt = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined;
    const proto = typeof BluetoothDevice !== 'undefined' ? BluetoothDevice.prototype : null;
    return {
      api: !!bt,
      requestDevice: !!(bt && typeof bt.requestDevice === 'function'),
      leScan: !!(bt && typeof bt.requestLEScan === 'function'),
      watchAds: !!(proto && typeof proto.watchAdvertisements === 'function'),
      getDevices: !!(bt && typeof bt.getDevices === 'function'),
    };
  }

  async availability() {
    try {
      if (!navigator.bluetooth || !navigator.bluetooth.getAvailability) return null;
      return await navigator.bluetooth.getAvailability();
    } catch (_) { return null; }
  }

  _upsert(device, source) {
    const key = device.id || ('dev-' + Math.random());
    let rec = this.devices.get(key);
    if (!rec) {
      if (this.devices.size >= this.maxDevices) {
        const oldest = [...this.devices.values()].filter((r) => !r.matches.length).sort((a, b) => a.lastSeen - b.lastSeen)[0];
        if (oldest) this.devices.delete(oldest.key);
      }
      rec = { key, device, name: device.name || '', sources: new Set(), companyIds: new Set(), manufacturerData: {}, serviceData: {}, uuids: new Set(), rssi: new RssiTracker(), txPower: null, firstSeen: Date.now(), lastSeen: Date.now(), matches: [], watching: false, watchError: null, abort: null, advCount: 0 };
      this.devices.set(key, rec);
    }
    rec.sources.add(source);
    return rec;
  }

  _analyze(rec) {
    rec.matches = this.db.match({ name: rec.name, companyIds: [...rec.companyIds], uuids: [...rec.uuids], manufacturerData: rec.manufacturerData });
  }

  /** 기기 선택창 실행 (사용자 동작 필요) */
  /** 의심 기기만 선택창에 보이도록 하는 필터 (스마트 글라스·IoT 식별자, 확인된 기기명 접두어) */
  suspectFilters() {
    const filters = [];
    for (const cid of [...new Set([...this.db.companyIdNumbers(), ...this.extraCompanyIds()])]) filters.push({ manufacturerData: [{ companyIdentifier: cid }] });
    for (const u of [...new Set([...this.db.serviceUuidList(), ...this.extraUuids()])]) filters.push({ services: [u] });
    const prefixes = new Set();
    for (const m of this.db.data.models) for (const a of m.aliases || []) { const t = (a.text || a || '').trim(); if (t.length >= 4) { prefixes.add(t); prefixes.add(t.toLowerCase()); prefixes.add(t.charAt(0).toUpperCase() + t.slice(1)); prefixes.add(t.toUpperCase()); } }
    for (const p of prefixes) filters.push({ namePrefix: p });
    return filters;
  }

  /** 기기 선택창 실행 (사용자 동작 필요). mode: 'suspect' | 'all' */
  async selectDevice(mode = 'all') {
    if (!this.support().requestDevice) throw Object.assign(new Error('Web Bluetooth 미지원'), { name: 'NotSupportedError' });
    const optionalServices = [...new Set([...this.db.serviceUuidList(), ...this.extraUuids()])];
    const optionalManufacturerData = [...new Set([...this.db.companyIdNumbers(), ...this.extraCompanyIds()])];
    const opts = mode === 'suspect'
      ? { filters: this.suspectFilters(), optionalServices, optionalManufacturerData }
      : { acceptAllDevices: true, optionalServices, optionalManufacturerData };
    let device;
    try {
      device = await navigator.bluetooth.requestDevice(opts);
    } catch (e) {
      if (e && e.name === 'TypeError') {
        // 구형 브라우저: manufacturerData 필터·옵션 미지원 → 해당 항목 제거 후 재시도
        delete opts.optionalManufacturerData;
        if (opts.filters) opts.filters = opts.filters.filter((f) => !f.manufacturerData);
        device = await navigator.bluetooth.requestDevice(opts);
      } else throw e;
    }
    const rec = this._upsert(device, '사용자 선택');
    rec.name = device.name || rec.name;
    rec.lastSeen = Date.now();
    this._analyze(rec);
    this.onUpdate();
    if (this.support().watchAds) {
      try {
        rec.abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
        device.addEventListener('advertisementreceived', (ev) => this._onAdv(ev, '선택 기기 광고'));
        await device.watchAdvertisements(rec.abort ? { signal: rec.abort.signal } : undefined);
        rec.watching = true;
        this.onStatus('선택한 기기의 광고 패킷 수신 대기 중 (실험적 기능)');
      } catch (e) {
        rec.watchError = '광고 패킷 수신을 시작하지 못했습니다 (브라우저 실험 기능 비활성 또는 미지원)';
      }
    } else {
      rec.watchError = '이 브라우저는 선택 기기의 광고 패킷 수신(watchAdvertisements)을 지원하지 않습니다. 기기명 분석만 제공합니다.';
    }
    this.onUpdate();
    return rec;
  }

  /** 주변 BLE 광고 스캔 (실험적, 사용자 동작 필요) */
  async startLEScan() {
    if (Native.available) {
      await Native.ensurePermissions();
      const r = Native.call('startBle');
      if (!r.ok) throw Object.assign(new Error(r.error), { name: 'NativeError', code: r.error });
      this.nativeScanning = true;
      this.onStatus('주변 블루투스 전체 스캔 중 (Android 앱)');
      return;
    }
    if (!this.support().leScan) throw Object.assign(new Error('requestLEScan 미지원'), { name: 'NotSupportedError' });
    if (this.scan && this.scan.active) return;
    navigator.bluetooth.removeEventListener('advertisementreceived', this._advHandler);
    navigator.bluetooth.addEventListener('advertisementreceived', this._advHandler);
    this.scan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
    this.onStatus('주변 BLE 광고 스캔 중 (실험적 기능)');
  }

  stopLEScan() {
    if (this.nativeScanning) { Native.call('stopBle'); this.nativeScanning = false; }
    try { if (this.scan && this.scan.active) this.scan.stop(); } catch (_) {}
    this.scan = null;
    try { navigator.bluetooth && navigator.bluetooth.removeEventListener('advertisementreceived', this._advHandler); } catch (_) {}
  }

  get scanning() { return !!(this.nativeScanning || (this.scan && this.scan.active)); }

  /** Android 앱 네이티브 스캔 결과 반영 */
  ingestNative(list) {
    for (const d of list || []) {
      const rec = this._upsert({ id: 'n:' + d.id, name: d.name || '' }, '주변 스캔(앱)');
      rec.advCount++;
      rec.lastSeen = d.t || Date.now();
      if (d.name) rec.name = d.name;
      if (typeof d.rssi === 'number') rec.rssi.push(d.rssi, rec.lastSeen);
      if (typeof d.txPower === 'number') rec.txPower = d.txPower;
      for (const [cid, hex] of Object.entries(d.mfr || {})) { rec.companyIds.add(+cid); rec.manufacturerData[+cid] = hex; }
      for (const [u, hex] of Object.entries(d.serviceData || {})) { rec.serviceData[u] = hex; rec.uuids.add(u); }
      for (const u of d.uuids || []) rec.uuids.add(u);
      this._analyze(rec);
    }
    this._throttledUpdate();
  }

  _onAdv(ev, source) {
    const rec = this._upsert(ev.device, source);
    rec.advCount++;
    rec.lastSeen = Date.now();
    if (ev.name || ev.device.name) rec.name = ev.name || ev.device.name;
    if (typeof ev.rssi === 'number') rec.rssi.push(ev.rssi);
    if (typeof ev.txPower === 'number') rec.txPower = ev.txPower;
    if (ev.manufacturerData) {
      ev.manufacturerData.forEach((dv, cid) => { rec.companyIds.add(cid); rec.manufacturerData[cid] = dataViewToHex(dv); });
    }
    if (ev.serviceData) {
      ev.serviceData.forEach((dv, uuid) => { rec.serviceData[uuid] = dataViewToHex(dv); rec.uuids.add(uuid); });
    }
    for (const u of ev.uuids || []) rec.uuids.add(u);
    this._analyze(rec);
    this._throttledUpdate();
  }

  _throttledUpdate() {
    if (this._t) return;
    this._t = setTimeout(() => { this._t = null; this.onUpdate(); }, 400);
  }

  setBaseline(key) { const r = this.devices.get(key); return r ? r.rssi.setBaseline() : null; }

  /** 현재 보이는 기기를 기준 상태로 저장 (메모리에만 보관) */
  markBaseline() { this.baselineKeys = new Set(this.devices.keys()); this.baselineAt = Date.now(); return this.baselineKeys.size; }
  clearBaseline() { this.baselineKeys = null; this.baselineAt = null; }

  reset() {
    this.clearBaseline();
    this.stopLEScan();
    for (const r of this.devices.values()) { try { r.abort && r.abort.abort(); } catch (_) {} }
    this.devices.clear();
    this.onUpdate();
  }

  /** 표시용 목록 (일치 기기 우선) */
  list({ showAll = false } = {}) {
    const all = [...this.devices.values()].map((r) => this.view(r));
    all.sort((a, b) => (b.matchWeight - a.matchWeight) || ((b.rssiFiltered ?? -200) - (a.rssiFiltered ?? -200)));
    const matched = all.filter((d) => d.matches.length);
    const others = all.filter((d) => !d.matches.length);
    return { matched, others: showAll ? others : others.filter((d) => d.sources.includes('사용자 선택')).concat(others.filter((d) => !d.sources.includes('사용자 선택')).slice(0, 15)), total: all.length };
  }

  view(r) {
    const tr = r.rssi.trend();
    return {
      key: r.key, name: r.name || '(이름 없음)', sources: [...r.sources],
      companyIds: [...r.companyIds].map((c) => ({ id: hex16(c), name: this.db.companyName(c) })),
      manufacturerData: Object.entries(r.manufacturerData).map(([cid, hex]) => ({ id: hex16(+cid), hex })),
      uuids: [...r.uuids], serviceData: r.serviceData,
      rssiLast: r.rssi.last, rssiFiltered: r.rssi.ema != null ? +r.rssi.ema.toFixed(1) : null, rssiCount: r.rssi.count, outliers: r.rssi.outliers,
      trend: tr, baseline: r.rssi.baseline, distance: r.rssi.distanceRange(),
      txPower: r.txPower, pathLoss: r.txPower != null && r.rssi.ema != null ? +(r.txPower - r.rssi.ema).toFixed(1) : null,
      history: r.rssi.history.slice(-60).map((h) => [h.t, h.raw, h.ema]),
      firstSeen: r.firstSeen, lastSeen: r.lastSeen, advCount: r.advCount,
      watching: r.watching, watchError: r.watchError,
      matches: r.matches, matchWeight: r.matches.reduce((s, m) => s + m.weight, 0),
    };
  }

  /** 융합 엔진용 */
  evidence() {
    const devs = [...this.devices.values()].map((r) => this.view(r));
    return { ran: this.devices.size > 0 || this.scanning, scanning: this.scanning, devices: devs.filter((d) => d.matches.length), total: devs.length };
  }
}
