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
 * В конце убирается туман — светлая дымка пятнами по фону (removeHaze) — и дым: слабое
 * свечение вокруг элементов и в пустых местах (suppressSmoke); основной фон становится
 * серым в тон приложению (grayBackground), элементы остаются голубыми.
 * Затем чёткость (sharpen). Итог — 1440 px по ширине, JPEG 95.
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
/** Сдвиг карты мира по вертикали (координаты исходника) — для её маски после переноса. */
const MAP_SHIFT_Y = -110;

const MOVES = [
  // Верхнее левое облако — чуть выше.
  { rect: [104, 144, 234, 252], dx: 0, dy: -28 },
  // Два больших облака снизу слева — убраны.
  { rect: [56, 698, 201, 820], remove: true },
  // Микрофон снизу справа — убран (сначала стоял на месте облаков, теперь там соты; на
  // его месте справа — куб с нейросетью).
  { rect: [436, 684, 526, 812], remove: true },
  // Камера справа на уровне верха радара — убрана…
  { rect: [427, 249, 541, 326], remove: true },
  // …и на её место — микрофон с левого края (он уходил под край экрана).
  { rect: [31, 470, 96, 562], dx: 436, dy: -228 },
  // Камера у левого края радара — убрана: камера слева одна, на месте микрофона.
  { rect: [106, 338, 188, 394], remove: true },
  // Камера из-под ника на «Поиске» — на место этого микрофона слева посередине, правее
  // него: на A35 видимая ширина начинается с ~58 из 572, и камера целиком на экране.
  // gain — приглушена: была ярче соседних иконок.
  { rect: [186, 612, 290, 694], dx: -137, dy: -139, gain: 0.6 },
  // Облака сообщений под радаром — убраны. Растушёвка узкая: прямо над ними Австралия.
  { rect: [323, 594, 418, 660], remove: true, feather: 5 },
  // Двойное облако, просвечивающее за радаром сверху, — убрано.
  { rect: [236, 252, 338, 330], remove: true, feather: 6 },
  // Столбики цифр слева над радаром — выше: освобождают место карте.
  { rect: [90, 270, 186, 350], dx: 0, dy: -38, feather: 6 },
  // Маленький кубик справа от верхнего облака — светлее (и не гасится как дым: SMOKE_KEEP).
  { rect: [342, 160, 390, 212], gain: 1.6, feather: 4 },
  // Карта мира — выше, чуть выше центра радара «Поиска»: материки выглядывают из-за него
  // по бокам и сверху, а не только снизу. Маска обходит камеру слева (её колонка x < 150
  // ниже Северной Америки) и график под Азией справа.
  {
    rects: [[105, 405, 430, 468], [152, 468, 430, 618], [430, 400, 468, 570]],
    dx: 0,
    dy: MAP_SHIFT_Y,
    feather: 7,
  },
];

/**
 * Соты на месте нижнего левого микрофона: уходят под левый край экрана, сверху и справа
 * сот меньше, книзу ряд шире и чуть правее. Координаты исходника, r — радиус соты.
 */
// На экране видно с x ≈ 58: сверху край одной соты, книзу 2–3, остальное под краем.
const HONEYCOMB = { top: 706, rows: 5, r: 19, reachTop: 44, reachBottom: 112, seed: 0x51ce7a };

/**
 * Новый элемент на месте микрофона: голографический куб, от вершин которого ветвятся линии
 * нейросети с узлами. Рисуется до перекраски в бирюзе, как родные иконки картинки, и
 * прибавляется светом (на тёмном фоне — как свечение).
 */
// Первый вариант — пользователю он понравился больше: ветки частично уходят за правый
// край экрана (телефон в портрете видит по ширине примерно 50…522 из 572).
// brightness: тусклее микрофона сверху справа — фон, а не акцент.
const NEURAL_CUBE = { cx: 480, cy: 744, r: 24, seed: 0x6c1f2e, brightness: 0.32 };

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
function moveElement(data, w, h, scale, { rect, rects, dx = 0, dy = 0, remove = false, gain = 1, feather: featherSrc = 10 }) {
  const feather = featherSrc * scale;
  // Элемент — один прямоугольник или объединение нескольких (карта без соседнего графика).
  const boxes = (rects || [rect]).map((r) => r.map((v) => v * scale));
  const rx0 = Math.min(...boxes.map((b) => b[0]));
  const ry0 = Math.min(...boxes.map((b) => b[1]));
  const rx1 = Math.max(...boxes.map((b) => b[2]));
  const ry1 = Math.max(...boxes.map((b) => b[3]));
  const sx = dx * scale;
  const sy = dy * scale;
  const pad = 40 * scale;
  const cx0 = Math.max(0, Math.floor(Math.min(rx0, rx0 + sx) - pad));
  const cy0 = Math.max(0, Math.floor(Math.min(ry0, ry0 + sy) - pad));
  const cx1 = Math.min(w, Math.ceil(Math.max(rx1, rx1 + sx) + pad));
  const cy1 = Math.min(h, Math.ceil(Math.max(ry1, ry1 + sy) + pad));
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;
  const mask = (x, y) => {
    let m = 0;
    for (const [bx0, by0, bx1, by1] of boxes) {
      m = Math.max(
        m,
        smoothstep(bx0 - feather, bx0 + feather, x) * (1 - smoothstep(bx1 - feather, bx1 + feather, x)) *
          smoothstep(by0 - feather, by0 + feather, y) * (1 - smoothstep(by1 - feather, by1 + feather, y)),
      );
    }
    return m;
  };
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
      for (let c = 0; c < 3; c++) data[k + c] = Math.min(255, data[k + c] + glow[g + c] * gain);
    }
  }
}

/**
 * Новые элементы картинки (куб с нейросетью, соты) одним слоем canvaskit в координатах
 * исходника; возвращает премультиплицированные RGBA пиксели размера w×h.
 */
async function drawOverlays(w, h, scale) {
  const ck = await require(path.join(__dirname, '..', 'node_modules', 'canvaskit-wasm', 'bin', 'full', 'canvaskit.js'))({
    locateFile: (f) => path.join(__dirname, '..', 'node_modules', 'canvaskit-wasm', 'bin', 'full', f),
  });
  const surface = ck.MakeSurface(w, h);
  const c = surface.getCanvas();
  c.clear(ck.TRANSPARENT);
  c.scale(scale, scale);
  drawNeuralCube(ck, c, scale, NEURAL_CUBE);
  drawHoneycomb(ck, c, scale, HONEYCOMB);
  const px = c.readPixels(0, 0, {
    width: w, height: h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul,
    colorSpace: ck.ColorSpace.SRGB,
  });
  surface.delete();
  return px;
}

function overlayPaint(ck, scale, rgb, alpha, { stroke, blur } = {}) {
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
}

/** Цвета новых элементов — в бирюзе исходника: перекраска делает их голубыми, как всё. */
const OVERLAY_TEAL = [93, 175, 185];
const OVERLAY_LIGHT = [175, 236, 242];

function drawHoneycomb(ck, c, scale, { top, rows, r, reachTop, reachBottom, seed }) {
  let state = seed >>> 0;
  const rnd = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  const paint = (rgb, alpha, opts) => overlayPaint(ck, scale, rgb, alpha, opts);
  const colW = Math.sqrt(3) * r;
  const rowH = 1.5 * r;
  const cells = [];
  for (let row = 0; row < rows; row++) {
    const t = row / (rows - 1);
    // Правая граница ряда: сверху ближе к краю, книзу шире; неровная, как у живых сот.
    const reach = reachTop + (reachBottom - reachTop) * Math.pow(t, 1.2) + (rnd() - 0.5) * colW * 0.5;
    const offset = row % 2 ? colW / 2 : 0;
    for (let x = -colW + offset; x <= reach; x += colW) {
      // Крайние справа ячейки иногда пропускаем — край сот рваный, а не ровная ступенька.
      if (x > reach - colW * 1.2 && rnd() < 0.4) continue;
      // Вправо и кверху соты гаснут — уходят в фон, а не обрываются.
      const fade = (1 - Math.max(0, (x - 40) / (reach - 40 + 1e-3)) * 0.5) * (0.7 + 0.3 * t);
      cells.push({ x, y: top + row * rowH, fade });
    }
  }
  const hexPath = (cx, cy, rr) => {
    const p = new ck.Path();
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (Math.PI / 3) * i;
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (i) p.lineTo(x, y);
      else p.moveTo(x, y);
    }
    p.close();
    return p;
  };
  for (const cell of cells) {
    const path = hexPath(cell.x, cell.y, r * 0.94);
    const a = cell.fade;
    if (rnd() < 0.15) c.drawPath(path, paint(OVERLAY_TEAL, 0.08 * a));
    c.drawPath(path, paint(OVERLAY_TEAL, 0.12 * a, { stroke: 1.6, blur: 1 }));
    c.drawPath(path, paint(OVERLAY_LIGHT, 0.3 * a, { stroke: 0.55 }));
  }
  // Узлы на части вершин — как у сети на карте.
  const node = paint(OVERLAY_LIGHT, 0.55);
  const halo = paint(OVERLAY_TEAL, 0.22, { blur: 2.5 });
  for (const cell of cells) {
    if (rnd() > 0.3) continue;
    const i = Math.floor(rnd() * 6);
    const ang = -Math.PI / 2 + (Math.PI / 3) * i;
    const x = cell.x + Math.cos(ang) * r * 0.94;
    const y = cell.y + Math.sin(ang) * r * 0.94;
    c.drawCircle(x, y, 2.8, halo);
    c.drawCircle(x, y, 1.0, node);
  }
}

function drawNeuralCube(ck, c, scale, { cx, cy, r, seed, brightness = 1 }) {
  let state = seed >>> 0;
  const rnd = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  const paint = (rgb, alpha, { stroke, blur } = {}) => {
    const p = new ck.Paint();
    p.setAntiAlias(true);
    p.setColor(ck.Color(rgb[0], rgb[1], rgb[2], alpha * brightness));
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

  // Тело куба рисуется отдельно, уже в итоговых цветах (drawCubeBody) — как маленький кубик
  // сверху. Здесь только мягкое свечение вокруг.
  const pts = [0, 1, 2, 3, 4, 5].map(corner);
  const hex = new ck.Path();
  pts.forEach(([x, y], i) => (i ? hex.lineTo(x, y) : hex.moveTo(x, y)));
  hex.close();
  c.drawPath(hex, paint(TEAL, 0.3, { blur: 12 }));
}

/**
 * Тело куба с нейросетью — в тех же цветах граней, что у маленького кубика справа от
 * верхнего облака (замерены на готовой картинке): верх, светлая синяя правая грань, тёмная
 * левая, тонкие рёбра. Рисуется поверх уже перекрашенной картинки, обычным наложением.
 */
const CUBE_FACES = {
  top: [59, 77, 101],
  right: [59, 79, 107],
  left: [59, 69, 83],
  edge: [86, 108, 136],
};

async function drawCubeBody(w, h, scale, { cx, cy, r }) {
  const ck = await require(path.join(__dirname, '..', 'node_modules', 'canvaskit-wasm', 'bin', 'full', 'canvaskit.js'))({
    locateFile: (f) => path.join(__dirname, '..', 'node_modules', 'canvaskit-wasm', 'bin', 'full', f),
  });
  const surface = ck.MakeSurface(w, h);
  const c = surface.getCanvas();
  c.clear(ck.TRANSPARENT);
  c.scale(scale, scale);
  const tilt = 0.14;
  const pts = [0, 1, 2, 3, 4, 5].map((i) => {
    const a = -Math.PI / 2 + (Math.PI / 3) * i + tilt;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  const fill = (rgb) => overlayPaint(ck, scale, rgb, 1);
  const face = (a, b, d, rgb) => {
    const f = new ck.Path();
    f.moveTo(cx, cy);
    f.lineTo(...pts[a]);
    f.lineTo(...pts[b]);
    f.lineTo(...pts[d]);
    f.close();
    c.drawPath(f, fill(rgb));
  };
  face(5, 0, 1, CUBE_FACES.top);
  face(1, 2, 3, CUBE_FACES.right);
  face(3, 4, 5, CUBE_FACES.left);
  const edge = overlayPaint(ck, scale, CUBE_FACES.edge, 0.35, { stroke: 0.8 });
  const hex = new ck.Path();
  pts.forEach(([x, y], i) => (i ? hex.lineTo(x, y) : hex.moveTo(x, y)));
  hex.close();
  c.drawPath(hex, edge);
  for (const i of [1, 3, 5]) c.drawLine(cx, cy, pts[i][0], pts[i][1], edge);
  const px = c.readPixels(0, 0, {
    width: w, height: h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul,
    colorSpace: ck.ColorSpace.SRGB,
  });
  surface.delete();
  return px;
}

/** Карта мира — мягкая маска по её рамке в координатах исходника. */
function mapMask(ox, oy) {
  return smoothstep(70, 110, ox) * (1 - smoothstep(455, 495, ox)) * smoothstep(385, 420, oy) * (1 - smoothstep(615, 650, oy));
}

/**
 * Чёткость: нерезкое маскирование по яркости (σ 1.4 px апскейла). Порог отсекает шум
 * фона, усиление — только деталям элементов: строки, края иконок, линии карты.
 */
const SHARPEN_SIGMA = 1.4;
const SHARPEN_AMOUNT = 0.7;
const SHARPEN_THRESHOLD = 2;

function sharpen(data, w, h) {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  }
  const soft = gaussianBlur(lum, w, h, SHARPEN_SIGMA);
  for (let i = 0; i < w * h; i++) {
    const detail = lum[i] - soft[i];
    const mag = Math.abs(detail);
    if (mag <= SHARPEN_THRESHOLD) continue;
    const add = SHARPEN_AMOUNT * Math.sign(detail) * (mag - SHARPEN_THRESHOLD);
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.min(255, Math.max(0, Math.round(data[i * 4 + c] + add)));
  }
}

/** Минимум (или максимум) по окну 2r+1 вдоль строк, затем столбцов — квадратное окно. */
function rankFilter(src, w, h, r, pick) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = src[y * w + x];
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = pick(m, src[y * w + k]);
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = tmp[y * w + x];
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = pick(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

/**
 * Туман: светлая дымка, разлитая по сцене крупными пятнами (до +17 уровней на фоне ~35).
 * Фон без элементов — морфологическое открытие: минимум, затем максимум по окну шире любой
 * иконки (просто минимум занижал дымку, а тёмные точки давали квадратные провалы), сверху
 * размытие. Над самым тёмным его уровнем всё вычитается: фон ровный и тёмный, а иконки,
 * карта и их свечение (мельче окна) остаются как были, только без подсветки дымкой.
 */
const HAZE_WINDOW = 30;
const HAZE_SIGMA = 18;
const HAZE_STRENGTH = 1;

function removeHaze(data, w, h, scale) {
  const sw = Math.round(w / scale);
  const sh = Math.round(h / scale);
  const fields = [0, 1, 2].map((c) => {
    const small = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        let acc = 0;
        let n = 0;
        for (let j = 0; j < scale; j++) {
          for (let i = 0; i < scale; i++) {
            const xx = Math.min(w - 1, Math.round(x * scale + i));
            const yy = Math.min(h - 1, Math.round(y * scale + j));
            acc += data[(yy * w + xx) * 4 + c];
            n++;
          }
        }
        small[y * sw + x] = acc / n;
      }
    }
    const clean = gaussianBlur(small, sw, sh, 3);
    const opened = rankFilter(rankFilter(clean, sw, sh, HAZE_WINDOW, Math.min), sw, sh, HAZE_WINDOW, Math.max);
    const haze = gaussianBlur(opened, sw, sh, HAZE_SIGMA);
    const sorted = Float32Array.from(haze).sort();
    const floor = sorted[Math.floor(sorted.length * 0.03)];
    for (let i = 0; i < haze.length; i++) haze[i] = Math.max(0, haze[i] - floor) * HAZE_STRENGTH;
    return haze;
  });
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1.001, Math.max(0, y / scale - 0.5));
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1.001, Math.max(0, x / scale - 0.5));
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const k = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const f = fields[c];
        const v =
          f[y0 * sw + x0] * (1 - tx) * (1 - ty) + f[y0 * sw + x0 + 1] * tx * (1 - ty) +
          f[(y0 + 1) * sw + x0] * (1 - tx) * ty + f[(y0 + 1) * sw + x0 + 1] * tx * ty;
        data[k + c] = Math.max(0, Math.round(data[k + c] - v));
      }
    }
  }
}

/**
 * Дым: слабое свечение над фоном — ореолы вокруг иконок, размытые строки и кубики, пятна
 * в пустых местах. Всё, что поднимается над локальным фоном слабее SMOKE_FULL уровней,
 * плавно гасится к фону; яркие элементы (сильнее SMOKE_FULL) не трогаются. Сверху (там
 * дыма больше всего) пороги выше. Новые элементы (overlay) не гасятся — их свечение задано.
 */
const SMOKE_FLOOR = 7;
const SMOKE_FULL = 40;
const SMOKE_TOP_BOOST = 1.6;
/** На карте мира тонкие линии слабее — там пороги ниже, чтобы сеть не тускнела. */
const SMOKE_MAP_FACTOR = 0.45;
/** Элементы, которые не гасятся как дым (координаты исходника): маленький кубик сверху. */
const SMOKE_KEEP = [[340, 158, 392, 214]];

function suppressSmoke(data, w, h, scale, overlay) {
  const sw = Math.round(w / scale);
  const sh = Math.round(h / scale);
  // Локальный фон — то же открытие, что для тумана, по каждому каналу.
  const bgs = [0, 1, 2].map((c) => {
    const small = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const xx = Math.min(w - 1, Math.round(x * scale + scale / 2));
        const yy = Math.min(h - 1, Math.round(y * scale + scale / 2));
        small[y * sw + x] = data[(yy * w + xx) * 4 + c];
      }
    }
    const clean = gaussianBlur(small, sw, sh, 2);
    const opened = rankFilter(rankFilter(clean, sw, sh, HAZE_WINDOW, Math.min), sw, sh, HAZE_WINDOW, Math.max);
    return gaussianBlur(opened, sw, sh, 10);
  });
  const sample = (f, x, y) => {
    const fx = Math.min(sw - 1.001, Math.max(0, x / scale - 0.5));
    const fy = Math.min(sh - 1.001, Math.max(0, y / scale - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    return (
      f[y0 * sw + x0] * (1 - tx) * (1 - ty) + f[y0 * sw + x0 + 1] * tx * (1 - ty) +
      f[(y0 + 1) * sw + x0] * (1 - tx) * ty + f[(y0 + 1) * sw + x0 + 1] * tx * ty
    );
  };
  // Порог по яркости слегка размытой картинки: тонкие линии карты держатся за счёт
  // соседства, а пиксельный шум не решает, что гасить.
  const lumSmall = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lumSmall[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  }
  for (let y = 0; y < h; y++) {
    const topness = 1 - smoothstep(0.25, 0.45, y / h);
    const rowFactor = 1 + (SMOKE_TOP_BOOST - 1) * topness;
    for (let x = 0; x < w; x++) {
      const map = mapMask(x / scale, y / scale - MAP_SHIFT_Y);
      const factor = rowFactor * (1 + (SMOKE_MAP_FACTOR - 1) * map);
      const floor = SMOKE_FLOOR * factor;
      const full = SMOKE_FULL * factor;
      const i = y * w + x;
      const k = i * 4;
      const bg = [sample(bgs[0], x, y), sample(bgs[1], x, y), sample(bgs[2], x, y)];
      const bgLum = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
      const rise = lumSmall[i] - bgLum;
      if (rise <= 0) continue;
      let keep = smoothstep(floor, full, rise);
      keep = Math.max(keep, Math.min(1, overlay[k + 3] / 255 * 1.5));
      const ox = x / scale;
      const oy = y / scale;
      for (const [kx0, ky0, kx1, ky1] of SMOKE_KEEP) {
        if (ox >= kx0 && ox <= kx1 && oy >= ky0 && oy <= ky1) keep = 1;
      }
      if (keep >= 1) continue;
      for (let c = 0; c < 3; c++) {
        const v = data[k + c];
        if (v > bg[c]) data[k + c] = Math.round(bg[c] + (v - bg[c]) * keep);
      }
    }
  }
}

/**
 * Основной фон — серый в тон приложению (сланец, как HOME_NAV_BG #252B34), а не синий:
 * тёмные пиксели теряют насыщенность до SLATE_SAT с оттенком SLATE_HUE и светлеют на
 * SLATE_LIFT — после затемнения сцены в шейдере (DIM) фон на экране серый, а не почти
 * чёрный. Светлые элементы (иконки, карта, куб) остаются голубыми, ореолы — плавный переход.
 */
const SLATE_HUE = 215;
const SLATE_SAT = 0.16;
const SLATE_LIFT = 0.08;

function grayBackground(data, w, h) {
  for (let i = 0; i < w * h * 4; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const bg = 1 - smoothstep(0.17, 0.33, lum);
    if (bg <= 0) continue;
    const [hue, sat, light] = rgbToHsl(r, g, b);
    let dh = SLATE_HUE - hue;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    const [nr, ng, nb] = hslToRgb(
      (hue + dh * bg + 360) % 360,
      sat + (Math.min(sat, SLATE_SAT) - sat) * bg,
      Math.min(1, light + SLATE_LIFT * bg),
    );
    data[i] = Math.round(nr * 255);
    data[i + 1] = Math.round(ng * 255);
    data[i + 2] = Math.round(nb * 255);
  }
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
      const map = mapMask(ox, oy);
      if (map <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const d = B[k + c] - A[k + c];
        if (d > 0) A[k + c] = Math.min(255, A[k + c] + d * 0.9 * map);
      }
    }
  }
  for (const move of MOVES) moveElement(A, w, h, scale, move);
  // Куб с нейросетью и соты — светом поверх фона.
  const overlay = await drawOverlays(w, h, scale);
  for (let i = 0; i < w * h * 4; i += 4) {
    if (overlay[i + 3] === 0) continue;
    for (let ch = 0; ch < 3; ch++) A[i + ch] = Math.min(255, A[i + ch] + overlay[i + ch]);
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
  removeHaze(A, w, h, scale);
  suppressSmoke(A, w, h, scale, overlay);
  sharpen(A, w, h);
  grayBackground(A, w, h);
  // Тело куба с нейросетью — поверх, в цветах маленького кубика.
  const body = await drawCubeBody(w, h, scale, NEURAL_CUBE);
  for (let i = 0; i < w * h * 4; i += 4) {
    const a = body[i + 3] / 255;
    if (a === 0) continue;
    for (let ch = 0; ch < 3; ch++) A[i + ch] = Math.round(body[i + ch] + A[i + ch] * (1 - a));
  }
  await base.resize(1440, Jimp.AUTO, Jimp.RESIZE_BICUBIC).quality(95).writeAsync(OUT);
  console.log(`${path.relative(process.cwd(), OUT)}  1440 px`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
