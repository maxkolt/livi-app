#!/usr/bin/env node
/** Ровная подложка; перенос куба без масштабирования, одинаковый цвет его граней. */
const path = require('path');
const Jimp = require('jimp-compact');
const { BACKGROUND, CUBE_FACE, LOWER_CUBE, SOURCE_WIDTH, UPPER_CUBE } = require('./spatial-stage-style');
const { repaintCube } = require('./spatial-cube');
const { findElements, layout, assignPlanes, shapeElements, fillBackground } = require('./generate-spatial-depth');

function cubeVertices(w, cube) {
  const s = w / SOURCE_WIDTH;
  return Array.from({ length: 6 }, (_, i) => {
    const a = -Math.PI / 2 + Math.PI / 3 * i + 0.14;
    return [(cube.cx + Math.cos(a) * cube.r) * s, (cube.cy + Math.sin(a) * cube.r) * s];
  });
}

function cubeMask(w, h, cube) {
  const points = cubeVertices(w, cube);
  const mask = new Uint8Array(w * h);
  const minX = Math.max(0, Math.floor(Math.min(...points.map(p => p[0])) - 2));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(...points.map(p => p[0])) + 2));
  const minY = Math.max(0, Math.floor(Math.min(...points.map(p => p[1])) - 2));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(...points.map(p => p[1])) + 2));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const inside = points.every((a, i) => {
      const b = points[(i + 1) % 6];
      return ((b[0] - a[0]) * (y + 0.5 - a[1]) - (b[1] - a[1]) * (x + 0.5 - a[0])) /
        Math.hypot(b[0] - a[0], b[1] - a[1]) >= -1.5;
    });
    if (inside) mask[y * w + x] = 1;
  }
  return mask;
}

async function normalizeStage(input, output = input, { legacyCube = false } = {}) {
  const image = await Jimp.read(input);
  const { width: w, height: h, data } = image.bitmap;
  const original = Buffer.from(data);
  const s = w / SOURCE_WIDTH;
  const sourceCube = legacyCube ? { cx: 480, cy: 744, r: 24 } : LOWER_CUBE;
  const protectedCube = cubeMask(w, h, sourceCube);
  const movedCube = new Uint8Array(w * h);
  const dx = Math.round((LOWER_CUBE.cx - sourceCube.cx) * s);
  const dy = Math.round((LOWER_CUBE.cy - sourceCube.cy) * s);

  // Вся бывшая зона ветвей — один цвет. Отдельная частица выше куба сохраняется.
  for (let y = Math.round(630 * s); y < Math.min(h, Math.round(875 * s)); y++) {
    for (let x = Math.round(372 * s); x < w; x++) {
      if (Math.hypot(x / s - 537.85, y / s - 693.13) < 12.4) continue;
      for (let c = 0; c < 3; c++) data[(y * w + x) * 4 + c] = BACKGROUND[c];
    }
  }
  for (let i = 0; i < protectedCube.length; i++) {
    if (!protectedCube[i]) continue;
    const target = i + dy * w + dx;
    if (target < 0 || target >= w * h) throw new Error('Cube outside the scene');
    movedCube[target] = 1;
    original.copy(data, target * 4, i * 4, i * 4 + 4);
  }

  const rgb = [0, 1, 2].map(c => Float32Array.from({ length: w * h }, (_, i) => data[i * 4 + c]));
  const lum = Float32Array.from(rgb[0], (_, i) => 0.2126 * rgb[0][i] + 0.7152 * rgb[1][i] + 0.0722 * rgb[2][i]);
  const detected = findElements(lum, w, h);
  const first = layout(detected.region, w, h);
  const named = assignPlanes({ ...detected, ...first }, w, h);
  const shaped = shapeElements(detected.region, first.labels, named.why, w, h);
  const elements = layout(shaped, w, h);
  const { why } = assignPlanes({ ...detected, ...elements }, w, h);
  const fill = fillBackground(rgb, elements.weight, w, h);
  const solidIcons = new Set(['bubble', 'camera', 'mic', 'cube-top']);
  let protectedPixels = 0;
  for (let i = 0; i < w * h; i++) {
    if (movedCube[i]) { protectedPixels++; continue; }
    const delta = rgb.map((ch, c) => ch[i] - fill[c][i]);
    const rise = 0.2126 * delta[0] + 0.7152 * delta[1] + 0.0722 * delta[2];
    const t = Math.min(1, Math.max(0, (rise - 1) / 3));
    const strength = elements.weight[i] * t * t * (3 - 2 * t);
    const solid = solidIcons.has(why[elements.labels[i]]) && rise >= 7;
    for (let c = 0; c < 3; c++) {
      const value = solid ? rgb[c][i] : BACKGROUND[c] + delta[c] * strength;
      data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  // Чистая геометрия в прежнем размере; все рёбра обрезаны внутри общего силуэта.
  await repaintCube(image, UPPER_CUBE, { padding: 12 });
  await repaintCube(image, LOWER_CUBE);
  await image.writeAsync(output);
  console.log(`uniform stage: ${w}×${h}; cube ${dx},${dy}px; faces ${CUBE_FACE.join(',')}; clean 4× vector edges`);
  return { width: w, height: h, dx, dy, protectedPixels };
}

if (require.main === module) {
  const input = process.argv[2] || path.join(__dirname, '..', 'assets', 'spatial', 'stage-hq.png');
  const output = path.join(__dirname, '..', 'assets', 'spatial', 'stage-hq.png');
  normalizeStage(input, output, { legacyCube: process.argv.includes('--legacy-cube') })
    .catch(error => { console.error(error); process.exit(1); });
}
module.exports = { normalizeStage, cubeMask };
