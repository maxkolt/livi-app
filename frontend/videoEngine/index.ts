// frontend/videoEngine/index.ts
import { createWebRTCEngine } from './webrtcEngine';
import { VideoEngine } from './types';
import { logger } from '../utils/logger';

export type VideoEngineType = 'webrtc';

export function createVideoEngine(type: VideoEngineType = 'webrtc'): VideoEngine {
  logger.debug('Creating video engine', { type });
  
  // Всегда используем WebRTC
  return createWebRTCEngine();
}

export type { VideoEngine, RemoteRender } from './types';
export { createWebRTCEngine } from './webrtcEngine';
