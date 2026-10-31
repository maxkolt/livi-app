#!/usr/bin/env node
/** Перевёрнутый список справа и небольшое чёткое облако под верхним стеклом. */
const path = require('path');
const Jimp = require('jimp-compact');
const { canvasKit } = require('./spatial-cube');
const { BACKGROUND, SOURCE_WIDTH, HEADER_DIGITS, HEADER_BUBBLE } = require('./spatial-stage-style');

function fillRect(image, rect) {
  const { width, data } = image.bitmap;
  for (let y = rect[1]; y < rect[3]; y++) for (let x = rect[0]; x < rect[2]; x++) {
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) data[i + c] = BACKGROUND[c];
    data[i + 3] = 255;
  }
}

/** Точный разворот пикселей без масштабирования и без переноса прямоугольника подложки. */
function moveDigits(image) {
  const { width, data } = image.bitmap;
  const scale = width / 1440;
  const [x0, y0, x1, y1] = HEADER_DIGITS.from.map(v => Math.round(v * scale));
  const [tx, ty] = HEADER_DIGITS.to.map(v => Math.round(v * scale));
  const w = x1 - x0, h = y1 - y0;
  const source = image.clone().crop(x0, y0, w, h).bitmap.data;
  fillRect(image, [x0, y0, x1, y1]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const from = ((h - 1 - y) * w + w - 1 - x) * 4;
    const to = ((ty + y) * width + tx + x) * 4;
    for (let c = 0; c < 3; c++) {
      data[to + c] = Math.max(0, Math.min(255, data[to + c] + source[from + c] - BACKGROUND[c]));
    }
  }
}

async function repaintBubble(image) {
  const { width, data } = image.bitmap;
  const scale = width / SOURCE_WIDTH;
  // Полностью убрать прежнее облако вместе с тенью. По краям здесь ровный фон.
  const rect = [190, 128, 305, 211].map(v => Math.round(v * scale));
  fillRect(image, rect);
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0, h = y1 - y0, samples = 4;
  const ck = await canvasKit();
  const surface = ck.MakeSurface(w * samples, h * samples);
  if (!surface) throw new Error('Unable to create header bubble surface');
  const canvas = surface.getCanvas();
  canvas.clear(ck.Color(...BACKGROUND, 1));
  canvas.scale(samples, samples);
  canvas.translate(-x0, -y0);
  canvas.scale(scale, scale);
  const b = HEADER_BUBBLE;
  const left = b.cx - b.w / 2, top = b.cy - b.h / 2, bottom = top + b.h;
  const body = new ck.Path();
  body.addRRect(ck.RRectXY(ck.LTRBRect(left, top, left + b.w, bottom), b.radius, b.radius));
  const tail = new ck.Path();
  tail.moveTo(left + b.w * 0.08, bottom - 1);
  tail.lineTo(left + b.w * 0.16, bottom + b.h * 0.26);
  tail.lineTo(left + b.w * 0.39, bottom - 1);
  tail.close();
  const shape = ck.Path.MakeFromOp(body, tail, ck.PathOp.Union);
  const paint = new ck.Paint();
  paint.setAntiAlias(true);
  // Тот же материал и лёгкая кромка, что в drawCamera(). Без широкой дымки.
  paint.setColor(ck.Color(57, 75, 98, 1));
  canvas.drawPath(shape, paint);
  paint.setStyle(ck.PaintStyle.Stroke);
  paint.setStrokeWidth(0.65);
  paint.setColor(ck.Color(86, 108, 136, 0.34));
  canvas.save();
  canvas.clipPath(shape, ck.ClipOp.Intersect, true);
  canvas.drawPath(shape, paint);
  canvas.restore();
  paint.setStrokeWidth(3);
  paint.setStrokeCap(ck.StrokeCap.Round);
  paint.setColor(ck.Color(...BACKGROUND, 1));
  canvas.drawLine(left + b.w * 0.2, top + b.h * 0.36, left + b.w * 0.8, top + b.h * 0.36, paint);
  canvas.drawLine(left + b.w * 0.2, top + b.h * 0.6, left + b.w * 0.58, top + b.h * 0.6, paint);
  const pixels = canvas.readPixels(0, 0, {
    width: w * samples, height: h * samples, colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB,
  });
  if (!pixels) throw new Error('Unable to read header bubble surface');
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dest = ((y0 + y) * width + x0 + x) * 4;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let yy = 0; yy < samples; yy++) for (let xx = 0; xx < samples; xx++) {
        sum += pixels[((y * samples + yy) * w * samples + x * samples + xx) * 4 + c];
      }
      data[dest + c] = Math.round(sum / (samples * samples));
    }
  }
  paint.delete(); shape.delete(); tail.delete(); body.delete(); surface.delete();
}

async function relayoutSpatialHeader(file) {
  const image = await Jimp.read(file);
  moveDigits(image);
  await repaintBubble(image);
  await image.writeAsync(file);
  console.log('spatial header: digits rotated 180° and moved right/up; smaller camera-material bubble; clean background');
}

if (require.main === module) {
  relayoutSpatialHeader(process.argv[2] || path.join(__dirname, '..', 'assets/spatial/stage-hq.png'))
    .catch(error => { console.error(error); process.exit(1); });
}
module.exports = { relayoutSpatialHeader };
