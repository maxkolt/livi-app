import {
  BlurStyle,
  FilterMode,
  MipmapMode,
  PaintStyle,
  Skia,
  TileMode,
  type SkCanvas,
  type SkColor,
  type SkImage,
  type SkPaint,
  type SkPath,
  type SkPicture,
  type SkRect,
} from '@shopify/react-native-skia';

/**
 * HUD-радар Поиска. Рисунок делится на три части:
 * - статика (стекло, изолинии, сетка, кольца дальности, шкала) — растр, один
 *   раз на геометрию, на JS-потоке;
 * - пунктирный HUD-обод — векторная картинка, которая медленно вращается;
 * - луч, подсветка шкалы и цели — пишутся заново каждый кадр на UI-потоке.
 * В кадре нет clip и blur по большим фигурам: только сектор с коническим
 * градиентом, линии и несколько размытых точек — это дёшево даже на 120 Гц.
 */

/**
 * Тона радара — бирюза: линии светлее подложки RADAR_INNER_BG, чтобы
 * читаться на непрозрачном диске.
 */
const HUD = '#3F8E96';
const ICE = '#8CCAD0';
/** Лёгкое общее приглушение без изменения баланса отдельных элементов. */
const RADAR_ALPHA = 0.85;
/** Затемнённая бирюза под рисунком радара — полупрозрачнее фона панелей. */
const RADAR_INNER_BG = '#0E2E33';
const RADAR_INNER_ALPHA = 0.52;

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

/** Один оборот луча, с. */
const SWEEP_PERIOD_S = 15;
/** Длина следа за лучом, градусы. */
const TAIL_DEG = 78;
/** Оборот пунктирного HUD-обода, с. */
const DASH_PERIOD_S = 120;
/** Шкала — риска каждые 2°. */
const TICK_STEP_DEG = 2;

/**
 * Цели: a0 — пеленг в момент t=0 (рад, от «севера» по часовой), w — медленный
 * дрейф (рад/с). Луч засекает цель, она вспыхивает и гаснет за оборот; на
 * следующем обороте её может не быть или она окажется на другой дальности.
 */
const CONTACTS: ReadonlyArray<{ a0: number; w: number }> = [
  { a0: 0.35, w: 0.05 },
  { a0: 1.2, w: -0.03 },
  { a0: 1.95, w: 0.04 },
  { a0: 2.7, w: 0.02 },
  { a0: 3.5, w: -0.05 },
  { a0: 4.3, w: 0.03 },
  { a0: 5.0, w: -0.02 },
  { a0: 5.75, w: 0.035 },
];
/** Доля оборотов, на которых цель видна. */
const CONTACT_PRESENCE = 0.7;
/** Кольцо-«пинг» при засечке, с — не зависит от скорости луча. */
const PING_S = 0.9;

export type RadarGeometry = {
  size: number;
  /** Масштаб деталей: 1 — радар 328 dp. */
  u: number;
  cx: number;
  cy: number;
  /** Видимый радиус аватара. */
  a: number;
  /** Тонкое кольцо вокруг аватара — отсюда начинается луч. */
  rIn: number;
  /** Край «стекла» со шкалой. */
  rDisc: number;
  rDash: number;
};

/** Край стекла — доля половины размера радара. */
const DISC_RATIO = 0.79;
/** Сохраняем прежнее внешнее поле, чтобы удаление полос не меняло масштаб радара. */
const DRAWN_EXTENT_U = 16 + 3 + 0.5;
/**
 * До какой доли половины размера доходит рисунок. Остальное — пустое поле контейнера:
 * раскладка вписывает радар по рисунку, а не по контейнеру.
 */
export const RADAR_DRAWN_EXTENT = DISC_RATIO + (DRAWN_EXTENT_U * 2) / 328;

export function radarGeometry(size: number, avatarSize: number): RadarGeometry {
  const half = size / 2;
  const u = size / 328;
  const rDisc = half * DISC_RATIO;
  // На очень маленьком радаре аватар может не влезть — оставляем полоску под луч.
  const a = Math.min(avatarSize / 2, rDisc - 16 * u);
  return {
    size,
    u,
    cx: half,
    cy: half,
    a,
    rIn: a + 5 * u,
    rDisc,
    rDash: rDisc + 5 * u,
  };
}

function color(hex: string, alpha: number): SkColor {
  'worklet';
  const n = parseInt(hex.slice(1), 16);
  return Skia.Color(
    `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha * RADAR_ALPHA})`,
  );
}

function strokePaint(width: number, c: SkColor): SkPaint {
  'worklet';
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setStyle(PaintStyle.Stroke);
  p.setStrokeWidth(width);
  p.setColor(c);
  return p;
}

function hash(i: number, n: number): number {
  'worklet';
  let x = (i * 374761393 + n * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

// ---------- изолинии «карты местности» ----------

function noiseAt(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = noiseAt(ix, iy, seed);
  const b = noiseAt(ix + 1, iy, seed);
  const c = noiseAt(ix, iy + 1, seed);
  const d = noiseAt(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function terrain(x: number, y: number): number {
  return (
    valueNoise(x * 2.1, y * 2.1, 7) * 0.62 +
    valueNoise(x * 4.3, y * 4.3, 11) * 0.28 +
    valueNoise(x * 9, y * 9, 3) * 0.1
  );
}

/** Marching squares по шуму, отрезки обрезаны кругом стекла. */
function buildContourPath(g: RadarGeometry): SkPath {
  const { cx, cy, rDisc } = g;
  const N = 72;
  const levels = [0.34, 0.42, 0.5, 0.58, 0.66];
  const rMax = rDisc - 1.5 * g.u;
  const rMin = g.a - 2;
  const step = (rDisc * 2) / N;
  const vals = new Float32Array((N + 1) * (N + 1));
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) vals[j * (N + 1) + i] = terrain(i / N, j / N);
  }
  const path = Skia.Path.Make();
  const addClipped = (x0: number, y0: number, x1: number, y1: number) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const fx = x0 - cx;
    const fy = y0 - cy;
    const A = dx * dx + dy * dy;
    if (!(A > 0)) return;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - rMax * rMax;
    const disc = B * B - 4 * A * C;
    if (disc <= 0) return;
    const sq = Math.sqrt(disc);
    const t0 = Math.max(0, (-B - sq) / (2 * A));
    const t1 = Math.min(1, (-B + sq) / (2 * A));
    if (t1 <= t0) return;
    const ax = x0 + dx * t0;
    const ay = y0 + dy * t0;
    const bx = x0 + dx * t1;
    const by = y0 + dy * t1;
    // Под аватаром линии всё равно не видны.
    if (Math.hypot((ax + bx) / 2 - cx, (ay + by) / 2 - cy) < rMin) return;
    path.moveTo(ax, ay);
    path.lineTo(bx, by);
  };
  const pts: number[] = [];
  for (const lv of levels) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v0 = vals[j * (N + 1) + i];
        const v1 = vals[j * (N + 1) + i + 1];
        const v2 = vals[(j + 1) * (N + 1) + i + 1];
        const v3 = vals[(j + 1) * (N + 1) + i];
        const x = cx - rDisc + i * step;
        const y = cy - rDisc + j * step;
        pts.length = 0;
        const edge = (va: number, vb: number, xa: number, ya: number, xb: number, yb: number) => {
          if (va < lv !== vb < lv) {
            const t = (lv - va) / (vb - va);
            pts.push(xa + (xb - xa) * t, ya + (yb - ya) * t);
          }
        };
        edge(v0, v1, x, y, x + step, y);
        edge(v1, v2, x + step, y, x + step, y + step);
        edge(v2, v3, x + step, y + step, x, y + step);
        edge(v3, v0, x, y + step, x, y);
        if (pts.length >= 4) addClipped(pts[0], pts[1], pts[2], pts[3]);
        if (pts.length === 8) addClipped(pts[4], pts[5], pts[6], pts[7]);
      }
    }
  }
  return path;
}

// ---------- статика ----------

function tickLength(deg: number, u: number): number {
  'worklet';
  if (deg % 30 === 0) return 7 * u;
  if (deg % 10 === 0) return 4.5 * u;
  return 2.6 * u;
}

function drawStatic(canvas: SkCanvas, g: RadarGeometry): void {
  const { cx, cy, u, a, rIn, rDisc } = g;
  const center = Skia.Point(cx, cy);

  // Всё внутри вращающегося пунктирного обода — прозрачное затемнённое стекло.
  const base = Skia.Paint();
  base.setAntiAlias(true);
  base.setColor(Skia.Color(RADAR_INNER_BG));
  base.setAlphaf(RADAR_INNER_ALPHA);
  canvas.drawCircle(cx, cy, g.rDash, base);

  // Стекло: свечение от аватара, темнее к краю, у самого края — отблеск.
  const glass = Skia.Paint();
  glass.setAntiAlias(true);
  glass.setShader(
    Skia.Shader.MakeRadialGradient(
      center,
      rDisc,
      [color(HUD, 0), color(HUD, 0.27), color(HUD, 0.125), color(HUD, 0.06), color(HUD, 0.16)],
      [0, a / rDisc, (a + (rDisc - a) * 0.45) / rDisc, 0.9, 1],
      TileMode.Clamp,
    ),
  );
  canvas.drawCircle(cx, cy, rDisc, glass);

  canvas.drawPath(buildContourPath(g), strokePaint(0.7 * u, color(HUD, 0.24)));

  // Квадратная сетка в пределах стекла.
  const grid = Skia.Path.Make();
  const cell = (rDisc - rIn) / 2.5;
  for (let k = -6; k <= 6; k++) {
    const off = k * cell;
    if (Math.abs(off) >= rDisc - 1) continue;
    const h = Math.sqrt(rDisc * rDisc - off * off) - 1.5 * u;
    grid.moveTo(cx + off, cy - h);
    grid.lineTo(cx + off, cy + h);
    grid.moveTo(cx - h, cy + off);
    grid.lineTo(cx + h, cy + off);
  }
  canvas.drawPath(grid, strokePaint(0.6 * u, color(HUD, 0.16)));

  const rangePaint = strokePaint(0.7 * u, color(HUD, 0.34));
  // Без аватара круг весь свободен — колец дальности на одно больше.
  const ranges = a > 0 ? 3 : 4;
  for (let k = 1; k < ranges; k++) canvas.drawCircle(cx, cy, rIn + ((rDisc - rIn) * k) / ranges, rangePaint);

  const cross = strokePaint(0.7 * u, color(HUD, 0.4));
  for (let k = 0; k < 4; k++) {
    const cs = Math.cos((k * Math.PI) / 2);
    const sn = Math.sin((k * Math.PI) / 2);
    canvas.drawLine(cx + cs * rIn, cy + sn * rIn, cx + cs * rDisc, cy + sn * rDisc, cross);
  }

  canvas.drawCircle(cx, cy, rIn, strokePaint(0.9 * u, color(HUD, 0.8)));

  // Шкала по внутреннему краю стекла.
  const minor = Skia.Path.Make();
  const mid = Skia.Path.Make();
  const major = Skia.Path.Make();
  const r1 = rDisc - 1.2 * u;
  for (let deg = 0; deg < 360; deg += TICK_STEP_DEG) {
    const ang = deg * D2R;
    const r0 = r1 - tickLength(deg, u);
    const target = deg % 30 === 0 ? major : deg % 10 === 0 ? mid : minor;
    target.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    target.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
  }
  canvas.drawPath(minor, strokePaint(0.55 * u, color(HUD, 0.6)));
  canvas.drawPath(mid, strokePaint(0.75 * u, color(HUD, 0.8)));
  canvas.drawPath(major, strokePaint(1 * u, color(HUD, 0.95)));

  // Край стекла: мягкий ореол и чёткая линия.
  const haloR = rDisc + 6 * u;
  const halo = Skia.Paint();
  halo.setAntiAlias(true);
  halo.setShader(
    Skia.Shader.MakeRadialGradient(
      center,
      haloR,
      [color(HUD, 0), color(HUD, 0), color(HUD, 0.4), color(HUD, 0)],
      [0, (rDisc - 6 * u) / haloR, rDisc / haloR, 1],
      TileMode.Clamp,
    ),
  );
  canvas.drawCircle(cx, cy, haloR, halo);
  canvas.drawCircle(cx, cy, rDisc, strokePaint(1.3 * u, color(HUD, 1)));
}

function recordDashRing(g: RadarGeometry): SkPicture {
  const { cx, cy, u, rDash, size } = g;
  const rec = Skia.PictureRecorder();
  const canvas = rec.beginRecording(Skia.XYWHRect(0, 0, size, size));
  const ring = Skia.Path.Make();
  ring.addCircle(cx, cy, rDash);
  // Целое число штрихов на окружность — без «шва».
  const circ = TAU * rDash;
  const unit = circ / Math.max(12, Math.round(circ / (9 * u)));
  ring.dash(unit * 0.62, unit * 0.38, 0);
  canvas.drawPath(ring, strokePaint(0.9 * u, color(HUD, 0.85)));
  return rec.finishRecordingAsPicture();
}

// ---------- сцена ----------

export type RadarPayload = {
  g: RadarGeometry;
  image: SkImage;
  dashRing: SkPicture;
};

/** JS-поток: всё, что не меняется от кадра к кадру. */
export function prepareRadarPayload(g: RadarGeometry, pd: number): RadarPayload | null {
  const px = Math.max(1, Math.ceil(g.size * pd));
  const surface = Skia.Surface.Make(px, px);
  if (!surface) return null;
  const canvas = surface.getCanvas();
  canvas.scale(px / g.size, px / g.size);
  drawStatic(canvas, g);
  surface.flush();
  return {
    g,
    image: surface.makeImageSnapshot().makeNonTextureImage(),
    dashRing: recordDashRing(g),
  };
}

export type RadarScene = RadarPayload & {
  /** Время сцены, с. Идёт только пока радар на экране. */
  t: number;
  /** Сколько времени прошло с последней перерисовки, мс. */
  sinceDrawMs: number;
  bounds: SkRect;
  src: SkRect;
  discOval: SkRect;
  sector: SkPath;
  beamPaint: SkPaint;
  edgeGlowPaint: SkPaint;
  edgePaint: SkPaint;
  arcPaint: SkPaint;
  tickPaint: SkPaint;
  glowPaint: SkPaint;
  corePaint: SkPaint;
  pingPaint: SkPaint;
  hud: SkColor;
  ice: SkColor;
};

/** UI-поток: кисти и формы, которые кадр переиспользует. */
export function buildRadarScene(p: RadarPayload, t: number): RadarScene {
  'worklet';
  const { cx, cy, u, rIn, rDisc, size } = p.g;
  const r0 = rIn + 0.5 * u;
  const r1 = rDisc - 0.7 * u;
  const tail = TAIL_DEG / 360;

  // Сектор следа: кромка на 0°, след назад против часовой.
  const sector = Skia.Path.Make();
  sector.moveTo(cx + Math.cos(-TAIL_DEG * D2R) * r0, cy + Math.sin(-TAIL_DEG * D2R) * r0);
  sector.arcToOval(Skia.XYWHRect(cx - r1, cy - r1, r1 * 2, r1 * 2), -TAIL_DEG, TAIL_DEG, false);
  sector.arcToOval(Skia.XYWHRect(cx - r0, cy - r0, r0 * 2, r0 * 2), 0, -TAIL_DEG, false);
  sector.close();

  const beamPaint = Skia.Paint();
  beamPaint.setAntiAlias(true);
  beamPaint.setShader(
    Skia.Shader.MakeSweepGradient(
      cx,
      cy,
      [color(HUD, 0), color(HUD, 0), color(HUD, 0.14), color(HUD, 0.36), color(HUD, 0.56), color(ICE, 0.5)],
      [0, 1 - tail, 1 - tail * 0.55, 1 - tail * 0.16, 1 - 0.014, 1],
      TileMode.Clamp,
    ),
  );

  const edgeShader = Skia.Shader.MakeLinearGradient(
    Skia.Point(cx + r0, cy),
    Skia.Point(cx + r1, cy),
    [color(HUD, 0.35), color(ICE, 1)],
    [0, 1],
    TileMode.Clamp,
  );
  const edgeGlowPaint = strokePaint(3.2 * u, color(ICE, 1));
  edgeGlowPaint.setShader(edgeShader);
  edgeGlowPaint.setAlphaf(0.28);
  const edgePaint = strokePaint(1.3 * u, color(ICE, 1));
  edgePaint.setShader(edgeShader);

  const arcPaint = strokePaint(1.8 * u, color(ICE, 1));
  arcPaint.setShader(
    Skia.Shader.MakeSweepGradient(
      cx,
      cy,
      [color(ICE, 0), color(ICE, 0), color(ICE, 0.8)],
      [0, 1 - tail * 0.6, 1],
      TileMode.Clamp,
    ),
  );

  const glowPaint = Skia.Paint();
  glowPaint.setAntiAlias(true);
  glowPaint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 3.4 * u, true));
  const corePaint = Skia.Paint();
  corePaint.setAntiAlias(true);

  return {
    ...p,
    t,
    sinceDrawMs: 0,
    bounds: Skia.XYWHRect(0, 0, size, size),
    src: Skia.XYWHRect(0, 0, p.image.width(), p.image.height()),
    discOval: Skia.XYWHRect(cx - rDisc, cy - rDisc, rDisc * 2, rDisc * 2),
    sector,
    beamPaint,
    edgeGlowPaint,
    edgePaint,
    arcPaint,
    tickPaint: strokePaint(0.8 * u, color(ICE, 1)),
    glowPaint,
    corePaint,
    pingPaint: strokePaint(0.9 * u, color(HUD, 1)),
    hud: color(HUD, 1),
    ice: color(ICE, 1),
  };
}

export function drawRadarFrame(S: RadarScene): SkPicture {
  'worklet';
  const { cx, cy, u, rIn, rDisc } = S.g;
  const t = S.t;
  const omega = TAU / SWEEP_PERIOD_S;
  // Кромка луча, экранный угол: 0 — «3 часа», по часовой; старт с «севера».
  const sweep = (t * omega) % TAU;
  const theta = sweep - Math.PI / 2;
  const r0 = rIn + 0.5 * u;
  const r1 = rDisc - 0.7 * u;

  const rec = Skia.PictureRecorder();
  const canvas = rec.beginRecording(S.bounds);
  canvas.drawImageRectOptions(S.image, S.src, S.bounds, FilterMode.Linear, MipmapMode.None, null);

  canvas.save();
  canvas.rotate(-((t / DASH_PERIOD_S) % 1) * 360, cx, cy);
  canvas.drawPicture(S.dashRing);
  canvas.restore();

  canvas.save();
  canvas.rotate(theta / D2R, cx, cy);
  canvas.drawPath(S.sector, S.beamPaint);
  canvas.drawLine(cx + r0, cy, cx + r1, cy, S.edgeGlowPaint);
  canvas.drawLine(cx + r0, cy, cx + r1, cy, S.edgePaint);
  canvas.drawArc(S.discOval, -TAIL_DEG * 0.6, TAIL_DEG * 0.6, false, S.arcPaint);
  canvas.restore();

  // Риски шкалы вспыхивают под лучом и гаснут следом.
  const tr1 = rDisc - 1.2 * u;
  for (let deg = 0; deg < 360; deg += TICK_STEP_DEG) {
    const ang = deg * D2R;
    let behind = (theta - ang) % TAU;
    if (behind < 0) behind += TAU;
    const lit = Math.exp(-behind / 0.3);
    if (lit < 0.04) continue;
    const tr0 = tr1 - tickLength(deg, u);
    S.tickPaint.setColor(S.ice);
    S.tickPaint.setAlphaf(0.75 * lit);
    S.tickPaint.setStrokeWidth((deg % 30 === 0 ? 1.1 : 0.8) * u);
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    canvas.drawLine(cx + cs * tr0, cy + sn * tr0, cx + cs * tr1, cy + sn * tr1, S.tickPaint);
  }

  // Цели. Номер оборота n — сколько раз луч прошёл цель; на нём меняются
  // дальность и «есть/нет», ровно в момент засечки, когда старая отметка
  // уже погасла. Отметка стоит там, где цель засекли, пока не погаснет.
  const span = Math.max(0, rDisc - rIn - 22 * u);
  for (let i = 0; i < CONTACTS.length; i++) {
    const ct = CONTACTS[i];
    const rel = t * omega - ct.a0 - ct.w * t;
    const n = Math.floor(rel / TAU);
    const age = rel / TAU - n;
    if (hash(i, n) > CONTACT_PRESENCE) continue;
    const tDet = (TAU * n + ct.a0) / (omega - ct.w);
    const aDet = ct.a0 + ct.w * tDet - Math.PI / 2;
    const rr = rIn + 9 * u + span * hash(i + 17, n);
    const x = cx + Math.cos(aDet) * rr;
    const y = cy + Math.sin(aDet) * rr;
    const b = Math.exp(-age * 2.6) * (1 - age);
    if (b < 0.01) continue;
    S.glowPaint.setColor(S.hud);
    S.glowPaint.setAlphaf(b);
    canvas.drawCircle(x, y, 4.6 * u, S.glowPaint);
    S.corePaint.setColor(S.ice);
    S.corePaint.setAlphaf(0.9 * b);
    canvas.drawCircle(x, y, 2 * u, S.corePaint);
    const pingT = (age * SWEEP_PERIOD_S) / PING_S;
    if (pingT < 1) {
      const k = pingT;
      S.pingPaint.setAlphaf(0.9 * (1 - k));
      canvas.drawCircle(x, y, (3 + k * 13) * u, S.pingPaint);
    }
  }

  return rec.finishRecordingAsPicture();
}

let emptyPicture: SkPicture | null = null;
export function getEmptyRadarPicture(): SkPicture {
  if (!emptyPicture) {
    const rec = Skia.PictureRecorder();
    rec.beginRecording(Skia.XYWHRect(0, 0, 1, 1));
    emptyPicture = rec.finishRecordingAsPicture();
  }
  return emptyPicture;
}
