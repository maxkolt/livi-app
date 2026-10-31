/** Геометрия куба общая для исходной сцены и финального PNG. */
const path = require('path');
const { BACKGROUND, CUBE_EDGE, CUBE_FACE, SOURCE_WIDTH } = require('./spatial-stage-style');

let ready;
function canvasKit() {
  const dir = path.join(__dirname, '..', 'node_modules', 'canvaskit-wasm', 'bin', 'full');
  ready ??= require(path.join(dir, 'canvaskit.js'))({ locateFile: f => path.join(dir, f) });
  return ready;
}

function vertices({ cx, cy, r, tilt = 0.14 }) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = -Math.PI / 2 + i * Math.PI / 3 + tilt;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
}

function paintCube(ck, canvas, scale, cube) {
  const points = vertices(cube);
  const outline = new ck.Path();
  points.forEach(([x, y], i) => i ? outline.lineTo(x, y) : outline.moveTo(x, y));
  outline.close();
  const body = new ck.Paint();
  body.setAntiAlias(true);
  body.setColor(ck.Color(...CUBE_FACE, 1));
  const edge = new ck.Paint();
  edge.setAntiAlias(true);
  edge.setStyle(ck.PaintStyle.Stroke);
  edge.setStrokeWidth(0.8);
  edge.setStrokeCap(ck.StrokeCap.Butt);
  edge.setStrokeJoin(ck.StrokeJoin.Miter);
  edge.setColor(ck.Color(...CUBE_EDGE, 0.35));
  const ribs = new ck.Path();
  for (const i of [1, 3, 5]) {
    ribs.moveTo(cube.cx, cube.cy);
    ribs.lineTo(...points[i]);
  }
  canvas.save();
  canvas.scale(scale, scale);
  // Обводка направлена внутрь: ни стыки, ни концы рёбер не выходят за силуэт.
  canvas.clipPath(outline, ck.ClipOp.Intersect, false);
  canvas.drawPath(outline, body);
  canvas.drawPath(outline, edge);
  canvas.drawPath(ribs, edge);
  canvas.restore();
  ribs.delete();
  outline.delete();
  body.delete();
  edge.delete();
}

function pixels(ck, canvas, width, height) {
  return canvas.readPixels(0, 0, {
    width, height, colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB,
  });
}

async function drawCubeBody(w, h, scale, cube) {
  const ck = await canvasKit();
  const surface = ck.MakeSurface(w, h);
  const canvas = surface.getCanvas();
  canvas.clear(ck.TRANSPARENT);
  paintCube(ck, canvas, scale, cube);
  const data = pixels(ck, canvas, w, h);
  surface.delete();
  return data;
}

/** 16 выборок на пиксель: сглаживание без ореолов bicubic/JPEG и выступов в вершинах. */
async function repaintCube(image, cube, { padding = 4 } = {}) {
  const { width, height, data } = image.bitmap;
  const scale = width / SOURCE_WIDTH;
  const points = vertices(cube).map(p => p.map(v => v * scale));
  const x0 = Math.max(0, Math.floor(Math.min(...points.map(p => p[0]))) - padding);
  const y0 = Math.max(0, Math.floor(Math.min(...points.map(p => p[1]))) - padding);
  const x1 = Math.min(width, Math.ceil(Math.max(...points.map(p => p[0]))) + padding);
  const y1 = Math.min(height, Math.ceil(Math.max(...points.map(p => p[1]))) + padding);
  const w = x1 - x0, h = y1 - y0, samples = 4;
  const ck = await canvasKit();
  const surface = ck.MakeSurface(w * samples, h * samples);
  const canvas = surface.getCanvas();
  canvas.clear(ck.Color(...BACKGROUND, 1));
  canvas.scale(samples, samples);
  canvas.translate(-x0, -y0);
  paintCube(ck, canvas, scale, cube);
  const high = pixels(ck, canvas, w * samples, h * samples);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let yy = 0; yy < samples; yy++) for (let xx = 0; xx < samples; xx++) {
        sum += high[((y * samples + yy) * w * samples + x * samples + xx) * 4 + c];
      }
      data[((y + y0) * width + x + x0) * 4 + c] = Math.round(sum / (samples * samples));
    }
    data[((y + y0) * width + x + x0) * 4 + 3] = 255;
  }
  surface.delete();
}

module.exports = { canvasKit, drawCubeBody, repaintCube };
