// frontend/sockets/modules/outboxTypes.ts
export type MessageOutboxItem = {
  id: string;
  /** Совпадает с id сообщения в UI до замены на outbox_/msg_* (чтобы удалить из очереди при отмене до ack). */
  optimisticUiId?: string;
  createdAt: number;
  /** Сколько раз сервер отказал временной ошибкой — после лимита сообщение «не отправлено». */
  attempts?: number;
  payload: {
    to: string;
    text?: string;
    type: "text" | "image" | "audio" | "sticker" | "video_note";
    uri?: string;
    /** Видеокружок: кадр-превью на сервере. */
    thumbUri?: string;
    /** Видеокружок: кадр-превью на устройстве, ещё не загруженный (как localUri). */
    localThumbUri?: string;
    /**
     * Файл на устройстве, ещё не загруженный на сервер (голосовое, записанное без сети).
     * Очередь сначала загружает его и кладёт адрес в uri, потом отправляет сообщение.
     */
    localUri?: string;
    name?: string;
    size?: number;
    duration?: number;
    stickerId?: string;
    stickerPackId?: string;
    stickerEmoji?: string;
    stickerLabel?: string;
    replyTo?: { id: string; text?: string; from: string };
    clientMessageId?: string;
    clientId?: string;
  };
};

export type EditOutboxItem = {
  id: string;
  messageId: string;
  text: string;
  /** Собеседник — нужен, чтобы зашифровать правку. В старых записях отсутствует. */
  to?: string;
  createdAt: number;
};

export type OutboxMessageDeliveredPayload = {
  to: string;
  outboxId: string;
  optimisticUiId?: string;
  serverMessageId: string;
  /** Получатель был онлайн — сразу две галочки. */
  delivered?: boolean;
  /** Адрес медиа, которое очередь загрузила сама (вместо локального файла). */
  uri?: string;
  /** То же для кадра-превью видеокружка. */
  thumbUri?: string;
};

/** Сервер окончательно отказал (не друзья, слишком длинный текст…) — повтор не поможет. */
export type OutboxMessageFailedPayload = {
  to: string;
  outboxId: string;
  optimisticUiId?: string;
  error: string;
};
