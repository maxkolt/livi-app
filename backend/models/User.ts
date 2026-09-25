import { Schema, model, models, Types, Model } from 'mongoose';

// Условное логирование для отладки - отключено в production
const isDebug = process.env.NODE_ENV === 'development' || process.env.DEBUG_LOGS === 'true';
const debugLog = (...args: any[]) => {
  if (isDebug) {}
};

export interface IUser {
  _id: Types.ObjectId;
  nick?: string;
  avatar?: string; // Старое поле (для совместимости, больше не используется)
  // Новые поля для аватаров
  avatarB64?: string; // Полный data URI (jpeg)
  avatarThumbB64?: string; // Миниатюра для списков
  avatarVer?: number; // Версия аватара для инвалидации кеша
  friends: Types.ObjectId[];
  friendRequests?: Types.ObjectId[]; // входящие заявки (userIds, кто пригласил)
  purchasedFrameIds?: string[];
  purchasedBackgroundIds?: string[];
  activeFrameId?: string;
  activeBackgroundId?: string;
  /** Публичный X25519-ключ сквозного шифрования чата (base64, 32 байта). Пусто — шифрование не включено. */
  e2ePublicKey?: string;
  e2eKeyUpdatedAt?: Date;
  /** Резервная копия приватного ключа под паролем пользователя. Никогда не отдаётся без authKey. */
  e2eBackup?: IE2eKeyBackup;
}

export interface IE2eKeyBackup {
  v: number;
  /** Параметры KDF: из пароля выводятся ключ шифрования копии и authKey. */
  kdf: { alg: string; N?: number; r?: number; p?: number; iterations?: number; salt: string };
  n: string;
  c: string;
  /** Публичный ключ, которому соответствует копия. */
  pk: string;
  /** HMAC(authKey) — сервер отдаёт копию только знающему пароль. */
  authHash: string;
  updatedAt: Date;
}

const isHttp = (s?: string) =>
  !!s && /^https?:\/\//i.test(String(s).trim());

const UserSchema = new Schema<IUser>(
  {
    nick: {
      type: String,
      default: '',
      set: (v: unknown) => {
        const clean = typeof v === 'string' ? v.trim() : '';
        // Логируем только если значение действительно изменилось
        if (clean !== '') {
          debugLog('[UserSchema] nick set →', clean);
        }
        return clean;
      },
    },

    // Старое поле (для совместимости, больше не используется)
    avatar: {
      type: String,
      default: '',
      set: (v: unknown) => {
        const raw = typeof v === 'string' ? v.trim() : '';
        return raw;
      },
    },

    // Новые поля для аватаров
    avatarB64: {
      type: String,
      default: '',
    },

    avatarThumbB64: {
      type: String,
      default: '',
    },

    // Версия аватара (инкремент при каждом обновлении/удалении)
    avatarVer: {
      type: Number,
      default: 0,
    },

    friends: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],
      index: true, // Индекс для быстрого поиска друзей
    },

    // Входящие заявки в друзья (ожидают ответа текущего пользователя)
    friendRequests: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],
      index: true,
    },

    purchasedFrameIds: {
      type: [String],
      default: [],
    },

    purchasedBackgroundIds: {
      type: [String],
      default: [],
    },

    activeFrameId: {
      type: String,
      default: '',
    },

    activeBackgroundId: {
      type: String,
      default: '',
    },

    e2ePublicKey: {
      type: String,
      default: '',
    },

    e2eKeyUpdatedAt: {
      type: Date,
    },

    // select: false — ни один существующий запрос профиля не должен унести копию наружу.
    e2eBackup: {
      type: {
        v: { type: Number, required: true },
        // scrypt: N/r/p; pbkdf2-sha256: iterations (см. sockets/e2eKeys.ts parseBackupKdf).
        kdf: {
          alg: { type: String, required: true },
          N: { type: Number },
          r: { type: Number },
          p: { type: Number },
          iterations: { type: Number },
          salt: { type: String, required: true },
        },
        n: { type: String, required: true },
        c: { type: String, required: true },
        pk: { type: String, required: true },
        authHash: { type: String, required: true },
        updatedAt: { type: Date, required: true },
      },
      default: undefined,
      select: false,
    },
  },
  {
    timestamps: true,
    collection: 'users',
  }
);

// Модель
const UserModel: Model<IUser> =
  (models.User as Model<IUser>) || model<IUser>('User', UserSchema);

export default UserModel;

// Удобный тип для lean()
export type LeanUser = Pick<IUser, '_id' | 'nick' | 'avatar' | 'avatarB64' | 'avatarThumbB64' | 'avatarVer' | 'friends'>;
