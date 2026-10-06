import { useEffect, useState } from 'react';
import { Image } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { ImageFormat, Skia, type SkData } from '@shopify/react-native-skia';
import { AVATAR_FISHEYE_K, fisheyePhotoPaint } from './fisheyeLens';
import { logger } from './logger';

/**
 * «Рыбий глаз» на всех аватарах приложения.
 *
 * Линза не рисуется на каждом кадре: для каждого фото один раз собирается его
 * копия под линзой (квадрат, линза во вписанный круг, углы — как в оригинале),
 * она ложится файлом в кэш, а ExpoImage показывает уже её. Так в списках нет
 * ни лишних Canvas, ни работы на кадр, а повторно файл берётся с диска.
 *
 * Пока копия готовится, аватар пустой: иначе на каждом холодном старте фото
 * мелькало бы плоским и тут же «вздувалось». Если готовится дольше
 * PENDING_FALLBACK_MS или не вышло — показываем исходное фото.
 */

/** Меняется вместе с формулой линзы — старые файлы тогда просто не находятся. */
const LENS_VERSION = 1;
/** Сторона файла: с запасом на полноэкранный просмотр аватара. */
const MAX_SIDE = 1080;
/** Меньше не делаем: двойной пересчёт крошечной миниатюры мылит. */
const MIN_SIDE = 192;
const JPEG_QUALITY = 92;
const PENDING_FALLBACK_MS = 1500;
const DIR = `${FileSystem.cacheDirectory}avatar_fisheye/`;

/** Ключ источника → файл под линзой; '' — не вышло, показываем исходное. */
const done = new Map<string, string>();
const jobs = new Map<string, Promise<string>>();
/** Задачи по одной: декод и линза идут на JS-потоке, пачкой они бы его заняли. */
let queue: Promise<unknown> = Promise.resolve();
let dirReady: Promise<unknown> | null = null;

function fnv1a(str: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function fileFor(key: string): string {
  const k = Math.round(AVATAR_FISHEYE_K * 100);
  return `${DIR}${fnv1a(key, 2166136261)}${fnv1a(key, 0x9747b28c)}_v${LENS_VERSION}k${k}.jpg`;
}

/** data: URI длинные — ключом служит их хэш. Остальные URI уникальны сами по себе. */
function uriKey(uri: string): string {
  if (/^data:/i.test(uri)) return `data:${fnv1a(uri, 2166136261)}${fnv1a(uri, 0x9747b28c)}_${uri.length}`;
  return uri;
}

async function loadUri(uri: string): Promise<SkData | null> {
  if (/^data:/i.test(uri)) {
    const comma = uri.indexOf(',');
    if (comma < 0 || !/;base64$/i.test(uri.slice(0, comma))) return null;
    return Skia.Data.fromBase64(uri.slice(comma + 1));
  }
  // ph:// и assets-library:// Skia не читает — останется исходное фото.
  if (!/^(file|https?|content):/i.test(uri)) return null;
  return Skia.Data.fromURI(uri);
}

async function build(key: string, load: () => Promise<SkData | null>): Promise<string> {
  const file = fileFor(key);
  const info = await FileSystem.getInfoAsync(file).catch(() => null);
  if (info?.exists) return file;

  const data = await load();
  const photo = data ? Skia.Image.MakeImageFromEncoded(data) : null;
  if (!photo) return '';
  const side = Math.round(
    Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.min(photo.width(), photo.height()))),
  );
  const surface = Skia.Surface.Make(side, side);
  if (!surface) return '';
  const paint = fisheyePhotoPaint(photo, 0, 0, side, 1);
  if (!paint) return '';
  // Весь квадрат: за ободом линза отдаёт исходные пиксели, углы остаются фото.
  surface.getCanvas().drawRect(Skia.XYWHRect(0, 0, side, side), paint);
  surface.flush();
  const base64 = surface.makeImageSnapshot().encodeToBase64(ImageFormat.JPEG, JPEG_QUALITY);
  if (!base64) return '';

  if (!dirReady) {
    dirReady = FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  }
  await dirReady;
  // Через временный файл: оборванная запись не должна остаться «готовым» кэшем.
  const tmp = `${file}.${Date.now()}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, base64, { encoding: FileSystem.EncodingType.Base64 });
  await FileSystem.moveAsync({ from: tmp, to: file });
  return file;
}

function lensFor(key: string, load: () => Promise<SkData | null>): Promise<string> {
  const known = done.get(key);
  if (known !== undefined) return Promise.resolve(known);
  let job = jobs.get(key);
  if (!job) {
    job = queue
      .then(() => build(key, load))
      .catch((e) => {
        logger.warn('[avatar-fisheye] failed', { error: String((e as Error)?.message ?? e) });
        return '';
      })
      .then((file) => {
        done.set(key, file);
        jobs.delete(key);
        return file;
      });
    jobs.set(key, job);
    queue = job;
  }
  return job;
}

/**
 * undefined — ещё готовится; '' — показываем исходное (не вышло или
 * задержалось); иначе file: URI копии под линзой.
 */
function useLens(key: string, load: () => Promise<SkData | null>): string | undefined {
  const [state, setState] = useState<{ key: string; value: string | undefined }>(() => ({
    key,
    value: key ? done.get(key) : '',
  }));

  useEffect(() => {
    if (!key) return;
    const known = done.get(key);
    if (known !== undefined) {
      setState((s) => (s.key === key && s.value === known ? s : { key, value: known }));
      return;
    }
    let alive = true;
    const fallback = setTimeout(() => {
      if (alive) setState((s) => (s.key === key && s.value !== undefined ? s : { key, value: '' }));
    }, PENDING_FALLBACK_MS);
    lensFor(key, load).then((file) => {
      if (alive) setState({ key, value: file });
    });
    return () => {
      alive = false;
      clearTimeout(fallback);
    };
    // key описывает источник целиком; load от него зависит однозначно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return '';
  const known = done.get(key);
  if (known !== undefined) return known;
  return state.key === key ? state.value : undefined;
}

/**
 * URI аватара под линзой для ExpoImage/Image. '' — пока готовится (ничего не
 * показываем); при сбое или задержке — исходный uri.
 */
export function useFisheyeAvatarUri(uri: string | null | undefined): string {
  const src = uri ? String(uri).trim() : '';
  const lensed = useLens(src ? uriKey(src) : '', () => loadUri(src));
  if (!src || lensed === undefined) return '';
  return lensed || src;
}

/** То же для фото из ассетов (require). null — пока готовится. */
export function useFisheyeAvatarAsset(asset: number): { uri: string } | number | null {
  const uri = Image.resolveAssetSource(asset)?.uri || '';
  const lensed = useLens(uri ? `asset:${uri}` : '', () => Skia.Data.fromURI(uri));
  if (!uri) return asset;
  if (lensed === undefined) return null;
  return lensed ? { uri: lensed } : asset;
}
