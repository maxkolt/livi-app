#!/usr/bin/env node
/**
 * Пространственная сцена главного экрана (SpatialDepth.kt) — слоями по глубине, как Spatial
 * Scenes на iPhone: каждый элемент картинки лежит на своём плане и при наклоне сдвигается
 * целиком, без растяжения пикселей, а за ним открывается чистый фон.
 *
 * assets/spatial/stage-hq.jpg (scripts/build-spatial-stage-hq.js) раскладывается на:
 *   spatial_stage_plate.jpg  — фон без элементов (дальний план): под элементами восстановлен
 *                              нормированным размытием окружения;
 *   spatial_stage_layers.png — элементы: разность картинки и фона, со смещением
 *                              LAYER_OFFSET (тени темнее фона — отрицательная разность);
 *   spatial_stage_planes.png — план каждого пикселя слоя (k · PLANE_STEP, 0 — нет), ½ размера;
 *   spatial_stage_tiles.png  — какие планы есть рядом с плиткой TILE px (биты · TILE_BIT_STEP):
 *                              шейдер проверяет только их.
 * В покое фон + слой = исходная картинка. Ещё пишутся spatial_stage.jpg (картинка целиком —
 * Android 12 и ниже сдвигает её одним планом) и размытая копия для стеклянных блоков
 * (SpatialGlassView): они показывают её кусок под собой, а не размывают сцену на каждом кадре.
 *
 * Элемент — то, что ярче (или темнее — тени) ровного фона: фон — медиана в окне ~200 px,
 * элементы мельче окна в неё не попадают. Ядро — перепад от CORE_BRIGHT/CORE_DARK уровней,
 * к нему прирастает ореол до GROW уровней (не дальше GROW_REACH px). План — по элементу
 * (SEEDS, GROUPS), частицы — по размеру: крупные размытые боке ближе, мелкие точки дальше.
 *
 *   node scripts/generate-spatial-depth.js [debug-dir]
 */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp-compact');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const HQ = path.join(ROOT, 'assets', 'spatial', 'stage-hq.jpg');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'drawable-nodpi');
const OUT_IMAGE = path.join(RES, 'spatial_stage.jpg');
const OUT_PLATE = path.join(RES, 'spatial_stage_plate.jpg');
const OUT_LAYERS = path.join(RES, 'spatial_stage_layers.png');
const OUT_PLANES = path.join(RES, 'spatial_stage_planes.png');
const OUT_TILES = path.join(RES, 'spatial_stage_tiles.png');
const OUT_BLUR = path.join(RES, 'spatial_stage_blur.jpg');
/** Размытая копия — в 1/4 ширины сцены: она гладкая, GPU растянет её без потерь. */
const BLUR_WIDTH = 360;
/** Сигма в пикселях копии: ×4 ≈ 10 px на сцене 1440 — прозрачное стекло, фон угадывается. */
const BLUR_SIGMA = 2.5;

// Константы формата — те же в SpatialDepth.kt (DepthScene).
/** Ноль разности в слое: тени до −LAYER_OFFSET, свет до 255 − LAYER_OFFSET уровней. */
const LAYER_OFFSET = 64;
const PLANE_STEP = 40;
const TILE = 32;
const TILE_BIT_STEP = 8;
/** Плитка помнит планы на столько плиток вокруг: дальний план сдвигается до ~46 px картинки. */
const TILE_REACH = 2;

/**
 * Планы (индекс — в spatial_stage_planes.png). Сдвиг при полном наклоне в SpatialDepth.kt
 * PLANE_SHIFT_DP: фон 14 dp, дальше всех панели данных, ближе всех облако и боке.
 */
const PLANE = { deep: 1, map: 2, mid: 3, icons: 4, near: 5 };

/**
 * Цельные элементы: точка внутри элемента (координаты stage-hq 1440×2578) → план. pad —
 * захватить ещё столько px вокруг: у облака широкая мягкая тень, иначе её край оставался
 * на фоне и при наклоне двоился.
 */
const SEEDS = [
  // Облако крупнее половины окна медианы фона: ядро — кольцо по краю, середина — дыра,
  // которую shapeElements заливает. Точка — у левого края тела.
  { name: 'bubble', at: [560, 430], plane: PLANE.near, pad: 36 },
  { name: 'cube-top', at: [988, 277], plane: PLANE.icons },
  { name: 'mic', at: [1256, 740], plane: PLANE.icons },
  // Камера — ниже и наклонена к кубу (build-spatial-stage-hq.js): точка внутри её корпуса.
  { name: 'camera', at: [235, 1399], plane: PLANE.icons },
  { name: 'neural-cube', at: [1208, 1872], plane: PLANE.icons },
];

/**
 * Россыпи (строки цифр, карта, графики, соты): компонент с центром в прямоугольнике → план.
 * Россыпь сплошняется закрытием на GROUP_CLOSE px — одним листом уходят и бледные линии
 * между точками, слабее порога ядра (иначе на фоне оставалась их тень).
 */
const GROUPS = [
  { name: 'digits', rect: [220, 590, 340, 790], plane: PLANE.deep },
  { name: 'data-left', rect: [0, 640, 240, 1160], plane: PLANE.deep },
  { name: 'data-right', rect: [1170, 1020, 1440, 1340], plane: PLANE.deep },
  { name: 'chart-right', rect: [1060, 1430, 1440, 1600], plane: PLANE.deep },
  { name: 'chart-left', rect: [0, 1460, 360, 1720], plane: PLANE.deep },
  { name: 'honeycomb', rect: [0, 1780, 270, 2140], plane: PLANE.deep },
  // Карта — шире: линии через океаны тоже уходят с ней.
  { name: 'map', rect: [270, 730, 1170, 1300], plane: PLANE.map, close: 64 },
];

/** Частицы по радиусу ядра, px: мельче — дальше. */
function particlePlane(radius) {
  if (radius < 2.5) return PLANE.map;
  if (radius < 5) return PLANE.mid;
  if (radius < 9) return PLANE.icons;
  return PLANE.near;
}

const CORE_BRIGHT = 7;
const CORE_DARK = -6;
const GROW = 3;
const GROW_REACH = 24;
const GROUP_CLOSE = 28;
/** Слой гаснет к фону от FEATHER_IN до FEATHER_OUT px за ореолом элемента. */
const FEATHER_IN = 1;
const FEATHER_OUT = 6;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

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

function medianFilter(src, w, h, r) {
  const out = new Float32Array(w * h);
  const buf = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      buf.length = 0;
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) {
        for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) buf.push(src[j * w + i]);
      }
      buf.sort((a, b) => a - b);
      out[y * w + x] = buf[buf.length >> 1];
    }
  }
  return out;
}

/** Среднее по блокам s×s. */
function downsample(src, w, h, s) {
  const sw = Math.ceil(w / s);
  const sh = Math.ceil(h / s);
  const out = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let acc = 0;
      let n = 0;
      for (let j = 0; j < s; j++) {
        for (let i = 0; i < s; i++) {
          const xx = x * s + i;
          const yy = y * s + j;
          if (xx < w && yy < h) {
            acc += src[yy * w + xx];
            n++;
          }
        }
      }
      out[y * sw + x] = acc / n;
    }
  }
  return { data: out, w: sw, h: sh };
}

/** Билинейно обратно в w×h из сетки с шагом s (центры блоков). */
function upsample(small, w, h, s) {
  const { data, w: sw, h: sh } = small;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1.001, Math.max(0, (y + 0.5) / s - 0.5));
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1.001, Math.max(0, (x + 0.5) / s - 0.5));
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      out[y * w + x] =
        data[y0 * sw + x0] * (1 - tx) * (1 - ty) + data[y0 * sw + x0 + 1] * tx * (1 - ty) +
        data[(y0 + 1) * sw + x0] * (1 - tx) * ty + data[(y0 + 1) * sw + x0 + 1] * tx * ty;
    }
  }
  return out;
}

/** Расстояние до ближайшего пикселя маски (фаска 3-4, ≈ евклидово). */
function distanceTo(mask, w, h) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}

/** Метки связных областей маски (8 соседей); 0 — вне маски. */
function label(mask, w, h) {
  const labels = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    labels[s] = next;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (mask[j] && !labels[j]) {
            labels[j] = next;
            queue[tail++] = j;
          }
        }
      }
    }
  }
  return { labels, count: next };
}

/** Элементы: ядро, ореол, растушёвка; метки компонентов. */
function findElements(lum, w, h) {
  // Ровный фон — медиана в окне 25×25 блоков по 8 px: иконки мельче окна в неё не входят.
  const s = 8;
  const small = downsample(lum, w, h, s);
  const background = upsample({ ...small, data: medianFilter(small.data, small.w, small.h, 12) }, w, h, s);
  const excess = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) excess[i] = lum[i] - background[i];
  const smooth = gaussianBlur(excess, w, h, 1.2);

  const core = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) core[i] = smooth[i] > CORE_BRIGHT || smooth[i] < CORE_DARK ? 1 : 0;
  // Ореол: всё заметное над фоном, связанное с ядром, — но не дальше GROW_REACH от него.
  const fromCore = distanceTo(core, w, h);
  const region = Uint8Array.from(core);
  const queue = [];
  for (let i = 0; i < w * h; i++) if (core[i]) queue.push(i);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (region[j] || Math.abs(smooth[j]) <= GROW || fromCore[j] > GROW_REACH) continue;
        region[j] = 1;
        queue.push(j);
      }
    }
  }
  return { excess, core, region };
}

/** Слой элементов: вес (1 внутри, растушёвка наружу) и метки компонентов. */
function layout(region, w, h) {
  const fromRegion = distanceTo(region, w, h);
  const weight = new Float32Array(w * h);
  const area = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    weight[i] = 1 - smoothstep(FEATHER_IN, FEATHER_OUT, fromRegion[i]);
    area[i] = fromRegion[i] < FEATHER_OUT ? 1 : 0;
  }
  return { weight, ...label(area, w, h) };
}

/**
 * Форма элементов: облако с тенью (pad), сплошные россыпи (закрытие), без дыр внутри — строки
 * текста в облаке темнее порога, и фон под облаком восстанавливался из них же (светлое пятно).
 */
function shapeElements(region, labels, why, w, h) {
  const shaped = Uint8Array.from(region);
  const grow = (names, apply) => {
    const mask = new Uint8Array(w * h);
    let any = false;
    for (let i = 0; i < w * h; i++) {
      if (labels[i] && names.has(why[labels[i]])) {
        mask[i] = 1;
        any = true;
      }
    }
    if (!any) return;
    const out = apply(mask);
    for (let i = 0; i < w * h; i++) if (out[i]) shaped[i] = 1;
  };
  const dilate = (mask, r) => {
    const d = distanceTo(mask, w, h);
    return d.map((v) => (v <= r ? 1 : 0));
  };
  const close = (mask, r) => {
    const grown = dilate(mask, r);
    const outside = distanceTo(grown.map((v) => 1 - v), w, h);
    return outside.map((v) => (v > r ? 1 : 0));
  };
  for (const seed of SEEDS) if (seed.pad) grow(new Set([seed.name]), (m) => dilate(m, seed.pad));
  for (const group of GROUPS) grow(new Set([group.name]), (m) => close(m, group.close || GROUP_CLOSE));
  // Дыры: всё, до чего фон не дотягивается от края картинки.
  const reached = new Uint8Array(w * h);
  const queue = [];
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) queue.push(y * w + x);
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) queue.push(y * w + x);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    if (reached[i] || shaped[i]) continue;
    reached[i] = 1;
    const x = i % w;
    if (x > 0) queue.push(i - 1);
    if (x < w - 1) queue.push(i + 1);
    if (i >= w) queue.push(i - w);
    if (i < w * (h - 1)) queue.push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (!reached[i]) shaped[i] = 1;
  return shaped;
}

/** План каждого компонента: цельные элементы по точке, россыпи по рамке, частицы по размеру. */
function assignPlanes({ excess, core, labels, count }, w, h) {
  const stats = Array.from({ length: count + 1 }, () => ({
    coreArea: 0, sx: 0, sy: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1, peak: 0,
  }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = labels[i];
      if (!l) continue;
      const st = stats[l];
      st.x0 = Math.min(st.x0, x);
      st.y0 = Math.min(st.y0, y);
      st.x1 = Math.max(st.x1, x);
      st.y1 = Math.max(st.y1, y);
      if (core[i]) {
        st.coreArea++;
        st.sx += x;
        st.sy += y;
        st.peak = Math.max(st.peak, Math.abs(excess[i]));
      }
    }
  }
  const planeOf = new Uint8Array(count + 1);
  const why = new Array(count + 1).fill('');
  for (const seed of SEEDS) {
    const l = labels[seed.at[1] * w + seed.at[0]];
    if (!l) throw new Error(`seed ${seed.name} is not on an element`);
    planeOf[l] = seed.plane;
    why[l] = seed.name;
  }
  for (let l = 1; l <= count; l++) {
    if (planeOf[l]) continue;
    const st = stats[l];
    const n = Math.max(1, st.coreArea);
    const cx = st.coreArea ? st.sx / n : (st.x0 + st.x1) / 2;
    const cy = st.coreArea ? st.sy / n : (st.y0 + st.y1) / 2;
    const group = GROUPS.find(({ rect: [x0, y0, x1, y1] }) => cx >= x0 && cx < x1 && cy >= y0 && cy < y1);
    if (group) {
      planeOf[l] = group.plane;
      why[l] = group.name;
    } else {
      planeOf[l] = particlePlane(Math.sqrt(st.coreArea / Math.PI));
      why[l] = 'particle';
    }
  }
  return { planeOf, stats, why };
}

/**
 * Фон под элементами: нормированное размытие того, что вокруг (вес — 1 − слой), в 1/4
 * разрешения. Два масштаба: мелкий держит фон у краёв элемента, крупный дотягивается до
 * середины крупного (облако с тенью ~320 px).
 */
function fillBackground(rgb, weight, w, h) {
  const q = 4;
  const valid = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) valid[i] = 1 - weight[i];
  const v = downsample(valid, w, h, q);
  const vFine = gaussianBlur(v.data, v.w, v.h, 6);
  const vCoarse = gaussianBlur(v.data, v.w, v.h, 24);
  return rgb.map((ch) => {
    const masked = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) masked[i] = ch[i] * valid[i];
    const m = downsample(masked, w, h, q);
    const a = gaussianBlur(m.data, m.w, m.h, 6);
    const b = gaussianBlur(m.data, m.w, m.h, 24);
    const out = new Float32Array(a.length);
    for (let i = 0; i < out.length; i++) {
      const near = a[i] / Math.max(1e-6, vFine[i]);
      const far = b[i] / Math.max(1e-6, vCoarse[i]);
      out[i] = far + (near - far) * Math.min(1, vFine[i] / 0.05);
    }
    return upsample({ data: out, w: m.w, h: m.h }, w, h, q);
  });
}

function writeGray(file, w, h, value) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const v = value(i);
    png.data[i * 4] = v;
    png.data[i * 4 + 1] = v;
    png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png, { colorType: 0 }));
}

async function main() {
  const debugDir = process.argv[2];
  const hq = await Jimp.read(HQ);
  const { width: w, height: h, data } = hq.bitmap;
  const rgb = [0, 1, 2].map((c) => {
    const ch = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) ch[i] = data[i * 4 + c];
    return ch;
  });
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.2126 * rgb[0][i] + 0.7152 * rgb[1][i] + 0.0722 * rgb[2][i];

  const { excess, core, region } = findElements(lum, w, h);
  // Сначала — какие компоненты чьи, затем форма элементов и окончательная раскладка.
  const first = layout(region, w, h);
  const firstPlanes = assignPlanes({ excess, core, ...first }, w, h);
  const shaped = shapeElements(region, first.labels, firstPlanes.why, w, h);
  const elements = { excess, core, ...layout(shaped, w, h) };
  const { planeOf, stats, why } = assignPlanes(elements, w, h);
  const { weight, labels } = elements;

  const fill = fillBackground(rgb, weight, w, h);
  const plate = new Jimp(w, h);
  for (let i = 0; i < w * h; i++) {
    const m = weight[i];
    for (let c = 0; c < 3; c++) plate.bitmap.data[i * 4 + c] = Math.round(rgb[c][i] * (1 - m) + fill[c][i] * m);
    plate.bitmap.data[i * 4 + 3] = 255;
  }
  await plate.quality(95).writeAsync(OUT_PLATE);
  // Разность — от фона, каким его увидит телефон (после JPEG): в покое сумма точна.
  const decoded = (await Jimp.read(OUT_PLATE)).bitmap.data;
  const layers = new PNG({ width: w, height: h });
  let clipped = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < w * h; i++) {
    const inLayer = labels[i] !== 0;
    for (let c = 0; c < 3; c++) {
      const d = inLayer ? data[i * 4 + c] - decoded[i * 4 + c] : 0;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
      const v = d + LAYER_OFFSET;
      if (v < 0 || v > 255) clipped++;
      layers.data[i * 4 + c] = Math.min(255, Math.max(0, v));
    }
    layers.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(OUT_LAYERS, PNG.sync.write(layers, { colorType: 2 }));

  // План пикселя слоя — в половину размера: шейдер читает его без фильтрации.
  const pw = Math.ceil(w / 2);
  const ph = Math.ceil(h / 2);
  const planes = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let p = 0;
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const xx = Math.min(w - 1, x * 2 + i);
          const yy = Math.min(h - 1, y * 2 + j);
          p = Math.max(p, planeOf[labels[yy * w + xx]]);
        }
      }
      planes[y * pw + x] = p;
    }
  }
  writeGray(OUT_PLANES, pw, ph, (i) => planes[i] * PLANE_STEP);

  const tw = Math.ceil(w / TILE);
  const th = Math.ceil(h / TILE);
  const own = new Uint8Array(tw * th);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const p = planes[y * pw + x];
      if (p) own[Math.floor((y * 2) / TILE) * tw + Math.floor((x * 2) / TILE)] |= 1 << (p - 1);
    }
  }
  const tiles = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      let bits = 0;
      for (let j = Math.max(0, y - TILE_REACH); j <= Math.min(th - 1, y + TILE_REACH); j++) {
        for (let i = Math.max(0, x - TILE_REACH); i <= Math.min(tw - 1, x + TILE_REACH); i++) bits |= own[j * tw + i];
      }
      tiles[y * tw + x] = bits;
    }
  }
  writeGray(OUT_TILES, tw, th, (i) => tiles[i] * TILE_BIT_STEP);

  fs.copyFileSync(HQ, OUT_IMAGE);
  const small = hq.clone().resize(BLUR_WIDTH, Jimp.AUTO, Jimp.RESIZE_BICUBIC);
  const { width: bw, height: bh, data: bd } = small.bitmap;
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) ch[i] = bd[i * 4 + c];
    const blurred = gaussianBlur(ch, bw, bh, BLUR_SIGMA);
    for (let i = 0; i < bw * bh; i++) bd[i * 4 + c] = Math.round(blurred[i]);
  }
  await small.quality(90).writeAsync(OUT_BLUR);

  const perPlane = {};
  for (let l = 1; l < planeOf.length; l++) perPlane[planeOf[l]] = (perPlane[planeOf[l]] || 0) + 1;
  console.log(`elements ${planeOf.length - 1}, per plane ${JSON.stringify(perPlane)}`);
  console.log(`layer difference ${lo}…${hi}, clipped ${clipped} channel values`);
  for (const f of [OUT_IMAGE, OUT_PLATE, OUT_LAYERS, OUT_PLANES, OUT_TILES, OUT_BLUR]) {
    console.log(`${path.relative(ROOT, f)}  ${fs.statSync(f).size} B`);
  }

  if (debugDir) {
    fs.mkdirSync(debugDir, { recursive: true });
    const colors = [[0, 0, 0], [80, 80, 255], [0, 200, 255], [0, 255, 120], [255, 200, 0], [255, 60, 60]];
    const vis = new Jimp(w, h);
    for (let i = 0; i < w * h; i++) {
      const p = planeOf[labels[i]];
      const k = weight[i];
      for (let c = 0; c < 3; c++) vis.bitmap.data[i * 4 + c] = Math.round(lum[i] * 0.5 * (1 - k) + colors[p][c] * k * (0.35 + lum[i] / 255));
      vis.bitmap.data[i * 4 + 3] = 255;
    }
    await vis.resize(720, Jimp.AUTO).writeAsync(path.join(debugDir, 'planes.png'));
    const named = [];
    for (let l = 1; l < planeOf.length; l++) {
      const st = stats[l];
      if (why[l] !== 'particle') continue;
      named.push(`${l} r${Math.sqrt(st.coreArea / Math.PI).toFixed(1)} peak${st.peak.toFixed(0)} [${st.x0},${st.y0},${st.x1},${st.y1}] → ${planeOf[l]}`);
    }
    fs.writeFileSync(path.join(debugDir, 'particles.txt'), named.join('\n'));
    fs.writeFileSync(path.join(debugDir, 'meta.json'), JSON.stringify({ w, h }));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
