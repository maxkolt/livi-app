#!/usr/bin/env node
/**
 * Запекает рендер кольца в геометрию живой рамки аватара.
 *
 * Исходники в assets/frames/source — кольца произвольной толщины. Рамка же
 * рисуется в полосе от 0.415 до 0.492 стороны (как огонь). Скрипт делает
 * полярную пересборку: радиус источника [srcIn, srcOut] ложится в долю полосы
 * [0, tMax], а угол повторяется repeat раз — так широкое кольцо становится тонким,
 * а камни не сплющиваются. На устройстве ImageShader внутри RuntimeEffect не
 * использует мипмапы, поэтому сжимаем здесь, с суперсэмплингом.
 *
 *   node scripts/bake-frame-ring.js
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const FRAMES_DIR = path.join(__dirname, '..', 'assets', 'frames');
/** Должны совпадать с BAKED_INNER / BAKED_BAND в шейдерах рамок. */
const BAKED_INNER = 0.415;
const BAKED_BAND = 0.077;

const RINGS = [
  {
    name: 'diamond-ring',
    source: 'source/diamond-ring-source.png',
    // Центр внутренней окружности источника (кольцо в картинке чуть смещено).
    center: [0.502, 0.489],
    srcIn: 0.302,
    srcOut: 0.468,
    tMax: 0.74,
    repeat: 3,
  },
  {
    name: 'ice-ring',
    source: 'source/ice-ring-source.png',
    center: [0.5015, 0.49],
    srcIn: 0.405,
    srcOut: 0.495,
    tMax: 0.7,
    repeat: 1,
  },
];
const SIZES = [512, 256];
const SUPERSAMPLE = 6;

function readPremultiplied(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const { width, height, data } = png;
  const pm = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    pm[i * 4] = (data[i * 4] / 255) * a;
    pm[i * 4 + 1] = (data[i * 4 + 1] / 255) * a;
    pm[i * 4 + 2] = (data[i * 4 + 2] / 255) * a;
    pm[i * 4 + 3] = a;
  }
  return { width, height, pm };
}

function bilinear(src, x, y, out) {
  const { width, height, pm } = src;
  x -= 0.5;
  y -= 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  out.fill(0);
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const xi = x0 + i;
      const yi = y0 + j;
      if (xi < 0 || yi < 0 || xi >= width || yi >= height) continue;
      const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const k = (yi * width + xi) * 4;
      for (let c = 0; c < 4; c++) out[c] += pm[k + c] * w;
    }
  }
}

function bake(ring, size) {
  const src = readPremultiplied(path.join(FRAMES_DIR, ring.source));
  const out = new PNG({ width: size, height: size });
  const sample = [0, 0, 0, 0];
  const acc = [0, 0, 0, 0];
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      acc.fill(0);
      for (let sj = 0; sj < SUPERSAMPLE; sj++) {
        for (let si = 0; si < SUPERSAMPLE; si++) {
          const px = (x + (si + 0.5) / SUPERSAMPLE) / size - 0.5;
          const py = (y + (sj + 0.5) / SUPERSAMPLE) / size - 0.5;
          const t = (Math.hypot(px, py) - BAKED_INNER) / BAKED_BAND;
          const srcR = ring.srcIn + (t / ring.tMax) * (ring.srcOut - ring.srcIn);
          if (srcR < 0.05) continue;
          const angle = Math.atan2(py, px) * ring.repeat;
          bilinear(
            src,
            (ring.center[0] + srcR * Math.cos(angle)) * src.width,
            (ring.center[1] + srcR * Math.sin(angle)) * src.height,
            sample,
          );
          for (let c = 0; c < 4; c++) acc[c] += sample[c];
        }
      }
      const k = (y * size + x) * 4;
      const a = acc[3] / n;
      for (let c = 0; c < 3; c++) {
        out.data[k + c] = a > 1e-4 ? Math.round(Math.min(1, acc[c] / n / a) * 255) : 0;
      }
      out.data[k + 3] = Math.round(a * 255);
    }
  }
  const file = path.join(FRAMES_DIR, `${ring.name}-${size}.png`);
  fs.writeFileSync(file, PNG.sync.write(out, { colorType: 6 }));
  console.log(`${path.relative(process.cwd(), file)}  ${fs.statSync(file).size} B`);
}

for (const ring of RINGS) {
  for (const size of SIZES) bake(ring, size);
}
