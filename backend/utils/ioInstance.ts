// Утилита для хранения глобального экземпляра io
import { Server } from 'socket.io';

let ioInstance: Server | null = null;

export function setIoInstance(io: Server) {
  ioInstance = io;
}

export function getIoInstance(): Server | null {
  return ioInstance;
}

