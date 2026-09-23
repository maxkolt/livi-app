/**
 * Классификация причин, по которым нас позвали пересчитать маршрут.
 *
 * Причина — это строка вроде `cycle`, `headset_poll_bt` или `applyRouting_repin`, и от
 * её толкования зависит приоритет: «пользователь нажал кнопку» бьёт автоматику, а
 * «надели гарнитуру» бьёт почти всё. Строки разрослись исторически, поэтому разбор
 * собран в одном месте — иначе очередная новая причина молча проваливается в ветку
 * «автоматика» и ломает уже сделанный выбор.
 *
 * Вынесено из useAudioRouting.ts: чистые функции от строки.
 */

import type { InCallAudioRoute } from '../audioRouteTypes';
import type { AudioRoutingOptions } from '../useAudioRouting';

/** Маршрут при старте звонка, если пользователь ещё ничего не выбирал. */
export const defaultUserRoute = (opts?: AudioRoutingOptions): InCallAudioRoute =>
  opts?.defaultToEarpiece ? 'EARPIECE' : 'SPEAKER_PHONE';

/** Гарнитуру физически подключили — это сильнее любого прежнего выбора. */
export function isPhysicalHeadsetGainReason(
  reason: string,
  ctx: { gainedBt: boolean; gainedWired: boolean },
): boolean {
  return (
    ctx.gainedBt ||
    ctx.gainedWired ||
    reason === 'headset_poll_bt' ||
    reason === 'onAudioDeviceChanged_gained_bt' ||
    reason === 'WiredHeadset'
  );
}

/** Раннее предпочтение BT: список причин, где автоподхват гарнитуры уместен. */
export function shouldPreferBluetoothEarlyInCall(reason: string): boolean {
  return (
    reason === 'bootstrap' ||
    reason.startsWith('poll_') ||
    reason === 'headset_poll_bt' ||
    reason === 'onAudioDeviceChanged_gained_bt' ||
    reason === 'applyRouting' ||
    reason === 'applyRouting_repin' ||
    reason === 'onAudioDeviceChanged' ||
    reason === 'remote_stream' ||
    reason === 'remote_stream_repin' ||
    reason === 'session_re_enable' ||
    reason === 'preferAudioMode' ||
    reason === 'native_probe'
  );
}

/** Гарнитуру выдернули/сняли. */
export function isHeadsetUnplugReason(reason: string): boolean {
  return (
    reason === 'WiredHeadset_unplug' ||
    reason === 'headset_poll_unplug' ||
    reason === 'headset_bt_unplug' ||
    reason === 'headset_unplug'
  );
}

/** Поводы откатиться на сохранённый встроенный маршрут после отключения гарнитуры. */
export function isHeadsetDisconnectFallbackReason(reason: string): boolean {
  return (
    reason === 'headset_unplug' ||
    reason === 'headset_bt_unplug' ||
    reason === 'headset_poll_unplug' ||
    reason === 'headset_poll_bt_inactive' ||
    reason.startsWith('headset_unplug') ||
    reason.startsWith('native_bt_unwear')
  );
}
