import type { BackendServer } from '../sockets/types';

let ioInstance: BackendServer | null = null;

export function setIoInstance(io: BackendServer) {
  ioInstance = io;
}

export function getIoInstance(): BackendServer | null {
  return ioInstance;
}

