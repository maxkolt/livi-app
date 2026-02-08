/**
 * Генерирует WAV для звука исходящего вызова.
 * Стиль: классический "звонок" — два чередующихся тона (как вибрация/трель), мягко.
 * Запуск: node scripts/generate-outgoing-call-sound.js
 *
 * Если нужен свой звук — просто положи любой WAV в assets/outgoing-call.wav
 * (моно или стерео, 8–48 kHz, приложение подхватит).
 */
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 8000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const AMPLITUDE = Math.floor(32767 * 0.11);

// Классический «звонок»: два тона по очереди (как у телефона)
const FREQ1 = 440;
const FREQ2 = 554;
const TONE_DURATION = 0.35;
const PAUSE_BETWEEN = 0.08;
const PAUSE_AFTER_PAIR = 0.5;

const FADE_SAMPLES = Math.floor(SAMPLE_RATE * 0.04);

function createWavHeader(dataLength) {
  const byteRate = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const header = Buffer.alloc(44);
  let offset = 0;
  header.write('RIFF', offset); offset += 4;
  header.writeUInt32LE(36 + dataLength, offset); offset += 4;
  header.write('WAVE', offset); offset += 4;
  header.write('fmt ', offset); offset += 4;
  header.writeUInt32LE(16, offset); offset += 4;
  header.writeUInt16LE(1, offset); offset += 2;
  header.writeUInt16LE(NUM_CHANNELS, offset); offset += 2;
  header.writeUInt32LE(SAMPLE_RATE, offset); offset += 4;
  header.writeUInt32LE(byteRate, offset); offset += 4;
  header.writeUInt16LE(blockAlign, offset); offset += 2;
  header.writeUInt16LE(BITS_PER_SAMPLE, offset); offset += 2;
  header.write('data', offset); offset += 4;
  header.writeUInt32LE(dataLength, offset);
  return header;
}

function fadeGain(i, total) {
  if (total <= FADE_SAMPLES * 2) return 1;
  if (i < FADE_SAMPLES) return i / FADE_SAMPLES;
  if (i >= total - FADE_SAMPLES) return (total - i) / FADE_SAMPLES;
  return 1;
}

function tone(numSamples, freq, amplitude) {
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const g = fadeGain(i, numSamples);
    const s = Math.round(amplitude * g * Math.sin(2 * Math.PI * freq * t));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return buf;
}

function silence(numSamples) {
  return Buffer.alloc(numSamples * 2, 0);
}

const toneSamples = Math.floor(SAMPLE_RATE * TONE_DURATION);
const pauseShort = Math.floor(SAMPLE_RATE * PAUSE_BETWEEN);
const pauseLong = Math.floor(SAMPLE_RATE * PAUSE_AFTER_PAIR);

const t1 = tone(toneSamples, FREQ1, AMPLITUDE);
const t2 = tone(toneSamples, FREQ2, AMPLITUDE);
const silShort = silence(pauseShort);
const silLong = silence(pauseLong);

// Один цикл: тон1 — пауза — тон2 — длинная пауза (потом зациклится)
const oneCycle = Buffer.concat([t1, silShort, t2, silLong]);
const header = createWavHeader(oneCycle.length);
const wavPath = path.join(__dirname, '..', 'assets', 'outgoing-call.wav');
fs.mkdirSync(path.dirname(wavPath), { recursive: true });
fs.writeFileSync(wavPath, Buffer.concat([header, oneCycle]));
console.log('Written:', wavPath, 'bytes:', header.length + oneCycle.length);
