// backend/sockets/handler.ts
import { Server } from "socket.io";
import type { AuthedSocket } from "./types";
import { bindWebRTC } from "./webrtc";
import { bindMatch } from "./match"; // ✅ подключаем матчинг
import { logger } from '../utils/logger';

export function socketHandler(io: Server, socket: AuthedSocket) {
  logger.debug('Socket connected', { socketId: socket.id });

  /** =========================
   *  Подключаем WebRTC signaling
   *  ========================= */
  bindWebRTC(io, socket);

  /** =========================
   *  Подключаем Matchmaking
   *  ========================= */
  bindMatch(io, socket);

  // Disconnect обработчик удален - используется основной обработчик в index.ts
}
