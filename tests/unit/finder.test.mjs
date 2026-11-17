import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGlints, analyzeTorchDiff, resetGlintState, run } from '../../js/processors.js';
import { Finder, scoreCandidate, linkRadio, angleSpan, TIERS } from '../../js/finder.js';

const W = 1280, H = 720;
function hash(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
/** 어두운 실내(노출 낮춤) 장면: 질감 배경 + 큰 조명 + 작은 렌즈 반사 */
function scene({ ox = 0, glint = true, glintR = 1.2, gx = 900, gy = 360, lamp = true, gv = 255, led = false } = {}) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = x + ox;
    const v = 30 + 25 * hash(wx >> 3, y >> 3) + 10 * hash(wx, y);
    const j = (y * W + x) * 4; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
  }
  const put = (cx, cy, r, v) => { for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) { if (x < 0 || y < 0 || x >= W || y >= H) continue; if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { const j = (y * W + x) * 4; d[j] = d[j + 1] = d[j + 2] = v; } } };
  if (lamp) for (let y = 100; y < 160; y++) for (let x = 300 - ox; x < 360 - ox; x++) if (x >= 0 && x < W) { const j = (y * W + x) * 4; d[j] = d[j + 1] = d[j + 2] = 255; }
  if (glint) put(gx - ox, gy, glintR, gv);
  if (led) put(400 - ox, 500, 1.5, 200);
  return d;
}

test('작은 렌즈 반사(지름 2~3픽셀) 검출, 큰 조명은 제외', () => {
  resetGlintState();
  const r = analyzeGlints({ rgba: scene(), w: W, h: H, params: { sensitivity: 'normal' } });
  const g = r.glints.find((x) => Math.hypot(x.x - 900, x.y - 360) < 3);
  assert.ok(g, '렌즈 반사 미검출: ' + JSON.stringify(r.glints.slice(0, 3)));
  assert.ok(!r.glints.some((x) => x.x > 290 && x.x < 370 && x.y > 90 && x.y < 170), '조명을 후보로 잡음');
  assert.ok(r.rejectedCount >= 1);
});

test('1픽셀 반사도 검출 (기존 방식은 축소·흐림으로 사라짐)', () => {
  resetGlintState();
  const r = analyzeGlints({ rgba: scene({ glintR: 0.5, lamp: false }), w: W, h: H, params: { sensitivity: 'normal' } });
  assert.ok(r.glints.some((x) => Math.hypot(x.x - 900, x.y - 360) < 2));
  const old = run('spots', { rgba: (() => { // 기존 일반 영상 분석: 640px로 축소한 영상
    const s = scene({ glintR: 0.5, lamp: false }); const o = new Uint8ClampedArray(640 * 360 * 4);
    for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) for (let c = 0; c < 4; c++) { let a = 0; for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) a += s[((y * 2 + dy) * W + x * 2 + dx) * 4 + c]; o[(y * 640 + x) * 4 + c] = a / 4; }
    return o; })(), w: 640, h: 360 });
  assert.ok(!old.candidates.some((x) => Math.hypot(x.x - 450, x.y - 180) < 3), '참고: 기존 방식이 검출함');
});

test('프레임 간 흔들림(평행이동) 추정', () => {
  resetGlintState();
  analyzeGlints({ rgba: scene({ ox: 0 }), w: W, h: H, streamKey: 's' });
  const r = analyzeGlints({ rgba: scene({ ox: 24 }), w: W, h: H, streamKey: 's' });
  assert.ok(r.shift.valid && Math.abs(r.shift.dx + 24) <= 8 && Math.abs(r.shift.dy) <= 8, JSON.stringify(r.shift));
});

test('등급: 손전등 반응 2회 + 여러 각도 → 빨강, 손전등과 무관하면 제외', () => {
  const base = { bestScore: 80, hits: 10, torchYes: 2, torchNo: 0, spanDeg: 25 };
  assert.equal(scoreCandidate(base).tier.key, 'red');
  assert.equal(scoreCandidate({ ...base, spanDeg: 5 }).tier.key, 'orange');
  assert.equal(scoreCandidate({ ...base, spanDeg: 5, radio: { linked: true, delta: 12 } }).tier.key, 'red');
  assert.equal(scoreCandidate({ ...base, torchYes: 0, torchNo: 3 }).tier.key, 'excluded');
  assert.equal(scoreCandidate({ bestScore: 50, hits: 3, torchYes: 0, torchNo: 0, spanDeg: 0 }).tier.key, 'yellow');
  assert.equal(scoreCandidate({ bestScore: 50, hits: 1, torchYes: 0, torchNo: 0, spanDeg: 0 }).tier.key, 'none');
  assert.equal(scoreCandidate({ ...base, torchYes: 0 }, { torchSupported: false }).tier.key, 'orange', '손전등 확인이 불가능하면 빛만으로는 빨강 불가');
  assert.equal(scoreCandidate({ ...base, torchYes: 0, radio: { linked: true, delta: 10 } }, { torchSupported: false }).tier.key, 'red');
  assert.ok(scoreCandidate(base).score <= 100);
});

test('각도 범위 계산', () => {
  assert.equal(angleSpan([{ px: 0, py: 0 }, { px: 12, py: 5 }, { px: -3, py: 0 }]) > 15, true);
  assert.equal(angleSpan([{ px: 0, py: 0 }]), 0);
});

test('다가갈 때 전파 연결: 한 기기만 뚜렷이 강해지면 연결', () => {
  const t0 = 0, t1 = 15000;
  const mk = (a, b) => [...Array(30)].map((_, i) => ({ t: i * 500, v: i < 6 ? a : i > 24 ? b : (a + b) / 2 }));
  const L = linkRadio([{ key: 'cam', name: 'IPC', samples: mk(-85, -62) }, { key: 'ph', name: 'Phone', samples: mk(-70, -68) }], t0, t1);
  assert.ok(L.linked && L.best.key === 'cam' && L.best.delta >= 20);
  const N = linkRadio([{ key: 'a', name: 'A', samples: mk(-80, -70) }, { key: 'b', name: 'B', samples: mk(-80, -71) }], t0, t1);
  assert.equal(N.linked, false, '둘 다 비슷하게 변하면 연결하지 않음');
});

test('찾기 모드 통합: 카메라를 돌려도 후보를 따라가며 손전등 반응·각도 확인 후 빨강', async () => {
  resetGlintState();
  let ox = 0;
  const cam = {
    active: true, hasTorch: true, torchOn: false, settings: {},
    async setTorch(v) { this.torchOn = v; return true; },
    async setDarkExposure() { return true; },
    grab() { const data = scene({ ox, glint: this.torchOn }); return { data, w: W, h: H, geom: { sx: 0, sy: 0, sw: W, sh: H, vw: W, vh: H, w: W, h: H } }; },
  };
  const proc = { run: (cmd, p) => Promise.resolve(run(cmd, p)) };
  const f = new Finder({ camera: cam, proc, sensors: { motionState: () => 'stable' }, ble: { devices: new Map() } });
  f.opts.maxSide = W;
  await f.start();
  const t0 = Date.now();
  let red = null;
  while (Date.now() - t0 < 25000) {
    await new Promise((r) => setTimeout(r, 120));
    ox = Math.min(520, ox + 14);      // 카메라가 천천히 옆으로 이동 (약 26°)
    red = f.cands.find((c) => c.tier && c.tier.key === 'red');
    if (red) break;
  }
  f.stop(true);
  const best = [...f.cands].sort((a, b) => b.score - a.score)[0];
  assert.ok(red, '빨강 미도달: ' + JSON.stringify(best && { hits: best.hits, ty: best.torchYes, tn: best.torchNo, span: best.spanDeg, score: best.score }));
  assert.ok(!f.cands.some((c) => c.tier && c.tier.rank >= 2 && c.ny < 0.25), '조명이 주황 이상');
});


test('약한 반사(밝기 100, 배경보다 약간 밝음)도 높음 감도에서 후보로 검출', () => {
  resetGlintState();
  const r = analyzeGlints({ rgba: scene({ gv: 100 }), w: W, h: H, params: { sensitivity: 'high' } });
  assert.ok(r.glints.some((x) => Math.hypot(x.x - 900, x.y - 360) < 3), JSON.stringify(r.stats));
  assert.ok(r.stats.sigma > 0 && r.stats.thr > 0);
});

test('손전등 차분: 손전등에만 반응하는 약한 반사는 찾고, 항상 켜진 표시등은 제외', () => {
  const on = scene({ gv: 90, led: true }), off = scene({ glint: false, led: true });
  const r = analyzeTorchDiff({ on, off, w: W, h: H, params: { sensitivity: 'high' } });
  assert.ok(r.spots.some((x) => Math.hypot(x.x - 900, x.y - 360) < 3), '약한 렌즈 반사 미검출 ' + JSON.stringify(r.stats));
  assert.ok(!r.spots.some((x) => Math.hypot(x.x - 400, x.y - 500) < 4), '표시등을 손전등 반응으로 오인');
});

test('찾기 모드: 휴대폰을 고정하면 약한 반사도 손전등 차분으로 찾아 주황 이상', async () => {
  resetGlintState();
  const cam = {
    active: true, hasTorch: true, torchOn: false, settings: {},
    async setTorch(v) { this.torchOn = v; return true; },
    async setDarkExposure() { return true; },
    grab() { const data = scene({ gv: 95, glint: this.torchOn, led: true }); return { data, w: W, h: H, geom: { sx: 0, sy: 0, sw: W, sh: H, vw: W, vh: H, w: W, h: H } }; },
  };
  const proc = { run: (cmd, p) => Promise.resolve(run(cmd, p)) };
  const f = new Finder({ camera: cam, proc, sensors: { motionState: () => 'unknown' }, ble: { devices: new Map() } });
  f.opts.maxSide = W;
  await f.start();
  const t0 = Date.now();
  let c = null;
  while (Date.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 200));
    c = f.cands.find((x) => Math.hypot(x.nx * W - 900, x.ny * H - 360) < 6 && x.tier && x.tier.rank >= 2);
    if (c) break;
  }
  f.stop(true);
  assert.ok(c, '약한 반사 후보 주황 미도달: ' + JSON.stringify(f.cands.map((x) => ({ x: Math.round(x.nx * W), y: Math.round(x.ny * H), ty: x.torchYes, tn: x.torchNo, h: x.hits, t: x.tier && x.tier.key }))));
  assert.ok(!f.cands.some((x) => Math.hypot(x.nx * W - 400, x.ny * H - 500) < 6 && x.tier && x.tier.rank >= 2), '표시등이 주황 이상');
  assert.ok(f.diag.diffRuns >= 1 && f.diag.fps >= 0);
});
