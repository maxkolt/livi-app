// frontend/sockets/modules/outboxTypes.ts
export type MessageOutboxItem = {
  id: string;
  /** Совпадает с id сообщения в UI до замены на outbox_/msg_* (чтобы удалить из очереди при отмене до ack). */
  optimisticUiId?: string;
  createdAt: number;
  payload: {
    to: string;
    text?: string;
    type: "text" | "image" | "audio" | "sticker";
    uri?: string;
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
  createdAt: number;
};

export type OutboxMessageDeliveredPayload = {
  to: string;
  outboxId: string;
  optimisticUiId?: string;
  serverMessageId: string;
};
