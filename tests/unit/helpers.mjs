/** 합성 RGBA 영상 생성 도우미 (테스트 전용 — 실제 탐지 데이터와 분리) */
export function makeImage(w, h, bg = 90, noise = 6, seed = 1) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = bg + (rnd() - 0.5) * 2 * noise + ((i % w) / w) * 20;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  return d;
}
export function disk(d, w, cx, cy, r, val, rgb = null) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
      const j = (y * w + x) * 4;
      if (rgb) { d[j] = rgb[0]; d[j + 1] = rgb[1]; d[j + 2] = rgb[2]; } else d[j] = d[j + 1] = d[j + 2] = val;
    }
  }
}
export function rect(d, w, x0, y0, rw, rh, val) {
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) { const j = (y * w + x) * 4; d[j] = d[j + 1] = d[j + 2] = val; }
}
export function shift(d, w, h, dx, dy) {
  const o = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(w - 1, Math.max(0, x - dx)), sy = Math.min(h - 1, Math.max(0, y - dy));
    const a = (y * w + x) * 4, b = (sy * w + sx) * 4;
    o[a] = d[b]; o[a + 1] = d[b + 1]; o[a + 2] = d[b + 2]; o[a + 3] = 255;
  }
  return o;
}
export function scale(d, k) { const o = new Uint8ClampedArray(d.length); for (let i = 0; i < d.length; i++) o[i] = (i % 4 === 3) ? 255 : d[i] * k; return o; }
