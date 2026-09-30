import React, { useEffect, useMemo, useState } from 'react';
import { PixelRatio, StyleSheet, View } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import Reanimated, {
  measure,
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useSharedValue,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated';
import {
  AlphaType,
  BlendMode,
  Canvas,
  ClipOp,
  ColorType,
  FilterMode,
  MipmapMode,
  PaintStyle,
  Picture,
  Skia,
  TileMode,
  makeImageFromView,
  type SkImage,
  type SkPaint,
  type SkPicture,
  type SkRect,
  type SkRSXform,
} from '@shopify/react-native-skia';
import { logger } from '../../utils/logger';

/**
 * «Пыль» аватара на радаре Поиска: палец проводит по аватару, тот рассыпается
 * на пиксели, а они сами собираются обратно.
 *
 * Как устроено:
 * - Текстура — точная копия того, что нарисовано на экране (фото, подложка,
 *   купленная рамка). Её режем на квадратные ячейки по целым физическим
 *   пикселям, поэтому в покое частицы складываются в картинку без швов.
 * - Физика и отрисовка целиком на UI-потоке: цикл запускается касанием и сам
 *   останавливается, когда все частицы вернулись домой. В покое ничего не
 *   считается и не рисуется.
 * - Пока частицы в движении, настоящий аватар спрятан, а слой с частицами
 *   лежит поверх всего экрана, чтобы разлёт нигде не обрезался.
 */

export type AvatarDustController = {
  /** Палец относительно центра аватара, dp. */
  fingerX: SharedValue<number>;
  fingerY: SharedValue<number>;
  /** 1, пока палец на экране. */
  fingerDown: SharedValue<number>;
  /** 1 — настоящий аватар спрятан, на его месте частицы. */
  realHidden: SharedValue<number>;
};

/** Что лежит в круге аватара — из этого строится текстура. */
export type AvatarDustSource =
  | {
      kind: 'photo';
      uri: string;
      /** Внешний диаметр аватара вместе с рамкой, dp. */
      size: number;
      photoSize: number;
      /** 0 — рамки нет. */
      ringWidth: number;
      frameColors: readonly string[] | null;
      backdrop: string;
    }
  | {
      /**
       * Буква вместо фото: снимаем сам view. Для фото так нельзя — на Android
       * Glide отдаёт hardware-битмапы, а снимок рисуется программно.
       */
      kind: 'snapshot';
      size: number;
      key: string;
    };

export function avatarDustSourceKey(source: AvatarDustSource | null): string {
  if (!source) return '';
  if (source.kind === 'snapshot') return `s|${source.size}|${source.key}`;
  return [
    'p',
    source.uri,
    source.size,
    source.photoSize,
    source.ringWidth,
    (source.frameColors ?? []).join(','),
    source.backdrop,
  ].join('|');
}

export function useAvatarDustController(): AvatarDustController {
  const fingerX = useSharedValue(0);
  const fingerY = useSharedValue(0);
  const fingerDown = useSharedValue(0);
  const realHidden = useSharedValue(0);
  return useMemo(
    () => ({ fingerX, fingerY, fingerDown, realHidden }),
    [fingerX, fingerY, fingerDown, realHidden],
  );
}

/**
 * Жест на весь радар. Центр радара совпадает с центром аватара, поэтому
 * координаты пальца отсчитываем от него.
 *
 * Pan с minDistance(0) забирает касание сразу, и Pressable под ним уже не
 * срабатывает — поэтому тап по аватару тоже ловим здесь.
 */
export function useAvatarDustGesture(
  dust: AvatarDustController,
  fieldSize: number,
  avatarSize: number,
  onTapAvatar: () => void,
) {
  return useMemo(() => {
    const half = fieldSize / 2;
    const hitR = avatarSize / 2 + 6;
    const hitR2 = hitR * hitR;
    const { fingerX, fingerY, fingerDown } = dust;
    const pan = Gesture.Pan()
      .minDistance(0)
      .shouldCancelWhenOutside(false)
      .onBegin((e) => {
        fingerX.value = e.x - half;
        fingerY.value = e.y - half;
        fingerDown.value = 1;
      })
      .onUpdate((e) => {
        fingerX.value = e.x - half;
        fingerY.value = e.y - half;
      })
      .onFinalize(() => {
        fingerDown.value = 0;
      });
    const tap = Gesture.Tap()
      .maxDistance(12)
      .onEnd((e, success) => {
        if (!success) return;
        const dx = e.x - half;
        const dy = e.y - half;
        if (dx * dx + dy * dy <= hitR2) runOnJS(onTapAvatar)();
      });
    return Gesture.Simultaneous(pan, tap);
  }, [avatarSize, dust, fieldSize, onTapAvatar]);
}

/** Прячет настоящий аватар, пока вместо него рисуются частицы. */
export function AvatarDustHide({
  dust,
  children,
}: {
  dust: AvatarDustController;
  children: React.ReactNode;
}) {
  const { realHidden } = dust;
  const style = useAnimatedStyle(() => ({ opacity: realHidden.value === 1 ? 0 : 1 }));
  return <Reanimated.View style={style}>{children}</Reanimated.View>;
}


// ——— Настройки ощущения. Расстояния и ускорения — для аватара 124 dp,
// на других размерах масштабируются пропорционально. ———

/** Сколько частиц на круг: мельче — красивее, но дороже по кадру. */
const TARGET_PARTICLES = 3000;
/** Радиус пятна под пальцем, доля диаметра аватара. */
const FINGER_RADIUS = 0.24;
/** Отталкивание в центре пятна, dp/с². */
const PUSH = 6000;
/** Какую долю скорости пальца частицы получают за секунду (1/с) — отсюда разлёт при взмахе. */
const WIND = 14;
/**
 * Сила удара у каждой частицы своя, со смещением к слабым: большинство
 * отлетает умеренно, а отдельные пиксели улетают далеко — облако, а не комок.
 */
const KICK_GAIN_MIN = 0.45;
const KICK_GAIN_SPREAD = 1.6;
/** И направление своё: удар поворачивается на случайный угол до ±KICK_TURN рад — веер. */
const KICK_TURN = 0.75;
/**
 * После удара частица сначала летит свободно, пружина включается плавно за
 * это время, с. Иначе её сразу тянет домой и она отлетает на пару пикселей.
 */
const LOOSE_TIME = 0.5;
/** Сопротивление воздуха в свободном полёте, 1/с. */
const AIR_DRAG = 1.4;
/** Пружина домой (ω² в 1/с²): ω ≈ 6.3 рад/с — у дома пиксель встаёт на место примерно за 0.8 с. */
const SPRING = 40;
/**
 * Издалека пружина мягче: тяга растёт с расстоянием всё слабее, и пиксель с
 * 80 dp летит домой ~0.6 с вместо ~0.5 с. Последние несколько dp (сама
 * сборка) от этого не меняются — там пружина прежняя. 100 уже медленно.
 */
const RETURN_SOFT_AT = 180;
/** Лёгкий перелёт через дом, без долгого дрожания. */
const DAMPING_RATIO = 0.74;
/** Разброс жёсткости: одни пиксели возвращаются раньше, другие догоняют. */
const STIFF_MIN = 0.55;
const STIFF_SPREAD = 0.9;
const MAX_SPEED = 2600;
/** На сколько уменьшается улетевший пиксель — между ними появляется воздух. */
const SHRINK = 0.45;
/** На каком удалении от дома пиксель уже уменьшен полностью, dp. */
const SHRINK_AT = 28;
/** Наибольший поворот улетевшего пикселя, рад. */
const SPIN = 0.5;
/** Лёгкое парение отлетевших пикселей, dp/с². */
const FLUTTER = 140;
/**
 * Порог «вернулся домой»: смещение, dp, и скорость, dp/с. Последний шаг
 * к дому — доли физического пикселя, глазом не виден.
 */
const REST_DIST2 = 0.06 * 0.06;
const REST_SPEED2 = 1;
/**
 * Сколько кадров частицы рисуются поверх ещё видимого аватара, прежде чем
 * его спрятать, и наоборот — на выходе. Картинки совпадают, а зазор
 * страхует от кадра, в котором не видно ни того, ни другого.
 */
const HANDOFF_FRAMES = 2;
const BASE_SIZE = 124;

const SRC_OVER = BlendMode.SrcOver;
const SAMPLING = { filter: FilterMode.Linear, mipmap: MipmapMode.None };
const NEAREST = FilterMode.Nearest;
const NO_MIPMAP = MipmapMode.None;
const MASK_COLOR_TYPE = ColorType.RGBA_8888;
const MASK_ALPHA_TYPE = AlphaType.Premul;

type DustPayload = {
  image: SkImage;
  empty: SkPicture;
  pd: number;
  texW: number;
  texH: number;
  cell: number;
  cols: number;
  rows: number;
  /** Пары [col, row] непрозрачных ячеек. */
  cells: number[];
  unit: number;
};

/**
 * Частица — ячейка текстуры. Пока она дома, её рисует сама текстура целиком
 * (одна картинка на весь аватар). Как только ячейку задело пальцем, она
 * вырезается из текстуры маской и дальше летит отдельным спрайтом атласа.
 * Так кадр стоит пропорционально тому, что реально движется.
 */
type DustSim = {
  n: number;
  image: SkImage;
  empty: SkPicture;
  paint: SkPaint;
  maskPaint: SkPaint;
  sprites: SkRect[];
  xf: SkRSXform[];
  pd: number;
  inv: number;
  texW: number;
  texH: number;
  unit: number;
  cols: number;
  rows: number;
  cellDp: number;
  /** Левый верхний угол ячейки в текстуре, dp. */
  lx: Float64Array;
  ly: Float64Array;
  /** Половина ячейки, px текстуры. */
  hw: Float64Array;
  hh: Float64Array;
  cellOf: Int32Array;
  cellToIdx: Int32Array;
  dx: Float64Array;
  dy: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  stiff: Float64Array;
  damp: Float64Array;
  spin: Float64Array;
  phase: Float64Array;
  gain: Float64Array;
  turnC: Float64Array;
  turnS: Float64Array;
  /** 1 — только что ударили, пружина выключена; к 0 она включается целиком. */
  loose: Float64Array;
  rest: Uint8Array;
  /** Индексы летящих частиц; первые actN — живые. */
  act: Int32Array;
  actN: number;
  /** Маска ячеек: 255 — ячейка дома и рисуется текстурой, 0 — улетела. */
  mask: Uint8Array;
  maskDirty: boolean;
  maskImg: SkImage | null;
  srcRect: SkRect;
  maskSrc: SkRect;
  dstRect: SkRect | null;
  maskDst: SkRect | null;
  aSpr: SkRect[];
  aXf: SkRSXform[];
  // Состояние цикла.
  live: boolean;
  frames: number;
  settle: number;
  lastT: number;
  ox: number;
  oy: number;
  bounds: SkRect | null;
  wasDown: boolean;
  pfx: number;
  pfy: number;
  fvx: number;
  fvy: number;
};

let emptyPicture: SkPicture | null = null;
function getEmptyPicture(): SkPicture {
  if (!emptyPicture) {
    const rec = Skia.PictureRecorder();
    rec.beginRecording(Skia.XYWHRect(0, 0, 1, 1));
    emptyPicture = rec.finishRecordingAsPicture();
  }
  return emptyPicture;
}

async function loadEncodedImage(uri: string): Promise<SkImage | null> {
  let data;
  if (/^data:/i.test(uri)) {
    const comma = uri.indexOf(',');
    if (comma < 0 || !/;base64$/i.test(uri.slice(0, comma))) return null;
    data = Skia.Data.fromBase64(uri.slice(comma + 1));
  } else {
    data = await Skia.Data.fromURI(uri);
  }
  return Skia.Image.MakeImageFromEncoded(data);
}

/**
 * Повторяет раскладку AvatarImage/HomeCenterProfile: подложка во весь круг,
 * фото «cover» в круге внутри рамки, волосяной ободок и градиентное кольцо.
 */
function renderPhotoTexture(
  photo: SkImage,
  source: Extract<AvatarDustSource, { kind: 'photo' }>,
  pd: number,
): SkImage | null {
  const size = source.size;
  const texPx = Math.max(1, Math.round(size * pd));
  const surface = Skia.Surface.Make(texPx, texPx);
  if (!surface) return null;
  const canvas = surface.getCanvas();
  const k = texPx / size;
  canvas.scale(k, k);
  const mid = size / 2;

  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setColor(Skia.Color(source.backdrop));
  canvas.drawCircle(mid, mid, mid, paint);

  const inset = source.ringWidth;
  const p = Math.max(1, size - inset * 2);
  const iw = photo.width();
  const ih = photo.height();
  const scale = Math.max(p / iw, p / ih);
  const sw = p / scale;
  const sh = p / scale;
  canvas.save();
  const clip = Skia.Path.Make();
  clip.addCircle(mid, mid, p / 2);
  canvas.clipPath(clip, ClipOp.Intersect, true);
  canvas.drawImageRectOptions(
    photo,
    Skia.XYWHRect((iw - sw) / 2, (ih - sh) / 2, sw, sh),
    Skia.XYWHRect(inset, inset, p, p),
    FilterMode.Linear,
    MipmapMode.Linear,
    null,
  );
  canvas.restore();

  const colors = source.frameColors;
  if (inset > 0 && colors && colors.length > 0) {
    const hairline = Skia.Paint();
    hairline.setAntiAlias(true);
    hairline.setStyle(PaintStyle.Stroke);
    hairline.setStrokeWidth(1);
    hairline.setColor(Skia.Color('rgba(255,255,255,0.38)'));
    canvas.drawCircle(mid, mid, p / 2 - 0.5, hairline);

    const ring = Skia.Paint();
    ring.setAntiAlias(true);
    ring.setStyle(PaintStyle.Stroke);
    ring.setStrokeWidth(inset);
    const stops = colors.length > 1 ? colors : [colors[0], colors[0]];
    ring.setShader(
      Skia.Shader.MakeLinearGradient(
        Skia.Point(inset / 2, inset / 2),
        Skia.Point(size - inset / 2, size - inset / 2),
        stops.map((c) => Skia.Color(c)),
        stops.map((_, i) => i / (stops.length - 1)),
        TileMode.Clamp,
      ),
    );
    canvas.drawCircle(mid, mid, (size - inset) / 2, ring);
  }

  surface.flush();
  return surface.makeImageSnapshot().makeNonTextureImage();
}

/** Ячейки, в которых есть хоть что-то видимое: углы квадрата вне круга выкидываем. */
function collectCells(image: SkImage, cell: number): number[] | null {
  const w = image.width();
  const h = image.height();
  const px = image.readPixels(0, 0, {
    width: w,
    height: h,
    colorType: ColorType.RGBA_8888,
    alphaType: AlphaType.Unpremul,
  });
  if (!px) return null;
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const out: number[] = [];
  for (let row = 0; row < rows; row++) {
    const y0 = row * cell;
    const y1 = Math.min(h, y0 + cell);
    for (let col = 0; col < cols; col++) {
      const x0 = col * cell;
      const x1 = Math.min(w, x0 + cell);
      let visible = false;
      for (let y = y0; y < y1 && !visible; y++) {
        let idx = (y * w + x0) * 4 + 3;
        for (let x = x0; x < x1; x++, idx += 4) {
          if (px[idx] > 6) {
            visible = true;
            break;
          }
        }
      }
      if (visible) out.push(col, row);
    }
  }
  return out;
}

function pickCellPx(texPx: number): number {
  const perSide = Math.sqrt(TARGET_PARTICLES / (Math.PI / 4));
  return Math.max(3, Math.ceil(texPx / perSide));
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type AvatarDustOverlayProps = {
  dust: AvatarDustController;
  source: AvatarDustSource | null;
  /** View настоящего аватара: по нему совмещаем частицы и снимаем букву. */
  avatarRef: AnimatedRef<View>;
};

/**
 * Слой частиц во весь экран Поиска. Кладётся последним ребёнком корня,
 * касания пропускает насквозь.
 */
export function AvatarDustOverlay({ dust, source, avatarRef }: AvatarDustOverlayProps) {
  const overlayRef = useAnimatedRef<View>();
  const sim = useSharedValue<DustSim | null>(null);
  const empty = getEmptyPicture();
  const picture = useSharedValue<SkPicture>(empty);
  const running = useSharedValue(0);
  const [ready, setReady] = useState(false);
  const { fingerX, fingerY, fingerDown, realHidden } = dust;
  const sourceKey = avatarDustSourceKey(source);

  const installSim = (p: DustPayload) => {
    'worklet';
    const n = p.cells.length >> 1;
    const inv = 1 / p.pd;
    const lx = new Float64Array(n);
    const ly = new Float64Array(n);
    const hw = new Float64Array(n);
    const hh = new Float64Array(n);
    const cellOf = new Int32Array(n);
    const cellToIdx = new Int32Array(p.cols * p.rows).fill(-1);
    const stiff = new Float64Array(n);
    const damp = new Float64Array(n);
    const spin = new Float64Array(n);
    const phase = new Float64Array(n);
    const gain = new Float64Array(n);
    const turnC = new Float64Array(n);
    const turnS = new Float64Array(n);
    const rest = new Uint8Array(n);
    const sprites: SkRect[] = new Array(n);
    const xf: SkRSXform[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const col = p.cells[i * 2];
      const row = p.cells[i * 2 + 1];
      const sx = col * p.cell;
      const sy = row * p.cell;
      const w = Math.min(p.cell, p.texW - sx);
      const h = Math.min(p.cell, p.texH - sy);
      sprites[i] = Skia.XYWHRect(sx, sy, w, h);
      xf[i] = Skia.RSXform(inv, 0, 0, 0);
      lx[i] = sx * inv;
      ly[i] = sy * inv;
      hw[i] = w * 0.5;
      hh[i] = h * 0.5;
      cellOf[i] = row * p.cols + col;
      cellToIdx[row * p.cols + col] = i;
      const k = STIFF_MIN + STIFF_SPREAD * Math.random();
      stiff[i] = SPRING * k;
      damp[i] = 2 * DAMPING_RATIO * Math.sqrt(SPRING * k);
      spin[i] = (Math.random() * 2 - 1) * SPIN;
      phase[i] = Math.random() * Math.PI * 2;
      const g = Math.random();
      gain[i] = KICK_GAIN_MIN + KICK_GAIN_SPREAD * g * g;
      const turn = (Math.random() * 2 - 1) * KICK_TURN;
      turnC[i] = Math.cos(turn);
      turnS[i] = Math.sin(turn);
      rest[i] = 1;
    }
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    const maskPaint = Skia.Paint();
    maskPaint.setBlendMode(BlendMode.DstIn);
    sim.value = {
      n,
      image: p.image,
      empty: p.empty,
      paint,
      maskPaint,
      sprites,
      xf,
      pd: p.pd,
      inv,
      texW: p.texW,
      texH: p.texH,
      unit: p.unit,
      cols: p.cols,
      rows: p.rows,
      cellDp: p.cell * inv,
      lx,
      ly,
      hw,
      hh,
      cellOf,
      cellToIdx,
      dx: new Float64Array(n),
      dy: new Float64Array(n),
      vx: new Float64Array(n),
      vy: new Float64Array(n),
      stiff,
      damp,
      spin,
      phase,
      gain,
      turnC,
      turnS,
      loose: new Float64Array(n),
      rest,
      act: new Int32Array(n),
      actN: 0,
      mask: new Uint8Array(p.cols * p.rows * 4).fill(255),
      maskDirty: true,
      maskImg: null,
      srcRect: Skia.XYWHRect(0, 0, p.texW, p.texH),
      maskSrc: Skia.XYWHRect(0, 0, p.cols, p.rows),
      dstRect: null,
      maskDst: null,
      aSpr: [],
      aXf: [],
      live: false,
      frames: 0,
      settle: 0,
      lastT: 0,
      ox: NaN,
      oy: NaN,
      bounds: null,
      wasDown: false,
      pfx: 0,
      pfy: 0,
      fvx: 0,
      fvy: 0,
    };
  };

  useEffect(() => {
    let alive = true;
    if (!source) {
      runOnUI(() => {
        'worklet';
        sim.value = null;
        picture.value = empty;
        realHidden.value = 0;
      })();
      return;
    }
    const pd = PixelRatio.get();
    (async () => {
      let image: SkImage | null = null;
      if (source.kind === 'photo') {
        const photo = await loadEncodedImage(source.uri);
        if (!alive || !photo) return;
        image = renderPhotoTexture(photo, source, pd);
      } else {
        // Буква и рамка должны успеть отрисоваться.
        await wait(400);
        if (!alive) return;
        image = await makeImageFromView(avatarRef);
      }
      if (!alive || !image) return;
      const texW = image.width();
      const texH = image.height();
      const cell = pickCellPx(Math.max(texW, texH));
      const cells = collectCells(image, cell);
      if (!alive || !cells || cells.length === 0) return;
      const payload: DustPayload = {
        image,
        empty,
        pd,
        texW,
        texH,
        cell,
        cols: Math.ceil(texW / cell),
        rows: Math.ceil(texH / cell),
        cells,
        unit: source.size / BASE_SIZE,
      };
      runOnUI(installSim)(payload);
      setReady(true);
    })().catch((e) => {
      logger.warn('[avatar-dust] texture failed', { error: String((e as Error)?.message ?? e) });
    });
    return () => {
      alive = false;
    };
    // sourceKey описывает source целиком.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  useEffect(
    () => () => {
      runOnUI(() => {
        'worklet';
        sim.value = null;
        picture.value = empty;
        realHidden.value = 0;
      })();
    },
    [sim, picture, empty, realHidden],
  );

  /** Первый кадр касания: где сейчас аватар относительно слоя, до пикселя. */
  const beginLive = (S: DustSim, ts: number): boolean => {
    'worklet';
    const o = measure(overlayRef);
    const a = measure(avatarRef);
    if (!o || !a || !(a.width > 0) || !(o.width > 0)) return false;
    // Текстура от другого размера (раскладка только что поменялась) — не
    // показываем, иначе на месте аватара мелькнёт картинка не того масштаба.
    if (Math.abs(a.width * S.pd - S.texW) > 3) return false;
    const ox = Math.round((a.pageX - o.pageX) * S.pd) / S.pd;
    const oy = Math.round((a.pageY - o.pageY) * S.pd) / S.pd;
    if (ox !== S.ox || oy !== S.oy) {
      S.ox = ox;
      S.oy = oy;
      S.dstRect = Skia.XYWHRect(ox, oy, S.texW * S.inv, S.texH * S.inv);
      S.maskDst = Skia.XYWHRect(ox, oy, S.cols * S.cellDp, S.rows * S.cellDp);
    }
    S.bounds = Skia.XYWHRect(0, 0, o.width, o.height);
    S.live = true;
    S.frames = 0;
    S.settle = 0;
    S.lastT = ts;
    S.wasDown = false;
    return true;
  };

  /** Ячейка ушла из текстуры в атлас (или вернулась). */
  const markCell = (S: DustSim, i: number, value: number) => {
    'worklet';
    const b = S.cellOf[i] * 4;
    const m = S.mask;
    m[b] = value;
    m[b + 1] = value;
    m[b + 2] = value;
    m[b + 3] = value;
    S.maskDirty = true;
  };

  const step = (ts: number): boolean => {
    'worklet';
    const S = sim.value;
    if (!S) {
      picture.value = empty;
      realHidden.value = 0;
      return false;
    }
    if (!S.live && !beginLive(S, ts)) return false;

    let dt = (ts - S.lastT) / 1000;
    S.lastT = ts;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 1 / 30) dt = 1 / 30;

    const u = S.unit;
    const inv = S.inv;
    const ox = S.ox;
    const oy = S.oy;

    const down = fingerDown.value === 1;
    const fx = ox + (S.texW * inv) / 2 + fingerX.value;
    const fy = oy + (S.texH * inv) / 2 + fingerY.value;
    if (down) {
      if (!S.wasDown) {
        S.pfx = fx;
        S.pfy = fy;
        S.fvx = 0;
        S.fvy = 0;
      }
      const follow = Math.min(1, dt * 22);
      S.fvx += ((fx - S.pfx) / dt - S.fvx) * follow;
      S.fvy += ((fy - S.pfy) / dt - S.fvy) * follow;
      S.pfx = fx;
      S.pfy = fy;
    }
    S.wasDown = down;

    const R = FINGER_RADIUS * S.texW * inv;
    const R2 = R * R;
    const { dx, dy, vx, vy, lx, ly, hw, hh, stiff, damp, spin, phase, gain, turnC, turnS, loose, rest, act, xf } = S;
    const frameStart = S.frames === 0;

    // Будим частицы, которые палец задел дома: смотрим только ячейки под ним.
    if (down) {
      const cd = S.cellDp;
      const c0 = Math.max(0, Math.floor((fx - R - ox) / cd));
      const c1 = Math.min(S.cols - 1, Math.floor((fx + R - ox) / cd));
      const r0 = Math.max(0, Math.floor((fy - R - oy) / cd));
      const r1 = Math.min(S.rows - 1, Math.floor((fy + R - oy) / cd));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const i = S.cellToIdx[r * S.cols + c];
          if (i < 0 || rest[i] === 0) continue;
          const rx = ox + lx[i] + hw[i] * inv - fx;
          const ry = oy + ly[i] + hh[i] * inv - fy;
          if (rx * rx + ry * ry >= R2) continue;
          rest[i] = 0;
          act[S.actN++] = i;
          markCell(S, i, 0);
        }
      }
    }

    const push = PUSH * u;
    const windX = S.fvx * WIND;
    const windY = S.fvy * WIND;
    const vmax = MAX_SPEED * u;
    const vmax2 = vmax * vmax;
    const shrinkAt = SHRINK_AT * u;
    const flutter = FLUTTER * u;
    const softAt = RETURN_SOFT_AT * u;
    const t = ts / 1000;

    for (let j = 0; j < S.actN; j++) {
      const i = act[j];
      const hwi = hw[i];
      const hhi = hh[i];
      const homeX = ox + lx[i] + hwi * inv;
      const homeY = oy + ly[i] + hhi * inv;
      let dxi = dx[i];
      let dyi = dy[i];
      let vxi = vx[i];
      let vyi = vy[i];
      let ax = 0;
      let ay = 0;

      let inField = false;
      if (down) {
        const rx = homeX + dxi - fx;
        const ry = homeY + dyi - fy;
        if (rx < R && rx > -R && ry < R && ry > -R) {
          const d2 = rx * rx + ry * ry;
          if (d2 < R2) {
            inField = true;
            const dist = Math.sqrt(d2);
            const w = (1 - dist / R) * gain[i];
            let nx;
            let ny;
            if (dist > 0.35) {
              nx = rx / dist;
              ny = ry / dist;
            } else {
              nx = Math.cos(phase[i]);
              ny = Math.sin(phase[i]);
            }
            const kx = (nx * push + windX) * w;
            const ky = (ny * push + windY) * w;
            ax += kx * turnC[i] - ky * turnS[i];
            ay += kx * turnS[i] + ky * turnC[i];
          }
        }
      }

      // Свободный полёт после удара, потом пружина плавно тянет домой.
      let lo = loose[i];
      if (inField) lo = 1;
      else if (lo > 0) {
        lo -= dt / LOOSE_TIME;
        if (lo < 0) lo = 0;
      }
      loose[i] = lo;
      const hold = 1 - lo;
      const off = Math.sqrt(dxi * dxi + dyi * dyi);
      const pull = (stiff[i] * hold * hold) / (1 + off / softAt);
      ax -= pull * dxi + (AIR_DRAG + damp[i] * hold) * vxi;
      ay -= pull * dyi + (AIR_DRAG + damp[i] * hold) * vyi;

      if (off > 0.5) {
        const amp = flutter * Math.min(1, off / shrinkAt);
        const ph = phase[i];
        ax += amp * Math.sin(t * 2.3 + ph);
        ay += amp * Math.cos(t * 1.9 + ph * 1.7);
      }

      vxi += ax * dt;
      vyi += ay * dt;
      const sp2 = vxi * vxi + vyi * vyi;
      if (sp2 > vmax2) {
        const s = vmax / Math.sqrt(sp2);
        vxi *= s;
        vyi *= s;
      }
      dxi += vxi * dt;
      dyi += vyi * dt;

      if (lo === 0 && dxi * dxi + dyi * dyi < REST_DIST2 && vxi * vxi + vyi * vyi < REST_SPEED2) {
        // Дома: снова рисуется текстурой, из атласа уходит.
        dx[i] = 0;
        dy[i] = 0;
        vx[i] = 0;
        vy[i] = 0;
        rest[i] = 1;
        markCell(S, i, 255);
        act[j] = act[--S.actN];
        j--;
        continue;
      }
      dx[i] = dxi;
      dy[i] = dyi;
      vx[i] = vxi;
      vy[i] = vyi;

      // Улетевший пиксель уменьшается и слегка поворачивается вокруг центра.
      let k = Math.sqrt(dxi * dxi + dyi * dyi) / shrinkAt;
      if (k > 1) k = 1;
      k = k * k * (3 - 2 * k);
      const scale = inv * (1 - SHRINK * k);
      const ang = spin[i] * k;
      const a2 = ang * ang;
      const sc = scale * (1 - a2 * 0.5 + (a2 * a2) / 24);
      const ss = scale * ang * (1 - a2 / 6);
      const cx = homeX + dxi;
      const cy = homeY + dyi;
      xf[i].set(sc, ss, cx - (sc * hwi - ss * hhi), cy - (ss * hwi + sc * hhi));
    }

    const actN = S.actN;
    if ((actN > 0 || S.maskDirty || frameStart) && S.bounds && S.dstRect && S.maskDst) {
      const rec = Skia.PictureRecorder();
      const canvas = rec.beginRecording(S.bounds);
      if (actN < S.n) {
        if (actN === 0) {
          canvas.drawImageRectOptions(S.image, S.srcRect, S.dstRect, NEAREST, NO_MIPMAP, null);
        } else {
          if (S.maskDirty || !S.maskImg) {
            S.maskImg = Skia.Image.MakeImage(
              { width: S.cols, height: S.rows, colorType: MASK_COLOR_TYPE, alphaType: MASK_ALPHA_TYPE },
              Skia.Data.fromBytes(S.mask),
              S.cols * 4,
            );
          }
          canvas.saveLayer(undefined, S.dstRect);
          canvas.drawImageRectOptions(S.image, S.srcRect, S.dstRect, NEAREST, NO_MIPMAP, null);
          if (S.maskImg) {
            canvas.drawImageRectOptions(S.maskImg, S.maskSrc, S.maskDst, NEAREST, NO_MIPMAP, S.maskPaint);
          }
          canvas.restore();
        }
      }
      S.maskDirty = false;
      if (actN > 0) {
        const aSpr = S.aSpr;
        const aXf = S.aXf;
        aSpr.length = actN;
        aXf.length = actN;
        for (let j = 0; j < actN; j++) {
          const i = act[j];
          aSpr[j] = S.sprites[i];
          aXf[j] = xf[i];
        }
        canvas.drawAtlas(S.image, aSpr, aXf, S.paint, SRC_OVER, undefined, SAMPLING);
      }
      picture.value = rec.finishRecordingAsPicture();
    }
    S.frames++;

    if (!down && actN === 0) {
      // Всё дома: сначала возвращаем настоящий аватар, потом убираем частицы.
      if (S.settle === 0) realHidden.value = 0;
      S.settle++;
      if (S.settle > HANDOFF_FRAMES) {
        picture.value = S.empty;
        S.live = false;
        return false;
      }
      return true;
    }
    if (S.settle > 0) S.settle = 0;
    if (S.frames >= HANDOFF_FRAMES && realHidden.value !== 1) realHidden.value = 1;
    return true;
  };

  const startLoop = () => {
    'worklet';
    if (running.value === 1 || !sim.value) return;
    running.value = 1;
    const tick = (ts: number) => {
      let more = false;
      try {
        more = step(ts);
      } catch (e) {
        more = false;
        const S = sim.value;
        if (S) {
          S.live = false;
          picture.value = S.empty;
        }
        realHidden.value = 0;
        console.warn('[avatar-dust] frame failed', String(e));
      }
      if (more) requestAnimationFrame(tick);
      else running.value = 0;
    };
    requestAnimationFrame(tick);
  };

  useAnimatedReaction(
    () => fingerDown.value,
    (down, prev) => {
      if (down === 1 && prev !== 1) startLoop();
    },
    // Всё, что захватывает цикл, стабильно между рендерами.
    [dust, avatarRef],
  );

  return (
    <View ref={overlayRef} pointerEvents="none" collapsable={false} style={StyleSheet.absoluteFill}>
      {ready ? (
        <Canvas style={StyleSheet.absoluteFill} colorSpace="srgb" pointerEvents="none">
          <Picture picture={picture} />
        </Canvas>
      ) : null}
    </View>
  );
}
