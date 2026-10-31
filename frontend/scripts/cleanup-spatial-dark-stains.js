#!/usr/bin/env node

const path = require('path');
const Jimp = require('jimp-compact');

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Пять тёмных следов, оставшихся после удаления отдельных светлых точек.
// Координаты заданы для исходной сцены 572×1024. Области намеренно небольшие:
// три идут вниз от левой камеры, справа остаются одна полоса и один треугольник.
const DARK_STAIN_CLEANUP = [
  { rect: [112, 589, 142, 628], feather: 7 },
  { rect: [90, 609, 143, 661], feather: 9 },
  { rect: [87, 641, 134, 693], feather: 9 },
  { rect: [408, 554, 463, 645], feather: 10 },
  { rect: [421, 633, 480, 703], feather: 10 },
];

function median(values) {
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

/**
 * Выравнивает только тёмную часть пятна по чистому фону слева и справа в той же
 * строке. Всё, что светлее фона (контуры камеры, графики, горы и линии куба),
 * остаётся нетронутым.
 */
function removeDarkCleanupStains(data, w, h, scale = w / 572) {
  // Единый опорный цвет берётся из большой чистой области. Медиана не реагирует
  // на редкие светлые линии карты и не создаёт горизонтальных полос по строкам.
  const reference = [[], [], []];
  for (let y = Math.floor(560 * scale); y < Math.ceil(700 * scale); y += 2) {
    for (let x = Math.floor(180 * scale); x < Math.ceil(390 * scale); x += 2) {
      const k = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) reference[c].push(data[k + c]);
    }
  }
  const target = reference.map(median);
  const targetLum = 0.2126 * target[0] + 0.7152 * target[1] + 0.0722 * target[2];

  for (const { rect, feather: featherSource } of DARK_STAIN_CLEANUP) {
    const [x0, y0, x1, y1] = rect.map((value) => value * scale);
    const feather = featherSource * scale;
    const left = Math.max(0, Math.floor(x0));
    const right = Math.min(w, Math.ceil(x1));
    const top = Math.max(0, Math.floor(y0));
    const bottom = Math.min(h, Math.ceil(y1));

    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const mask =
          smoothstep(x0, x0 + feather, x) *
          (1 - smoothstep(x1 - feather, x1, x)) *
          smoothstep(y0, y0 + feather, y) *
          (1 - smoothstep(y1 - feather, y1, y));
        if (mask <= 0) continue;
        const k = (y * w + x) * 4;
        const lum = 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
        // Фон и пятно выравниваются полностью; заметно более светлая графика
        // постепенно исключается из маски и сохраняет исходные пиксели.
        const background = 1 - smoothstep(targetLum + 0.5, targetLum + 4, lum);
        const amount = mask * background;
        if (amount <= 0) continue;
        for (let c = 0; c < 3; c++) data[k + c] += (target[c] - data[k + c]) * amount;
      }
    }
  }
}

async function main() {
  const imagePath = process.argv[2] || path.join(__dirname, '..', 'assets', 'spatial', 'stage-hq.png');
  const image = await Jimp.read(imagePath);
  removeDarkCleanupStains(image.bitmap.data, image.bitmap.width, image.bitmap.height);
  await image.writeAsync(imagePath);
  console.log(`${path.relative(process.cwd(), imagePath)}: убраны пять тёмных следов`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { removeDarkCleanupStains };
