import type { Request } from 'express';
import type { BackendServer } from '../sockets/types';

/** Fields installed by the HTTP authentication and upload middleware. */
export type AuthenticatedRequest = Request & {
  installId?: string;
  userId?: string;
  uploadUserId?: string;
  io?: BackendServer;
};

/** Optional diagnostics supplied by Error, Node and external SDK failures. */
export type ErrorDetails = Partial<Pick<Error, 'message' | 'stack'>> & {
  code?: string | number;
};
