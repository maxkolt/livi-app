import {
  FilterMode,
  MipmapMode,
  Skia,
  TileMode,
  type SkCanvas,
  type SkImage,
  type SkPaint,
  type SkRuntimeEffect,
} from '@shopify/react-native-skia';

/**
 * «Рыбий глаз»: круг под выпуклым стеклом. Им покрыты все аватары
 * (utils/avatarFisheye) и местность радара Поиска.
 *
 * Точка экрана на доле x радиуса линзы показывает то, что лежит на доле
 * g(x) = x·(1 − k + k·x²). В центре всё крупнее в 1/(1 − k) раз, к краю
 * сжимается в (1 + 2k) раз, а сам край круга стоит на месте: линза ничего
 * не выталкивает за свой обод, и шва с тем, что снаружи, нет. За ободом
 * картинка как есть — углы квадратного фото не растягиваются. k < 1.
 */
export const FISHEYE_SKSL = `
uniform shader image;
uniform float2 center;
uniform float radius;
uniform float k;
uniform float2 shift;

half4 main(float2 p) {
  float2 d = (p - center) / radius;
  float x2 = dot(d, d);
  float m = x2 < 1.0 ? 1.0 - k + k * x2 : 1.0;
  return image.eval(center + d * m * radius - shift);
}
`;

/** Сила линзы на аватарах: в центре ×1.33, у края сжатие ×1.5. */
export const AVATAR_FISHEYE_K = 0.25;

/** Доля радиуса, с которой точка экрана на доле x берёт картинку. */
export function fisheyeSource(x: number, k: number): number {
  'worklet';
  return x * (1 - k + k * x * x);
}

/** Обратное: на какой доле радиуса видно то, что лежит на доле s. */
export function fisheyeScreen(s: number, k: number): number {
  'worklet';
  // g монотонна и выпукла при k < 1 — Ньютону хватает пары шагов, берём с запасом.
  let x = s;
  for (let i = 0; i < 5; i++) {
    x -= (x * (1 - k + k * x * x) - s) / (1 - k + 3 * k * x * x);
  }
  return x;
}

let effect: SkRuntimeEffect | null | undefined;
/** JS-поток. На UI-потоке эффект собирают сами (кэш модуля туда не попадает). */
export function getFisheyeEffect(): SkRuntimeEffect | null {
  if (effect === undefined) effect = Skia.RuntimeEffect.Make(FISHEYE_SKSL);
  return effect;
}

/**
 * Кисть: фото «cover» в квадрате со стороной d и левым верхним углом (x, y),
 * под линзой во вписанный круг. pd — пикселей на единицу холста.
 */
export function fisheyePhotoPaint(
  photo: SkImage,
  x: number,
  y: number,
  d: number,
  pd: number,
  k: number = AVATAR_FISHEYE_K,
): SkPaint | null {
  const lens = getFisheyeEffect();
  if (!lens) return null;
  // Сначала уменьшаем снимок с мипмапами, как ExpoImage, — линза берёт уже
  // его. Иначе крупный снимок под линзой рябит.
  const px = Math.max(1, Math.round(d * pd));
  const flat = Skia.Surface.Make(px, px);
  if (!flat) return null;
  const iw = photo.width();
  const ih = photo.height();
  const side = Math.min(iw, ih);
  flat
    .getCanvas()
    .drawImageRectOptions(
      photo,
      Skia.XYWHRect((iw - side) / 2, (ih - side) / 2, side, side),
      Skia.XYWHRect(0, 0, px, px),
      FilterMode.Linear,
      MipmapMode.Linear,
      null,
    );
  flat.flush();
  const m = Skia.Matrix();
  m.translate(x, y);
  m.scale(d / px, d / px);
  const child = flat
    .makeImageSnapshot()
    .makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None, m);
  const r = d / 2;
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setShader(lens.makeShaderWithChildren([x + r, y + r, r, k, 0, 0], [child]));
  return paint;
}

/** Фото под линзой — только круг, вписанный в квадрат (x, y, d). */
export function drawFisheyePhoto(
  canvas: SkCanvas,
  photo: SkImage,
  x: number,
  y: number,
  d: number,
  pd: number,
  k: number = AVATAR_FISHEYE_K,
): boolean {
  const paint = fisheyePhotoPaint(photo, x, y, d, pd, k);
  if (!paint) return false;
  canvas.drawCircle(x + d / 2, y + d / 2, d / 2, paint);
  return true;
}
