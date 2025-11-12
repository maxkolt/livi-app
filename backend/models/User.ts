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
