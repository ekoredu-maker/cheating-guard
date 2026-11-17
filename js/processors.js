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

export function run(cmd, payload) {
  switch (cmd) {
    case 'flashDiff': return analyzeFlashDiff(payload);
    case 'spots': return analyzeSpots(payload);
    case 'led': return analyzeLed(payload);
    case 'dark': return analyzeDark(payload);
    case 'ping': return { ok: true };
    default: throw new Error('unknown command: ' + cmd);
  }
}
