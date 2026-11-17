/**
 * CheatingGuard 영상 분석 처리기 (Web Worker 및 메인 스레드 공용, DOM 비의존)
 * 모든 결과의 수치는 실제 입력 영상에서 계산된 측정값이다.
 */
import * as ip from './image-processing.js';

export const SENSITIVITY = {
  low:    { minDiff: 55, C: 24, contrast: 2.0, minTop: 50, minPeak: 200, circ: 0.55 },
  normal: { minDiff: 40, C: 18, contrast: 1.6, minTop: 38, minPeak: 185, circ: 0.45 },
  high:   { minDiff: 28, C: 12, contrast: 1.35, minTop: 28, minPeak: 165, circ: 0.38 },
};

function params(p) { return Object.assign({}, SENSITIVITY[(p && p.sensitivity) || 'normal'], p || {}); }

function qualityOf(gray, w, h) {
  return {
    sharpness: Math.round(ip.laplacianVariance(gray, w, h)),
    brightness: Math.round(ip.mean(gray, 5)),
    saturated: +ip.saturatedFraction(gray).toFixed(4),
  };
}

/**
 * 반사점 후보 판정. 거부 사유가 있으면 rejected에 사유를 기록한다.
 * score는 "규칙 기반 반사 특징 점수"이며 확률이 아니다.
 */
export function classifyReflection(f, P, imgArea) {
  const reasons = [];
  let reject = null;
  const maxArea = Math.max(30, imgArea * 0.004);
  if (f.area > maxArea) reject = '넓은 반사 영역 (안경알·평면 반사 가능성)';
  else if (f.offPeak >= 245) reject = '플래시 이전부터 포화된 영역 (조명·화면 등)';
  else if (f.area >= 6 && f.circularity < P.circ) reject = '길쭉한 형태 (안경테 가장자리·금속 반사 가능성)';
  else if (f.contrast < P.contrast) reject = '주변 대비 부족';
  if (f.area < 6) reasons.push('매우 작은 점 (원형도 판정 신뢰도 낮음)');
  else reasons.push(`원형도 ${f.circularity.toFixed(2)}`);
  reasons.push(`주변 대비 ${f.contrast.toFixed(1)}배`);
  if (f.diffPeak != null) reasons.push(`플래시 밝기 증가 ${Math.round(f.diffPeak)}`);
  const score = Math.round(
    (f.diffPeak != null ? Math.min(1, f.diffPeak / 160) * 40 : Math.min(1, (f.peak - 150) / 105) * 30) +
    (f.area >= 6 ? f.circularity : 0.6) * 25 +
    Math.min(1, (f.contrast - 1) / 5) * 25 +
    (f.area <= imgArea * 0.0015 ? 10 : 0));
  return { reject, reasons, featureScore: Math.max(0, Math.min(100, score)) };
}

/**
 * 플래시 ON/OFF 차분 분석.
 * off: 플래시 끈 기준 영상, on: 플래시 켠 영상, off2(선택): 플래시 끈 후 재측정 영상
 * off2가 있으면 양방향 차분의 최솟값을 사용해 움직임에 의한 거짓 반응을 줄인다.
 */
export function analyzeFlashDiff({ off, on, off2, w, h, params: p }) {
  const P = params(p);
  const n = w * h;
  const gOff = ip.gaussianBlur(ip.rgbaToGray(off, n), w, h);
  const gOn = ip.gaussianBlur(ip.rgbaToGray(on, n), w, h);
  const a1 = ip.alignTranslation(gOff, gOn, w, h, 8, 3);
  const gain1 = ip.estimateGain(gOn, gOff);
  let diff = ip.diffAligned(gOn, gOff, w, h, a1.dx, a1.dy, gain1);
  let a2 = null, gain2 = null, gOff2 = null;
  if (off2) {
    gOff2 = ip.gaussianBlur(ip.rgbaToGray(off2, n), w, h);
    a2 = ip.alignTranslation(gOff2, gOn, w, h, 8, 3);
    gain2 = ip.estimateGain(gOn, gOff2);
    const d2 = ip.diffAligned(gOn, gOff2, w, h, a2.dx, a2.dy, gain2);
    for (let i = 0; i < n; i++) if (d2[i] < diff[i]) diff[i] = d2[i];
  }
  let bin = ip.adaptiveThreshold(diff, w, h, 7, P.C, P.minDiff);
  bin = ip.closing(ip.removeIsolated(bin, w, h), w, h);
  const cc = ip.connectedComponents(bin, w, h, diff, { minArea: 1, maxArea: n * 0.05, maxBlobs: 300 });
  const candidates = [], rejected = [];
  for (const b of cc.blobs) {
    const ring = ip.ringMean(gOn, w, h, b, 3, cc.labels);
    const inner = ip.blobMean(gOn, w, b, cc.labels);
    const offPeak = ip.regionMax(gOff, w, h, b.minX - 3, b.minY - 3, b.maxX + 3, b.maxY + 3);
    const f = {
      x: b.cx, y: b.cy, area: b.area, radius: b.radius, circularity: b.circularity,
      diffPeak: b.peak, onPeak: ip.blobMax(gOn, w, b, cc.labels), offPeak,
      contrast: (inner + 1) / (ring + 1), bbox: [b.minX, b.minY, b.bw, b.bh],
    };
    const c = classifyReflection(f, P, n);
    const item = Object.assign(f, c);
    (c.reject ? rejected : candidates).push(item);
  }
  candidates.sort((a, b) => b.featureScore - a.featureScore);
  const shift = Math.max(Math.hypot(a1.dx, a1.dy), a2 ? Math.hypot(a2.dx, a2.dy) : 0);
  const motionDelta = a2 ? Math.abs(a1.score - a2.score) : 0;
  return {
    mode: 'flash-diff', w, h,
    candidates: candidates.slice(0, 30),
    rejected: rejected.sort((a, b) => b.diffPeak - a.diffPeak).slice(0, 15),
    rejectedCount: rejected.length,
    truncated: cc.truncated,
    quality: Object.assign(qualityOf(gOn, w, h), {
      offBrightness: Math.round(ip.mean(gOff, 5)),
      gain: +gain1.toFixed(2), shiftPx: +shift.toFixed(1),
      alignResidual: +a1.score.toFixed(1), motionDelta: +motionDelta.toFixed(1),
      flashEffect: +(gain1 - 1).toFixed(2),
    }),
  };
}

/** 플래시 없이 일반 영상에서 작은 밝은 반사점 후보 추출 */
export function analyzeSpots({ rgba, w, h, params: p }) {
  const P = params(p);
  const n = w * h;
  const gray = ip.gaussianBlur(ip.rgbaToGray(rgba, n), w, h);
  const th = ip.topHat(gray, w, h, 10);
  const t = Math.max(P.minTop, ip.percentile(th, 99.7, 2));
  let bin = ip.threshold(th, n, t);
  for (let i = 0; i < n; i++) if (bin[i] && gray[i] < P.minPeak) bin[i] = 0;
  bin = ip.closing(ip.removeIsolated(bin, w, h), w, h);
  const cc = ip.connectedComponents(bin, w, h, gray, { minArea: 1, maxArea: n * 0.05, maxBlobs: 300 });
  const candidates = [], rejected = [];
  for (const b of cc.blobs) {
    const ring = ip.ringMean(gray, w, h, b, 4, cc.labels);
    const inner = ip.blobMean(gray, w, b, cc.labels);
    const f = {
      x: b.cx, y: b.cy, area: b.area, radius: b.radius, circularity: b.circularity,
      peak: b.peak, offPeak: 0, contrast: (inner + 1) / (ring + 1), bbox: [b.minX, b.minY, b.bw, b.bh],
    };
    const c = classifyReflection(f, P, n);
    if (!c.reject && b.peak >= 252 && b.area > 40) c.reject = '과다 노출된 광원 영역';
    (c.reject ? rejected : candidates).push(Object.assign(f, c));
  }
  candidates.sort((a, b) => b.featureScore - a.featureScore);
  return {
    mode: 'spots', w, h, threshold: t,
    candidates: candidates.slice(0, 30), rejected: rejected.slice(0, 15), rejectedCount: rejected.length,
    truncated: cc.truncated, quality: qualityOf(gray, w, h),
  };
}

/** 촬영 표시등 후보용 발광점 추출 (최대 채널 기반, 색상 포함) */
export function analyzeLed({ rgba, w, h, params: p }) {
  const P = params(p);
  const n = w * h;
  const mx = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) mx[i] = Math.max(rgba[j], rgba[j + 1], rgba[j + 2]);
  const gray = ip.rgbaToGray(rgba, n);
  const th = ip.topHat(mx, w, h, 8);
  const t = Math.max(P.minTop + 10, ip.percentile(th, 99.8, 2));
  let bin = ip.threshold(th, n, t);
  for (let i = 0; i < n; i++) if (bin[i] && mx[i] < P.minPeak) bin[i] = 0;
  bin = ip.removeIsolated(bin, w, h);
  const maxArea = Math.max(25, n * 0.0025);
  const cc = ip.connectedComponents(bin, w, h, mx, { minArea: 1, maxArea, maxBlobs: 120 });
  const spots = [];
  for (const b of cc.blobs) {
    const col = ip.blobColor(rgba, w, b, cc.labels);
    const hsv = ip.rgbToHsv(col.r, col.g, col.b);
    const ring = ip.ringMean(mx, w, h, b, 4, cc.labels);
    spots.push({
      x: b.cx, y: b.cy, area: b.area, peak: b.peak, circularity: b.circularity,
      contrast: (b.meanV + 1) / (ring + 1),
      color: { r: Math.round(col.r), g: Math.round(col.g), b: Math.round(col.b) },
      hue: Math.round(hsv.h), sat: +hsv.s.toFixed(2), colorName: ip.colorName(hsv),
    });
  }
  return { mode: 'led', w, h, spots: spots.filter(s => s.contrast >= 1.3).slice(0, 40), quality: qualityOf(gray, w, h) };
}

/** 렌즈 형태 후보: 작고 둥근 어두운 점 (규칙 기반, 신뢰도 낮음) */
export function analyzeDark({ rgba, w, h, params: p }) {
  const P = params(p);
  const n = w * h;
  const gray = ip.gaussianBlur(ip.rgbaToGray(rgba, n), w, h);
  const bh = ip.blackHat(gray, w, h, 9);
  const t = Math.max(30, ip.percentile(bh, 99.5, 2));
  let bin = ip.removeIsolated(ip.threshold(bh, n, t), w, h);
  bin = ip.opening(bin, w, h);
  const cc = ip.connectedComponents(bin, w, h, bh, { minArea: 5, maxArea: n * 0.004, maxBlobs: 150 });
  const items = [];
  for (const b of cc.blobs) {
    if (b.circularity < Math.max(0.55, P.circ + 0.1)) continue;
    const ring = ip.ringMean(gray, w, h, b, 3, cc.labels);
    const inner = ip.blobMean(gray, w, b, cc.labels);
    const ratio = (ring + 1) / (inner + 1);
    if (ratio < 1.4) continue;
    items.push({ x: b.cx, y: b.cy, area: b.area, radius: b.radius, circularity: b.circularity, darkRatio: +ratio.toFixed(2) });
  }
  items.sort((a, b) => b.darkRatio * b.circularity - a.darkRatio * a.circularity);
  return { mode: 'dark', w, h, items: items.slice(0, 10), quality: qualityOf(gray, w, h) };
}


// ------------------------------------------------------------ 작은 렌즈 반사(글린트) 검출 v2
// 카메라 렌즈(지름 1~2mm)의 손전등 반사는 화면에서 1~5픽셀 크기일 수 있다.
// 해상도를 줄이거나 흐리게 하면 사라지므로, 고해상도 원본 밝기에서 국소 대비로 찾는다.
export const GLINT = {
  veryhigh: { k: 3.5, minDog: 8, minRatio: 1.15, minPeak: 35 },
  high:     { k: 4.5, minDog: 12, minRatio: 1.25, minPeak: 45 },
  normal:   { k: 5.5, minDog: 18, minRatio: 1.4, minPeak: 60 },
  low:      { k: 7, minDog: 30, minRatio: 1.8, minPeak: 90 },
};
let prevSmall = null, prevKey = null, prevDims = '';

function downsample(src, w, h, f) {
  const sw = Math.floor(w / f), sh = Math.floor(h / f);
  const out = new Uint8ClampedArray(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let s = 0;
    for (let yy = 0; yy < f; yy++) { const r = (y * f + yy) * w + x * f; for (let xx = 0; xx < f; xx++) s += src[r + xx]; }
    out[y * sw + x] = s / (f * f);
  }
  return { data: out, w: sw, h: sh };
}

/** 잡음 크기(강건한 표준편차): 국소 대비 값들의 MAD */
function robustSigma(dog, n, step = 7) {
  const hist = new Uint32Array(512); let c = 0;
  for (let i = 0; i < n; i += step) { hist[Math.max(-255, Math.min(255, Math.round(dog[i]))) + 256]++; c++; }
  const pct = (p) => { const t = c * p; let a = 0; for (let v = 0; v < 512; v++) { a += hist[v]; if (a >= t) return v - 256; } return 255; };
  const med = pct(0.5);
  const dev = new Uint32Array(512); let c2 = 0;
  for (let i = 0; i < n; i += step) { dev[Math.min(511, Math.abs(Math.round(dog[i]) - med))]++; c2++; }
  let a = 0, mad = 0; for (let v = 0; v < 512; v++) { a += dev[v]; if (a >= c2 / 2) { mad = v; break; } }
  return Math.max(1.5, 1.4826 * mad);
}

/** 작은 점 검출 공통: 국소 대비(원본 - 주변 평균)가 잡음의 k배 이상인 작은 성분 */
function smallSpots(lum, w, h, G, rgba) {
  const n = w * h;
  const mean = ip.boxMean(lum, w, h, 8);
  const dog = new Float32Array(n);
  for (let i = 0; i < n; i++) dog[i] = lum[i] - mean[i];
  const sigma = robustSigma(dog, n);
  const thr = Math.max(G.minDog, G.k * sigma);
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (dog[i] >= thr && lum[i] >= G.minPeak) bin[i] = 1;
  const maxGlint = Math.max(60, n * 0.0004);
  const cc = ip.connectedComponents(bin, w, h, lum, { minArea: 1, maxArea: n * 0.004, maxBlobs: 400 });
  const spots = [], rej = {};
  let maxSnr = 0;
  for (const b of cc.blobs) {
    const ring = ip.ringMean(lum, w, h, b, 4, cc.labels);
    const ratio = (b.peak + 1) / (ring + 1);
    const snr = (b.peak - ring) / sigma;
    let reject = null;
    if (b.area > maxGlint) reject = '큰 밝은 영역(조명·반사면)';
    else if (ratio < G.minRatio) reject = '주변도 밝음(넓은 반사)';
    else if (b.area >= 8 && b.circularity < 0.35) reject = '길쭉한 반사(테두리·모서리)';
    if (reject) { rej[reject] = (rej[reject] || 0) + 1; continue; }
    if (snr > maxSnr) maxSnr = snr;
    const k = G.k;
    const score = Math.round(
      Math.min(1, Math.max(0, (snr - k) / (3 * k))) * 35 +
      Math.min(1, (ratio - 1) / 3) * 25 +
      (b.area <= 12 ? 20 : b.area <= 40 ? 12 : 5) +
      (b.area >= 8 ? b.circularity * 20 : 12));
    const g = { x: b.cx, y: b.cy, area: b.area, peak: b.peak, ratio: +ratio.toFixed(2), snr: +snr.toFixed(1), circularity: +b.circularity.toFixed(2), score };
    if (rgba) { const col = ip.blobColor(rgba, w, b, cc.labels); g.colorName = ip.colorName(ip.rgbToHsv(col.r, col.g, col.b)); }
    spots.push(g);
  }
  spots.sort((a, b) => b.score - a.score);
  return { spots, rej, sigma: +sigma.toFixed(1), thr: +thr.toFixed(1), maxSnr: +maxSnr.toFixed(1), raw: cc.blobs.length };
}

export function analyzeGlints({ rgba, w, h, params: p, streamKey = 'cam' }) {
  const G = GLINT[(p && p.sensitivity) || 'high'] || GLINT.high;
  const n = w * h;
  const lum = ip.rgbaToGray(rgba, n);
  const f = Math.max(1, Math.round(w / 160));
  const sm = downsample(lum, w, h, f);
  let shift = { dx: 0, dy: 0, valid: false };
  const dims = sm.w + 'x' + sm.h;
  if (prevSmall && prevKey === streamKey && prevDims === dims) {
    const a = ip.alignTranslation(prevSmall, sm.data, sm.w, sm.h, 10, 1);
    shift = { dx: a.dx * f, dy: a.dy * f, valid: true, residual: +a.score.toFixed(1) };
  }
  prevSmall = sm.data; prevKey = streamKey; prevDims = dims;
  const r = smallSpots(lum, w, h, G, rgba);
  return {
    mode: 'glint', w, h, glints: r.spots.slice(0, 60), rejected: r.rej, rejectedCount: Object.values(r.rej).reduce((a, b) => a + b, 0), shift,
    stats: { sigma: r.sigma, thr: r.thr, maxSnr: r.maxSnr, raw: r.raw, kept: r.spots.length },
    quality: { brightness: Math.round(ip.mean(lum, 7)), saturated: +ip.saturatedFraction(lum).toFixed(4), sharpness: Math.round(ip.laplacianVariance(sm.data, sm.w, sm.h, 1)) },
  };
}

/** 손전등 켬/끔 차분: 손전등에만 반응하는 약한 반사도 찾는다 (휴대폰을 잠깐 고정했을 때) */
export function analyzeTorchDiff({ on, off, w, h, params: p }) {
  const G = GLINT[(p && p.sensitivity) || 'high'] || GLINT.high;
  const n = w * h;
  const gOn = ip.rgbaToGray(on, n), gOff = ip.rgbaToGray(off, n);
  const f = Math.max(1, Math.round(w / 240));
  const sOn = downsample(gOn, w, h, f), sOff = downsample(gOff, w, h, f);
  const a = ip.alignTranslation(sOff.data, sOn.data, sOn.w, sOn.h, 6, 1);
  const dx = a.dx * f, dy = a.dy * f;
  // 손전등은 화면 전체를 밝히므로 끔 영상의 밝기를 켬 영상 수준으로 맞춘 뒤 뺀다
  const gain = ip.estimateGain(gOn, gOff);
  const diff = new Uint8ClampedArray(n);
  for (let y = 0; y < h; y++) {
    const yy = y - dy;
    for (let x = 0; x < w; x++) {
      const xx = x - dx;
      if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
      const v = gOn[y * w + x] - gain * gOff[yy * w + xx];
      diff[y * w + x] = v > 0 ? v : 0;
    }
  }
  const DG = Object.assign({}, G, { minPeak: G.minDog, minRatio: Math.max(1.3, G.minRatio) });
  const r = smallSpots(diff, w, h, DG, null);
  // 켬 영상에서도 어느 정도 보이는 점만 (차분 잡음 제외)
  // 끔 영상의 같은 자리(정합 보정, 주변 4픽셀)도 밝으면 손전등과 무관한 물체 가장자리 → 제외
  const peakAround = (img, cx, cy, r) => { let m = 0; for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) { const v = img[y * w + x]; if (v > m) m = v; } return m; };
  const spots = r.spots.filter((s) => {
    const x = Math.round(s.x), y = Math.round(s.y);
    const onP = peakAround(gOn, x, y, 2);
    if (onP < G.minPeak * 0.6) return false;
    const offP = peakAround(gOff, x - dx, y - dy, 4) * gain;
    return offP < onP * 0.8;
  }).slice(0, 40);
  return { mode: 'torchDiff', w, h, spots, shift: { dx, dy }, gain: +gain.toFixed(2), stats: { sigma: r.sigma, thr: r.thr, maxSnr: r.maxSnr, raw: r.raw, kept: spots.length } };
}

export function resetGlintState() { prevSmall = null; prevKey = null; prevDims = ''; }

export function run(cmd, payload) {
  switch (cmd) {
    case 'flashDiff': return analyzeFlashDiff(payload);
    case 'spots': return analyzeSpots(payload);
    case 'led': return analyzeLed(payload);
    case 'dark': return analyzeDark(payload);
    case 'glint': return analyzeGlints(payload);
    case 'torchDiff': return analyzeTorchDiff(payload);
    case 'glintReset': resetGlintState(); return { ok: true };
    case 'ping': return { ok: true };
    default: throw new Error('unknown command: ' + cmd);
  }
}
