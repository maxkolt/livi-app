#!/usr/bin/env node
/**
 * Качественная сцена пространственного фона (assets/spatial/stage-hq.jpg) из двух
 * 4×-апскейлов исходника assets/spatial/stage-source.jpg, сделанных Real-ESRGAN
 * (realesrgan-ncnn-vulkan, релиз v0.2.5.0):
 *
 *   realesrgan-ncnn-vulkan -i stage-source.jpg -o x4plus.png -n realesrgan-x4plus
 *   realesrgan-ncnn-vulkan -i stage-source.jpg -o anime.png  -n realesr-animevideov3 -s 4
 *
 * x4plus — основа: чёткие иконки и строки, без JPEG-квадратов, но выбрасывает россыпь точек
 * на континентах; на карте мира поверх него (lighten, мягкая маска) — animevideov3.
 * Правки элементов (MOVES): элемент вычитается из фона как свечение над восстановленным
 * фоном и прибавляется на новом месте (или не прибавляется — убран). На месте микрофона —
 * новый куб с ветвями нейросети (NEURAL_CUBE), нарисованный canvaskit. Затем цвет: бирюза → голубой (фон к
 * ~216°, светлые элементы к голубому LiVi ~203°, чуть приглушённо) и лёгкий холодный тон.
 * Итог — 1440 px по ширине, JPEG 92.
 *
 *   node scripts/build-spatial-stage-hq.js x4plus.png anime.png
 *   node scripts/generate-spatial-depth.js
 */
const path = require('path');
const Jimp = require('jimp-compact');

const OUT = path.join(__dirname, '..', 'assets', 'spatial', 'stage-hq.jpg');

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/**
 * Правки картинки по просьбам пользователя, координаты исходника 572×1024: прямоугольник
 * вокруг элемента вместе со свечением и сдвиг (remove — элемент убрать, оставив фон).
 * Порядок важен: микрофон переезжает на место уже убранных облаков.
 */
const MOVES = [
  // Верхнее левое облако — чуть выше.
  { rect: [104, 144, 234, 252], dx: 0, dy: -28 },
  // Два больших облака снизу слева — убраны.
  { rect: [56, 698, 201, 820], remove: true },
  // Микрофон снизу справа — на место облаков; справа остаётся размытый фон.
  { rect: [436, 684, 526, 812], dx: -353, dy: 10 },
  // Камера под ником на «Поиске» — убрана.
  { rect: [186, 612, 290, 694], remove: true },
  // Камера справа на уровне верха радара — убрана…
  { rect: [427, 249, 541, 326], remove: true },
  // …и на её место — микрофон с левого края (он уходил под край экрана).
  { rect: [31, 470, 96, 562], dx: 436, dy: -228 },
];

/**
 * Новый элемент на месте микрофона: голографический куб, от вершин которого ветвятся линии
 * нейросети с узлами. Рисуется до перекраски в бирюзе, как родные иконки картинки, и
 * прибавляется светом (на тёмном фоне — как свечение).
 */
// Первый вариант — пользователю он понравился больше: ветки частично уходят за правый
// край экрана (телефон в портрете видит по ширине примерно 50…522 из 572).
const NEURAL_CUBE = { cx: 480, cy: 744, r: 24, seed: 0x6c1f2e };

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

/**
 * Сдвигает элемент: фон под ним восстанавливается нормированным размытием окружения
 * (дымка тут гладкая), а сам элемент — это превышение над этим фоном (иконки светятся
 * на тёмном), и оно прибавляется на новом месте.
 */
function moveElement(data, w, h, scale, { rect, dx = 0, dy = 0, remove = false }) {
  const feather = 10 * scale;
  const [rx0, ry0, rx1, ry1] = rect.map((v) => v * scale);
  const sx = dx * scale;
  const sy = dy * scale;
  const pad = 40 * scale;
  const cx0 = Math.max(0, Math.floor(Math.min(rx0, rx0 + sx) - pad));
  const cy0 = Math.max(0, Math.floor(Math.min(ry0, ry0 + sy) - pad));
  const cx1 = Math.min(w, Math.ceil(Math.max(rx1, rx1 + sx) + pad));
  const cy1 = Math.min(h, Math.ceil(Math.max(ry1, ry1 + sy) + pad));
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;
  const mask = (x, y) =>
    smoothstep(rx0 - feather, rx0 + feather, x) * (1 - smoothstep(rx1 - feather, rx1 + feather, x)) *
    smoothstep(ry0 - feather, ry0 + feather, y) * (1 - smoothstep(ry1 - feather, ry1 + feather, y));
  // Фон под элементом — в 1/4 разрешения: он гладкий, а размытие так в 16 раз дешевле.
  const q = 4;
  const qw = Math.ceil(cw / q);
  const qh = Math.ceil(ch / q);
  const valid = new Float32Array(qw * qh);
  const chans = [0, 1, 2].map(() => new Float32Array(qw * qh));
  for (let y = 0; y < qh; y++) {
    for (let x = 0; x < qw; x++) {
      const px = Math.min(w - 1, cx0 + x * q + q / 2);
      const py = Math.min(h - 1, cy0 + y * q + q / 2);
      const v = 1 - mask(px, py);
      valid[y * qw + x] = v;
      const k = (Math.floor(py) * w + Math.floor(px)) * 4;
      for (let c = 0; c < 3; c++) chans[c][y * qw + x] = data[k + c] * v;
    }
  }
  // Два масштаба: мелкое размытие держит фон у краёв, крупное дотягивается до середины
  // большой дыры (ядро обрезано на 3σ — без него в центре было чёрное пятно).
  const fine = 18;
  const coarse = 48;
  const vFine = gaussianBlur(valid, qw, qh, fine);
  const vCoarse = gaussianBlur(valid, qw, qh, coarse);
  const fill = chans.map((ch2) => {
    const a2 = gaussianBlur(ch2, qw, qh, fine);
    const b2 = gaussianBlur(ch2, qw, qh, coarse);
    const out = new Float32Array(a2.length);
    for (let i = 0; i < out.length; i++) {
      const near = a2[i] / Math.max(1e-6, vFine[i]);
      const far = b2[i] / Math.max(1e-6, vCoarse[i]);
      const t = Math.min(1, vFine[i] / 0.05);
      out[i] = far + (near - far) * t;
    }
    return out;
  });
  const fillAt = (x, y, c) => {
    const fx = Math.min(qw - 1.001, Math.max(0, (x - cx0) / q - 0.5));
    const fy = Math.min(qh - 1.001, Math.max(0, (y - cy0) / q - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const f = fill[c];
    return (
      f[y0 * qw + x0] * (1 - tx) * (1 - ty) + f[y0 * qw + x0 + 1] * tx * (1 - ty) +
      f[(y0 + 1) * qw + x0] * (1 - tx) * ty + f[(y0 + 1) * qw + x0 + 1] * tx * ty
    );
  };
  // Свечение элемента над восстановленным фоном.
  const glow = new Float32Array(cw * ch * 3);
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const m = mask(x, y);
      if (m <= 0) continue;
      const k = (y * w + x) * 4;
      const g = ((y - cy0) * cw + (x - cx0)) * 3;
      for (let c = 0; c < 3; c++) {
        const bg = fillAt(x, y, c);
        glow[g + c] = Math.max(0, data[k + c] - bg) * m;
        data[k + c] = data[k + c] * (1 - m) + bg * m;
      }
    }
  }
  if (remove) return;
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const ox = Math.round(x - sx);
      const oy = Math.round(y - sy);
      if (ox < cx0 || oy < cy0 || ox >= cx1 || oy >= cy1) continue;
      const g = ((oy - cy0) * cw + (ox - cx0)) * 3;
      const k = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) data[k + c] = Math.min(255, data[k + c] + glow[g + c]);
    }
  }
}

async function drawNeuralCube(w, h, scale, { cx, cy, r, seed }) {
  const ck = await require(path.join(__dirname, '..', 'node_modules', 'canvaskit-wasm', 'bin', 'full', 'canvaskit.js'))({
    locateFile: (f) => path.join(__dirname, '..', 'node_modules', 'canvaskit-wasm', 'bin', 'full', f),
  });
  let state = seed >>> 0;
  const rnd = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  const surface = ck.MakeSurface(w, h);
  const c = surface.getCanvas();
  c.clear(ck.TRANSPARENT);
  c.scale(scale, scale);
  const paint = (rgb, alpha, { stroke, blur } = {}) => {
    const p = new ck.Paint();
    p.setAntiAlias(true);
    p.setColor(ck.Color(rgb[0], rgb[1], rgb[2], alpha));
    if (stroke) {
      p.setStyle(ck.PaintStyle.Stroke);
      p.setStrokeWidth(stroke);
      p.setStrokeCap(ck.StrokeCap.Round);
      p.setStrokeJoin(ck.StrokeJoin.Round);
    }
    if (blur) p.setMaskFilter(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, blur * scale, false));
    return p;
  };
  const TEAL = [93, 175, 185];
  const LIGHT = [175, 236, 242];

  // Ветви нейросети: от вершин куба наружу, на концах узлы, у части — вторые ветки.
  const tilt = 0.14;
  const corner = (i) => {
    const a = -Math.PI / 2 + (Math.PI / 3) * i + tilt;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const inBounds = (x, y) => x > 372 && x < 556 && y > 650 && y < 872;
  const nodes = [];
  const branch = (x0, y0, angle, length, depth) => {
    const x1 = x0 + Math.cos(angle) * length;
    const y1 = y0 + Math.sin(angle) * length;
    if (!inBounds(x1, y1)) return;
    const bend = (rnd() - 0.5) * length * 0.35;
    const mx = (x0 + x1) / 2 - Math.sin(angle) * bend;
    const my = (y0 + y1) / 2 + Math.cos(angle) * bend;
    const p = new ck.Path();
    p.moveTo(x0, y0);
    p.quadTo(mx, my, x1, y1);
    c.drawPath(p, paint(TEAL, depth ? 0.22 : 0.3, { stroke: 3.2, blur: 1.6 }));
    c.drawPath(p, paint(LIGHT, depth ? 0.42 : 0.6, { stroke: depth ? 0.8 : 1.05 }));
    nodes.push([x1, y1, depth]);
    if (depth < 2) {
      const kids = depth === 0 ? 1 + Math.floor(rnd() * 2) : rnd() < 0.5 ? 1 : 0;
      for (let k = 0; k < kids; k++) {
        branch(x1, y1, angle + (rnd() - 0.5) * 1.3, length * (0.45 + rnd() * 0.25), depth + 1);
      }
    }
  };
  for (let i = 0; i < 6; i++) {
    const [x0, y0] = corner(i);
    const out = Math.atan2(y0 - cy, x0 - cx);
    branch(x0, y0, out + (rnd() - 0.5) * 0.5, 30 + rnd() * 34, 0);
  }
  // Поперечные связи между близкими узлами — сеть, а не дерево.
  const link = paint(LIGHT, 0.22, { stroke: 0.6 });
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]);
      if (d < 34 && rnd() < 0.55) c.drawLine(nodes[i][0], nodes[i][1], nodes[j][0], nodes[j][1], link);
    }
  }
  for (const [x, y, depth] of nodes) {
    c.drawCircle(x, y, depth ? 4 : 5.5, paint(TEAL, 0.4, { blur: 3 }));
    c.drawCircle(x, y, depth ? 1.3 : 1.9, paint(LIGHT, 0.95));
  }

  // Куб: свечение, три грани разной яркости, светлые рёбра.
  const pts = [0, 1, 2, 3, 4, 5].map(corner);
  const hex = new ck.Path();
  pts.forEach(([x, y], i) => (i ? hex.lineTo(x, y) : hex.moveTo(x, y)));
  hex.close();
  c.drawPath(hex, paint(TEAL, 0.45, { blur: 12 }));
  const face = (a, b, d, rgb, alpha) => {
    const f = new ck.Path();
    f.moveTo(cx, cy);
    f.lineTo(...pts[a]);
    f.lineTo(...pts[b]);
    f.lineTo(...pts[d]);
    f.close();
    c.drawPath(f, paint(rgb, alpha));
  };
  face(5, 0, 1, LIGHT, 0.34);
  face(1, 2, 3, TEAL, 0.3);
  face(3, 4, 5, [70, 140, 155], 0.26);
  const edge = paint(LIGHT, 0.9, { stroke: 1.2 });
  c.drawPath(hex, paint(LIGHT, 0.35, { stroke: 3, blur: 1.8 }));
  c.drawPath(hex, edge);
  for (const i of [1, 3, 5]) c.drawLine(cx, cy, pts[i][0], pts[i][1], edge);
  c.drawCircle(cx, cy, 2.2, paint([225, 250, 252], 0.95));

  const px = c.readPixels(0, 0, {
    width: w, height: h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul,
    colorSpace: ck.ColorSpace.SRGB,
  });
  surface.delete();
  return px;
}

async function main() {
  const [x4Path, animePath] = process.argv.slice(2);
  if (!x4Path || !animePath) throw new Error('usage: build-spatial-stage-hq.js x4plus.png anime.png');
  const base = await Jimp.read(x4Path);
  const anime = await Jimp.read(animePath);
  const { width: w, height: h, data: A } = base.bitmap;
  const B = anime.bitmap.data;
  const scale = w / 572;
  // Сначала карта из второй модели — иначе она возвращала убранные элементы (верх камеры).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      // Карта мира — мягкая маска по её рамке в координатах исходника.
      const ox = x / scale;
      const oy = y / scale;
      const map = smoothstep(70, 110, ox) * (1 - smoothstep(455, 495, ox)) * smoothstep(385, 420, oy) * (1 - smoothstep(615, 650, oy));
      if (map <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const d = B[k + c] - A[k + c];
        if (d > 0) A[k + c] = Math.min(255, A[k + c] + d * 0.9 * map);
      }
    }
  }
  for (const move of MOVES) moveElement(A, w, h, scale, move);
  // Куб с нейросетью — светом поверх фона.
  const cube = await drawNeuralCube(w, h, scale, NEURAL_CUBE);
  for (let i = 0; i < w * h * 4; i += 4) {
    if (cube[i + 3] === 0) continue;
    for (let ch = 0; ch < 3; ch++) A[i + ch] = Math.min(255, A[i + ch] + cube[i + ch]);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      let [hue, sat, light] = rgbToHsl(A[k] / 255, A[k + 1] / 255, A[k + 2] / 255);
      if (sat > 0.02) {
        const lum = (0.2126 * A[k] + 0.7152 * A[k + 1] + 0.0722 * A[k + 2]) / 255;
        const target = 216 + (203 - 216) * smoothstep(0.25, 0.6, lum);
        const weight = smoothstep(150, 175, hue) * (1 - smoothstep(235, 255, hue));
        hue += (target - hue) * 0.85 * weight;
        sat *= 1 - 0.1 * weight;
        const [r, g, b] = hslToRgb(hue, sat, light);
        A[k] = Math.round(r * 255);
        A[k + 1] = Math.round(g * 255);
        A[k + 2] = Math.round(b * 255);
      }
      // Холоднее: фон из серо-бирюзового становится голубоватым.
      A[k] = Math.min(255, Math.round(A[k] * 0.9));
      A[k + 1] = Math.min(255, Math.round(A[k + 1] * 0.96));
      A[k + 2] = Math.min(255, Math.round(A[k + 2] * 1.07));
    }
  }
  await base.resize(1440, Jimp.AUTO, Jimp.RESIZE_BICUBIC).quality(92).writeAsync(OUT);
  console.log(`${path.relative(process.cwd(), OUT)}  1440 px`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
