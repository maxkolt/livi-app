#!/usr/bin/env node

/**
 * Финальная точечная ретушь пространственной сцены:
 *   1. убирает ровно восемь крупных круглых маркеров с карты мира и выравнивает тёмные
 *      квадраты прежней чистки карты — однотонно с фоном, линии продолжаются;
 *   2. стирает исходные камеру и микрофон до фона и рисует на их месте чистые векторные:
 *      камера — та же по форме, размеру, месту и тону; микрофон — те же пропорции, на 15% меньше.
 *
 * Координаты заданы в сетке исходника 572×1024, поэтому результат одинаков при любом
 * рабочем разрешении. Остальная сцена не пересчитывается и не перерисовывается.
 *
 *   node scripts/refine-spatial-stage-details.js [stage-hq.jpg]
 */
const path = require('path');
const Jimp = require('jimp-compact');

const SOURCE_WIDTH = 572;

/** Восемь кругов, отмеченных красным на portrait-скриншоте от 21.10.2026. */
const MAP_ROUND_MARKERS = [
  { cx: 189.0, cy: 372.0, radius: 12.0 },
  { cx: 273.5, cy: 363.5, radius: 11.0 },
  { cx: 325.0, cy: 340.0, radius: 8.0 },
  { cx: 283.5, cy: 412.0, radius: 8.0 },
  { cx: 356.0, cy: 409.0, radius: 11.0 },
  { cx: 223.0, cy: 443.0, radius: 16.0 },
  { cx: 147.5, cy: 493.0, radius: 9.0 },
  { cx: 430.0, cy: 474.0, radius: 20.0 },
];

/**
 * Прямоугольники прежней чистки карты (MAP_MARKED_CLEANUP в build-spatial-stage-hq.js): там
 * точки убраны плоской заливкой, и на фоне фактуры карты они читались тёмными квадратами.
 * band — процентили фона у края (по умолчанию 25…75, как у кругов).
 */
const MAP_CLEANUP_PATCHES = [
  { rect: [146, 239, 162, 258] },
  { rect: [241, 327, 267, 354] },
  { rect: [408, 367, 435, 398] },
  { rect: [377, 428, 396, 447] },
  // У нижнего края Африки: сверху дымка густой сети — фон по просветам между её точками,
  // иначе заливка продолжает дымку вниз туманным квадратом.
  { rect: [293, 457, 311, 478], band: [0.15, 0.55] },
  { rect: [503, 442, 514, 454] },
  { rect: [500, 665, 512, 682] },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const smoothstep = (a, b, value) => {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Билинейная выборка из снимка: канал 0–2 или яркость (3). */
function sampler(src, w, h) {
  const value = (x, y, channel) => {
    const k = (y * w + x) * 4;
    return channel < 3 ? src[k + channel] : 0.2126 * src[k] + 0.7152 * src[k + 1] + 0.0722 * src[k + 2];
  };
  return (x, y, channel) => {
    const sx = clamp(x, 0, w - 1.001);
    const sy = clamp(y, 0, h - 1.001);
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const fx = sx - x0;
    const fy = sy - y0;
    return (
      value(x0, y0, channel) * (1 - fx) * (1 - fy) +
      value(x0 + 1, y0, channel) * fx * (1 - fy) +
      value(x0, y0 + 1, channel) * (1 - fx) * fy +
      value(x0 + 1, y0 + 1, channel) * fx * fy
    );
  };
}

const lumOf = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const angleBetween = (a, b) => Math.acos(clamp(a[0] * b[0] + a[1] * b[1], -1, 1));

/** Секторов фона по кругу (по 1°). */
const RING_SECTORS = 360;

/**
 * Фон вокруг круга по углам: в каждом секторе ±5° кольца шириной 8 px исходника — среднее
 * пикселей между 25-м и 75-м процентилем яркости (без линий, точек и тёмных ореолов от
 * резкости, но с лёгкой дымкой карты — иначе заливка читается тёмным пятном), затем
 * сглаживание по кругу ±15°.
 */
function ringBackground(src, w, cx, cy, inner, outer) {
  const buckets = Array.from({ length: RING_SECTORS }, () => []);
  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance < inner || distance > outer) continue;
      const sector = Math.floor(((Math.atan2(y - cy, x - cx) / (2 * Math.PI)) + 1) * RING_SECTORS) % RING_SECTORS;
      const k = (y * w + x) * 4;
      buckets[sector].push([src[k], src[k + 1], src[k + 2]]);
    }
  }
  const raw = buckets.map((_, sector) => {
    const pixels = [];
    for (let offset = -5; offset <= 5; offset++) pixels.push(...buckets[(sector + offset + RING_SECTORS) % RING_SECTORS]);
    pixels.sort((a, b) => lumOf(a) - lumOf(b));
    const middle = pixels.slice(Math.floor(pixels.length * 0.25), Math.ceil(pixels.length * 0.75));
    return [0, 1, 2].map((channel) => middle.reduce((sum, pixel) => sum + pixel[channel], 0) / middle.length);
  });
  return raw.map((_, sector) => {
    const sum = [0, 0, 0];
    for (let offset = -15; offset <= 15; offset++) {
      const rgb = raw[(sector + offset + RING_SECTORS) % RING_SECTORS];
      for (let channel = 0; channel < 3; channel++) sum[channel] += rgb[channel] / 31;
    }
    return sum;
  });
}

/**
 * Линии карты, входящие в круг: пики яркости на кольце радиуса ring, направление — то,
 * вдоль которого наружу тянется длинная непрерывная полоса (россыпь точек отсеивается),
 * профиль поперёк — по каналам над фоном, с подстройкой под ось линии в каждой точке
 * (иначе у чуть изогнутых линий он размазывается и продолжение выходит широким и мутным).
 * Пятна шире ~2.4 px исходника — не линии.
 */
function findLines(at, background, cx, cy, ring, scale) {
  const sectorOf = (x, y) =>
    Math.floor(((Math.atan2(y - cy, x - cx) / (2 * Math.PI)) + 1) * RING_SECTORS) % RING_SECTORS;
  const rise = (x, y) => at(x, y, 3) - lumOf(background[sectorOf(x, y)]);
  const steps = Math.ceil(2 * Math.PI * ring * 2);
  const onRing = [];
  for (let i = 0; i < steps; i++) {
    const theta = (i / steps) * 2 * Math.PI;
    onRing.push(rise(cx + ring * Math.cos(theta), cy + ring * Math.sin(theta)));
  }
  const peaks = [];
  for (let i = 0; i < steps; i++) {
    const v = onRing[i];
    if (v < 5 || v < onRing[(i + steps - 1) % steps] || v < onRing[(i + 1) % steps]) continue;
    peaks.push({ theta: (i / steps) * 2 * Math.PI, value: v });
  }

  const lines = [];
  const tFrom = 2 * scale;
  const tTo = 12 * scale;
  const trace = (x0, y0, phi) => {
    const normal = [-Math.sin(phi), Math.cos(phi)];
    const values = [];
    for (let t = tFrom; t <= tTo; t += 0.75) {
      const x = x0 + t * Math.cos(phi);
      const y = y0 + t * Math.sin(phi);
      values.push(Math.max(rise(x, y), rise(x + normal[0], y + normal[1]), rise(x - normal[0], y - normal[1])));
    }
    const mean = values.reduce((sum, v) => sum + Math.max(0, v), 0) / values.length;
    values.sort((a, b) => a - b);
    return { mean, low: values[Math.floor(values.length * 0.2)] };
  };
  const half = Math.ceil(1.5 * scale);
  for (const peak of peaks) {
    let x0 = cx + ring * Math.cos(peak.theta);
    let y0 = cy + ring * Math.sin(peak.theta);
    let best = { mean: -1 };
    for (let deg = -75; deg <= 75; deg += 1) {
      const phi = peak.theta + (deg * Math.PI) / 180;
      const result = trace(x0, y0, phi);
      if (result.mean > best.mean) best = { ...result, phi };
    }
    for (let deg = -1; deg <= 1; deg += 0.25) {
      const phi = best.phi + (deg * Math.PI) / 180;
      const result = trace(x0, y0, phi);
      if (result.mean > best.mean) best = { ...result, phi };
    }
    if (best.mean < 5 || best.low < Math.max(2, 0.3 * best.mean)) continue;

    const out = [Math.cos(best.phi), Math.sin(best.phi)];
    const normal = [-out[1], out[0]];
    // Ось линии в каждой точке — по пику поперёк (±2 px, с параболической доводкой).
    const centres = [];
    for (let t = 2.5 * scale; t <= 9 * scale; t += 0.75) {
      const px = x0 + t * out[0];
      const py = y0 + t * out[1];
      let top = 0;
      let topValue = -Infinity;
      for (let s = -2; s <= 2; s += 0.5) {
        const v = rise(px + s * normal[0], py + s * normal[1]);
        if (v > topValue) {
          topValue = v;
          top = s;
        }
      }
      const left = rise(px + (top - 0.5) * normal[0], py + (top - 0.5) * normal[1]);
      const right = rise(px + (top + 0.5) * normal[0], py + (top + 0.5) * normal[1]);
      const curvature = left - 2 * topValue + right;
      const offset = curvature < 0 ? clamp((0.25 * (left - right)) / curvature, -0.25, 0.25) : 0;
      centres.push({ t, x: px, y: py, s: top - offset });
    }
    const profile = [];
    for (let s = -half; s <= half; s += 0.5) {
      const rows = centres.map(({ x, y, s: centre }) => {
        const qx = x + (centre + s) * normal[0];
        const qy = y + (centre + s) * normal[1];
        const bg = background[sectorOf(qx, qy)];
        return [0, 1, 2].map((channel) => at(qx, qy, channel) - bg[channel]);
      });
      // Медиана по длине: случайные точки рядом с линией не попадают в профиль.
      profile.push([0, 1, 2].map((channel) => median(rows.map((row) => row[channel]))));
    }
    const lums = profile.map(lumOf);
    const peakLum = Math.max(...lums);
    const width = lums.filter((v) => v >= peakLum / 2).length * 0.5;
    if (peakLum < 6 || width > 2.4 * scale || Math.max(lums[0], lums[lums.length - 1]) > 0.35 * peakLum) continue;
    const tapered = profile.map((rgb, i) => {
      const taper = 1 - smoothstep(half - 1.5, half, Math.abs(-half + i * 0.5));
      return rgb.map((v) => v * taper);
    });
    // Начало линии — на её оси у кольца (по ближайшим к кругу точкам).
    const near = centres.slice(0, 4);
    const shift = near.reduce((sum, c) => sum + c.s, 0) / near.length;
    x0 += shift * normal[0];
    y0 += shift * normal[1];

    const duplicate = lines.find(
      (line) => Math.hypot(line.x - x0, line.y - y0) < 3 && angleBetween(line.dir, [-out[0], -out[1]]) < 0.18,
    );
    if (duplicate) {
      if (duplicate.strength >= best.mean) continue;
      lines.splice(lines.indexOf(duplicate), 1);
    }
    lines.push({ x: x0, y: y0, dir: [-out[0], -out[1]], profile: tapered, half, strength: best.mean });
  }
  return lines;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * Отрезки, которыми линии продолжаются внутри круга: встречные линии (смотрят друг на
 * друга) соединяются напрямую; линии, нацеленные в центр, сходятся в нём, как в узле сети.
 */
function lineSegments(lines, cx, cy, scale) {
  const segments = [];
  const paired = new Set();
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const v = [(b.x - a.x) / length, (b.y - a.y) / length];
      const errorA = angleBetween(a.dir, v);
      const errorB = angleBetween(b.dir, [-v[0], -v[1]]);
      if (errorA < 0.25 && errorB < 0.25) candidates.push({ i, j, score: errorA + errorB });
    }
  }
  candidates.sort((p, q) => p.score - q.score);
  for (const { i, j } of candidates) {
    if (paired.has(i) || paired.has(j)) continue;
    paired.add(i);
    paired.add(j);
    const a = lines[i];
    const b = lines[j];
    // Профили повёрнуты к поперечной оси отрезка: у начальной линии она смотрит в другую сторону.
    segments.push({ from: [a.x, a.y], to: [b.x, b.y], profiles: [mirrored(a.profile), b.profile], half: a.half, fade: false });
  }
  // Линии без пары, нацеленные в центр: если подходят с разных сторон (центр внутри них),
  // сходятся в нём, как в узле сети; если с одной стороны — заходят не дальше 8 px
  // исходника и мягко гаснут (дальше — «кометы» в пустоте, а сведённые в центр — острый
  // шпиль). Остальные не продолжаются — одинокий отросток заметнее обрыва.
  const radial = lines.filter((line, index) => {
    if (paired.has(index)) return false;
    const toCenter = [cx - line.x, cy - line.y];
    const distance = Math.hypot(toCenter[0], toCenter[1]);
    return angleBetween(line.dir, [toCenter[0] / distance, toCenter[1] / distance]) < 0.26;
  });
  const entries = radial.map((line) => Math.atan2(line.y - cy, line.x - cx)).sort((a, b) => a - b);
  const widestGap = entries.reduce(
    (gap, angle, i) => Math.max(gap, (i ? angle - entries[i - 1] : angle - entries[entries.length - 1] + 2 * Math.PI)),
    0,
  );
  const junction = radial.length >= 2 && widestGap < Math.PI;
  for (const line of radial) {
    const profile = mirrored(line.profile);
    const distance = Math.hypot(cx - line.x, cy - line.y);
    const length = junction ? distance : Math.min(distance, 8 * scale);
    segments.push({
      from: [line.x, line.y],
      to: [line.x + ((cx - line.x) / distance) * length, line.y + ((cy - line.y) / distance) * length],
      profiles: [profile, profile],
      half: line.half,
      fade: !junction,
    });
  }
  return segments;
}

/** Профиль задан на симметричной сетке −half…half, поэтому зеркало — обратный порядок. */
const mirrored = (profile) => [...profile].reverse();

function profileValue(profile, half, s, channel) {
  const position = (s + half) / 0.5;
  if (position < 0 || position > profile.length - 1) return 0;
  const i = Math.min(profile.length - 2, Math.floor(position));
  const f = position - i;
  return profile[i][channel] * (1 - f) + profile[i + 1][channel] * f;
}

/**
 * Фон под заплаткой: решение уравнения Лапласа (SOR) с граничными значениями — фоном прямо
 * у края заплатки (среднее между процентилями band в окне 5 px исходника снаружи).
 * Так заливка совпадает с ближайшим окружением, даже если вокруг светлая дымка карты.
 */
function laplaceBackground(src, w, h, scale, box, amount, band) {
  const [bx0, by0, bw, bh] = box;
  const window = Math.round(5 * scale);
  const field = [0, 1, 2].map(() => new Float32Array(bw * bh));
  const unknown = new Uint8Array(bw * bh);
  const known = new Uint8Array(bw * bh);
  const inHole = (x, y) => x >= 0 && y >= 0 && x < bw && y < bh && amount[y * bw + x] > 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      if (inHole(x, y)) {
        unknown[i] = 1;
        continue;
      }
      const touches = inHole(x - 1, y) || inHole(x + 1, y) || inHole(x, y - 1) || inHole(x, y + 1);
      if (!touches) continue;
      const pixels = [];
      for (let dy = -window; dy <= window; dy++) {
        for (let dx = -window; dx <= window; dx++) {
          if (dx * dx + dy * dy > window * window) continue;
          const lx = x + dx;
          const ly = y + dy;
          if (inHole(lx, ly)) continue;
          const gx = bx0 + lx;
          const gy = by0 + ly;
          if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
          const k = (gy * w + gx) * 4;
          pixels.push([src[k], src[k + 1], src[k + 2]]);
        }
      }
      pixels.sort((a, b) => lumOf(a) - lumOf(b));
      const middle = pixels.slice(Math.floor(pixels.length * band[0]), Math.ceil(pixels.length * band[1]));
      for (let channel = 0; channel < 3; channel++) {
        field[channel][i] = middle.reduce((sum, pixel) => sum + pixel[channel], 0) / middle.length;
      }
      known[i] = 1;
    }
  }
  for (let channel = 0; channel < 3; channel++) {
    const f = field[channel];
    let sum = 0;
    let n = 0;
    for (let i = 0; i < f.length; i++) if (known[i]) (sum += f[i]), n++;
    for (let i = 0; i < f.length; i++) if (unknown[i]) f[i] = sum / n;
    for (let iteration = 0; iteration < 600; iteration++) {
      for (let y = 1; y < bh - 1; y++) {
        for (let x = 1; x < bw - 1; x++) {
          const i = y * bw + x;
          if (!unknown[i]) continue;
          const average = (f[i - 1] + f[i + 1] + f[i - bw] + f[i + bw]) / 4;
          f[i] += 1.9 * (average - f[i]);
        }
      }
    }
  }
  return field;
}

/**
 * Заплатка убирается так, чтобы место смотрелось однотонно с картой вокруг: фон внутри —
 * гладкое продолжение фона у края (laplaceBackground), поверх — линии, продолженные через
 * заплатку с их же профилем и цветом, зерно как у фона, мягкий край. Линии ищутся на
 * окружности ring вокруг центра, рисуются только внутри заплатки.
 */
function removePatch(src, data, w, h, scale, patch) {
  const at = sampler(src, w, h);
  const { cx, cy, ring, reach, amountAt, solidAt, band } = patch;
  const background = ringBackground(src, w, cx, cy, ring, ring + 8 * scale);
  const lines = findLines(at, background, cx, cy, ring, scale);
  const segments = lineSegments(lines, cx, cy, scale);

  const bx0 = Math.max(0, Math.floor(cx - reach) - 1);
  const by0 = Math.max(0, Math.floor(cy - reach) - 1);
  const bw = Math.min(w, Math.ceil(cx + reach) + 2) - bx0;
  const bh = Math.min(h, Math.ceil(cy + reach) + 2) - by0;
  const amount = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) amount[y * bw + x] = amountAt(bx0 + x, by0 + y);
  const base = laplaceBackground(src, w, h, scale, [bx0, by0, bw, bh], amount, band);

  for (let ly = 0; ly < bh; ly++) {
    for (let lx = 0; lx < bw; lx++) {
      const reachAmount = amount[ly * bw + lx];
      if (reachAmount <= 0) continue;
      const x = bx0 + lx;
      const y = by0 + ly;
      const bright = [0, 0, 0];
      const dark = [0, 0, 0];
      for (const segment of segments) {
        const dx = segment.to[0] - segment.from[0];
        const dy = segment.to[1] - segment.from[1];
        const length = Math.hypot(dx, dy);
        if (length < 0.5) continue;
        const along = ((x - segment.from[0]) * dx + (y - segment.from[1]) * dy) / length;
        const across = ((x - segment.from[0]) * -dy + (y - segment.from[1]) * dx) / length;
        if (Math.abs(across) > segment.half || along < -0.7 || along > length + 0.7) continue;
        const u = clamp(along / length, 0, 1);
        let weight = 1 - smoothstep(length, length + 0.7, along);
        if (segment.fade) weight *= 1 - smoothstep(0.3, 1, u);
        for (let channel = 0; channel < 3; channel++) {
          const v =
            weight *
            (profileValue(segment.profiles[0], segment.half, across, channel) * (1 - u) +
              profileValue(segment.profiles[1], segment.half, across, channel) * u);
          if (v > bright[channel]) bright[channel] = v;
          if (v < dark[channel]) dark[channel] = v;
        }
      }
      const grain = triangularGrain(x, y);
      const k = (y * w + x) * 4;
      // За сплошной частью меняется только фон: точки и линии сети ярче него остаются.
      const solid = solidAt(x, y);
      const baseLum = lumOf([0, 1, 2].map((channel) => base[channel][ly * bw + lx]));
      const backgroundness = 1 - smoothstep(baseLum + 3, baseLum + 9, lumOf([src[k], src[k + 1], src[k + 2]]));
      const a = solid + (reachAmount - solid) * backgroundness;
      for (let channel = 0; channel < 3; channel++) {
        const fill = base[channel][ly * bw + lx] + bright[channel] + dark[channel] + grain;
        data[k + channel] = Math.round(clamp(src[k + channel] * (1 - a) + fill * a, 0, 255));
      }
    }
  }
  return { lines: lines.length, segments: segments.length };
}

/** Круглый маркер: целиком до radius + 1, мягкий край до radius + 2.5 px исходника. */
function markerPatch(marker, scale) {
  const cx = marker.cx * scale;
  const cy = marker.cy * scale;
  const solid = (marker.radius + 1) * scale;
  const outer = (marker.radius + 2.5) * scale;
  const amountAt = (x, y) => 1 - smoothstep(solid, outer, Math.hypot(x - cx, y - cy));
  return { cx, cy, ring: (marker.radius + 3.5) * scale, reach: outer, amountAt, solidAt: amountAt, band: [0.25, 0.75] };
}

/**
 * Прямоугольная заплатка прежней чистки: целиком до 2 px исходника за краем (тёмный край
 * заливки), дальше до 8 px — только фон: там остался светлый ореол убранной точки, и без
 * него заливка выходит светлым туманным квадратом.
 */
function rectPatch({ rect: [x0, y0, x1, y1], band = [0.25, 0.75] }, scale) {
  const cx = ((x0 + x1) / 2) * scale;
  const cy = ((y0 + y1) / 2) * scale;
  const halfW = ((x1 - x0) / 2) * scale;
  const halfH = ((y1 - y0) / 2) * scale;
  const distance = (x, y) => Math.hypot(Math.max(0, Math.abs(x - cx) - halfW), Math.max(0, Math.abs(y - cy) - halfH));
  const outer = 8 * scale;
  return {
    cx,
    cy,
    ring: Math.hypot(halfW, halfH) + outer + 1.5 * scale,
    reach: Math.hypot(halfW, halfH) + outer,
    amountAt: (x, y) => 1 - smoothstep(6 * scale, outer, distance(x, y)),
    solidAt: (x, y) => 1 - smoothstep(2 * scale, 3.5 * scale, distance(x, y)),
    band,
  };
}

/**
 * Прямоугольники вокруг исходных камеры и микрофона (с запасом ≥7 px до элемента). Без
 * стирания исходник проступал краями из-под векторной версии и всё сливалось.
 */
const ERASE_RECTS = [
  [60, 525, 140, 596],
  [473, 266, 530, 353],
];

/**
 * Фон под элементом — плоскость, подобранная по краевой полосе прямоугольника (фон тут
 * гладкий после evenBackground). Заменяются пиксели, отличающиеся от неё больше чем на 2.5
 * уровня, с запасом 2 px (кольцо от резкости) и мягким краем.
 */
function eraseElement(data, w, h, scale, rect) {
  const [x0, y0, x1, y1] = rect.map((v) => Math.round(v * scale));
  const band = Math.round(4 * scale);
  // Нормальные уравнения МНК для c = a + b·x + d·y, по каналам.
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhs = [0, 1, 2].map(() => [0, 0, 0]);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x - x0 >= band && x1 - 1 - x >= band && y - y0 >= band && y1 - 1 - y >= band) continue;
      const basis = [1, x - x0, y - y0];
      const k = (y * w + x) * 4;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) m[i][j] += basis[i] * basis[j];
        for (let channel = 0; channel < 3; channel++) rhs[channel][i] += basis[i] * data[k + channel];
      }
    }
  }
  const coef = rhs.map((b) => solve3(m, b));
  const plane = (x, y, channel) => coef[channel][0] + coef[channel][1] * (x - x0) + coef[channel][2] * (y - y0);

  const rw = x1 - x0;
  const rh = y1 - y0;
  const mask = new Uint8Array(rw * rh);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = (y * w + x) * 4;
      let diff = 0;
      for (let channel = 0; channel < 3; channel++) diff = Math.max(diff, Math.abs(data[k + channel] - plane(x, y, channel)));
      if (diff > 2.5) mask[(y - y0) * rw + (x - x0)] = 1;
    }
  }
  const grow = 2 * scale;
  const feather = 1.5 * scale;
  const reach = Math.ceil(grow + feather);
  const amount = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (!mask[y * rw + x]) continue;
      for (let dy = -reach; dy <= reach; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rh) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= rw) continue;
          const a = 1 - smoothstep(grow, grow + feather, Math.hypot(dx, dy));
          if (a > amount[yy * rw + xx]) amount[yy * rw + xx] = a;
        }
      }
    }
  }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const a = amount[(y - y0) * rw + (x - x0)];
      if (a <= 0) continue;
      const k = (y * w + x) * 4;
      const grain = triangularGrain(x, y);
      for (let channel = 0; channel < 3; channel++) {
        const fill = plane(x, y, channel) + grain;
        data[k + channel] = Math.round(data[k + channel] * (1 - a) + fill * a);
      }
    }
  }
}

function solve3(m, b) {
  const a = m.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const f = a[row][col] / a[col][col];
      for (let k = col; k < 4; k++) a[row][k] -= f * a[col][k];
    }
  }
  return a.map((row, i) => row[3] / row[i]);
}

/** Треугольное монохромное зерно ±1 уровень — как у ровного фона из evenBackground. */
function triangularGrain(x, y) {
  const h1 = (Math.imul(x + 17, 1103515245) ^ Math.imul(y + 31, 12345)) >>> 0;
  const h2 = (Math.imul(y + 101, 1664525) ^ Math.imul(x + 7, 1013904223)) >>> 0;
  return (h1 & 1023) / 1023 - (h2 & 1023) / 1023;
}

let canvasKitReady = null;
function canvasKit() {
  const dir = path.join(__dirname, '..', 'node_modules', 'canvaskit-wasm', 'bin', 'full');
  canvasKitReady ??= require(path.join(dir, 'canvaskit.js'))({ locateFile: (file) => path.join(dir, file) });
  return canvasKitReady;
}

function paint(ck, scale, rgb, alpha = 1, options = {}) {
  const result = new ck.Paint();
  result.setAntiAlias(true);
  result.setColor(ck.Color(rgb[0], rgb[1], rgb[2], alpha));
  if (options.stroke) {
    result.setStyle(ck.PaintStyle.Stroke);
    result.setStrokeWidth(options.stroke);
    result.setStrokeCap(ck.StrokeCap.Round);
    result.setStrokeJoin(ck.StrokeJoin.Round);
  }
  if (options.blur) {
    result.setMaskFilter(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, options.blur * scale, false));
  }
  return result;
}

function roundedPolygon(ck, points, radius) {
  const result = new ck.Path();
  const count = points.length;
  result.moveTo((points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2);
  for (let index = 1; index <= count; index++) {
    const [x1, y1] = points[index % count];
    const [x2, y2] = points[(index + 1) % count];
    result.arcToTangent(x1, y1, x2, y2, radius);
  }
  result.close();
  return result;
}

/**
 * Камера — геометрия и тон сняты с прежней (растровой) камеры в этом месте: корпус
 * 39.5×31 с радиусом 5.5, зазор до объектива 2.75, объектив-трапеция 6.4 → 14.2 по
 * полувысоте, поворот 29°. С 2026-10-22 ниже прежнего места (94.1, 557) и левее: задняя
 * треть корпуса уходит под левый край экрана (на S25 Ultra виден x от ~64). 2026-10-26 —
 * на 45 выше (было cy 600), тот же x и угол.
 */
function drawCamera(ck, canvas, scale) {
  const cx = 70.0;
  const cy = 555.0;
  canvas.save();
  canvas.rotate(29, cx, cy);

  const bodyRect = ck.RRectXY(ck.LTRBRect(cx - 19.75, cy - 15.5, cx + 19.75, cy + 15.5), 5.5, 5.5);
  const lens = roundedPolygon(
    ck,
    [
      [cx + 22.5, cy - 6.4],
      [cx + 34.75, cy - 14.2],
      [cx + 34.75, cy + 14.2],
      [cx + 22.5, cy + 6.4],
    ],
    1.5,
  );

  // Небольшая родная тень остаётся мягкой, сами грани — чистые и резкие, как у куба.
  const shadow = paint(ck, scale, [20, 25, 33], 0.28, { blur: 1.8 });
  canvas.save();
  canvas.translate(0.7, 1.1);
  canvas.drawRRect(bodyRect, shadow);
  canvas.drawPath(lens, shadow);
  canvas.restore();

  canvas.drawPath(lens, paint(ck, scale, [57, 74, 95]));
  canvas.drawRRect(bodyRect, paint(ck, scale, [57, 75, 98]));
  canvas.drawPath(lens, paint(ck, scale, [83, 103, 131], 0.3, { stroke: 0.65 }));
  canvas.drawRRect(bodyRect, paint(ck, scale, [86, 108, 136], 0.34, { stroke: 0.65 }));
  lens.delete();
  canvas.restore();
}

/** Во сколько раз микрофон меньше прежнего; уменьшается вокруг прежнего центра (501, 309.5). */
const MIC_SCALE = 0.85;
/** С 2026-10-22 микрофон ниже прежнего места и чуть правее. */
const MIC_SHIFT = [3, 85];

/**
 * Микрофон — пропорции и тон прежнего: капсула 24.75×48.75, дужка — полуокружность r 18.1
 * толщиной 4.5, ножка 4.2, подставка 3.3. Рисуется в прежних координатах и уменьшается
 * вокруг центра.
 */
function drawMicrophone(ck, canvas, scale) {
  canvas.save();
  canvas.translate(MIC_SHIFT[0], MIC_SHIFT[1]);
  canvas.translate(501, 309.5);
  canvas.scale(MIC_SCALE, MIC_SCALE);
  canvas.translate(-501, -309.5);

  const body = ck.RRectXY(ck.LTRBRect(488.25, 274.5, 513, 323.25), 12.375, 12.375);
  const cradle = new ck.Path();
  cradle.moveTo(519.3, 308);
  cradle.lineTo(519.3, 309.9);
  cradle.arcToOval(ck.LTRBRect(483.1, 291.8, 519.3, 328), 0, 180, false);
  cradle.lineTo(483.1, 308);

  const shadowFill = paint(ck, scale, [20, 25, 33], 0.3, { blur: 1.6 });
  const shadowStroke = (width) => paint(ck, scale, [20, 25, 33], 0.28, { stroke: width, blur: 1.1 });
  canvas.save();
  canvas.translate(0.6, 1.0);
  canvas.drawRRect(body, shadowFill);
  canvas.drawPath(cradle, shadowStroke(4.5));
  canvas.drawLine(501, 330, 501, 342.6, shadowStroke(4.2));
  canvas.drawLine(490.4, 342.6, 511.1, 342.6, shadowStroke(3.3));
  canvas.restore();

  canvas.drawRRect(body, paint(ck, scale, [61, 74, 94]));
  canvas.drawRRect(body, paint(ck, scale, [88, 108, 136], 0.3, { stroke: 0.65 }));
  canvas.drawPath(cradle, paint(ck, scale, [61, 72, 89], 1, { stroke: 4.5 }));
  canvas.drawLine(501, 330, 501, 342.6, paint(ck, scale, [60, 71, 86], 1, { stroke: 4.2 }));
  canvas.drawLine(490.4, 342.6, 511.1, 342.6, paint(ck, scale, [60, 71, 86], 1, { stroke: 3.3 }));
  cradle.delete();
  canvas.restore();
}

async function drawCrispIcons(w, h, scale) {
  const ck = await canvasKit();
  const surface = ck.MakeSurface(w, h);
  const canvas = surface.getCanvas();
  canvas.clear(ck.TRANSPARENT);
  canvas.scale(scale, scale);
  drawCamera(ck, canvas, scale);
  drawMicrophone(ck, canvas, scale);
  const pixels = canvas.readPixels(0, 0, {
    width: w,
    height: h,
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Premul,
    colorSpace: ck.ColorSpace.SRGB,
  });
  surface.delete();
  return pixels;
}

function compositePremultiplied(base, layer) {
  for (let i = 0; i < base.length; i += 4) {
    const alpha = layer[i + 3] / 255;
    if (alpha <= 0) continue;
    for (let channel = 0; channel < 3; channel++) {
      base[i + channel] = Math.round(layer[i + channel] + base[i + channel] * (1 - alpha));
    }
  }
}

async function refineSpatialStage(imagePath) {
  const image = await Jimp.read(imagePath);
  const { width: w, height: h, data } = image.bitmap;
  const scale = w / SOURCE_WIDTH;
  const patches = [
    ...MAP_ROUND_MARKERS.map((marker) => markerPatch(marker, scale)),
    ...MAP_CLEANUP_PATCHES.map((patch) => rectPatch(patch, scale)),
  ];
  // Каждая заплатка читает картинку после предыдущих: пояс квадрата у второго круга
  // иначе возвращал кусок ещё не убранного маркера.
  for (const patch of patches) removePatch(Buffer.from(data), data, w, h, scale, patch);
  for (const rect of ERASE_RECTS) eraseElement(data, w, h, scale, rect);
  compositePremultiplied(data, await drawCrispIcons(w, h, scale));
  await image.quality(95).writeAsync(imagePath);
  return { width: w, height: h, removedMarkers: MAP_ROUND_MARKERS.length };
}

if (require.main === module) {
  const imagePath = process.argv[2] || path.join(__dirname, '..', 'assets', 'spatial', 'stage-hq.jpg');
  refineSpatialStage(imagePath)
    .then(({ width, height, removedMarkers }) => {
      console.log(`${path.relative(process.cwd(), imagePath)}: ${width}×${height}, убрано кругов: ${removedMarkers}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { MAP_ROUND_MARKERS, ERASE_RECTS, eraseElement, drawCrispIcons, compositePremultiplied, refineSpatialStage };
