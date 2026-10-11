#!/usr/bin/env node
/**
 * Пространственный фон главного экрана (SpatialDepth.kt): картинка сцены и её карта глубины.
 *
 * assets/spatial/stage-source.jpg — исходник 572×1024. assets/spatial/stage-hq.jpg — он же
 * после Real-ESRGAN и перекраски бирюзы в голубой (scripts/build-spatial-stage-hq.js).
 * Скрипт копирует её в res как есть, глубину считает по ней же (уменьшенной до 572 px —
 * элементы, перенесённые при сборке, переезжают и в глубине) и пишет размытую копию для
 * стеклянных блоков (SpatialGlassView): они показывают её кусок под собой, а не размывают
 * сцену на каждом кадре.
 *
 * Глубина = насколько место ярче окружения после размытия: светлые крупные иконки (облака,
 * камеры, микрофоны) — ближний план у стекла (1), тёмная дымка — дальний (0). Затем ещё одно
 * размытие, чтобы при параллаксе края иконок тянулись мягко, без разрывов.
 *
 *   node scripts/generate-spatial-depth.js
 */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp-compact');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const HQ = path.join(ROOT, 'assets', 'spatial', 'stage-hq.jpg');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'drawable-nodpi');
const OUT_IMAGE = path.join(RES, 'spatial_stage.jpg');
const OUT_DEPTH = path.join(RES, 'spatial_stage_depth.png');
const OUT_BLUR = path.join(RES, 'spatial_stage_blur.jpg');
/** Размытая копия — в 1/4 ширины сцены: она гладкая, GPU растянет её без потерь. */
const BLUR_WIDTH = 360;
/** Сигма в пикселях копии: ×4 ≈ 10 px на сцене 1440 — прозрачное стекло, фон угадывается. */
const BLUR_SIGMA = 2.5;

function gaussianBlur(src, w, h, sigma) {
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  let norm = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    norm += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= norm;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += src[y * w + Math.min(w - 1, Math.max(0, x + k))] * kernel[k + radius];
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x] * kernel[k + radius];
      out[y * w + x] = acc;
    }
  }
  return out;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

async function main() {
  const image = (await Jimp.read(HQ)).resize(572, 1024, Jimp.RESIZE_BICUBIC);
  const { width: w, height: h, data } = image.bitmap;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
  }
  // Ярче окрестности — ближе: фон местами светлее (низ, середина), иконки выделяются
  // именно на фоне своего окружения.
  const near = gaussianBlur(lum, w, h, 5);
  const surround = gaussianBlur(lum, w, h, 40);
  const depth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const icon = smoothstep(0.03, 0.2, near[i] - surround[i]) * smoothstep(0.2, 0.34, near[i]);
      // Лёгкий купол к центру: карта мира чуть ближе краёв сцены.
      const dx = (x / w - 0.5) / 0.5;
      const dy = (y / h - 0.48) / 0.5;
      depth[i] = Math.max(icon, 0.18 * Math.max(0, 1 - (dx * dx + dy * dy)));
    }
  }
  const smooth = gaussianBlur(depth, w, h, 4);

  const dw = Math.round(w / 2);
  const dh = Math.round(h / 2);
  const png = new PNG({ width: dw, height: dh });
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) acc += smooth[Math.min(h - 1, y * 2 + j) * w + Math.min(w - 1, x * 2 + i)];
      }
      const v = Math.round(Math.min(1, acc / 4) * 255);
      const k = (y * dw + x) * 4;
      png.data[k] = v;
      png.data[k + 1] = v;
      png.data[k + 2] = v;
      png.data[k + 3] = 255;
    }
  }
  fs.writeFileSync(OUT_DEPTH, PNG.sync.write(png, { colorType: 0 }));
  fs.copyFileSync(HQ, OUT_IMAGE);
  const hq = await Jimp.read(HQ);

  const small = hq.clone().resize(BLUR_WIDTH, Jimp.AUTO, Jimp.RESIZE_BICUBIC);
  const { width: bw, height: bh, data: bd } = small.bitmap;
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) ch[i] = bd[i * 4 + c];
    const blurred = gaussianBlur(ch, bw, bh, BLUR_SIGMA);
    for (let i = 0; i < bw * bh; i++) bd[i * 4 + c] = Math.round(blurred[i]);
  }
  await small.quality(90).writeAsync(OUT_BLUR);
  console.log(`${path.relative(ROOT, OUT_BLUR)}  ${bw}x${bh}  ${fs.statSync(OUT_BLUR).size} B`);
  console.log(`${path.relative(ROOT, OUT_IMAGE)}  ${hq.bitmap.width}x${hq.bitmap.height}  ${fs.statSync(OUT_IMAGE).size} B`);
  console.log(`${path.relative(ROOT, OUT_DEPTH)}  ${dw}x${dh}  ${fs.statSync(OUT_DEPTH).size} B`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
