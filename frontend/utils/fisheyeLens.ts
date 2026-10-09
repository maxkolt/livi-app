/**
 * «Рыбий глаз»: круг под выпуклым стеклом — им покрыта местность радара Поиска.
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
