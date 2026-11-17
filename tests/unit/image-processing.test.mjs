import test from 'node:test';
import assert from 'node:assert/strict';
import * as ip from '../../js/image-processing.js';
import { makeImage, disk, shift } from './helpers.mjs';

test('rgbaToGray 계산', () => {
  const g = ip.rgbaToGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2);
  assert.equal(g[0], 255); assert.equal(g[1], 0);
});

test('gaussianBlur는 평탄한 영상을 유지', () => {
  const src = new Uint8ClampedArray(100).fill(120);
  const out = ip.gaussianBlur(src, 10, 10);
  assert.ok(out.every((v) => Math.abs(v - 120) <= 1));
});

test('alignTranslation이 평행이동을 찾음', () => {
  const w = 160, h = 120;
  const a = makeImage(w, h, 80, 40, 7);
  for (let k = 0; k < 12; k++) disk(a, w, 20 + k * 11, 30 + (k % 4) * 20, 4, 220);
  const b = shift(a, w, h, 3, -2);
  const ga = ip.rgbaToGray(a, w * h), gb = ip.rgbaToGray(b, w * h);
  const r = ip.alignTranslation(ga, gb, w, h, 6, 2);
  assert.equal(r.dx, 3); assert.equal(r.dy, -2);
});

test('connectedComponents: 원형/선형 구분', () => {
  const w = 60, h = 40, bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if ((x - 15) ** 2 + (y - 20) ** 2 <= 25) bin[y * w + x] = 1;
    if (y === 10 && x >= 30 && x < 55) { bin[y * w + x] = 1; bin[(y + 1) * w + x] = 1; }
  }
  const { blobs } = ip.connectedComponents(bin, w, h, null);
  assert.equal(blobs.length, 2);
  const disc = blobs.find((b) => Math.abs(b.cx - 15) < 1);
  const line = blobs.find((b) => b !== disc);
  assert.ok(disc.circularity > 0.75, 'disc ' + disc.circularity);
  assert.ok(line.circularity < 0.3, 'line ' + line.circularity);
});

test('percentile / estimateGain', () => {
  const a = new Uint8ClampedArray(1000).map((_, i) => i % 256);
  assert.ok(Math.abs(ip.percentile(a, 50) - 124) <= 6);
  const g = ip.estimateGain(new Uint8ClampedArray(100).fill(200), new Uint8ClampedArray(100).fill(100));
  assert.ok(g > 1.9 && g < 2.1);
});

test('laplacianVariance: 질감이 있으면 크다', () => {
  const flat = new Uint8ClampedArray(64 * 64).fill(100);
  let s = 5; const tex = new Uint8ClampedArray(64 * 64).map(() => { s = (s * 1103515245 + 12345) & 0x7fffffff; return 50 + (s % 150); });
  assert.ok(ip.laplacianVariance(tex, 64, 64) > ip.laplacianVariance(flat, 64, 64) + 1000);
});

test('rgbToHsv / colorName', () => {
  assert.equal(ip.colorName(ip.rgbToHsv(255, 20, 20)), '적색');
  assert.equal(ip.colorName(ip.rgbToHsv(240, 240, 240)), '백색');
  assert.equal(ip.colorName(ip.rgbToHsv(20, 230, 40)), '녹색');
});
