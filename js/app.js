/**
 * CheatingGuard v1.0.0 — 앱 진입점 (UI, 화면 전환, 모듈 연결)
 * 2026@박주가리 교감
 */
import { runCapabilityCheck, updateCameraCapabilities, updateEntry, summarize, STATUS } from './capability-check.js';
import { GlassesDB, hex16 } from './database.js';
import { storage } from './storage.js';
import { BluetoothDetector, describeBleError } from './bluetooth-detector.js';
import { CameraManager, ProcessingClient, OpticalDetector, describeCameraError, drawOverlay, containRect } from './optical-detector.js';
import { VisionDetector, ModelRegistry, APPEARANCE_CHECKLIST, emissionHint } from './vision-detector.js';
import { SensorHub } from './sensor-detector.js';
import { evaluate } from './fusion-engine.js';
import { Notifier } from './notification.js';
import { SpycamDetector, rssiLevel, beepInterval, compilePatterns, matchBleIot } from './spycam-detector.js';
import { classifyDevice, priorityScore, filterDevices, HeadingSensor, DirectionFinder, compassName, CONFIDENCE_LABEL } from './radio-analyzer.js';
import { buildReview } from './integrated-review.js';
import { Finder, drawFinderOverlay, TIERS, ANGLE_GOAL } from './finder.js';
import { MagAnomaly } from './mag-anomaly.js';

export const VERSION = '1.5.0';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const pct = (v) => (v * 100).toFixed(0) + '%';

const S = {
  view: 'find', lastTool: 'optical', caps: [], settings: storage.loadSettings(), integrated: false, intToken: 0,
  wakeLock: null, verdict: null, swReg: null, deferredPrompt: null, cache: null,
  stillShown: false, stillSize: null, sheet: null, updateRequested: false, notified: new Set(),
};

const db = new GlassesDB();
const video = $('#video');
const camera = new CameraManager(video);
const proc = new ProcessingClient();
const optical = new OpticalDetector(camera, proc);
const vision = new VisionDetector(camera, proc);
const sensors = new SensorHub();
const ble = new BluetoothDetector(db);
const notifier = new Notifier();
const models = new ModelRegistry();
optical.motionState = () => sensors.motionState();
const heading = new HeadingSensor();
const spycam = new SpycamDetector({ camera, proc, ble, sensors, heading });
ble.extraCompanyIds = () => spycam.extraCompanyIds();
ble.extraUuids = () => spycam.extraUuids();
const finder = new Finder({ camera, proc, sensors, ble });
const TOOL_VIEWS = ['optical', 'vision', 'spycam', 'magscan'];
const magScan = new MagAnomaly(sensors);

// ---------------------------------------------------------------- 공통 UI
let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}
function setStatus(id, msg, err = false) {
  const el = $('#' + id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('err', !!err);
}
function saveSettings() { storage.saveSettings(S.settings); }

// ---------------------------------------------------------------- 화면 전환
const STAGE_SLOTS = { find: 'findStageSlot', home: 'homeStageSlot', optical: 'opticalStageSlot', vision: 'visionStageSlot', spycam: 'spycamStageSlot' };

function mountStage(view) {
  const slot = STAGE_SLOTS[view];
  if (!slot) return;
  const el = $('#' + slot), stage = $('#camStage');
  if (stage.parentElement !== el) {
    el.appendChild(stage);
    if (camera.active) video.play().catch(() => {});
  }
}

function updateStageVisibility() {
  const home = $('#homeStageSlot');
  home.hidden = !(S.view === 'home' && (camera.active || S.integrated));
}

async function showView(v) {
  if (v === 'tools') v = S.lastTool || 'optical';
  if (v === S.view) return;
  if (TOOL_VIEWS.includes(v)) S.lastTool = v;
  if (camera.active || S.stillShown || S.integrated) await stopCameraWork('화면을 전환하여 카메라와 플래시를 해제했습니다.');
  if (S.view === 'spycam' || S.view === 'ble') { stopBleBeep(); $('#chkBleBeep').checked = false; $('#chkBleBeep2').checked = false; }
  if (S.view === 'spycam') stopMag();
  if (S.view === 'ble') stopDirection();
  if (S.view === 'magscan') { magScan.stop(); stopMsBeep(); renderMagScan(); }
  S.view = v;
  for (const s of $$('.view')) s.classList.toggle('active', s.id === 'view-' + v);
  const navKey = TOOL_VIEWS.includes(v) ? 'tools' : v;
  for (const b of $$('.bottom-nav button')) b.classList.toggle('active', b.dataset.view === navKey);
  document.body.classList.remove('immersive');
  mountStage(v);
  updateStageVisibility();
  window.scrollTo(0, 0);
  if (v === 'ble') renderBle();
  if (v === 'vision') renderVision();
  if (v === 'spycam') renderSpycam();
  if (v === 'find') renderFind();
  if (v === 'magscan') renderMagScan();
}

async function stopCameraWork(reason) {
  const had = camera.active || S.integrated;
  if (S.integrated) await stopIntegrated(true);
  await optical.stop();
  vision.stopLed();
  spycam.stopAll();
  finder.stop(true); stopPulse();
  if (!$('#screenLight').hidden) screenLight.set(false, true);
  if (typeof magScan !== 'undefined') magScan.stop();
  stopBleBeep(); stopMag();
  if (!dirTimer) heading.stop();
  await camera.stop();
  hideStill();
  releaseWakeLock();
  if (had && reason) toast(reason);
  renderCameraButtons();
}

// ---------------------------------------------------------------- 카메라
camera.on((type) => {
  if (type === 'started') {
    const info = camera.info();
    updateCameraCapabilities(S.caps, info);
    renderCaps();
    $('#stageMsg').hidden = true;
    renderCameraButtons();
    const z = camera.zoomRange;
    $('#zoomRow').hidden = !z;
    if (z) { const r = $('#zoom'); r.min = z.min; r.max = z.max; r.step = z.step; r.value = camera.settings.zoom || z.min; $('#zoomVal').textContent = (+r.value).toFixed(1) + '×'; }
    $('#flashSupport').textContent = camera.hasTorch
      ? '이 카메라는 플래시 제어를 지원합니다. 스마트폰을 고정한 뒤 차분 분석을 시작하세요.'
      : '이 카메라·브라우저는 플래시 제어를 지원하지 않습니다. 일반 영상·정지 영상 분석을 사용하세요.';
    requestWakeLock();
  }
  if (type === 'stopped' || type === 'ended') {
    $('#stageMsg').hidden = S.stillShown;
    $('#stageMsg').textContent = '카메라가 꺼져 있습니다';
    renderCameraButtons();
    releaseWakeLock();
    if (type === 'ended') {
      optical.stop(); vision.stopLed(); spycam.stopAll();
      if (S.integrated) stopIntegrated(true);
      toast('카메라가 중단되었습니다. 다른 앱이 카메라를 사용 중이거나 권한이 변경되었을 수 있습니다.', 'alert');
    }
    renderOverlay();
  }
  updateStageVisibility();
});

async function startCamera() {
  try {
    $('#stageMsg').textContent = '카메라를 여는 중…';
    $('#stageMsg').hidden = false;
    hideStill();
    await camera.start();
    return true;
  } catch (e) {
    const msg = describeCameraError(e);
    $('#stageMsg').textContent = msg;
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) updateEntry(S.caps, 'getUserMedia', { status: 'error', works: false, detail: '카메라 권한 거부됨' });
    if (e && e.name === 'NotReadableError') updateEntry(S.caps, 'getUserMedia', { status: 'error', works: false, detail: '카메라를 열 수 없음 (다른 앱 사용 중 등)' });
    renderCaps();
    toast(msg, 'alert');
    return false;
  }
}

function renderCameraButtons() {
  const on = camera.active;
  $('#btnCamStart').disabled = on;
  $('#btnCamStop').disabled = !on;
  $('#btnCamSwitch').disabled = !on;
  const flashRunning = optical.running && optical.mode === 'flash' && !S.integrated;
  const spotRunning = optical.running && optical.mode === 'spots' && !S.integrated;
  $('#btnFlashStart').disabled = !on || !camera.hasTorch || flashRunning || S.integrated;
  $('#btnFlashStop').disabled = !flashRunning;
  $('#btnSpotStart').disabled = !on || spotRunning || S.integrated;
  $('#btnSpotStop').disabled = !spotRunning;
  $('#btnFreeze').disabled = !on && !S.stillShown;
  $('#btnFreeze').textContent = S.stillShown ? '실시간 영상으로 돌아가기' : '현재 화면 정지 분석';
  $('#btnVisCam').disabled = false;
  $('#btnVisCam').textContent = on ? '카메라 끄기' : '카메라 시작';
  $('#btnLedStart').disabled = !on || vision.running || S.integrated;
  $('#btnLedStop').disabled = !vision.running || S.integrated;
  $('#btnDark').disabled = !on;
  $('#btnSpyCam').textContent = on ? '카메라 끄기' : '후면 카메라 시작';
  $('#btnLensStart').disabled = !on || spycam.lensRunning || spycam.irRunning;
  $('#btnLensStop').disabled = !spycam.lensRunning;
  $('#btnIrTest').disabled = !on || spycam.irRunning || spycam.lensRunning;
  $('#btnIrStart').disabled = !on || spycam.irRunning || spycam.lensRunning;
  $('#btnIrStop').disabled = !spycam.irRunning;
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !S.wakeLock && document.visibilityState === 'visible') {
      S.wakeLock = await navigator.wakeLock.request('screen');
      updateEntry(S.caps, 'wakeLock', { works: true, detail: '화면 꺼짐 방지 작동 확인' });
      S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
    }
  } catch (_) { updateEntry(S.caps, 'wakeLock', { works: false, status: 'error', detail: '화면 꺼짐 방지 요청 실패 (절전 모드 등)' }); }
}
function releaseWakeLock() { try { S.wakeLock && S.wakeLock.release(); } catch (_) {} S.wakeLock = null; }

// ---------------------------------------------------------------- 정지 영상
function hideStill() {
  S.stillShown = false; S.stillSize = null;
  $('#stillCanvas').hidden = true;
  optical.still = null;
  if (!camera.active) $('#stageMsg').hidden = false;
}

async function showStillFrom(source, w, h) {
  const c = $('#stillCanvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(source, 0, 0, w, h);
  c.hidden = false;
  S.stillShown = true; S.stillSize = { w, h };
  $('#stageMsg').hidden = true;
  await analyzeStill();
}

async function analyzeStill() {
  if (!S.stillShown) return;
  const c = $('#stillCanvas');
  setStatus('opticalStatus', '정지 영상 분석 중…');
  try {
    const res = await optical.analyzeStill(c, c.width, c.height);
    setStatus('opticalStatus', `정지 영상 분석 완료 · 반사점 후보 ${res.items.length}개 · 렌즈 형태 후보 ${res.dark.length}개`);
    renderOptical();
    renderOverlay();
    scheduleFusion();
  } catch (e) { setStatus('opticalStatus', '정지 영상 분석 중 오류가 발생했습니다.', true); }
}

// ---------------------------------------------------------------- 오버레이
function renderOverlay() {
  const canvas = $('#overlay');
  const srcW = S.stillShown ? S.stillSize.w : video.videoWidth;
  const srcH = S.stillShown ? S.stillSize.h : video.videoHeight;
  if (S.view === 'find') { drawFinderOverlay(canvas, srcW || 3, srcH || 4, finder, minTierRank(), S.pulse || 0); return; }
  const layers = { roi: optical.roi };
  if (S.stillShown && optical.still) {
    layers.items = optical.still.items; layers.dark = optical.still.dark; layers.rejected = optical.still.rejected;
  } else if (camera.active) {
    if (S.view === 'optical' || S.view === 'home') {
      layers.tracks = optical.last ? optical.last.tracks : [];
      if (S.view === 'optical' && optical.last) layers.rejected = optical.last.rejected;
    }
    if (S.view === 'vision' || S.view === 'home') layers.leds = vision.leds;
    if (S.view === 'vision' && vision.dark) layers.dark = vision.dark.items;
    if (S.view === 'spycam') {
      layers.tracks = spycam.lens ? spycam.lens.tracks : [];
      layers.leds = spycam.ir;
    }
  }
  drawOverlay(canvas, srcW || 3, srcH || 4, layers);
}
window.addEventListener('resize', () => renderOverlay());

function onStageTap(ev) {
  if (S.view === 'find') { findTap(ev); return; }
  if (!camera.active && !S.stillShown) return;
  const stage = $('#camStage');
  const rect = stage.getBoundingClientRect();
  const srcW = S.stillShown ? S.stillSize.w : video.videoWidth, srcH = S.stillShown ? S.stillSize.h : video.videoHeight;
  const r = containRect(rect.width, rect.height, srcW, srcH);
  const nx = (ev.clientX - rect.left - r.x) / r.w, ny = (ev.clientY - rect.top - r.y) / r.h;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
  const side = 0.34 * Math.min(srcW, srcH);
  const w = Math.min(1, side / srcW), h = Math.min(1, side / srcH);
  const roi = { x: Math.min(1 - w, Math.max(0, nx - w / 2)), y: Math.min(1 - h, Math.max(0, ny - h / 2)), w, h };
  optical.roi = roi; vision.roi = roi; spycam.roi = roi;
  optical.flashTracker.reset(); optical.spotTracker.reset(); vision.led.reset(); spycam.lensTracker.reset(); spycam.irTracker.reset();
  toast('관심 영역을 지정했습니다. 이 영역을 집중 분석합니다.');
  renderOverlay();
  if (S.stillShown) analyzeStill();
}

// ---------------------------------------------------------------- 광학 화면
optical.onStatus = (m) => setStatus('opticalStatus', m, /오류|없습니다/.test(m));
optical.onUpdate = () => { renderOptical(); renderOverlay(); scheduleFusion(); if (S.integrated) renderHomeMode(); };

function renderOptical() {
  const still = S.stillShown && optical.still;
  const src = still ? optical.still : optical.last;
  const q = src && src.quality;
  const qEl = $('#opticalQuality');
  if (!q) qEl.innerHTML = '<span class="muted">측정 전</span>';
  else {
    const rows = [
      ['선명도(라플라시안)', q.sharpness], ['평균 밝기', q.brightness], ['포화 영역', pct(q.saturated)],
    ];
    if (q.gain != null) rows.push(['노출 보정 이득', q.gain], ['플래시 밝기 변화', (q.flashEffect >= 0 ? '+' : '') + pct(q.flashEffect)], ['정합 이동량', q.shiftPx + 'px']);
    if (!still && optical.last) rows.push(['분석 횟수', optical.last.cycles + '회']);
    rows.push(['분석 실행', proc.label]);
    if (src.roi || optical.roi) rows.push(['관심 영역', '지정됨']);
    qEl.innerHTML = rows.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  }
  const env = src ? src.env : null;
  $('#opticalEnv').innerHTML = env && env.issues.length ? env.issues.map((i) => `<li>⚠ ${esc(i)}</li>`).join('') : '';

  const list = $('#opticalList');
  let html = '';
  if (still) {
    if (!optical.still.items.length) html = '<li class="muted">이 영상에서 반사점 후보를 찾지 못했습니다. (렌즈가 없다는 뜻은 아닙니다)</li>';
    for (const c of optical.still.items) html += candLi(c, null);
    if (optical.still.dark.length) html += `<li><span class="pill">렌즈 형태</span>어두운 원형점 후보 ${optical.still.dark.length}개 (분홍 사각형, 참고용)</li>`;
    html += rejectedSummary(optical.still.rejected, optical.still.rejectedCount);
  } else if (optical.last) {
    const tr = optical.last.tracks;
    if (!tr.length) html = '<li class="muted">현재 반사점 후보가 없습니다.</li>';
    for (const t of tr.slice(0, 12)) html += candLi(t.last, t);
    html += rejectedSummary(optical.last.rejected, optical.last.rejectedCount);
  } else html = '<li class="muted">측정 전</li>';
  list.innerHTML = html;
}

function candLi(c, t) {
  const pos = `위치 ${(c.nx * 100).toFixed(0)}%, ${(c.ny * 100).toFixed(0)}%`;
  const pill = t ? (t.reproducible ? `<span class="pill alert">재현 ${t.hits}/${t.observed}</span>` : t.pending ? `<span class="pill warn">확인 중 ${t.hits}/${t.observed}</span>` : `<span class="pill">비재현 ${t.hits}/${t.observed}</span>`) : '<span class="pill warn">후보</span>';
  const vals = [`면적 ${c.area}px`, c.area >= 6 ? `원형도 ${c.circularity.toFixed(2)}` : '원형도 판정 불가(소형)', `주변 대비 ${c.contrast.toFixed(1)}배`];
  if (c.diffPeak != null) vals.push(`플래시 증가 ${Math.round(c.diffPeak)}`);
  else if (c.peak != null) vals.push(`최대 밝기 ${c.peak}`);
  vals.push(`반사 특징 점수 ${t ? t.featureScore : c.featureScore}`);
  return `<li>${pill}${esc(pos)}<span class="meta">${esc(vals.join(' · '))}</span></li>`;
}

function rejectedSummary(rej, count) {
  if (!count) return '';
  const by = {};
  for (const r of rej) by[r.reject] = (by[r.reject] || 0) + 1;
  const txt = Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ');
  return `<li class="muted">오탐 제거 규칙으로 제외된 반사 ${count}개<span class="meta">${esc(txt)}${count > rej.length ? ' 외' : ''}</span></li>`;
}

// ---------------------------------------------------------------- 영상 분석 화면
vision.onStatus = (m) => setStatus('visionStatus', m, /오류/.test(m));
vision.onUpdate = () => { if (S.view === 'vision') renderLeds(); renderOverlay(); scheduleFusion(); };

function renderLeds() {
  const el = $('#ledList');
  if (!vision.frames) { el.innerHTML = '<li class="muted">측정 전</li>'; return; }
  const reps = optical.evidence().reproducible;
  const items = vision.leds.filter((l) => l.candidate || l.seen >= 3).slice(0, 10);
  if (!items.length) { el.innerHTML = `<li class="muted">지속·점멸 발광점이 없습니다 (분석 프레임 ${vision.frames}개)</li>`; return; }
  el.innerHTML = items.map((l) => `<li>${l.candidate ? '<span class="pill alert">표시등 후보</span>' : '<span class="pill">관찰 중</span>'}${esc(l.colorName)} 발광점 · 위치 ${(l.nx * 100).toFixed(0)}%, ${(l.ny * 100).toFixed(0)}%
    <span class="meta">${esc(`유지 ${(l.durationMs / 1000).toFixed(1)}초 · 출현율 ${pct(l.presence)} · 점멸 전환 ${l.transitions}회 · ${l.blinking ? '점멸' : l.steady ? '지속' : '불규칙'} · 최대 밝기 ${l.peak}`)}</span>
    <span class="meta">${esc(emissionHint(l, reps))}</span></li>`).join('');
}

function renderDark() {
  const el = $('#darkList');
  if (!vision.dark) { el.innerHTML = '<li class="muted">측정 전</li>'; return; }
  el.innerHTML = vision.dark.items.length
    ? vision.dark.items.map((d) => `<li><span class="pill">규칙 기반</span>어두운 원형점 · 위치 ${(d.nx * 100).toFixed(0)}%, ${(d.ny * 100).toFixed(0)}%<span class="meta">면적 ${d.area}px · 원형도 ${d.circularity.toFixed(2)} · 주변 대비 ${d.darkRatio}배</span></li>`).join('')
    : '<li class="muted">렌즈 형태 후보가 없습니다.</li>';
}

function renderChecklist() {
  $('#checklist').innerHTML = APPEARANCE_CHECKLIST.map((c) => {
    const v = vision.checklist[c.id] || '';
    const opt = (val, label) => `<label><input type="radio" name="ck_${c.id}" value="${val}" ${v === val ? 'checked' : ''}> ${label}</label>`;
    return `<div class="ck-item"><p class="small">${esc(c.text)}</p><div class="seg">${opt('yes', '예')}${opt('no', '아니오')}${opt('unknown', '모름')}</div></div>`;
  }).join('');
}

function renderVision() {
  renderLeds(); renderDark();
  $('#modelStatus').innerHTML = models.status().map((m) => `<li><strong>${esc(m.label)}</strong> — ${esc(m.state)}<span class="meta">${esc(m.detail)}</span></li>`).join('');
}

// ---------------------------------------------------------------- 블루투스 화면
ble.onUpdate = () => { if (S.view === 'ble') { if (dirTimer) renderBleTracker(); else renderBle(); } if (S.view === 'spycam') { renderBleMeter(); spycam.onUpdate('ble'); } scheduleFusion(); };
ble.onStatus = (m) => setStatus('bleStatus', m);

function renderBleSupport() {
  const s = ble.support();
  const flagState = $('#bleFlagState');
  if (flagState) {
    $('#bleFlagCard').hidden = !s.api;
    flagState.innerHTML = s.leScan || s.watchAds ? '<span class="pill ok">켜짐 ✓</span> 실험 기능이 켜져 있습니다. ‘주변 광고 스캔’과 신호 세기 기능을 쓸 수 있습니다.' : '<span class="pill warn">꺼짐</span> 아직 실험 기능이 꺼져 있습니다.';
  }
  let t;
  if (!s.api) t = '이 브라우저는 Web Bluetooth를 지원하지 않습니다 (아이폰 Safari, 일부 브라우저). 광학 탐지와 영상 분석을 사용하세요.';
  else {
    t = '기기 선택 검색: 사용 가능';
    t += s.watchAds ? ' · 선택 기기 광고 수신(RSSI): 실험적 지원' : ' · 광고 패킷·RSSI 수신: 미지원 (기기명 분석만 제공)';
    t += s.leScan ? ' · 주변 광고 스캔: 실험적 지원' : ' · 주변 광고 스캔: 미지원';
  }
  $('#bleSupport').textContent = t;
  $('#btnBleSelect').disabled = !s.requestDevice;
  $('#btnBleSuspect').disabled = !s.requestDevice;
  $('#btnBleScan').disabled = !s.leScan || ble.scanning;
  $('#btnBleStop').disabled = !ble.scanning;
}

/** 수신한 블루투스 기기를 분류·우선순위와 함께 반환 */
function radioItems() {
  const out = [];
  for (const rec of ble.devices.values()) {
    const v = ble.view(rec);
    const iot = matchBleIot(spycam.db, { name: rec.name, companyIds: [...rec.companyIds], uuids: [...rec.uuids] });
    const category = classifyDevice(v, iot);
    const priority = priorityScore(v, category, { baselineKeys: ble.baselineKeys, baselineAt: ble.baselineAt });
    out.push(Object.assign(v, { category, priority, iot }));
  }
  return out.sort((x, y) => (y.priority.score - x.priority.score) || ((y.rssiFiltered ?? -200) - (x.rssiFiltered ?? -200)));
}

function renderBle() {
  renderBleSupport();
  renderBleTracker();
  const all = radioItems();
  const el = $('#bleList');
  $('#btnBaselineClear').disabled = !ble.baselineAt;
  $('#baselineInfo').textContent = ble.baselineAt
    ? `기준 상태 저장됨 (${fmtTime(ble.baselineAt)}, 기기 ${ble.baselineKeys.size}대). 이후 새로 나타난 기기에 ‘신규’ 표시가 붙습니다.`
    : '의심 장소에 들어가기 전(또는 모든 사람이 휴대폰을 끈 상태)에서 기준을 저장하면, 이후 새로 나타나는 기기만 골라 볼 수 있습니다.';
  if (!all.length) { el.innerHTML = '<div class="card muted small">아직 검색한 기기가 없습니다.</div>'; return; }
  const shown = filterDevices(all, { hidePersonal: $('#fltPersonal').checked, onlyNew: $('#fltNew').checked, nearOnly: $('#fltNear').checked });
  const limit = S.settings.showAllBle ? shown : shown.slice(0, 20);
  const hiddenPersonal = $('#fltPersonal').checked ? all.filter((d) => d.category.key === 'personal').length : 0;
  const card = (d) => {
    const ms = d.matches.map((m) => `<li><span class="pill ${m.verified ? 'ok' : 'warn'}">${m.verified ? '확인된 자료' : '미검증'}</span>${esc(m.label)}${m.camera === 'yes' ? ' <span class="pill alert">카메라 탑재 모델</span>' : m.camera === 'no' ? ' <span class="pill">카메라 없는 모델</span>' : ''}${m.note ? `<span class="meta">${esc(m.note)}</span>` : ''}</li>`).join('');
    const iots = d.iot.map((m) => `<li><span class="pill warn">IoT</span>${esc(m.label)}<span class="meta">${esc(m.note || '')}</span></li>`).join('');
    const g = [];
    g.push(['제조사 ID', d.companyIds.length ? d.companyIds.map((c) => c.id + (c.name ? ` (${c.name})` : '')).join(', ') : (d.advCount ? '없음' : '광고 미수신')]);
    g.push(['RSSI 최근/필터', d.rssiLast != null ? `${d.rssiLast} / ${d.rssiFiltered} dBm` : '확보 불가']);
    g.push(['신호 추세', d.trend.state + (d.trend.slope != null ? ` (${d.trend.slope} dB/s)` : '')]);
    if (d.txPower != null) g.push(['Tx Power', d.txPower + ' dBm']);
    if (d.distance) g.push(['거리 추정(제한적)', `약 ${d.distance.min}~${d.distance.max} m`]);
    g.push(['관측 시간', d.priority.presenceSec >= 60 ? `${Math.round(d.priority.presenceSec / 60)}분` : `${d.priority.presenceSec}초`], ['최근 관측', fmtTime(d.lastSeen)]);
    const tone = d.category.key === 'glasses' ? 'alert' : d.category.key === 'personal' ? '' : 'warn';
    return `<div class="dev ${d.priority.score >= 25 ? 'matched' : ''}" data-key="${esc(d.key)}">
      <div class="dev-head"><strong>${esc(d.name)}</strong><span class="prio">우선순위 ${d.priority.score}</span></div>
      <p><span class="pill ${tone}">${esc(d.category.label)}</span>${d.priority.isNew ? '<span class="pill alert">신규</span>' : ''}${spycam.trackKey === d.key ? '<span class="pill ok">추적 중</span>' : ''}<span class="tiny muted">${esc(d.category.detail)}</span></p>
      ${ms || iots ? `<ul class="list">${ms}${iots}</ul>` : ''}
      ${d.priority.reasons.length ? `<ul class="reasons">${d.priority.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      <div class="grid">${g.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('')}</div>
      ${d.manufacturerData.length ? `<p class="mono">${d.manufacturerData.map((m) => `${m.id}: ${m.hex}`).map(esc).join('<br>')}</p>` : ''}
      ${d.watchError ? `<p class="tiny muted">${esc(d.watchError)}</p>` : ''}
      ${d.history.length > 1 ? '<canvas class="spark"></canvas>' : ''}
      <div class="btn-row"><button class="btn small" data-track="${esc(d.key)}" type="button">${spycam.trackKey === d.key ? '추적 중' : '이 기기 추적·방향 찾기'}</button>${d.rssiFiltered != null ? `<button class="btn small ghost" data-baseline="${esc(d.key)}" type="button">${d.baseline != null ? `1 m 기준 ${d.baseline} dBm` : '1 m 기준값 설정'}</button>` : ''}</div>
    </div>`;
  };
  let html = `<p class="tiny muted">확인한 기기 ${all.length}대 · 표시 ${limit.length}대${hiddenPersonal ? ` · 개인 휴대기기 ${hiddenPersonal}대 숨김` : ''}${shown.length > limit.length ? ` · ${shown.length - limit.length}대 더 있음` : ''} · 의심 우선순위 순</p>`;
  html += limit.length ? limit.map(card).join('') : '<div class="card muted small">조건에 맞는 기기가 없습니다. 목록 정리 조건을 바꿔 보세요.</div>';
  html += '<p class="tiny muted">우선순위 점수는 정렬용 규칙 점수이며 확률이 아닙니다. 신호 강도는 실제 거리와 같지 않습니다. 애플 회사 번호는 iBeacon 등 애플이 아닌 기기도 사용할 수 있습니다.</p>';
  el.innerHTML = html;
  for (const c of $$('.dev', el)) {
    const sp = $('.spark', c);
    if (!sp) continue;
    const d = limit.find((x) => x.key === c.dataset.key);
    if (d) drawSpark(sp, d.history);
  }
}

// ---- 추적·방향 찾기
const dirFinder = new DirectionFinder(12);
let dirTimer = null, dirLastT = 0, dirStarted = 0;
S.dirResult = null;

function trackedName() { const d = spycam.trackedView(); return d ? d.name : null; }

function renderBleTracker() {
  const d = spycam.trackedView();
  $('#trackCard').hidden = !d;
  if (!d) return;
  $('#trkName').textContent = d.name;
  $('#trkVal').textContent = d.rssiFiltered != null ? `${d.rssiFiltered} dBm` : '신호 미수신';
  $('#trkFill').style.width = (rssiLevel(d.rssiFiltered) * 100).toFixed(0) + '%';
  $('#trkTrend').textContent = d.rssiFiltered == null
    ? (d.watchError || '이 브라우저에서는 신호 세기를 받을 수 없어 방향 찾기를 할 수 없습니다. (Android Chrome 실험 기능 필요 — 사용설명서 참고)')
    : `추세: ${d.trend.state}${d.trend.state === '증가' ? ' (가까워지는 중일 수 있음)' : d.trend.state === '감소' ? ' (멀어지는 중일 수 있음)' : ''} · 최근 관측 ${fmtTime(d.lastSeen)}`;
  $('#btnDirStart').disabled = !!dirTimer || d.rssiCount === 0;
  $('#btnDirStop').disabled = !dirTimer;
  drawPolar($('#dirCanvas'), dirTimer ? dirFinder.result() : S.dirResult, dirTimer ? heading.heading : null);
}

async function startDirection() {
  const rec = spycam.trackKey && ble.devices.get(spycam.trackKey);
  if (!rec) return;
  const ok = await heading.start();
  if (!ok) { setStatus('dirResult', heading.state === 'denied' ? '방향 센서 권한이 거부되었습니다.' : '이 기기는 방향 센서를 지원하지 않습니다. 걸어 다니며 신호가 커지는 쪽을 찾으세요.', true); return; }
  dirFinder.reset(); dirLastT = 0; dirStarted = Date.now(); S.dirResult = null;
  setStatus('dirResult', '천천히 한 바퀴 도세요… (최대 40초)');
  dirTimer = setInterval(() => {
    const r = ble.devices.get(spycam.trackKey);
    if (!r) { stopDirection(); return; }
    if (heading.state === 'no-data') { stopDirection('나침반 값이 들어오지 않습니다. 이 기기·브라우저에서는 방향 찾기를 할 수 없습니다.'); return; }
    const last = r.rssi.raw[r.rssi.raw.length - 1];
    if (last && last.t > dirLastT && heading.fresh) { dirFinder.add(heading.heading, last.v, last.t); dirLastT = last.t; }
    const res = dirFinder.result();
    renderBleTracker();
    const done = res.ready && res.coverage >= 11;
    if (done || Date.now() - dirStarted > 40000) stopDirection();
    else setStatus('dirResult', `측정 중 · 방위 구간 ${res.coverage}/12 · 신호 표본 ${res.samples}개 · 현재 ${compassName(heading.heading)}쪽`);
  }, 150);
  renderBleTracker();
}

function stopDirection(msg) {
  if (!dirTimer) return;
  clearInterval(dirTimer); dirTimer = null;
  heading.stop();
  const res = dirFinder.result();
  if (msg) setStatus('dirResult', msg, true);
  else if (!res.ready) setStatus('dirResult', `방위 구간이 부족합니다 (${res.coverage}/12). 더 천천히 한 바퀴 돌아 주세요.`, true);
  else {
    S.dirResult = Object.assign({ target: trackedName(), at: Date.now() }, res);
    setStatus('dirResult', `추정 방향: 약 ${res.compass}쪽 (방위 ${res.bearing}°, ±${res.spread / 2}°) · 신호 차이 ${res.contrast} dB · ${CONFIDENCE_LABEL[res.confidence]}${res.confidence === 'low' ? ' — 다른 위치에서 다시 측정하세요' : ''}`, res.confidence === 'low');
  }
  renderBleTracker(); scheduleFusion();
}

function drawPolar(canvas, res, live) {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth || 260;
  canvas.width = W * dpr; canvas.height = W * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = W / 2, R = W / 2 - 22;
  ctx.clearRect(0, 0, W, W);
  ctx.strokeStyle = '#1d3a2c'; ctx.lineWidth = 1;
  for (const k of [0.33, 0.66, 1]) { ctx.beginPath(); ctx.arc(c, c, R * k, 0, 7); ctx.stroke(); }
  ctx.fillStyle = '#8fa89b'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  [['북', 0], ['동', 90], ['남', 180], ['서', 270]].forEach(([t, a]) => { const r = a * Math.PI / 180; ctx.fillText(t, c + Math.sin(r) * (R + 12), c - Math.cos(r) * (R + 12)); });
  if (res && res.sectors) {
    const vals = res.sectors.filter((v) => v != null);
    if (vals.length) {
      const mx = Math.max(...vals), mn = Math.min(...vals);
      const n = res.sectors.length, w = Math.PI * 2 / n;
      res.sectors.forEach((v, i) => {
        if (v == null) return;
        const k = 0.15 + 0.85 * (mx === mn ? 1 : (v - mn) / (mx - mn));
        ctx.beginPath(); ctx.moveTo(c, c);
        ctx.arc(c, c, R * k, -Math.PI / 2 + i * w, -Math.PI / 2 + (i + 1) * w);
        ctx.closePath();
        ctx.fillStyle = `rgba(46,224,138,${0.15 + 0.5 * k})`; ctx.fill();
      });
    }
    if (res.ready && res.bearing != null) {
      const a = res.bearing * Math.PI / 180;
      ctx.strokeStyle = '#ff5d5d'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.sin(a) * R, c - Math.cos(a) * R); ctx.stroke();
    }
  }
  if (live != null) {
    const a = live * Math.PI / 180;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.sin(a) * R * 0.9, c - Math.cos(a) * R * 0.9); ctx.stroke(); ctx.setLineDash([]);
  }
}

async function trackDevice(key) {
  spycam.trackKey = key;
  S.dirResult = null; dirFinder.reset();
  renderBle();
  $('#trackCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drawSpark(canvas, hist) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 56;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vals = hist.flatMap((p) => [p[1], p[2]]).filter((v) => v != null);
  const lo = Math.min(...vals) - 3, hi = Math.max(...vals) + 3;
  const t0 = hist[0][0], t1 = hist[hist.length - 1][0] || t0 + 1;
  const X = (t) => 4 + (w - 8) * (t - t0) / Math.max(1, t1 - t0);
  const Y = (v) => h - 4 - (h - 8) * (v - lo) / Math.max(1, hi - lo);
  ctx.fillStyle = 'rgba(143,168,155,0.6)';
  for (const p of hist) { ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 1.6, 0, 7); ctx.fill(); }
  ctx.strokeStyle = '#2ee08a'; ctx.lineWidth = 2; ctx.beginPath();
  let first = true;
  for (const p of hist) { if (p[2] == null) continue; const x = X(p[0]), y = Y(p[2]); if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y); }
  ctx.stroke();
  ctx.fillStyle = '#8fa89b'; ctx.font = '10px system-ui';
  ctx.fillText(`${Math.round(hi)} dBm`, 6, 12); ctx.fillText(`${Math.round(lo)} dBm`, 6, h - 6);
}

async function bleSelect(mode = 'all') {
  setStatus('bleStatus', mode === 'suspect' ? '의심 기기만 보이는 선택창을 여는 중…' : '기기 선택창을 여는 중…');
  try {
    const rec = await ble.selectDevice(mode);
    setStatus('bleStatus', rec.matches.length ? `‘${rec.name || '이름 없음'}’ — 데이터베이스 일치 항목 ${rec.matches.length}개` : `‘${rec.name || '이름 없음'}’ — 데이터베이스와 일치하는 항목이 없습니다`);
    updateEntry(S.caps, 'btRequestDevice', { works: true, status: 'supported', detail: '기기 선택 작동 확인' });
  } catch (e) {
    setStatus('bleStatus', e && e.name === 'NotFoundError' && mode === 'suspect' ? '선택창에 의심 기기가 없었거나 선택을 취소했습니다. (의심 기기가 없다는 뜻은 아닙니다 — 신호를 보내지 않는 기기는 보이지 않습니다)' : describeBleError(e), true);
  }
  renderBle(); scheduleFusion();
}

async function bleScan() {
  try { await ble.startLEScan(); updateEntry(S.caps, 'btRequestLEScan', { works: true, detail: '광고 스캔 작동 확인 (실험적)' }); }
  catch (e) { setStatus('bleStatus', describeBleError(e), true); updateEntry(S.caps, 'btRequestLEScan', { works: false, detail: '스캔 시작 실패' }); }
  renderBle();
}

// ---------------------------------------------------------------- 통합 탐지
function renderHomeMode() {
  let m = '대기';
  if (S.integrated) {
    const parts = [];
    if (camera.active) parts.push(camera.hasTorch ? '플래시 차분' : '일반 영상', '표시등');
    if (ble.scanning) parts.push('BLE 스캔');
    if (sensors.motion.receiving) parts.push('센서');
    m = '통합 탐지 · ' + (parts.join(' + ') || '준비 중');
  } else if (optical.running) m = optical.mode === 'flash' ? '플래시 차분 분석' : '일반 영상 분석';
  else if (vision.running) m = '표시등 추적';
  else if (camera.active) m = '카메라 실행 중';
  $('#homeMode').textContent = m;
}

async function startIntegrated() {
  if (S.integrated) return;
  notifier.unlock();
  S.integrated = true;
  const token = ++S.intToken;
  $('#btnIntStart').disabled = true; $('#btnIntStop').disabled = false;
  renderHomeMode();
  const s = ble.support();
  const hints = [];
  if (s.leScan) { try { await ble.startLEScan(); } catch (e) { hints.push('BLE 광고 스캔을 시작하지 못했습니다: ' + describeBleError(e)); } }
  if (!s.api) hints.push('이 브라우저는 블루투스 탐지를 지원하지 않아 카메라와 센서만 사용합니다.');
  else if (!s.leScan) hints.push('블루투스 검색은 브라우저 보안 정책상 블루투스 탭의 ‘기기 선택 검색’으로 따로 실행해 주세요.');
  await sensors.startAll();
  heading.start();
  if (token !== S.intToken) return;
  mountStage('home');
  S.view === 'home' && ($('#homeStageSlot').hidden = false);
  const ok = await startCamera();
  if (token !== S.intToken) return;
  if (!ok) hints.push('카메라를 사용할 수 없어 광학·영상 분석을 건너뜁니다.');
  else hints.push(camera.hasTorch ? '스마트폰을 고정하고 대상 안경테가 화면 중앙에 오게 하세요. 플래시가 약 4초마다 켜집니다.' : '이 기기는 플래시 제어를 지원하지 않아 일반 영상 분석을 사용합니다.');
  $('#homeHint').textContent = hints.join(' ');
  updateStageVisibility(); renderHomeMode(); renderCameraButtons();
  if (ok) runIntegratedLoop(token);
}

async function runIntegratedLoop(token) {
  const alive = () => S.integrated && token === S.intToken && camera.active;
  optical.mode = camera.hasTorch ? 'flash' : 'spots';
  optical.running = true; optical.cycles = 0;
  optical.flashTracker.reset(); optical.spotTracker.reset();
  vision.led.reset(); vision.frames = 0;
  const optToken = optical._loopToken;
  while (alive()) {
    const t0 = performance.now();
    let i = 0;
    while (alive() && performance.now() - t0 < 2400) {
      const f0 = performance.now();
      try {
        const f = camera.grab({ roi: vision.roi, maxSide: 480 });
        if (f) await vision.ledOnce(null, f);
        if (!camera.hasTorch && i % 2 === 0) await optical.spotOnce(null);
      } catch (_) {}
      i++;
      await sleep(Math.max(40, 200 - (performance.now() - f0)));
    }
    if (alive() && camera.hasTorch) {
      try { await optical.flashCycle(optToken); } catch (_) {}
    }
    renderHomeMode();
  }
}

async function stopIntegrated(silent) {
  if (!S.integrated) return;
  S.integrated = false; S.intToken++;
  await optical.stop();
  vision.stopLed();
  ble.stopLEScan();
  sensors.stop();
  if (!dirTimer) heading.stop();
  await camera.stop();
  releaseWakeLock();
  $('#btnIntStart').disabled = false; $('#btnIntStop').disabled = true;
  $('#homeHint').textContent = silent ? '측정이 중단되었습니다. 결과는 마지막 측정값 기준입니다.' : '탐지를 중지했습니다. 아래 결과는 마지막 측정값 기준입니다.';
  renderHomeMode(); updateStageVisibility(); renderCameraButtons(); scheduleFusion();
}

// ---------------------------------------------------------------- 판단 결과
let fusionTimer = null;
function scheduleFusion() {
  if (fusionTimer) return;
  fusionTimer = setTimeout(() => { fusionTimer = null; runFusion(); }, 400);
}

function runFusion() {
  const sum = summarize(S.caps);
  const input = {
    support: { ble: sum.ble, camera: sum.camera, torch: camera.hasTorch },
    ble: ble.evidence(), optical: optical.evidence(), vision: vision.evidence(),
    sensors: sensors.environment(), sameTarget: $('#chkSameTarget').checked,
  };
  S.verdict = evaluate(input);
  renderVerdict();
  maybeNotify(S.verdict, input);
  renderReview(sum);
}

function renderReview(sum) {
  const bs = ble.support();
  const spy = spycam.evaluate();
  const spyEv = spycam.evidence();
  const lensEnv = spycam.lens && spycam.lens.env ? spycam.lens.env.issues : [];
  const r = buildReview({
    glasses: S.verdict, spy,
    support: { camera: sum.camera, ble: sum.ble, bleRssi: bs.watchAds || bs.leScan, torch: camera.hasTorch, heading: typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && heading.state !== 'unsupported' && heading.state !== 'denied' && heading.state !== 'no-data' },
    optical: optical.evidence(), vision: vision.evidence(), spyEv,
    finder: finder.evidence(), mag: magScan.evidence(),
    radio: { ran: ble.devices.size > 0, items: radioItems(), direction: S.dirResult, targetName: S.dirResult ? S.dirResult.target : trackedName() },
    env: { issues: [...(S.verdict ? S.verdict.envIssues : []), ...lensEnv] },
  });
  S.review = r;
  $('#reviewCard').className = 'card verdict tone-' + r.tone;
  $('#reviewLevel').textContent = r.overall;
  $('#reviewCounts').textContent = `점검 요인 ${r.counts.total}개 중 근거 있음 ${r.counts.found}개 · 미실행 ${r.counts.notrun}개 · 스마트 글라스: ${S.verdict ? S.verdict.level : '-'} · 몰래카메라: ${spy.level}`;
  $('#reviewMatches').innerHTML = r.matches.map((m) => `<div class="match">◎ ${esc(m.text)}</div>`).join('');
  let g = '';
  $('#factorBody').innerHTML = r.factors.map((x) => {
    const head = x.group !== g ? (g = x.group) : '';
    return `<tr><td>${esc(head)}</td><td>${esc(x.name)}</td><td><span class="pill st-${x.status}">${esc(x.label)}</span> ${esc(x.detail)}${x.action && x.status !== 'found' ? `<span class="act">→ ${esc(x.action)}</span>` : ''}</td></tr>`;
  }).join('');
  $('#reviewSteps').innerHTML = r.steps.length ? r.steps.map((t) => `<li>${esc(t)}</li>`).join('') : '<li class="muted">추가로 할 일이 없습니다.</li>';
  $('#reviewNotes').innerHTML = r.notes.map((n) => `<li>${esc(n)}</li>`).join('');
}

function renderVerdict() {
  const v = S.verdict;
  if (!v) return;
  const card = $('#verdictCard');
  card.className = 'card verdict tone-' + v.tone;
  $('#verdictLevel').textContent = v.level;
  $('#verdictScore').textContent = v.score;
  $('#evidenceList').innerHTML = v.evidence.length
    ? v.evidence.map((e) => `<li><span class="pill">${esc(e.source)}</span>${esc(e.text)} <span class="pill ${e.points ? 'warn' : ''}">+${e.points}</span>${e.note ? `<span class="meta">${esc(e.note)}</span>` : ''}</li>`).join('')
    : '<li class="muted">아직 탐지 근거가 없습니다.</li>';
  $('#verdictNotes').innerHTML = v.notes.map((n) => `<li>${esc(n)}</li>`).join('');
  $('#statCandidates').textContent = v.candidateCount;
  $('#statReview').textContent = v.reviewCount;
  $('#reviewList').innerHTML = v.reviewItems.length ? v.reviewItems.map((r) => `<li>${esc(r)}</li>`).join('') : '<li class="muted">없음</li>';
  $('#moduleList').innerHTML = v.modules.map((m) => `<li><strong>${esc(m.name)}</strong> <span class="pill ${m.state === '측정함' ? 'ok' : ''}">${esc(m.state)}</span><span class="meta">${esc(m.detail)}</span></li>`).join('');
  $('#envList').innerHTML = v.envIssues.map((i) => `<li>⚠ ${esc(i)}</li>`).join('');
  $('#saveRow').hidden = !S.settings.recordEnabled || v.levelKey === 'unavailable';
}

function maybeNotify(v, input) {
  if (!S.settings.alertsEnabled) return;
  const optRep = (input.optical.reproducible || []).length > 0;
  if (v.rank < 4 && !(v.rank === 3 && optRep)) return;
  const key = v.levelKey + '|' + (v.evidence[0] ? v.evidence[0].source + v.evidence[0].points : '');
  const repeat = S.notified.has(key);
  if (notifier.notify(key, `${v.level} — ${v.evidence[0] ? v.evidence[0].text : ''}`, { repeat })) S.notified.add(key);
}
notifier.onShow = (msg, kind) => toast(`[${kind}] ${msg}`, 'alert');

async function saveRecord() {
  const v = S.verdict;
  if (!v || !S.settings.recordEnabled) return;
  const oe = optical.evidence();
  const modelIds = new Set();
  for (const e of v.evidence) for (const id of e.models || []) modelIds.add(id);
  const names = [...modelIds].map((id) => (db.data.models.find((m) => m.id === id) || {}).model).filter(Boolean);
  const rec = {
    at: new Date().toISOString(),
    methods: v.modules.filter((m) => m.state === '측정함').map((m) => m.name),
    level: v.level, score: v.score,
    candidateModels: names,
    evidence: v.evidence.map((e) => ({ source: e.source, text: e.safeText || e.text, points: e.points })),
    measurements: {
      optical: oe.quality ? Object.assign({ mode: oe.mode, cycles: oe.cycles, reproducible: oe.reproducible.length }, oe.quality) : null,
      ble: ble.evidence().devices.map((d) => ({ rssiFiltered: d.rssiFiltered, txPower: d.txPower, companyIds: d.companyIds.map((c) => c.id) })),
      leds: vision.evidence().ledCandidates.length,
    },
    quality: { environmentIssues: v.envIssues, motion: sensors.motionState(), lux: sensors.light.lux },
    userConfirm: $('#userConfirm').value,
    appVersion: VERSION, dbVersion: db.version,
  };
  try { await storage.add('logs', rec); toast('탐지 결과를 이 기기에 기록했습니다.'); }
  catch (e) { toast(e.message || '기록 저장에 실패했습니다.', 'alert'); }
}



// ---------------------------------------------------------------- 찾기 화면 (v1.4)
const FIND_DEFAULTS = { light: 'auto', sensitivity: 'high', darkExposure: false, torchConfirm: true, minTier: 'yellow', maxSide: 1280, sound: true };
function findOpts() { return Object.assign({}, FIND_DEFAULTS, S.settings.find || {}); }
function minTierRank() { return (TIERS[findOpts().minTier] || TIERS.yellow).rank; }
let pulseTimer = null;
function startPulse() { if (pulseTimer) return; pulseTimer = setInterval(() => { S.pulse = (S.pulse || 0) + 0.35; if (S.view === 'find' && finder.cands.some((c) => c.tier && c.tier.key === 'red')) renderOverlay(); }, 120); }
function stopPulse() { clearInterval(pulseTimer); pulseTimer = null; }

let findTimer = null;
finder.onUpdate = () => {
  renderOverlay();
  if (findTimer) return;
  findTimer = setTimeout(() => { findTimer = null; if (S.view === 'find') renderFind(); scheduleFusion(); }, 250);
};
finder.onStatus = (m) => { S.findStatus = m; if (S.view === 'find') renderFind(); };
finder.onRed = (c) => {
  toast(`가능성 높은 후보 ${c.id}번을 찾았습니다 (빨간 원).`, 'alert');
  if (findOpts().sound) { notifier.beep(); notifier.vibrate([200, 100, 200]); }
};

function findTap(ev) {
  if (!camera.active) return;
  const rect = $('#camStage').getBoundingClientRect();
  const r = containRect(rect.width, rect.height, video.videoWidth, video.videoHeight);
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  let best = null, bd = 48;
  for (const c of finder.cands) {
    if (!c.tier || c.offscreen) continue;
    const d = Math.hypot(r.x + c.nx * r.w - px, r.y + c.ny * r.h - py);
    if (d < bd) { bd = d; best = c; }
  }
  if (best) { finder.lock(best.id); toast(`후보 ${best.id}번을 선택했습니다. 안내에 따라 확인하세요.`); }
  renderFind();
}

function renderFind() {
  const o = findOpts();
  const bs = ble.support();
  const rxDevices = [...ble.devices.values()].filter((r) => r.rssi.count > 0 && Date.now() - r.lastSeen < 10000).length;
  const chips = [];
  chips.push(finder.running ? (finder.lightKind === 'screen' ? ['ok', '화면 빛 사용'] : finder.torch ? ['ok', '손전등 켜짐'] : ['warn', '빛 제어 불가']) : ['', '빛 꺼짐']);
  if (finder.running) chips.push(finder.dark ? ['ok', '노출 낮춤'] : ['', o.darkExposure ? '노출 조절 미지원' : '노출 기본']);
  const ms = sensors.motionState();
  chips.push(ms === 'moving' ? ['warn', '흔들림 큼'] : ms === 'stable' ? ['ok', '안정'] : ['', '흔들림 정보 없음']);
  chips.push(rxDevices ? ['ok', `전파 수신 ${rxDevices}대`] : bs.watchAds || bs.leScan ? ['', '전파 미수신'] : ['', '전파 세기 미지원']);
  if (finder.running && finder.quality) chips.push([finder.quality.brightness > 150 ? 'warn' : '', `밝기 ${finder.quality.brightness}${finder.quality.brightness > 150 ? ' (불을 끄세요)' : ''}`]);
  $('#fChips').innerHTML = chips.map(([c, t]) => `<span class="chip ${c}">${esc(t)}</span>`).join('');
  const g = finder.guide();
  $('#fStep').textContent = g.step || 1;
  $('#fGuideText').textContent = S.findStatus && finder.running && g.step <= 1 ? S.findStatus : g.text;
  $('#btnFindStart').disabled = finder.running;
  $('#btnFindStop').disabled = !finder.running && !camera.active;
  const cnt = finder.counts();
  $('#fCounts').textContent = `높음 ${cnt.red} · 중간 ${cnt.orange} · 낮음 ${cnt.yellow}${finder.frames ? ` · 분석 ${finder.frames}프레임` : ''}`;
  const minR = minTierRank();
  const list = finder.cands.filter((c) => c.tier && (c.tier.rank >= minR || c.tier.key === 'excluded')).sort((a, b) => (b.tier.rank - a.tier.rank) || (b.score - a.score)).slice(0, 12);
  $('#fList').innerHTML = list.length ? list.map((c) => `<div class="cand t-${c.tier.key}" data-cand="${c.id}">
      <div class="cbody"><div class="ctitle tc-${c.tier.key}">${c.id}번 · ${esc(c.tier.label)}${finder.locked === c.id ? ' · 선택됨' : ''}${c.offscreen ? ' · 화면 밖' : ''}</div>
      <div class="cmeta">반복 ${c.hits}회 · 손전등 반응 ${c.torchYes}/${c.torchYes + c.torchNo} · 각도 ${Math.round(c.spanDeg)}° · 대비 ${c.ratio}배 · 크기 ${c.area}px${c.radio ? ` · 전파 ${c.radio.linked ? '연결 +' + c.radio.delta + 'dB' : '연결 안 됨'}` : ''}</div></div>
      <div class="cscore tc-${c.tier.key}">${c.tier.key === 'excluded' ? '—' : c.score}</div></div>`).join('')
    : `<p class="muted small">${finder.running ? '조건에 맞는 후보가 없습니다. 천천히 계속 훑어 보세요.' : '아직 후보가 없습니다.'}</p>`;
  // 선택한 후보 단계
  const L = finder.lockedCand();
  $('#fLock').hidden = !L;
  if (L) {
    $('#fLockTitle').textContent = `선택한 후보 ${L.id}번 — ${L.tier.label}`;
    $('#fLockTitle').style.color = L.tier.color;
    const step = (cls, t) => `<li class="${cls}">${esc(t)}</li>`;
    const torchState = !finder.torch ? 'bad' : L.torchYes >= 2 ? 'done' : L.torchNo >= 2 ? 'bad' : 'now';
    const A = finder.approach;
    $('#fChecks').innerHTML = [
      step(L.hits >= 3 ? 'done' : 'now', `① 같은 자리에서 반복 반짝임 (${L.hits}회)`),
      step(torchState, `② 손전등을 끄면 사라짐 (${L.torchYes}/${L.torchYes + L.torchNo}회)${finder.torch ? '' : ' — 이 기기는 손전등 제어 불가'}`),
      step(L.spanDeg >= ANGLE_GOAL ? 'done' : 'now', `③ 여러 각도에서도 보임 (${Math.round(L.spanDeg)}° / ${ANGLE_GOAL}°)`),
      step(L.radio ? (L.radio.linked ? 'done' : 'bad') : (A && A.active ? 'now' : ''), `④ 다가갈 때 전파 신호 증가 ${L.radio ? (L.radio.linked ? `(${L.radio.name} +${L.radio.delta} dB)` : '(뚜렷한 증가 없음)') : rxDevices ? '' : '(전파 신호 수신 필요)'}`),
    ].join('');
    $('#fAngleFill').style.width = Math.min(100, L.spanDeg / ANGLE_GOAL * 100).toFixed(0) + '%';
    $('#btnApproach').disabled = !!(A && A.active) || !rxDevices;
    $('#btnArrive').disabled = !(A && A.active);
    $('#fReasons').innerHTML = (L.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('');
  }
  $('#fRadio').textContent = rxDevices
    ? `블루투스 신호 ${rxDevices}대 수신 중. 후보를 선택한 뒤 ‘다가가며 전파 확인’으로 어느 기기 신호가 강해지는지 확인합니다.`
    : bs.leScan ? '주변 전파 스캔을 시작하면 다가갈 때 신호 변화를 함께 확인할 수 있습니다.'
    : bs.watchAds ? '전파 탭에서 의심 기기를 선택·추적하면 다가갈 때 신호 변화를 함께 확인할 수 있습니다.'
    : bs.api ? '이 브라우저는 블루투스 신호 세기를 주지 않습니다 (Chrome 실험 기능 필요). 빛 확인만 진행합니다.' : '이 브라우저는 블루투스를 지원하지 않습니다. 빛 확인만 진행합니다.';
  $('#btnFindScan').disabled = !bs.leScan || ble.scanning;
  renderDiag();
}

function diagData() {
  const D = finder.diag, st = D.stats || {}, td = D.torchDiff || {};
  const caps = camera.caps || {};
  return {
    app: VERSION, ua: navigator.userAgent, running: finder.running,
    light: finder.lightKind, torchProbe: S.torchProbe || null,
    camera: { res: D.res, torch: camera.hasTorch, torchOn: camera.torchOn, exposureComp: caps.exposureCompensation ? [caps.exposureCompensation.min, caps.exposureCompensation.max] : null, darkApplied: finder.dark, zoom: camera.zoomRange, facing: camera.settings && camera.settings.facingMode },
    settings: findOpts(),
    frame: { fps: D.fps, frames: D.frames, brightness: finder.quality && finder.quality.brightness, saturated: finder.quality && finder.quality.saturated, shiftPx: D.lastShift, motion: sensors.motionState() },
    glint: { sigma: st.sigma, thr: st.thr, raw: st.raw, kept: st.kept, maxSnr: st.maxSnr, rejected: D.rejected || {} },
    torchDiff: { runs: D.diffRuns, sigma: td.sigma, thr: td.thr, raw: td.raw, kept: td.kept, maxSnr: td.maxSnr },
    candidates: finder.cands.slice(0, 15).map((c) => ({ id: c.id, tier: c.tier && c.tier.key, score: c.score, hits: c.hits, ty: c.torchYes, tn: c.torchNo, span: Math.round(c.spanDeg), area: c.area, peak: c.peak, ratio: c.ratio, lastTorch: c.lastTorch || null })),
  };
}

function renderDiag() {
  if (!$('#fDiag').open) return;
  const d = diagData();
  const rows = [
    ['분석 해상도', d.camera.res], ['분석 속도', `${d.frame.fps} 프레임/초`], ['화면 밝기', d.frame.brightness ?? '-'],
    ['빛 방식', d.light === 'screen' ? '화면 빛' : d.light === 'torch' ? '손전등' : '없음'], ['손전등', d.camera.torch ? (d.camera.torchOn ? '켜짐' : '꺼짐') : '제어 불가'], ['손전등 카메라 탐색', d.torchProbe ? d.torchProbe.map((p) => `${p.label}:${p.torch ? '가능' : p.error ? '오류' : '불가'}`).join(', ') : '-'], ['노출 낮춤', d.camera.darkApplied ? '적용' : (d.camera.exposureComp ? '사용 안 함' : '미지원')],
    ['잡음 크기(σ)', d.glint.sigma ?? '-'], ['검출 기준', d.glint.thr ?? '-'], ['작은 점 (검출/통과)', `${d.glint.raw ?? '-'} / ${d.glint.kept ?? '-'}`],
    ['최대 신호/잡음', d.glint.maxSnr ?? '-'], ['제외 사유', Object.entries(d.glint.rejected).map(([k, v]) => `${k.split('(')[0]} ${v}`).join(', ') || '없음'],
    ['손전등 차분', `${d.torchDiff.runs}회 · 마지막 통과 ${d.torchDiff.kept ?? '-'}개`], ['흔들림 이동', `${d.frame.shiftPx ?? '-'}px (${d.frame.motion})`],
  ];
  $('#fDiagBody').innerHTML = rows.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(String(v))}</span></div>`).join('');
}

// ---- 화면 빛: 화면 전체를 흰색/검은색으로 바꿔 전면 카메라 쪽에서 빛을 비춘다 (손전등 제어가 안 되는 기기용)
const screenLight = {
  kind: 'screen',
  async set(on, final) {
    const el = $('#screenLight');
    if (final) { el.hidden = true; document.body.classList.remove('sl-mode'); mountStage('find'); return true; }
    if (el.hidden) { el.hidden = false; document.body.classList.add('sl-mode'); const slot = $('#slStageSlot'); if ($('#camStage').parentElement !== slot) { slot.appendChild($('#camStage')); video.play().catch(() => {}); } }
    el.classList.toggle('on', !!on);
    return true;
  },
};
const torchLight = { kind: 'torch', set: (on) => camera.setTorch(on) };

async function openRear(deviceId) {
  camera.facing = 'environment'; camera.deviceId = deviceId || null;
  mountStage('find');
  return startCamera();
}

async function startFind(forceMode) {
  notifier.unlock();
  const o = findOpts();
  Object.assign(finder.opts, o);
  sensors.startMotion();
  let mode = forceMode || o.light || 'auto';
  if (mode === 'screen' && !S.settings.screenFlashOk) { openSheet('screenWarn'); return; }
  if (mode !== 'screen') {
    const front = camera.settings.facingMode === 'user';
    if (!camera.active || front) { if (!(await openRear(S.settings.torchCam))) { renderFind(); return; } }
    if (!camera.hasTorch && camera.active) {
      $('#fGuideText').textContent = '손전등을 쓸 수 있는 카메라를 찾는 중…';
      const id = await camera.probeTorchCamera();
      if (id) { S.settings.torchCam = id; saveSettings(); await openRear(id); toast('손전등을 쓸 수 있는 카메라로 바꿨습니다.'); }
      else { await openRear(S.settings.torchCam || null); S.torchProbe = camera.probeLog; }
    }
    if (camera.hasTorch) finder.light = torchLight;
    else if (mode === 'auto') {
      toast('이 휴대폰·브라우저는 손전등 제어가 안 됩니다. 화면 빛 모드로 바꿉니다.', 'alert');
      if (!S.settings.screenFlashOk) { openSheet('screenWarn'); return; }
      mode = 'screen';
    } else finder.light = null;
  }
  if (mode === 'screen') {
    await finder.stop(true);
    camera.facing = 'user'; camera.deviceId = null;
    if (!(await startCamera())) { renderFind(); return; }
    finder.light = screenLight;
  }
  try { await finder.start(); startPulse(); } catch (e) { toast(e.message, 'alert'); }
  renderFind();
}

function bindFind() {
  $('#btnFindStart').onclick = () => startFind();
  const stopFind = async () => { finder.stop(); stopPulse(); await screenLight.set(false, true); await stopCameraWork(); renderFind(); renderOverlay(); };
  $('#btnFindStop').onclick = stopFind;
  $('#btnSlStop').onclick = stopFind;
  $('#btnFindSettings').onclick = () => openSheet('find');
  $('#fDiag').addEventListener('toggle', () => renderDiag());
  $('#btnDiagCopy').onclick = async () => {
    const txt = JSON.stringify(diagData(), null, 1);
    try { await navigator.clipboard.writeText(txt); toast('진단 정보를 복사했습니다. 대화창에 붙여 넣어 주세요.'); }
    catch (_) { toast('복사하지 못했습니다.', 'alert'); }
  };
  $('#btnUnlock').onclick = () => { finder.lock(null); renderFind(); };
  $('#fList').addEventListener('click', (e) => { const c = e.target.closest('[data-cand]'); if (c) { finder.lock(+c.dataset.cand); renderFind(); } });
  $('#btnApproach').onclick = () => { try { finder.startApproach(); } catch (e) { toast(e.message, 'alert'); } renderFind(); };
  $('#btnArrive').onclick = () => { finder.finishApproach(); renderFind(); };
  $('#btnFindScan').onclick = async () => { try { await ble.startLEScan(); toast('주변 전파 스캔을 시작했습니다.'); } catch (e) { toast(describeBleError(e), 'alert'); } renderFind(); };
  $('#btnFindToBle').onclick = () => showView('ble');
  for (const b of $$('.seg-tabs button')) b.onclick = () => showView(b.dataset.tool);
}


// ---------------------------------------------------------------- 자석·배터리 근접 스캔 (v1.5)
let msBeepTimer = null;
function stopMsBeep() { clearTimeout(msBeepTimer); msBeepTimer = null; }
function msBeepLoop() {
  stopMsBeep();
  if (!$('#chkMsBeep').checked || magScan.state !== 'active') return;
  const lv = magScan.level();
  if (lv >= 0.2) notifier.beep();
  msBeepTimer = setTimeout(msBeepLoop, lv >= 0.2 ? Math.round(900 - 750 * lv) : 500);
}
let msTimer = null;
magScan.onUpdate = () => { if (msTimer) return; msTimer = setTimeout(() => { msTimer = null; if (S.view === 'magscan') renderMagScan(); scheduleFusion(); }, 120); };
function renderMagScan() {
  const st = magScan.state;
  const names = { idle: '정지됨', waiting: '센서 준비 중…', active: '', 'no-data': '나침반 값이 들어오지 않습니다. 이 기기·브라우저에서는 사용할 수 없습니다.', 'no-gyro': '자이로(회전) 값이 없어 회전과 자기 이상을 구분할 수 없습니다.', denied: '방향·동작 센서 권한이 거부되었습니다.', unsupported: '이 브라우저는 방향 센서를 지원하지 않습니다.' };
  const md = magScan.magDelta();
  const active = st === 'active';
  $('#btnMagScanStart').disabled = active || st === 'waiting';
  $('#btnMagScanBase').disabled = !active;
  $('#btnMagScanStop').disabled = !(active || st === 'waiting' || st === 'no-gyro');
  if (md != null) { $('#msLabel').textContent = '자기장 변화 (센서 직접)'; $('#msVal').textContent = `${md >= 0 ? '+' : ''}${md.toFixed(1)} µT`; }
  else { $('#msLabel').textContent = '자기 이상 (나침반−자이로)'; $('#msVal').textContent = active ? `${Math.round(magScan.dev)}°` : '-'; }
  const lv = magScan.level();
  $('#msFill').style.width = (lv * 100).toFixed(0) + '%';
  $('#msState').textContent = active ? (magScan.rotating ? '휴대폰이 돌고 있어 측정을 잠시 멈췄습니다. 방향을 유지하세요.' : lv >= 0.33 ? '강한 반응 — 이 위치의 물건을 살펴보세요.' : lv >= 0.2 ? '약한 반응' : '반응 없음') + ` · 최대 ${Math.round(magScan.peak)}°` : (names[st] || '');
  $('#msEvents').innerHTML = magScan.events.slice(-6).reverse().map((e) => `<li>${fmtTime(e.t)} · 이상 ${e.dev}°</li>`).join('');
}
function bindMagScan() {
  $('#btnMagScanStart').onclick = async () => { notifier.unlock(); await magScan.start(); renderMagScan(); msBeepLoop(); };
  $('#btnMagScanBase').onclick = () => { magScan.rebase(); renderMagScan(); };
  $('#btnMagScanStop').onclick = () => { magScan.stop(); stopMsBeep(); renderMagScan(); };
  $('#chkMsBeep').onchange = () => msBeepLoop();
}

// ---------------------------------------------------------------- 몰래카메라 탐지 화면
spycam.onStatus = (m) => setStatus('spyStatus', m, /못했|안 됩니다|오류/.test(m));
let spyTimer = null;
spycam.onUpdate = (kind) => {
  if (kind === 'lens' || kind === 'ir') renderOverlay();
  scheduleFusion();
  if (spyTimer) return;
  spyTimer = setTimeout(() => { spyTimer = null; if (S.view === 'spycam') renderSpycam(); renderCameraButtons(); }, 300);
};

function renderSpyVerdict() {
  const v = spycam.evaluate();
  $('#spyVerdict').className = 'card verdict tone-' + v.tone;
  $('#spyLevel').textContent = v.level;
  $('#spyScore').textContent = v.score;
  $('#spyEvidence').innerHTML = v.evidence.length ? v.evidence.map((e) => `<li><span class="pill">${esc(e.source)}</span>${esc(e.text)} <span class="pill ${e.points ? 'warn' : ''}">+${e.points}</span>${e.note ? `<span class="meta">${esc(e.note)}</span>` : ''}</li>`).join('') : '<li class="muted">아직 점검 근거가 없습니다.</li>';
  $('#spyModules').innerHTML = v.modules.map((m) => `<li><strong>${esc(m.name)}</strong> <span class="pill ok">${esc(m.state)}</span><span class="meta">${esc(m.detail)}</span></li>`).join('');
  $('#spyNotes').innerHTML = v.notes.map((n) => `<li>${esc(n)}</li>`).join('');
  if (S.settings.alertsEnabled && v.levelKey === 'suspect') notifier.notify('spy|' + v.score, `몰래카메라 점검: ${v.level} — ${v.evidence[0] ? v.evidence[0].text : ''}`);
}

function renderSpycam() {
  renderSpyVerdict();
  // 렌즈 스윕
  const L = spycam.lens;
  if (!L) $('#lensList').innerHTML = '<li class="muted">측정 전</li>';
  else {
    const tr = L.tracks.filter((t) => t.reproducible || t.seenNow).slice(0, 8);
    let h = tr.length ? tr.map((t) => { const cf = spycam.confirm.get(t.id); const hd = spycam.headings.get('lens:' + t.id); return `<li>${t.reproducible ? `<span class="pill alert">반복 ${t.hits}/${t.observed}</span>` : '<span class="pill warn">관찰 중</span>'}${cf ? (cf.responsive ? `<span class="pill alert">손전등 반응 ✓</span>` : `<span class="pill">손전등 무관 — 제외</span>`) : ''}${hd != null ? `<span class="pill">${compassName(hd)}쪽</span>` : ''}위치 ${(t.nx * 100).toFixed(0)}%, ${(t.ny * 100).toFixed(0)}%<span class="meta">면적 ${t.last.area}px · 주변 대비 ${t.last.contrast.toFixed(1)}배 · 최대 밝기 ${t.last.peak} · 반사 특징 점수 ${t.featureScore}${cf ? ` · 손전등 켬 ${cf.onPeak} / 끔 ${cf.offPeak}` : ''}</span></li>`; }).join('') : `<li class="muted">반짝이는 작은 점이 없습니다 (분석 ${spycam.lensFrames}프레임)</li>`;
    if (L.env.issues.length) h += L.env.issues.map((i) => `<li class="muted">⚠ ${esc(i)}</li>`).join('');
    $('#lensList').innerHTML = h;
  }
  // 적외선
  $('#irVisible').textContent = '이 카메라의 적외선 감지: ' + (spycam.irVisible === true ? '확인됨 ✓' : spycam.irVisible === false ? '감지 못함 (다른 카메라로 시험하세요)' : '미확인 (리모컨 시험 권장)');
  if (!spycam.irFrames) $('#irList').innerHTML = '<li class="muted">측정 전</li>';
  else if (spycam.irTest) $('#irList').innerHTML = `<li class="muted">리모컨 시험 중… 관찰된 발광점 ${spycam.ir.length}개</li>`;
  else {
    const c = spycam.ir.filter((l) => l.candidate || l.seen >= 3).slice(0, 8);
    $('#irList').innerHTML = c.length ? c.map((l) => `<li>${l.candidate && ['자주색', '백색', '청색'].includes(l.colorName) ? '<span class="pill alert">IR 후보</span>' : l.candidate ? '<span class="pill">표시등류</span>' : '<span class="pill">관찰 중</span>'}${esc(l.colorName)} 점 · 위치 ${(l.nx * 100).toFixed(0)}%, ${(l.ny * 100).toFixed(0)}%<span class="meta">유지 ${(l.durationMs / 1000).toFixed(1)}초 · 출현율 ${pct(l.presence)} · ${l.blinking ? '점멸' : l.steady ? '지속' : '불규칙'} · 최대 밝기 ${l.peak}</span></li>`).join('') : `<li class="muted">지속되는 발광점이 없습니다 (분석 ${spycam.irFrames}프레임)</li>`;
  }
  // Wi-Fi
  const W = spycam.wifi;
  $('#ssidList').innerHTML = !W ? '' : W.matches.length
    ? W.matches.map((m) => `<li><span class="pill ${m.verified ? 'alert' : 'warn'}">${m.verified ? '카메라 이름 규칙' : '미검증 규칙'}</span><strong>${esc(m.ssid)}</strong><span class="meta">${esc(m.app)} · ${esc(m.deviceType)} · 확인 수준 ${esc(m.level)}</span></li>`).join('')
    : `<li class="muted">입력한 ${W.count}개 이름 중 카메라 핫스팟 이름 규칙과 일치하는 것이 없습니다.</li>`;
  // 블루투스
  renderBleMeter();
  const iot = spycam.bleIotDevices();
  $('#iotList').innerHTML = iot.length ? iot.map((d) => `<li><strong>${esc(d.name || '(이름 없음)')}</strong>${d.matches.map((m) => `<span class="meta">${esc(m.label)}${m.note ? ' — ' + esc(m.note) : ''}</span>`).join('')}</li>`).join('') : '<li class="muted">블루투스 탭에서 검색한 기기 중 해당 항목이 없습니다.</li>';
  renderMag();
}

// ---- 블루투스 신호 추적
let bleBeepTimer = null;
function renderBleMeter() {
  const d = spycam.trackedView();
  $('#bleMeter').hidden = !d;
  $('#btnBleTrackStop').disabled = !spycam.trackKey;
  if (!d) return;
  $('#bleMeterName').textContent = d.name;
  $('#bleMeterVal').textContent = d.rssiFiltered != null ? `${d.rssiFiltered} dBm` : '신호 미수신';
  $('#bleMeterFill').style.width = (rssiLevel(d.rssiFiltered) * 100).toFixed(0) + '%';
  $('#bleMeterTrend').textContent = d.rssiFiltered == null
    ? (d.watchError || '이 브라우저에서는 신호 세기를 받을 수 없습니다.')
    : `추세: ${d.trend.state}${d.trend.state === '증가' ? ' (가까워지는 중일 수 있음)' : d.trend.state === '감소' ? ' (멀어지는 중일 수 있음)' : ''} · 최근 관측 ${fmtTime(d.lastSeen)}`;
}
function scheduleBleBeep() {
  clearTimeout(bleBeepTimer);
  if (!($('#chkBleBeep').checked || $('#chkBleBeep2').checked) || !spycam.trackKey) return;
  const d = spycam.trackedView();
  const lvl = d && d.rssiFiltered != null && Date.now() - d.lastSeen < 5000 ? rssiLevel(d.rssiFiltered) : null;
  if (lvl != null) notifier.beep();
  bleBeepTimer = setTimeout(scheduleBleBeep, lvl != null ? beepInterval(lvl) : 1500);
}
function stopBleBeep() { clearTimeout(bleBeepTimer); bleBeepTimer = null; }

// ---- 자기장
let magOn = false;
function stopMag() { if (magOn && !S.integrated) sensors.stop(); magOn = false; }
function renderMag() {
  const m = sensors.mag;
  const names = { idle: '정지', waiting: '측정 준비 중', active: '측정 중', unsupported: '이 기기·브라우저는 자기장 센서를 지원하지 않습니다.', denied: '자기장 센서 권한이 거부되었습니다.', error: '자기장 센서를 사용할 수 없습니다.' };
  $('#magStatus').textContent = magOn || m.state !== 'idle' ? (names[m.state] || m.state) + (m.baseline == null && m.state === 'active' ? ' · 빈 곳에서 기준값을 설정하세요' : '') : '';
  $('#btnMagStart').disabled = magOn && m.state !== 'unsupported';
  $('#btnMagBase').disabled = m.state !== 'active';
  $('#btnMagStop').disabled = !magOn;
  $('#magMeter').hidden = m.state !== 'active';
  if (m.state === 'active') {
    const d = m.delta;
    $('#magVal').textContent = d == null ? `${m.total.toFixed(1)} µT (기준값 없음)` : `${d >= 0 ? '+' : ''}${d.toFixed(1)} µT`;
    $('#magFill').style.width = d == null ? '0%' : Math.min(100, Math.abs(d) / 60 * 100).toFixed(0) + '%';
  }
}

function bindSpycam() {
  $('#btnSpyCam').onclick = async () => {
    if (camera.active) { await stopCameraWork(); return; }
    notifier.unlock();
    camera.facing = 'environment'; camera.deviceId = null;
    mountStage('spycam'); await startCamera(); renderCameraButtons();
  };
  $('#btnLensStart').onclick = async () => {
    heading.start();
    try { await spycam.startLensSweep(); } catch (e) { setStatus('spyStatus', e.message, true); }
    renderCameraButtons();
  };
  $('#btnLensStop').onclick = async () => { await spycam.stopLensSweep(); setStatus('spyStatus', '스윕을 정지했습니다.'); renderCameraButtons(); renderSpycam(); };
  $('#btnIrFront').onclick = async () => {
    notifier.unlock();
    spycam.stopAll(true);
    mountStage('spycam');
    try { $('#stageMsg').hidden = false; $('#stageMsg').textContent = '전면 카메라를 여는 중…'; await spycam.useFrontCamera(); spycam.irVisible = null; setStatus('spyStatus', '전면 카메라로 전환했습니다. 리모컨 시험으로 적외선 감지 여부를 확인하세요.'); }
    catch (e) { toast(describeCameraError(e), 'alert'); }
    renderCameraButtons(); renderSpycam();
  };
  $('#btnIrTest').onclick = async () => { try { await spycam.startIrScan({ test: true }); } catch (e) { setStatus('spyStatus', e.message, true); } renderCameraButtons(); };
  $('#btnIrStart').onclick = async () => { heading.start(); try { await spycam.startIrScan(); } catch (e) { setStatus('spyStatus', e.message, true); } renderCameraButtons(); };
  $('#btnIrStop').onclick = () => { spycam.stopIrScan(); setStatus('spyStatus', '적외선 탐색을 정지했습니다.'); renderCameraButtons(); renderSpycam(); };
  $('#btnSsidCheck').onclick = () => {
    const r = spycam.checkWifi($('#ssidInput').value);
    setStatus('spyStatus', r.count ? `Wi-Fi 이름 ${r.count}개 점검 · 일치 ${r.matches.length}개` : 'Wi-Fi 이름을 입력해 주세요.', !r.count);
    renderSpycam();
  };
  $('#btnSsidClear').onclick = () => { $('#ssidInput').value = ''; spycam.wifi = null; renderSpycam(); };
  $('#btnBleTrack').onclick = async () => {
    notifier.unlock();
    if (!ble.support().requestDevice) { setStatus('spyStatus', '이 브라우저는 블루투스 기기 선택을 지원하지 않습니다 (아이폰 등).', true); return; }
    try { const rec = await ble.selectDevice(); spycam.trackKey = rec.key; setStatus('spyStatus', `‘${rec.name || '이름 없음'}’ 추적을 시작했습니다.`); scheduleBleBeep(); }
    catch (e) { setStatus('spyStatus', describeBleError(e), true); }
    renderSpycam();
  };
  $('#btnBleTrackStop').onclick = () => { spycam.trackKey = null; stopBleBeep(); renderSpycam(); };
  $('#chkBleBeep').onchange = (e) => { if (e.target.checked) { notifier.unlock(); scheduleBleBeep(); } else stopBleBeep(); };
  $('#btnMagStart').onclick = () => { magOn = true; sensors.startMagnetometer(); renderMag(); };
  $('#btnMagBase').onclick = () => { sensors.setMagBaseline(); renderMag(); };
  $('#btnMagStop').onclick = () => { stopMag(); renderMag(); renderSpyVerdict(); };
  $('#spotChecklist').innerHTML = (spycam.db.hidingSpots || []).map((t, i) => `<label class="ck-row"><input type="checkbox" id="spot${i}"> ${esc(t)}</label>`).join('');
  $('#ssidRules').innerHTML = compilePatterns(spycam.db).map((p) => `<li><span class="mono">${esc(p.example)}</span> — ${esc(p.app)} (${esc(p.level)})</li>`).join('');
}

// ---------------------------------------------------------------- 기능 진단 표시
function renderCaps() {
  const by = (id) => S.caps.find((r) => r.id === id);
  const chip = (label, r) => {
    if (!r) return '';
    const cls = r.status === 'supported' ? 'ok' : r.status === 'experimental' || r.status === 'permission' ? 'exp' : 'no';
    return `<span class="chip ${cls}">${esc(label)}: ${esc(STATUS[r.status])}</span>`;
  };
  $('#capSummary').innerHTML = [
    chip('블루투스', by('btRequestDevice')), chip('BLE 광고', by('btWatchAds')), chip('카메라', by('getUserMedia')),
    chip('플래시', by('cam_torch')), chip('동작 센서', by('deviceMotion')), chip('자기장', by('magnetometer')),
    chip('조도', by('ambientLight')), chip('오프라인', by('serviceWorker')),
  ].join('');
  if (S.sheet === 'caps') openSheet('caps', true);
}

// ---------------------------------------------------------------- 하위 화면 (시트)
const SHEETS = {
  screenWarn: '화면 빛 모드 안내',
  find: '찾기 설정',
  caps: '스마트폰 기능 진단', db: '스마트 글라스 데이터베이스', sensors: '센서 진단', logs: '탐지 기록',
  guide: '사용설명서', install: '앱 설치 방법', privacy: '개인정보 보호 안내', share: '프로그램 공유', reset: '데이터 초기화',
};

function openSheet(name, refresh) {
  S.sheet = name;
  $('#sheetTitle').textContent = SHEETS[name];
  const body = $('#sheetBody');
  const scroll = refresh ? body.scrollTop : 0;
  body.innerHTML = '';
  const tpl = $('#tpl-' + name);
  if (tpl) body.appendChild(tpl.content.cloneNode(true));
  const r = SHEET_RENDER[name];
  if (r) r(body);
  $('#sheet').hidden = false;
  body.scrollTop = scroll;
}
function closeSheet() {
  if (S.sheet === 'sensors' && !S.integrated) sensors.stop();
  S.sheet = null;
  $('#sheet').hidden = true;
}

const SHEET_RENDER = {
  screenWarn(body) {
    body.innerHTML = `<div class="doc">
      <p><strong>화면 빛 모드</strong>는 휴대폰 화면 전체를 흰색과 검은색으로 천천히(약 1초 간격) 바꾸며, 전면 카메라로 렌즈 반사를 비교합니다. 손전등 제어가 안 되는 휴대폰(아이폰 등)에서도 작동합니다.</p>
      <ul>
        <li>화면이 깜빡입니다. <strong>빛 깜빡임에 민감한 분(광과민성 발작 등)은 사용하지 마세요.</strong></li>
        <li>화면 밝기를 최대로 올리고, 방 불을 끈 뒤 대상에 <strong>30cm~1.5m</strong>까지 다가가세요. 화면 빛은 손전등보다 약해 먼 곳은 찾기 어렵습니다.</li>
        <li>화면이 대상을 향해야 하므로 휴대폰 화면 쪽(전면 카메라)을 대상에 향하게 들고, 위쪽 작은 미리보기 창을 보며 움직이세요.</li>
      </ul>
      <button id="btnSwOk" class="btn primary big" type="button">이해했습니다 · 화면 빛으로 시작</button></div>`;
    $('#btnSwOk', body).onclick = () => { S.settings.screenFlashOk = true; saveSettings(); closeSheet(); startFind('screen'); };
  },
  find(body) {
    const o = findOpts();
    const row = (label, sub, ctrl) => `<div class="form-row"><span class="lbl">${label}<small>${sub}</small></span>${ctrl}</div>`;
    const sel = (id, opts, v) => `<select id="${id}">${opts.map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    const chk = (id, v) => `<input type="checkbox" id="${id}" ${v ? 'checked' : ''}>`;
    body.innerHTML = `
      ${row('감도', '높을수록 작은 반사도 잡지만 오탐이 늘어납니다', sel('foSens', [['low', '낮음'], ['normal', '보통'], ['high', '높음 (기본)'], ['veryhigh', '최고 (아주 약한 빛까지)']], o.sensitivity))}
      ${row('빛 방식', '자동: 손전등 → 안 되면 화면 빛. 화면 빛은 전면 카메라로 가까이(30cm~1.5m)에서 사용', sel('foLight', [['auto', '자동 (권장)'], ['torch', '손전등만'], ['screen', '화면 빛 (모든 휴대폰)']], o.light || 'auto'))}
      ${row('표시할 최소 등급', '낮은 등급을 숨기면 화면이 단순해집니다', sel('foTier', [['yellow', '낮음(노랑)부터'], ['orange', '중간(주황)부터'], ['red', '높음(빨강)만']], o.minTier))}
      ${row('노출 낮추기', '배경을 어둡게 해 작은 렌즈 반사를 돋보이게 함 (지원 기종)', chk('foDark', o.darkExposure))}
      ${row('손전등 반응 자동 확인', '후보가 보이면 손전등을 0.3초 꺼서 확인', chk('foTorch', o.torchConfirm))}
      ${row('분석 해상도', '높을수록 먼 곳의 작은 렌즈를 찾지만 느려짐', sel('foRes', [['960', '보통 (960)'], ['1280', '높음 (1280)'], ['1920', '최고 (1920)']], String(o.maxSide)))}
      ${row('빨간 후보 소리·진동', '가능성 높은 후보를 찾으면 알림', chk('foSound', o.sound))}
      <p class="tiny muted">설정은 다음 ‘찾기 시작’부터 적용됩니다. 손전등은 5분 후 자동으로 꺼집니다.</p>`;
    body.onchange = () => {
      S.settings.find = { light: $('#foLight').value, sensitivity: $('#foSens').value, minTier: $('#foTier').value, darkExposure: $('#foDark').checked, torchConfirm: $('#foTorch').checked, maxSide: +$('#foRes').value, sound: $('#foSound').checked };
      saveSettings(); Object.assign(finder.opts, { sensitivity: S.settings.find.sensitivity, torchConfirm: S.settings.find.torchConfirm, minTier: S.settings.find.minTier, sound: S.settings.find.sound });
      renderFind(); renderOverlay();
    };
  },
  caps(body) {
    const groups = {};
    for (const r of S.caps) (groups[r.group] = groups[r.group] || []).push(r);
    let html = '<p class="tiny muted">‘API 존재’는 브라우저에 기능이 있는지, ‘실제 작동’은 이 기기에서 실제로 실행해 확인했는지를 뜻합니다. 카메라 세부 기능(플래시·줌 등)은 카메라를 한 번 실행해야 확인됩니다.</p>';
    html += '<table class="cap-table"><thead><tr><th>기능</th><th>상태</th><th>API</th><th>실제 작동</th></tr></thead><tbody>';
    for (const [g, list] of Object.entries(groups)) {
      html += `<tr><td colspan="4" class="cap-group">${esc(g)}</td></tr>`;
      for (const r of list) {
        html += `<tr><td>${esc(r.name)}${r.detail ? `<br><span class="muted tiny">${esc(r.detail)}</span>` : ''}</td><td class="st-${r.status}">${esc(STATUS[r.status])}</td><td>${r.apiPresent ? '있음' : '없음'}</td><td>${r.works === true ? '확인됨' : r.works === false ? '실패' : '미확인'}</td></tr>`;
      }
    }
    html += '</tbody></table><div class="btn-row"><button id="btnRecheck" class="btn" type="button">다시 진단</button></div>';
    html += `<p class="tiny muted">브라우저: ${esc(navigator.userAgent)}</p>`;
    body.innerHTML = html;
    $('#btnRecheck', body).onclick = async () => { const prev = S.caps; S.caps = await runCapabilityCheck(); if (camera.active) updateCameraCapabilities(S.caps, camera.info()); else carryCameraCaps(prev); renderCaps(); openSheet('caps', true); };
  },

  db(body) {
    const render = (q = '') => {
      const list = db.search(q);
      const tri = (v) => v === 'yes' ? '있음' : v === 'no' ? '없음' : '미확인';
      $('#dbList', body).innerHTML = list.map((m) => `<details class="db-item"><summary>${esc(m.model)} <span class="pill ${m.camera === 'yes' ? 'alert' : ''}">카메라 ${tri(m.camera)}</span>${m.origin === 'user' ? '<span class="pill ok">사용자</span>' : ''}</summary>
        <div class="grid small">
          <p>제조사: ${esc(m.manufacturer || '미확인')} · 브랜드: ${esc(m.brand || '미확인')}</p>
          <p>마이크 ${tri(m.microphone)} · 디스플레이 ${tri(m.display)} · 촬영 표시등 ${tri(m.recordingLed)}</p>
          <p>기기명 별칭: ${esc((m.aliases || []).map((a) => (a.text || a) + (a.verified ? '(확인)' : '(미검증)')).join(', ') || '미확인')}</p>
          <p>제조사 식별번호: ${esc((m.companyIds || []).join(', ') || '미확인')}</p>
          <p>서비스 UUID: <span class="mono">${esc((m.serviceUuids || []).map((u) => u.uuid || u).join(', ') || '미확인')}</span></p>
          <p>광고 패킷 지문: ${esc((m.adFingerprints || []).map((f) => `${f.companyId}:${f.dataPrefix}${f.verified ? '' : '(미검증)'}`).join(', ') || '미확인')}</p>
          <p>외형 특징: ${esc((m.features || []).join(' / ') || '미확인')}</p>
          <p>검증 수준: 블루투스 ${esc(m.bleLevel || 'U')} · 사양 ${esc(m.specVerification || '미확인')}</p>
          <p>확인 날짜: 블루투스 ${esc(m.bleChecked || '미확인')} · 사양 ${esc(m.specChecked || '미확인')}</p>
          ${(m.sources || []).map((s) => `<p class="tiny"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a></p>`).join('')}
          ${m.origin === 'user' ? `<div class="btn-row"><button class="btn small" data-edit="${esc(m.id)}" type="button">수정</button><button class="btn small danger" data-del="${esc(m.id)}" type="button">삭제</button></div>` : ''}
        </div></details>`).join('') || '<p class="muted">검색 결과가 없습니다.</p>';
    };
    body.innerHTML = `
      <p class="tiny muted">기본 데이터 버전 ${esc(db.version)} · 기본 ${db.base ? db.base.models.length : 0}개 · 사용자 추가 ${db.user.length}개. 기본 데이터는 읽기 전용이며, 업데이트되어도 사용자 추가 데이터는 유지됩니다. 확인하지 못한 정보는 ‘미확인’으로 표시합니다.</p>
      ${db.loadError ? `<p class="status-line err">${esc(db.loadError)}</p>` : ''}
      <input id="dbSearch" type="search" placeholder="모델·브랜드·제조사 검색" aria-label="모델 검색">
      <div class="btn-row"><button id="dbAdd" class="btn small primary" type="button">기기 추가</button><button id="dbExport" class="btn small" type="button">사용자 데이터 내보내기</button><button id="dbExportAll" class="btn small" type="button">전체 내보내기</button><label class="btn small file-btn">JSON 가져오기<input id="dbImport" type="file" accept="application/json,.json" hidden></label></div>
      <p id="dbMsg" class="status-line"></p>
      <div id="dbForm"></div>
      <div id="dbList"></div>`;
    render();
    $('#dbSearch', body).oninput = (e) => render(e.target.value);
    $('#dbAdd', body).onclick = () => showDbForm(body, null, render);
    $('#dbExport', body).onclick = () => download(`cheatingguard-user-devices-${today()}.json`, db.exportJSON(false), 'application/json');
    $('#dbExportAll', body).onclick = () => download(`cheatingguard-db-full-${today()}.json`, db.exportJSON(true), 'application/json');
    $('#dbImport', body).onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) { setStatus('dbMsg', '파일이 너무 큽니다 (최대 5MB).', true); return; }
      try { const n = await db.importJSON(await f.text()); setStatus('dbMsg', `${n}개 항목을 가져왔습니다.`); render(); }
      catch (err) { setStatus('dbMsg', '가져오기 실패: ' + err.message + ' (기존 데이터는 그대로 유지됩니다)', true); }
    };
    $('#dbList', body).onclick = async (e) => {
      const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
      if (ed) showDbForm(body, db.user.find((m) => m.id === ed.dataset.edit), render);
      if (del) {
        if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = '한 번 더 누르면 삭제'; return; }
        try { await db.remove(del.dataset.del); setStatus('dbMsg', '삭제했습니다.'); render($('#dbSearch', body).value); } catch (err) { setStatus('dbMsg', err.message, true); }
      }
    };
  },

  sensors(body) {
    body.innerHTML = `
      <p class="tiny muted">센서 값은 이 기기에서 실제로 측정한 값입니다. 자기장 변화는 일반 전자기기·금속에서도 생기므로 스마트 글라스 판단 근거로 사용하지 않습니다.</p>
      <div class="btn-row"><button id="snStart" class="btn primary" type="button">센서 측정 시작</button><button id="snStop" class="btn" type="button">정지</button></div>
      <div class="card"><h3>동작 센서 (자이로·가속도)</h3><div id="snMotion" class="kv-grid"></div></div>
      <div class="card"><h3>자기장 센서</h3><div id="snMag" class="kv-grid"></div><div class="btn-row"><button id="snBase" class="btn small" type="button">현재 값을 배경 기준값으로 설정</button></div></div>
      <div class="card"><h3>조도 센서</h3><div id="snLight" class="kv-grid"></div></div>`;
    $('#snStart', body).onclick = async () => { await sensors.startAll(); renderSensorsSheet(); };
    $('#snStop', body).onclick = () => { if (!S.integrated) sensors.stop(); renderSensorsSheet(); };
    $('#snBase', body).onclick = () => { if (sensors.setMagBaseline() == null) toast('자기장 측정값이 없습니다.'); renderSensorsSheet(); };
    renderSensorsSheet();
  },

  async logs(body) {
    let logs = [];
    try { logs = await storage.getAll('logs'); } catch (_) {}
    logs.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    body.innerHTML = `
      <p class="tiny muted">기록 저장: ${S.settings.recordEnabled ? '허용됨' : '사용 안 함 (설정에서 허용 가능)'} · 저장된 기록 ${logs.length}건 · ${storage.persistent ? '이 기기 브라우저 저장소' : '임시 메모리 (앱 종료 시 삭제)'}</p>
      <div class="btn-row"><button id="lgJson" class="btn small" type="button" ${logs.length ? '' : 'disabled'}>JSON 내보내기</button><button id="lgCsv" class="btn small" type="button" ${logs.length ? '' : 'disabled'}>CSV 내보내기</button><button id="lgDel" class="btn small danger" type="button" ${logs.length ? '' : 'disabled'}>기록 전체 삭제</button></div>
      <ul class="list">${logs.map((l) => `<li><strong>${esc(l.level)}</strong> · 점수 ${esc(l.score)} · ${esc(new Date(l.at).toLocaleString('ko-KR'))}<span class="meta">${esc(l.methods.join(', '))} · 후보 모델: ${esc(l.candidateModels.join(', ') || '없음')} · 사용자 확인: ${esc(l.userConfirm)}</span></li>`).join('') || '<li class="muted">기록이 없습니다.</li>'}</ul>`;
    $('#lgJson', body).onclick = () => download(`cheatingguard-logs-${today()}.json`, JSON.stringify(logs, null, 2), 'application/json');
    $('#lgCsv', body).onclick = () => download(`cheatingguard-logs-${today()}.csv`, logsToCsv(logs), 'text/csv');
    $('#lgDel', body).onclick = async (e) => {
      const b = e.currentTarget;
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = '한 번 더 누르면 전체 삭제'; return; }
      await storage.clear('logs'); toast('기록을 모두 삭제했습니다.'); openSheet('logs');
    };
  },

  install(body) {
    if (S.deferredPrompt) {
      $('#installBtnWrap', body).hidden = false;
      $('#btnInstall', body).onclick = async () => { S.deferredPrompt.prompt(); try { await S.deferredPrompt.userChoice; } catch (_) {} S.deferredPrompt = null; closeSheet(); };
    }
  },

  share(body) {
    const url = location.href.split('#')[0].split('?')[0].replace(/index\.html$/, '');
    body.innerHTML = `
      <p>아래 주소를 공유하면 다른 사용자가 바로 접속해 사용할 수 있습니다. 설치나 회원가입이 필요 없습니다.</p>
      <p class="mono card">${esc(url)}</p>
      <div class="btn-col"><button id="shShare" class="btn primary" type="button">공유하기</button><button id="shCopy" class="btn" type="button">주소 복사</button></div>
      <p class="tiny muted">공유할 때 ‘탐지 결과만으로 촬영 여부나 부정행위를 판단할 수 없다’는 안내를 함께 전달해 주세요.</p>`;
    $('#shShare', body).disabled = !navigator.share;
    $('#shShare', body).onclick = async () => { try { await navigator.share({ title: '칫팅가드 CheatingGuard', text: '스마트 글라스·몰래카메라 후보 탐색 보조 도구', url }); } catch (_) {} };
    $('#shCopy', body).onclick = async () => {
      try { await navigator.clipboard.writeText(url); toast('주소를 복사했습니다.'); }
      catch (_) { toast('복사하지 못했습니다. 주소를 길게 눌러 복사해 주세요.'); }
    };
  },

  reset(body) {
    body.innerHTML = `
      <p>삭제한 데이터는 되돌릴 수 없습니다. 각 버튼을 두 번 눌러야 실행됩니다.</p>
      <div class="btn-col">
        <button class="btn" data-reset="logs" type="button">탐지 기록 전체 삭제</button>
        <button class="btn" data-reset="user" type="button">사용자 추가 데이터베이스 삭제</button>
        <button class="btn" data-reset="settings" type="button">설정 초기화</button>
        <button class="btn danger" data-reset="all" type="button">모든 데이터와 오프라인 캐시 삭제</button>
      </div><p id="rsMsg" class="status-line"></p>`;
    body.onclick = async (e) => {
      const b = e.target.closest('[data-reset]');
      if (!b) return;
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.dataset.label = b.textContent; b.textContent = '한 번 더 누르면 실행'; return; }
      const k = b.dataset.reset;
      try {
        if (k === 'logs') await storage.clear('logs');
        if (k === 'user') { await storage.clear('userDevices'); await db.loadUser(); }
        if (k === 'settings') { S.settings = Object.assign(storage.loadSettings(), { onboarded: true }); localStorage.removeItem('cheatingguard.settings.v1'); S.settings = Object.assign(storage.loadSettings(), { onboarded: true }); saveSettings(); applySettingsToUI(); }
        if (k === 'all') {
          await storage.resetAll();
          if (typeof caches !== 'undefined') for (const key of await caches.keys()) if (key.startsWith('cheatingguard-')) await caches.delete(key);
          if (S.swReg) await S.swReg.unregister();
          setStatus('rsMsg', '모든 데이터를 삭제했습니다. 잠시 후 다시 불러옵니다.');
          setTimeout(() => location.reload(), 1200);
          return;
        }
        b.textContent = '완료'; b.dataset.confirm = '';
        setStatus('rsMsg', '삭제했습니다.');
      } catch (err) { setStatus('rsMsg', '삭제 중 오류가 발생했습니다.', true); }
    };
  },
};

function carryCameraCaps(prev) {
  for (const r of prev) if (r.id.startsWith('cam_') && r.works != null) updateEntry(S.caps, r.id, { status: r.status, works: r.works, detail: r.detail });
}

function renderSensorsSheet() {
  if (S.sheet !== 'sensors') return;
  const body = $('#sheetBody');
  const fmt = (v, d = 1) => v == null ? '-' : (+v).toFixed(d);
  const stName = { idle: '정지', waiting: '대기 중', active: '측정 중', unsupported: '미지원', denied: '권한 거부', error: '실행 오류', 'no-data': '데이터 없음 (센서 없음 또는 차단)' };
  const m = sensors.motion, g = sensors.mag, l = sensors.light;
  const grid = (rows) => rows.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  const mo = $('#snMotion', body); if (!mo) return;
  mo.innerHTML = grid([['상태', stName[m.state] || m.state], ['회전 속도', fmt(m.rot) + ' °/s'], ['가속도(중력 제외)', fmt(m.acc, 2) + ' m/s²'], ['흔들림 판정', m.stable == null ? '-' : m.stable ? '안정' : '흔들림']]);
  $('#snMag', body).innerHTML = grid([['상태', stName[g.state] || g.state], ['X', fmt(g.x) + ' µT'], ['Y', fmt(g.y) + ' µT'], ['Z', fmt(g.z) + ' µT'], ['전체 세기', fmt(g.total) + ' µT'], ['배경 기준값', fmt(g.baseline) + ' µT'], ['기준 대비 변화', fmt(g.delta) + ' µT']]);
  $('#snLight', body).innerHTML = grid([['상태', stName[l.state] || l.state], ['조도', fmt(l.lux, 0) + ' lx'], ['환경 평가', { dark: '어두움', ok: '적합', bright: '매우 밝음', unknown: '-' }[sensors.lightState()]]]);
}
sensors.onUpdate = () => { renderSensorsSheet(); if (magOn) { spycam.noteMag(); if (S.view === 'spycam') renderMag(); } if (S.integrated) { renderHomeMode(); scheduleFusion(); } };

function showDbForm(body, entry, rerender) {
  const e = entry || {};
  const triSel = (name, v) => `<select name="${name}">${['unknown', 'yes', 'no'].map((o) => `<option value="${o}" ${(v || 'unknown') === o ? 'selected' : ''}>${{ unknown: '미확인', yes: '있음', no: '없음' }[o]}</option>`).join('')}</select>`;
  const join = (a) => (a || []).map((x) => (x && typeof x === 'object' ? (x.text || x.uuid) : x)).join(', ');
  $('#dbForm', body).innerHTML = `<form class="card form-grid" id="dbF">
    <h3>${entry ? '기기 수정' : '기기 추가'}</h3>
    <label>제조사<input type="text" name="manufacturer" value="${esc(e.manufacturer)}"></label>
    <label>브랜드<input type="text" name="brand" value="${esc(e.brand)}"></label>
    <label>모델명 (필수)<input type="text" name="model" required value="${esc(e.model)}"></label>
    <label>기기명·별칭 (쉼표로 구분)<input type="text" name="aliases" value="${esc(join(e.aliases))}"></label>
    <label>제조사 식별번호 (예: 0x01AB, 쉼표 구분)<input type="text" name="companyIds" value="${esc(join(e.companyIds))}"></label>
    <label>서비스 UUID (쉼표 구분)<input type="text" name="serviceUuids" value="${esc(join(e.serviceUuids))}"></label>
    <label>카메라 ${triSel('camera', e.camera)}</label><label>마이크 ${triSel('microphone', e.microphone)}</label>
    <label>디스플레이 ${triSel('display', e.display)}</label><label>촬영 표시등 ${triSel('recordingLed', e.recordingLed)}</label>
    <label>외형 특징 (쉼표 구분)<input type="text" name="features" value="${esc((e.features || []).join(', '))}"></label>
    <label>정보 출처 URL<input type="text" name="source" value="${esc(e.sources && e.sources[0] ? e.sources[0].url : '')}"></label>
    <label class="check"><input type="checkbox" name="verified" ${e.aliases && e.aliases[0] && e.aliases[0].verified ? 'checked' : ''}> 별칭을 직접 실측으로 확인함</label>
    <div class="btn-row"><button class="btn primary" type="submit">저장</button><button class="btn" type="button" id="dbCancel">취소</button></div>
  </form>`;
  const f = $('#dbF', body);
  $('#dbCancel', body).onclick = () => { $('#dbForm', body).innerHTML = ''; };
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(f);
    const list = (k) => String(fd.get(k) || '').split(',').map((s) => s.trim()).filter(Boolean);
    const verified = !!fd.get('verified');
    const src = String(fd.get('source') || '').trim();
    const item = {
      id: e.id, manufacturer: fd.get('manufacturer'), brand: fd.get('brand'), model: String(fd.get('model') || '').trim(),
      aliases: list('aliases').map((t) => ({ text: t, verified, source: '사용자 입력' })),
      companyIds: list('companyIds').map((c) => c.toUpperCase().replace(/^0X/, '0x')),
      serviceUuids: list('serviceUuids').map((u) => ({ uuid: u.toLowerCase(), verified, source: '사용자 입력' })),
      adFingerprints: e.adFingerprints || [],
      camera: fd.get('camera'), microphone: fd.get('microphone'), display: fd.get('display'), recordingLed: fd.get('recordingLed'),
      features: list('features'),
      sources: src && /^https?:\/\//.test(src) ? [{ url: src, title: src }] : [],
      bleLevel: verified ? 'B' : 'U', bleChecked: verified ? today() : null, specVerification: '사용자 입력', specChecked: today(),
    };
    try { await db.addOrUpdate(item); setStatus('dbMsg', '저장했습니다.'); $('#dbForm', body).innerHTML = ''; rerender(); }
    catch (err) { setStatus('dbMsg', '저장 실패: ' + err.message, true); }
  };
  f.scrollIntoView({ behavior: 'smooth' });
}

function today() { return new Date().toISOString().slice(0, 10); }

function download(name, text, type) {
  try {
    const blob = new Blob([type === 'text/csv' ? '﻿' + text : text], { type: type + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (_) { toast('파일을 내보내지 못했습니다.', 'alert'); }
}

export function logsToCsv(logs) {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['탐지 일시', '탐지 방법', '판단 결과', '탐지 근거 점수', '후보 모델', '판단 근거', '광학 측정값', '블루투스 측정값', '측정 품질', '사용자 확인'];
  const rows = logs.map((l) => [l.at, l.methods.join('; '), l.level, l.score, l.candidateModels.join('; '),
    l.evidence.map((e) => `[${e.source}] ${e.text} (+${e.points})`).join('; '),
    l.measurements.optical ? JSON.stringify(l.measurements.optical) : '', JSON.stringify(l.measurements.ble || []),
    (l.quality.environmentIssues || []).join('; ') + (l.quality.motion ? ` / 흔들림: ${l.quality.motion}` : ''), l.userConfirm]);
  return [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
}

// ---------------------------------------------------------------- 서비스 워커 · 오프라인
async function registerSW() {
  if (!('serviceWorker' in navigator)) { setOfflineState('미지원 (이 브라우저)'); return; }
  try {
    const reg = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
    S.swReg = reg;
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) $('#updateBar').hidden = false;
        if (nw.state === 'activated') checkCache();
      });
    });
    if (reg.waiting && navigator.serviceWorker.controller) $('#updateBar').hidden = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (S.updateRequested) { S.updateRequested = false; location.reload(); } else checkCache();
    });
    await navigator.serviceWorker.ready;
    updateEntry(S.caps, 'serviceWorker', { works: true, status: 'supported', detail: '등록·활성화됨' });
    checkCache();
  } catch (e) {
    setOfflineState('사용 불가 (등록 실패)');
    updateEntry(S.caps, 'serviceWorker', { works: false, status: 'error', detail: 'Service Worker 등록 실패' });
    renderCaps();
  }
}

async function checkCache() {
  const sw = navigator.serviceWorker && (navigator.serviceWorker.controller || (S.swReg && S.swReg.active));
  if (!sw) { setOfflineState('준비 중'); return; }
  const res = await new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 4000);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
    try { sw.postMessage({ type: 'CHECK_CACHE' }, [ch.port2]); } catch (_) { clearTimeout(t); resolve(null); }
  });
  S.cache = res;
  if (!res) setOfflineState('확인 불가');
  else if (res.complete) setOfflineState('사용 가능', true);
  else setOfflineState(`준비 중 (${res.total - res.missing.length}/${res.total})`);
  if (res && !res.complete) setTimeout(checkCache, 3000);
}

function setOfflineState(text, ok = false) {
  const b = $('#offlineBadge');
  b.textContent = ok ? '오프라인 가능' : text.startsWith('준비') ? '오프라인 준비 중' : '오프라인 불가';
  b.className = 'badge ' + (ok ? 'ok' : 'dim');
  $('#infoOffline').textContent = text;
}

function updateNet() { $('#netBadge').hidden = navigator.onLine !== false; }

// ---------------------------------------------------------------- 설정 UI
function applySettingsToUI() {
  $('#chkAlerts').checked = !!S.settings.alertsEnabled;
  for (const r of $$('input[name="alertMode"]')) r.checked = r.value === S.settings.alertMode;
  $('#chkRecord').checked = !!S.settings.recordEnabled;
  $('#chkShowAllBle').checked = !!S.settings.showAllBle;
  $('#selSens').value = S.settings.sensitivity;
  optical.sensitivity = vision.sensitivity = spycam.sensitivity = S.settings.sensitivity;
  notifier.enabled = !!S.settings.alertsEnabled;
  notifier.mode = S.settings.alertMode;
  renderVerdict();
}

async function renderInfo() {
  $('#infoVersion').textContent = VERSION;
  $('#infoDb').textContent = db.loadError ? '로드 실패' : `${db.version} (${db.base.models.length}개 + 사용자 ${db.user.length}개)`;
  $('#infoProc').textContent = proc.label;
  const est = await storage.estimate();
  $('#infoStorage').textContent = (storage.persistent ? 'IndexedDB' : '임시 메모리') + (est && est.quota ? ` · ${(est.usage / 1048576).toFixed(1)}MB 사용` : '');
}

// ---------------------------------------------------------------- 이벤트 연결
function bind() {
  for (const b of $$('.bottom-nav button')) b.addEventListener('click', () => showView(b.dataset.view));
  for (const b of $$('[data-sheet]')) b.addEventListener('click', () => openSheet(b.dataset.sheet));
  $('#sheetClose').onclick = closeSheet;

  $('#btnOnboardOk').onclick = () => { S.settings.onboarded = true; saveSettings(); $('#onboarding').hidden = true; };

  $('#btnIntStart').onclick = () => startIntegrated();
  $('#btnIntStop').onclick = () => stopIntegrated(false);
  $('#chkSameTarget').onchange = () => scheduleFusion();
  $('#btnSaveRecord').onclick = () => saveRecord();

  $('#btnBleSelect').onclick = () => bleSelect('all');
  $('#btnBleSuspect').onclick = () => bleSelect('suspect');
  $('#btnCopyFlag').onclick = async () => { try { await navigator.clipboard.writeText('chrome://flags/#enable-experimental-web-platform-features'); toast('복사했습니다. Chrome 새 탭 주소창에 붙여 넣으세요.'); } catch (_) { toast('복사하지 못했습니다. 직접 입력하세요: chrome://flags/#enable-experimental-web-platform-features', 'alert'); } };
  for (const id of ['fltPersonal', 'fltNew', 'fltNear']) $('#' + id).onchange = () => renderBle();
  $('#btnBaseline').onclick = () => { const n = ble.markBaseline(); toast(`현재 기기 ${n}대를 기준 상태로 저장했습니다.`); renderBle(); };
  $('#btnBaselineClear').onclick = () => { ble.clearBaseline(); $('#fltNew').checked = false; renderBle(); };
  $('#btnDirStart').onclick = () => startDirection();
  $('#btnDirStop').onclick = () => stopDirection();
  $('#btnTrackOff').onclick = () => { stopDirection(); spycam.trackKey = null; S.dirResult = null; stopBleBeep(); renderBle(); scheduleFusion(); };
  $('#chkBleBeep2').onchange = (e) => { if (e.target.checked) { notifier.unlock(); scheduleBleBeep(); } else stopBleBeep(); };
  $('#btnBleScan').onclick = () => bleScan();
  $('#btnBleStop').onclick = () => { ble.stopLEScan(); setStatus('bleStatus', '스캔을 중지했습니다.'); renderBle(); };
  $('#btnBleReset').onclick = () => { ble.reset(); setStatus('bleStatus', '검색 결과를 초기화했습니다.'); renderBle(); scheduleFusion(); };
  $('#chkShowAllBle').onchange = (e) => { S.settings.showAllBle = e.target.checked; saveSettings(); renderBle(); };
  $('#bleList').addEventListener('click', (e) => {
    const tb = e.target.closest('[data-track]');
    if (tb) { trackDevice(tb.dataset.track); return; }
    const b = e.target.closest('[data-baseline]');
    if (!b) return;
    const v = ble.setBaseline(b.dataset.baseline);
    toast(v != null ? `1 m 기준값을 ${v} dBm으로 설정했습니다.` : '신호값이 없습니다.');
    renderBle();
  });

  $('#btnCamStart').onclick = async () => { notifier.unlock(); await startCamera(); };
  $('#btnCamStop').onclick = () => stopCameraWork();
  $('#btnCamSwitch').onclick = async () => {
    await optical.stop(); vision.stopLed();
    try { await camera.switchCamera(); } catch (e) { toast(describeCameraError(e), 'alert'); }
    renderCameraButtons();
  };
  $('#btnImmersive').onclick = () => { document.body.classList.add('immersive'); $('#camStage').scrollIntoView(); setTimeout(renderOverlay, 50); };
  $('#btnExitImmersive').onclick = (e) => { e.stopPropagation(); document.body.classList.remove('immersive'); setTimeout(renderOverlay, 50); };
  $('#zoom').oninput = async (e) => { $('#zoomVal').textContent = (+e.target.value).toFixed(1) + '×'; await camera.setZoom(+e.target.value); };

  $('#btnFlashStart').onclick = async () => {
    try { await optical.startFlash(); } catch (e) { setStatus('opticalStatus', e.message, true); }
    renderCameraButtons(); renderHomeMode();
  };
  $('#btnFlashStop').onclick = async () => { await optical.stop(); renderCameraButtons(); renderHomeMode(); };
  $('#btnSpotStart').onclick = async () => {
    try { await optical.startSpots(); } catch (e) { setStatus('opticalStatus', e.message, true); }
    renderCameraButtons(); renderHomeMode();
  };
  $('#btnSpotStop').onclick = async () => { await optical.stop(); renderCameraButtons(); renderHomeMode(); };
  $('#btnFreeze').onclick = async () => {
    if (S.stillShown) { hideStill(); renderOptical(); renderOverlay(); renderCameraButtons(); return; }
    if (!camera.active) return;
    await optical.stop();
    await showStillFrom(video, video.videoWidth, video.videoHeight);
    renderCameraButtons();
  };
  $('#filePhoto').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      await optical.stop();
      let bmp;
      if (typeof createImageBitmap === 'function') bmp = await createImageBitmap(f);
      else bmp = await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(f); });
      const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
      const scale = Math.min(1, 2400 / Math.max(w, h));
      await showStillFrom(bmp, Math.round(w * scale), Math.round(h * scale));
      if (bmp.close) bmp.close();
      renderCameraButtons();
    } catch (_) { setStatus('opticalStatus', '사진을 열 수 없습니다.', true); }
  };
  $('#btnRoiClear').onclick = () => { optical.roi = vision.roi = spycam.roi = null; renderOverlay(); toast('관심 영역을 해제했습니다.'); if (S.stillShown) analyzeStill(); };
  $('#selSens').onchange = (e) => { S.settings.sensitivity = e.target.value; saveSettings(); optical.sensitivity = vision.sensitivity = spycam.sensitivity = e.target.value; };
  $('#camStage').addEventListener('click', onStageTap);

  $('#btnVisCam').onclick = async () => { if (camera.active) await stopCameraWork(); else { mountStage('vision'); await startCamera(); } renderCameraButtons(); };
  $('#btnLedStart').onclick = async () => { try { await vision.startLed(); } catch (e) { setStatus('visionStatus', e.message, true); } renderCameraButtons(); };
  $('#btnLedStop').onclick = () => { vision.stopLed(); renderCameraButtons(); };
  $('#btnDark').onclick = async () => {
    try { await vision.analyzeDark(); renderDark(); renderOverlay(); setStatus('visionStatus', `렌즈 형태 분석 완료 · 후보 ${vision.dark.items.length}개`); scheduleFusion(); }
    catch (e) { setStatus('visionStatus', e.message, true); }
  };
  $('#checklist').addEventListener('change', (e) => {
    const m = /^ck_(.+)$/.exec(e.target.name || '');
    if (m) { vision.setCheck(m[1], e.target.value); scheduleFusion(); }
  });

  $('#chkAlerts').onchange = (e) => { S.settings.alertsEnabled = e.target.checked; notifier.enabled = e.target.checked; if (e.target.checked) notifier.unlock(); saveSettings(); };
  for (const r of $$('input[name="alertMode"]')) r.onchange = () => { S.settings.alertMode = r.value; notifier.mode = r.value; saveSettings(); };
  $('#btnTestAlert').onclick = () => { notifier.mode = S.settings.alertMode; notifier.test(); toast('[알림 시험] ' + ({ sound: '경고음과 진동', vibrate: '진동', silent: '화면 표시만' }[S.settings.alertMode]) + (navigator.vibrate ? '' : ' (이 기기는 진동 API 미지원)')); };
  $('#chkRecord').onchange = (e) => { S.settings.recordEnabled = e.target.checked; saveSettings(); renderVerdict(); };
  $('#btnUpdate').onclick = () => {
    const w = S.swReg && S.swReg.waiting;
    if (w) { S.updateRequested = true; w.postMessage({ type: 'SKIP_WAITING' }); } else location.reload();
  };
  $('#btnCheckUpdate').onclick = async () => {
    if (!S.swReg) { toast('이 브라우저에서는 업데이트 확인을 할 수 없습니다.'); return; }
    if (navigator.onLine === false) { toast('오프라인 상태에서는 업데이트를 확인할 수 없습니다.'); return; }
    try { await S.swReg.update(); toast(S.swReg.waiting || S.swReg.installing ? '새 버전을 내려받는 중입니다.' : '최신 버전입니다.'); } catch (_) { toast('업데이트를 확인하지 못했습니다.'); }
  };

  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.deferredPrompt = e; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && (camera.active || S.integrated || optical.running)) {
      stopCameraWork();
      S.pausedByBg = true;
    } else if (!document.hidden && S.pausedByBg) {
      S.pausedByBg = false;
      toast('앱이 백그라운드로 전환되어 카메라·플래시 측정이 중단되었습니다. 다시 시작해 주세요.');
      $('#homeHint').textContent = '백그라운드 전환으로 측정이 중단되었습니다.';
    }
  });
  window.addEventListener('pagehide', () => { camera.stop(); });
  window.addEventListener('unhandledrejection', (e) => { console.warn('[CheatingGuard]', e.reason); });
  window.addEventListener('error', (e) => { console.warn('[CheatingGuard]', e.message); });
}

// ---------------------------------------------------------------- 시작
async function init() {
  bind();
  $('#appVersion').textContent = 'v' + VERSION;
  applySettingsToUI();
  updateNet();
  if (!S.settings.onboarded) $('#onboarding').hidden = false;
  mountStage(S.view);
  renderChecklist(); renderVision(); renderCameraButtons(); renderBleSupport(); renderHomeMode();
  runFusion();
  try { S.caps = await runCapabilityCheck(); } catch (_) { S.caps = []; }
  renderCaps(); renderBleSupport();
  await storage.open();
  await db.load();
  if (db.loadError) toast(db.loadError, 'alert');
  await spycam.load();
  bindSpycam();
  bindFind();
  bindMagScan();
  renderFind();
  renderInfo();
  registerSW();
  runFusion();
  setTimeout(renderInfo, 1500);
  document.documentElement.dataset.ready = '1';
}

init();
