/**
 * CheatingGuard 영상처리 기본 연산 (순수 JavaScript, 브라우저·Web Worker·Node 공용)
 * 모든 함수는 8비트 단일 채널 배열(Uint8ClampedArray / Uint8Array)을 다룬다.
 */

/** RGBA → Grayscale (BT.601 근사) */
export function rgbaToGray(rgba, n, out) {
  if (!out || out.length !== n) out = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return out;
}

/** 5탭 가우시안 블러 [1 4 6 4 1]/16 (분리형) */
export function gaussianBlur(src, w, h, out, tmp) {
  const n = w * h;
  if (!out || out.length !== n) out = new Uint8ClampedArray(n);
  if (!tmp || tmp.length !== n) tmp = new Uint16Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xm2 = x > 1 ? x - 2 : 0, xm1 = x > 0 ? x - 1 : 0;
      const xp1 = x < w - 1 ? x + 1 : w - 1, xp2 = x < w - 2 ? x + 2 : w - 1;
      tmp[row + x] = src[row + xm2] + 4 * src[row + xm1] + 6 * src[row + x] + 4 * src[row + xp1] + src[row + xp2];
    }
  }
  for (let y = 0; y < h; y++) {
    const ym2 = (y > 1 ? y - 2 : 0) * w, ym1 = (y > 0 ? y - 1 : 0) * w, y0 = y * w;
    const yp1 = (y < h - 1 ? y + 1 : h - 1) * w, yp2 = (y < h - 2 ? y + 2 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      out[y0 + x] = (tmp[ym2 + x] + 4 * tmp[ym1 + x] + 6 * tmp[y0 + x] + 4 * tmp[yp1 + x] + tmp[yp2 + x] + 128) >> 8;
    }
  }
  return out;
}

/** 적분 영상 ((w+1)*(h+1)) */
export function integralImage(src, w, h, out) {
  const W = w + 1;
  if (!out || out.length !== W * (h + 1)) out = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x];
      out[(y + 1) * W + x + 1] = out[y * W + x + 1] + rowSum;
    }
  }
  return out;
}

/** 반경 r 박스 평균 */
export function boxMean(src, w, h, r, out, integ) {
  const n = w * h;
  if (!out || out.length !== n) out = new Float32Array(n);
  const I = integralImage(src, w, h, integ);
  const W = w + 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const s = I[(y1 + 1) * W + x1 + 1] - I[y0 * W + x1 + 1] - I[(y1 + 1) * W + x0] + I[y0 * W + x0];
      out[y * w + x] = s / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}

/** 밝은 소형 구조 강조 (화이트 탑햇 근사: 원본 - 국소 평균) */
export function topHat(src, w, h, r, out) {
  const mean = boxMean(src, w, h, r);
  const n = w * h;
  if (!out || out.length !== n) out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) out[i] = src[i] - mean[i];
  return out;
}

/** 어두운 소형 구조 강조 (블랙 탑햇 근사: 국소 평균 - 원본) */
export function blackHat(src, w, h, r, out) {
  const mean = boxMean(src, w, h, r);
  const n = w * h;
  if (!out || out.length !== n) out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) out[i] = mean[i] - src[i];
  return out;
}

/** 적응형 임계값: 국소 평균 + C 이상이고 절대값 minAbs 이상이면 1 */
export function adaptiveThreshold(src, w, h, r, C, minAbs, out) {
  const mean = boxMean(src, w, h, r);
  const n = w * h;
  if (!out || out.length !== n) out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (src[i] >= minAbs && src[i] > mean[i] + C) ? 1 : 0;
  return out;
}

/** 단순 임계값 */
export function threshold(src, n, t, out) {
  if (!out || out.length !== n) out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = src[i] >= t ? 1 : 0;
  return out;
}

/** 8비트 히스토그램 기반 백분위수 */
export function percentile(src, p, step = 1) {
  const hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < src.length; i += step) { hist[src[i]]++; count++; }
  const target = Math.max(1, Math.round(count * p / 100));
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
  return 255;
}

export function mean(src, step = 1) {
  let s = 0, c = 0;
  for (let i = 0; i < src.length; i += step) { s += src[i]; c++; }
  return c ? s / c : 0;
}

/** 포화(과다 노출) 픽셀 비율 */
export function saturatedFraction(src, t = 250, step = 2) {
  let s = 0, c = 0;
  for (let i = 0; i < src.length; i += step) { if (src[i] >= t) s++; c++; }
  return c ? s / c : 0;
}

/** 노출 차이 보정용 이득 추정 (중앙값 비율, 0.4~4로 제한) */
export function estimateGain(on, off) {
  const mOn = percentile(on, 50, 3), mOff = percentile(off, 50, 3);
  const g = (mOn + 1) / (mOff + 1);
  return Math.min(4, Math.max(0.4, g));
}

/**
 * 전역 평행이동 정합. mov(x+dx, y+dy) ≈ ref(x, y)를 만족하는 (dx, dy) 탐색.
 * 이득 차이 영향을 줄이기 위해 각 영상의 평균을 뺀 SAD 사용.
 */
export function alignTranslation(ref, mov, w, h, maxShift = 8, sample = 3) {
  const mR = mean(ref, 7), mM = mean(mov, 7);
  const margin = maxShift + 1;
  let best = { dx: 0, dy: 0, score: Infinity };
  let zeroScore = Infinity;
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let s = 0, c = 0;
      for (let y = margin; y < h - margin; y += sample) {
        const r0 = y * w, m0 = (y + dy) * w + dx;
        for (let x = margin; x < w - margin; x += sample) {
          const d = (ref[r0 + x] - mR) - (mov[m0 + x] - mM);
          s += d < 0 ? -d : d; c++;
        }
      }
      const sc = c ? s / c : Infinity;
      if (dx === 0 && dy === 0) zeroScore = sc;
      if (sc < best.score) best = { dx, dy, score: sc };
    }
  }
  best.zeroScore = zeroScore;
  return best;
}

/** 정합·노출 보정 후 양의 차분: max(0, on(x+dx,y+dy) - gain*off(x,y)) */
export function diffAligned(on, off, w, h, dx, dy, gain, out) {
  const n = w * h;
  if (!out || out.length !== n) out = new Uint8ClampedArray(n);
  for (let y = 0; y < h; y++) {
    const yy = y + dy;
    for (let x = 0; x < w; x++) {
      const xx = x + dx;
      const i = y * w + x;
      if (yy < 0 || yy >= h || xx < 0 || xx >= w) { out[i] = 0; continue; }
      const v = on[yy * w + xx] - gain * off[i];
      out[i] = v > 0 ? v : 0;
    }
  }
  return out;
}

/** 라플라시안 분산 (초점·흔들림 품질 지표) */
export function laplacianVariance(src, w, h, step = 2) {
  let s = 0, s2 = 0, c = 0;
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const i = y * w + x;
      const v = 4 * src[i] - src[i - 1] - src[i + 1] - src[i - w] - src[i + w];
      s += v; s2 += v * v; c++;
    }
  }
  if (!c) return 0;
  const m = s / c;
  return s2 / c - m * m;
}

/** 3x3 이진 침식/팽창 */
export function morph(bin, w, h, op, out) {
  const n = w * h;
  if (!out || out.length !== n) out = new Uint8Array(n);
  const erode = op === 'erode';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let ky = -1; ky <= 1 && (erode ? v === 1 : v === 0); ky++) {
        const yy = y + ky;
        if (yy < 0 || yy >= h) { if (erode) v = 0; continue; }
        for (let kx = -1; kx <= 1; kx++) {
          const xx = x + kx;
          if (xx < 0 || xx >= w) { if (erode) { v = 0; break; } continue; }
          const b = bin[yy * w + xx];
          if (erode && !b) { v = 0; break; }
          if (!erode && b) { v = 1; break; }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * 모폴로지 열림. 소형 반사점(1~4픽셀)이 사라지지 않도록,
 * 열림 결과에 남지 않은 원래 성분 중 "고립된 작은 점"은 보존하지 않고
 * 잡음 화소만 제거하는 방식(침식 후 팽창)을 사용한다.
 */
export function opening(bin, w, h) { return morph(morph(bin, w, h, 'erode'), w, h, 'dilate'); }
export function closing(bin, w, h) { return morph(morph(bin, w, h, 'dilate'), w, h, 'erode'); }

/** 고립 단일 화소 잡음 제거 (8-이웃 중 1개 미만) — 작은 반사점 보존용 경량 필터 */
export function removeIsolated(bin, w, h, out) {
  const n = w * h;
  if (!out || out.length !== n) out = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!bin[i]) { out[i] = 0; continue; }
      let c = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const yy = y + ky; if (yy < 0 || yy >= h) continue;
        for (let kx = -1; kx <= 1; kx++) {
          const xx = x + kx; if ((kx || ky) && xx >= 0 && xx < w && bin[yy * w + xx]) c++;
        }
      }
      out[i] = c >= 1 ? 1 : 0;
    }
  }
  return out;
}

/**
 * 연결 성분 분석 (8-연결). values: 성분 내 밝기 통계용 단일 채널 영상.
 * 반환: { blobs, labels, truncated }
 */
export function connectedComponents(bin, w, h, values, opts = {}) {
  const { minArea = 1, maxArea = Infinity, maxBlobs = 400 } = opts;
  const n = w * h;
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  const blobs = [];
  let next = 1, truncated = false;
  for (let start = 0; start < n; start++) {
    if (!bin[start] || labels[start]) continue;
    if (next > maxBlobs * 4) { truncated = true; break; }
    const lab = next++;
    let sp = 0; stack[sp++] = start; labels[start] = lab;
    let area = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sumV = 0, peak = 0, peakIdx = start, boundary = 0;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      area++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      const v = values ? values[i] : 255;
      sumV += v; if (v > peak) { peak = v; peakIdx = i; }
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      let isBoundary = false;
      for (let ky = -1; ky <= 1; ky++) {
        const yy = y + ky;
        if (yy < 0 || yy >= h) { isBoundary = true; continue; }
        for (let kx = -1; kx <= 1; kx++) {
          if (!kx && !ky) continue;
          const xx = x + kx;
          if (xx < 0 || xx >= w) { isBoundary = true; continue; }
          const j = yy * w + xx;
          if (!bin[j]) { if (!kx || !ky) isBoundary = true; continue; }
          if (!labels[j]) { labels[j] = lab; stack[sp++] = j; }
        }
      }
      if (isBoundary) boundary++;
    }
    if (area < minArea || area > maxArea) { blobs.push(null); continue; }
    const cx = sx / area, cy = sy / area;
    const vxx = sxx / area - cx * cx + 1 / 12, vyy = syy / area - cy * cy + 1 / 12, vxy = sxy / area - cx * cy;
    const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
    const roundness = Math.sqrt(l2 / l1);
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    const circularity = Math.min(1, roundness * Math.min(1, fill / 0.785));
    blobs.push({
      label: lab, area, cx, cy, minX, minY, maxX, maxY, bw, bh,
      meanV: sumV / area, peak, peakIdx, boundary, roundness, fill, circularity,
      radius: Math.sqrt(area / Math.PI),
    });
  }
  const valid = blobs.filter(Boolean);
  if (valid.length > maxBlobs) truncated = true;
  return { blobs: valid.slice(0, maxBlobs), labels, truncated };
}

/** 블롭 외곽 고리 영역의 평균 밝기 */
export function ringMean(src, w, h, blob, pad = 3, labels = null) {
  const x0 = Math.max(0, blob.minX - pad), x1 = Math.min(w - 1, blob.maxX + pad);
  const y0 = Math.max(0, blob.minY - pad), y1 = Math.min(h - 1, blob.maxY + pad);
  let s = 0, c = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const inside = x >= blob.minX && x <= blob.maxX && y >= blob.minY && y <= blob.maxY;
      if (inside) continue;
      const i = y * w + x;
      if (labels && labels[i]) continue;
      s += src[i]; c++;
    }
  }
  return c ? s / c : 0;
}

/** 블롭 내부 평균 (라벨 기준) */
export function blobMean(src, w, blob, labels) {
  let s = 0, c = 0;
  for (let y = blob.minY; y <= blob.maxY; y++) {
    for (let x = blob.minX; x <= blob.maxX; x++) {
      const i = y * w + x;
      if (labels[i] === blob.label) { s += src[i]; c++; }
    }
  }
  return c ? s / c : 0;
}

/** 블롭 영역 최대값 */
export function blobMax(src, w, blob, labels) {
  let m = 0;
  for (let y = blob.minY; y <= blob.maxY; y++) {
    for (let x = blob.minX; x <= blob.maxX; x++) {
      const i = y * w + x;
      if (labels[i] === blob.label && src[i] > m) m = src[i];
    }
  }
  return m;
}

/** 사각 영역 최댓값 (경계 포함 확장 영역) */
export function regionMax(src, w, h, x0, y0, x1, y1) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1);
  let m = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = src[y * w + x]; if (v > m) m = v; }
  return m;
}

/** 블롭 평균 RGB (RGBA 원본 기준) */
export function blobColor(rgba, w, blob, labels) {
  let r = 0, g = 0, b = 0, c = 0;
  for (let y = blob.minY; y <= blob.maxY; y++) {
    for (let x = blob.minX; x <= blob.maxX; x++) {
      const i = y * w + x;
      if (labels[i] === blob.label) { const j = i * 4; r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; c++; }
    }
  }
  return c ? { r: r / c, g: g / c, b: b / c } : { r: 0, g: 0, b: 0 };
}

/** RGB → 색상(Hue, 도), 채도(0~1), 명도(0~1) */
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d) {
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60; if (hh < 0) hh += 360;
  }
  return { h: hh, s: mx ? d / mx : 0, v: mx };
}

export function colorName(hsv) {
  if (hsv.s < 0.22) return '백색';
  const h = hsv.h;
  if (h < 20 || h >= 330) return '적색';
  if (h < 45) return '주황색';
  if (h < 70) return '황색';
  if (h < 170) return '녹색';
  if (h < 260) return '청색';
  return '자주색';
}
