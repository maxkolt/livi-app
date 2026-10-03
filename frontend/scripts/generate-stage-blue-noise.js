/**
 * Порог дизеринга основного фона Android (StageBackground.kt): тайл blue noise 64×64,
 * 8 бит на ячейку, каждое значение 0…255 встречается ровно 16 раз.
 *
 * Void-and-cluster (Ulichney, 1993) на торе, ядро Гаусса σ = 1.5. PRNG детерминированный —
 * повторный запуск даёт тот же файл.
 *
 * Usage:
 *   node ./scripts/generate-stage-blue-noise.js [out]
 *   # по умолчанию android/app/src/main/res/raw/stage_blue_noise.bin
 */
const fs = require('fs');
const path = require('path');

const N = 64;
const A = N * N;
const SIGMA = 1.5;

let seed = 0x1234567;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

const kernel = new Float64Array(A);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const dx = Math.min(x, N - x);
    const dy = Math.min(y, N - y);
    kernel[y * N + x] = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
  }
}

function addEnergy(energy, p, sign) {
  const px = p % N;
  const py = (p / N) | 0;
  for (let y = 0; y < N; y++) {
    const ky = ((y - py + N) % N) * N;
    const ey = y * N;
    for (let x = 0; x < N; x++) energy[ey + x] += sign * kernel[ky + ((x - px + N) % N)];
  }
}

function energyOf(bits, value) {
  const energy = new Float64Array(A);
  for (let p = 0; p < A; p++) if (bits[p] === value) addEnergy(energy, p, 1);
  return energy;
}

/** Самая плотная точка (max) или самая большая пустота (min) среди ячеек со значением value. */
function extreme(energy, bits, value, max) {
  let best = -1;
  let bestEnergy = max ? -Infinity : Infinity;
  for (let p = 0; p < A; p++) {
    if (bits[p] !== value) continue;
    if (max ? energy[p] > bestEnergy : energy[p] < bestEnergy) {
      bestEnergy = energy[p];
      best = p;
    }
  }
  return best;
}

// Начальный узор: ~10% единиц, перекладываем из кластеров в пустоты до сходимости.
const initial = new Uint8Array(A);
const ones = Math.round(A * 0.1);
for (let placed = 0; placed < ones; ) {
  const p = (rnd() * A) | 0;
  if (!initial[p]) {
    initial[p] = 1;
    placed++;
  }
}
{
  const energy = energyOf(initial, 1);
  for (let i = 0; i < A; i++) {
    const cluster = extreme(energy, initial, 1, true);
    initial[cluster] = 0;
    addEnergy(energy, cluster, -1);
    const voidAt = extreme(energy, initial, 0, false);
    initial[voidAt] = 1;
    addEnergy(energy, voidAt, 1);
    if (voidAt === cluster) break;
  }
}

const rank = new Int32Array(A);
// 1: ранги исходных единиц — снимаем самые плотные кластеры.
{
  const bits = initial.slice();
  const energy = energyOf(bits, 1);
  for (let r = ones - 1; r >= 0; r--) {
    const cluster = extreme(energy, bits, 1, true);
    bits[cluster] = 0;
    addEnergy(energy, cluster, -1);
    rank[cluster] = r;
  }
}
// 2: до половины — вставка в самую большую пустоту.
const bits = initial.slice();
let r = ones;
{
  const energy = energyOf(bits, 1);
  for (; r < A / 2; r++) {
    const voidAt = extreme(energy, bits, 0, false);
    bits[voidAt] = 1;
    addEnergy(energy, voidAt, 1);
    rank[voidAt] = r;
  }
}
// 3: теперь в меньшинстве нули — заполняем самый плотный кластер нулей.
{
  const energy = energyOf(bits, 0);
  for (; r < A; r++) {
    const cluster = extreme(energy, bits, 0, true);
    bits[cluster] = 1;
    addEnergy(energy, cluster, -1);
    rank[cluster] = r;
  }
}

const out = Buffer.alloc(A);
for (let p = 0; p < A; p++) out[p] = Math.floor((rank[p] * 256) / A);

const target =
  process.argv[2] ||
  path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'raw', 'stage_blue_noise.bin');
fs.writeFileSync(target, out);
console.log(`Wrote ${target} (${N}×${N})`);
