/**
 * Same behavior as @livekit/react-native registerGlobals(), but without
 * unconditional require('promise.allsettled') / array.prototype.at shims
 * that can crash release builds (unknown module IDs in Hermes).
 */
import 'well-known-symbols/Symbol.asyncIterator/auto';
import 'well-known-symbols/Symbol.iterator/auto';
import './MediaRecorderShim';
import { registerGlobals as webrtcRegisterGlobals } from '@livekit/react-native-webrtc';
import { setupURLPolyfill } from 'react-native-url-polyfill';
import '@livekit/react-native/src/polyfills/EncoderDecoderTogether.min.js';
import AudioSession from '@livekit/react-native/src/audio/AudioSession';
import { PixelRatio, Platform } from 'react-native';
import type { LiveKitReactNativeInfo } from 'livekit-client';
import { setupNativeEvents } from '@livekit/react-native/src/events/EventEmitter';
import { ReadableStream, WritableStream } from 'web-streams-polyfill';
import { ensureCoreJsPolyfills } from '../polyfills/ensureCoreJsPolyfills';

export interface SafeRegisterGlobalsOptions {
  autoConfigureAudioSession?: boolean;
}

function iosCategoryEnforce(): void {
  if (Platform.OS === 'ios') {
    const mediaDevices = global.navigator.mediaDevices as MediaDevices;
    const getUserMediaFunc = mediaDevices.getUserMedia.bind(mediaDevices);
    mediaDevices.getUserMedia = async (constraints: MediaStreamConstraints) => {
      if (constraints.audio) {
        await AudioSession.setAppleAudioConfiguration({
          audioCategory: 'playAndRecord',
        });
      }
      return getUserMediaFunc(constraints);
    };
  }
}

function livekitRegisterGlobals(): void {
  const lkGlobal: LiveKitReactNativeInfo = {
    platform: Platform.OS,
    devicePixelRatio: PixelRatio.get(),
  };
  (global as typeof globalThis & { LiveKitReactNativeGlobal?: LiveKitReactNativeInfo }).LiveKitReactNativeGlobal =
    lkGlobal;
}

function fixWebrtcAdapter(): void {
  const nav = global.navigator as Navigator & { userAgent?: string; product?: string };
  if (nav && nav.userAgent === undefined) {
    try {
      Object.defineProperty(nav, 'userAgent', {
        value: nav.product ?? 'Unknown',
        configurable: true,
      });
    } catch {
      (nav as { userAgent: string }).userAgent = nav.product ?? 'Unknown';
    }
  }
}

function shimCryptoUuid(): void {
  let crypto = global.crypto;
  if (typeof global.crypto?.randomUUID !== 'function') {
    const createRandomUUID = (): `${string}-${string}-${string}-${string}-${string}` =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }) as `${string}-${string}-${string}-${string}-${string}`;

    if (!crypto) {
      crypto = {} as Crypto;
      global.crypto = crypto;
    }
    crypto.randomUUID = createRandomUUID;
  }
}

function shimWebstreams(): void {
  const g = global as typeof globalThis & {
    WritableStream?: typeof WritableStream;
    ReadableStream?: typeof ReadableStream;
  };
  if (typeof g.WritableStream === 'undefined') {
    g.WritableStream = WritableStream;
  }
  if (typeof g.ReadableStream === 'undefined') {
    g.ReadableStream = ReadableStream as any;
  }
}

export function safeRegisterLiveKitGlobals(options?: SafeRegisterGlobalsOptions): void {
  const opts = { autoConfigureAudioSession: true, ...options };
  ensureCoreJsPolyfills();
  webrtcRegisterGlobals();
  if (opts.autoConfigureAudioSession) {
    iosCategoryEnforce();
  }
  livekitRegisterGlobals();
  setupURLPolyfill();
  fixWebrtcAdapter();
  shimCryptoUuid();
  shimWebstreams();
  setupNativeEvents();
}
