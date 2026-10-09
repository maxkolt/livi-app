/**
 * Тексты, которые сервер кладёт в push сам: превью медиа и fallback-уведомления
 * (Expo/iOS), когда устройство не собирает уведомление нативно.
 *
 * Язык приходит от клиента вместе с push-токеном (PushToken.lang). Старые версии
 * приложения язык не передают — для них остаётся русский, как было раньше.
 */

export const PUSH_LANGS = [
  'ru', 'en', 'es', 'de', 'fr', 'it', 'pt', 'tr', 'ar',
  'ja', 'ko', 'zh', 'zh-TW', 'hi', 'vi', 'th', 'id',
] as const;

export type PushLang = (typeof PUSH_LANGS)[number];

const LEGACY_LANG: PushLang = 'ru';

export function normalizePushLang(value: unknown): PushLang | '' {
  const raw = typeof value === 'string' ? value.trim() : '';
  return (PUSH_LANGS as readonly string[]).includes(raw) ? (raw as PushLang) : '';
}

type PushTextKey =
  | 'newMessage'
  | 'incomingCall'
  | 'missedCall'
  | 'fromNick'
  | 'callDeclined'
  | 'callDeclinedBody'
  | 'callEnded'
  | 'callEndedBody'
  | 'photo'
  | 'sticker'
  | 'voice'
  | 'video';

const DICT: Record<PushLang, Record<PushTextKey, string>> = {
  ru: {
    newMessage: 'Новое сообщение',
    incomingCall: 'Входящий вызов',
    missedCall: 'Пропущенный вызов',
    fromNick: 'От {nick}',
    callDeclined: 'Звонок отклонён',
    callDeclinedBody: 'Собеседник отклонил вызов',
    callEnded: 'Звонок завершён',
    callEndedBody: 'Собеседник завершил разговор',
    photo: 'Фото',
    sticker: 'Стикер',
    voice: 'Голосовое',
    video: 'Видеосообщение',
  },
  en: {
    newMessage: 'New message',
    incomingCall: 'Incoming call',
    missedCall: 'Missed call',
    fromNick: 'From {nick}',
    callDeclined: 'Call declined',
    callDeclinedBody: 'The other person declined the call',
    callEnded: 'Call ended',
    callEndedBody: 'The other person ended the call',
    photo: 'Photo',
    sticker: 'Sticker',
    voice: 'Voice message',
    video: 'Video message',
  },
  es: {
    newMessage: 'Nuevo mensaje',
    incomingCall: 'Llamada entrante',
    missedCall: 'Llamada perdida',
    fromNick: 'De {nick}',
    callDeclined: 'Llamada rechazada',
    callDeclinedBody: 'La otra persona rechazó la llamada',
    callEnded: 'Llamada finalizada',
    callEndedBody: 'La otra persona finalizó la llamada',
    photo: 'Foto',
    sticker: 'Sticker',
    voice: 'Mensaje de voz',
    video: 'Mensaje de video',
  },
  de: {
    newMessage: 'Neue Nachricht',
    incomingCall: 'Eingehender Anruf',
    missedCall: 'Verpasster Anruf',
    fromNick: 'Von {nick}',
    callDeclined: 'Anruf abgelehnt',
    callDeclinedBody: 'Die andere Person hat den Anruf abgelehnt',
    callEnded: 'Anruf beendet',
    callEndedBody: 'Die andere Person hat den Anruf beendet',
    photo: 'Foto',
    sticker: 'Sticker',
    voice: 'Sprachnachricht',
    video: 'Videonachricht',
  },
  fr: {
    newMessage: 'Nouveau message',
    incomingCall: 'Appel entrant',
    missedCall: 'Appel manqué',
    fromNick: 'De {nick}',
    callDeclined: 'Appel refusé',
    callDeclinedBody: "L'autre personne a refusé l'appel",
    callEnded: 'Appel terminé',
    callEndedBody: "L'autre personne a mis fin à l'appel",
    photo: 'Photo',
    sticker: 'Autocollant',
    voice: 'Message vocal',
    video: 'Message vidéo',
  },
  it: {
    newMessage: 'Nuovo messaggio',
    incomingCall: 'Chiamata in arrivo',
    missedCall: 'Chiamata persa',
    fromNick: 'Da {nick}',
    callDeclined: 'Chiamata rifiutata',
    callDeclinedBody: "L'altra persona ha rifiutato la chiamata",
    callEnded: 'Chiamata terminata',
    callEndedBody: "L'altra persona ha terminato la chiamata",
    photo: 'Foto',
    sticker: 'Sticker',
    voice: 'Messaggio vocale',
    video: 'Videomessaggio',
  },
  pt: {
    newMessage: 'Nova mensagem',
    incomingCall: 'Chamada recebida',
    missedCall: 'Chamada perdida',
    fromNick: 'De {nick}',
    callDeclined: 'Chamada recusada',
    callDeclinedBody: 'A outra pessoa recusou a chamada',
    callEnded: 'Chamada encerrada',
    callEndedBody: 'A outra pessoa encerrou a chamada',
    photo: 'Foto',
    sticker: 'Figurinha',
    voice: 'Mensagem de voz',
    video: 'Mensagem de vídeo',
  },
  tr: {
    newMessage: 'Yeni mesaj',
    incomingCall: 'Gelen arama',
    missedCall: 'Cevapsız arama',
    fromNick: 'Arayan: {nick}',
    callDeclined: 'Arama reddedildi',
    callDeclinedBody: 'Karşı taraf aramayı reddetti',
    callEnded: 'Arama sona erdi',
    callEndedBody: 'Karşı taraf aramayı sonlandırdı',
    photo: 'Fotoğraf',
    sticker: 'Çıkartma',
    voice: 'Sesli mesaj',
    video: 'Görüntülü mesaj',
  },
  ar: {
    newMessage: 'رسالة جديدة',
    incomingCall: 'مكالمة واردة',
    missedCall: 'مكالمة فائتة',
    fromNick: 'من {nick}',
    callDeclined: 'تم رفض المكالمة',
    callDeclinedBody: 'رفض الطرف الآخر المكالمة',
    callEnded: 'انتهت المكالمة',
    callEndedBody: 'أنهى الطرف الآخر المكالمة',
    photo: 'صورة',
    sticker: 'ملصق',
    voice: 'رسالة صوتية',
    video: 'رسالة فيديو',
  },
  ja: {
    newMessage: '新着メッセージ',
    incomingCall: '着信',
    missedCall: '不在着信',
    fromNick: '{nick}さんから',
    callDeclined: '通話が拒否されました',
    callDeclinedBody: '相手が通話を拒否しました',
    callEnded: '通話が終了しました',
    callEndedBody: '相手が通話を終了しました',
    photo: '写真',
    sticker: 'スタンプ',
    voice: 'ボイスメッセージ',
    video: 'ビデオメッセージ',
  },
  ko: {
    newMessage: '새 메시지',
    incomingCall: '수신 전화',
    missedCall: '부재중 전화',
    fromNick: '{nick}님',
    callDeclined: '통화가 거절되었습니다',
    callDeclinedBody: '상대방이 통화를 거절했습니다',
    callEnded: '통화가 종료되었습니다',
    callEndedBody: '상대방이 통화를 종료했습니다',
    photo: '사진',
    sticker: '스티커',
    voice: '음성 메시지',
    video: '영상 메시지',
  },
  zh: {
    newMessage: '新消息',
    incomingCall: '来电',
    missedCall: '未接来电',
    fromNick: '来自 {nick}',
    callDeclined: '通话被拒绝',
    callDeclinedBody: '对方拒绝了通话',
    callEnded: '通话已结束',
    callEndedBody: '对方结束了通话',
    photo: '图片',
    sticker: '贴纸',
    voice: '语音消息',
    video: '视频消息',
  },
  'zh-TW': {
    newMessage: '新訊息',
    incomingCall: '來電',
    missedCall: '未接來電',
    fromNick: '來自 {nick}',
    callDeclined: '通話被拒絕',
    callDeclinedBody: '對方拒絕了通話',
    callEnded: '通話已結束',
    callEndedBody: '對方結束了通話',
    photo: '圖片',
    sticker: '貼圖',
    voice: '語音訊息',
    video: '影片訊息',
  },
  hi: {
    newMessage: 'नया संदेश',
    incomingCall: 'इनकमिंग कॉल',
    missedCall: 'मिस्ड कॉल',
    fromNick: '{nick} से',
    callDeclined: 'कॉल अस्वीकार की गई',
    callDeclinedBody: 'दूसरे व्यक्ति ने कॉल अस्वीकार कर दी',
    callEnded: 'कॉल समाप्त हुई',
    callEndedBody: 'दूसरे व्यक्ति ने कॉल समाप्त कर दी',
    photo: 'फ़ोटो',
    sticker: 'स्टिकर',
    voice: 'वॉइस संदेश',
    video: 'वीडियो संदेश',
  },
  vi: {
    newMessage: 'Tin nhắn mới',
    incomingCall: 'Cuộc gọi đến',
    missedCall: 'Cuộc gọi nhỡ',
    fromNick: 'Từ {nick}',
    callDeclined: 'Cuộc gọi bị từ chối',
    callDeclinedBody: 'Người kia đã từ chối cuộc gọi',
    callEnded: 'Cuộc gọi đã kết thúc',
    callEndedBody: 'Người kia đã kết thúc cuộc gọi',
    photo: 'Ảnh',
    sticker: 'Nhãn dán',
    voice: 'Tin nhắn thoại',
    video: 'Tin nhắn video',
  },
  th: {
    newMessage: 'ข้อความใหม่',
    incomingCall: 'สายเรียกเข้า',
    missedCall: 'สายที่ไม่ได้รับ',
    fromNick: 'จาก {nick}',
    callDeclined: 'สายถูกปฏิเสธ',
    callDeclinedBody: 'อีกฝ่ายปฏิเสธสาย',
    callEnded: 'สิ้นสุดการโทร',
    callEndedBody: 'อีกฝ่ายวางสายแล้ว',
    photo: 'รูปภาพ',
    sticker: 'สติกเกอร์',
    voice: 'ข้อความเสียง',
    video: 'ข้อความวิดีโอ',
  },
  id: {
    newMessage: 'Pesan baru',
    incomingCall: 'Panggilan masuk',
    missedCall: 'Panggilan tak terjawab',
    fromNick: 'Dari {nick}',
    callDeclined: 'Panggilan ditolak',
    callDeclinedBody: 'Lawan bicara menolak panggilan',
    callEnded: 'Panggilan berakhir',
    callEndedBody: 'Lawan bicara mengakhiri panggilan',
    photo: 'Foto',
    sticker: 'Stiker',
    voice: 'Pesan suara',
    video: 'Pesan video',
  },
};

export function pushText(lang: unknown, key: PushTextKey, vars?: { nick?: string }): string {
  const table = DICT[normalizePushLang(lang) || LEGACY_LANG];
  const text = table[key] ?? DICT.en[key];
  return vars?.nick != null ? text.replace('{nick}', vars.nick) : text;
}

export type MediaPreviewKind = 'photo' | 'sticker' | 'voice' | 'video';

/** «[Фото]», «[Фото ×3]», «[Стикер]», «[Голосовое]» на языке получателя. */
export function mediaPreviewText(lang: unknown, kind: MediaPreviewKind, albumCount = 0): string {
  const label = pushText(lang, kind);
  return kind === 'photo' && albumCount > 1 ? `[${label} ×${albumCount}]` : `[${label}]`;
}

/** Тело уведомления о пропущенном: «От Ника» или «Входящий вызов». */
export function missedCallBody(lang: unknown, fromNick?: string | null): string {
  const nick = String(fromNick || '').trim();
  return nick ? pushText(lang, 'fromNick', { nick }) : pushText(lang, 'incomingCall');
}
