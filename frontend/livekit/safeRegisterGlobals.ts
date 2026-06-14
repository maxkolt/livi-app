/**
 * Same behavior as @livekit/react-native registerGlobals(), but without
 * unconditional require('promise.allsettled') / array.prototype.at shims
 * that can crash release builds (unknown module IDs in Hermes).
 */
import 'well-known-symbols/Symbol.asyncIterator/auto';
import 'well-known-symbols/Symbol.iterator/auto';
import '@livekit/react-native/src/polyfills/MediaRecorderShim';
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
    // @ts-expect-error RN web globals
    const getUserMediaFunc = global.navigator.mediaDevices.getUserMedia;
    // @ts-expect-error RN web globals
    global.navigator.mediaDevices.getUserMedia = async (constraints: { audio?: unknown }) => {
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
  // @ts-expect-error LiveKit global
  global.LiveKitReactNativeGlobal = lkGlobal;
}

function fixWebrtcAdapter(): void {
  // @ts-expect-error RN web globals
  if (window?.navigator !== undefined) {
    // @ts-expect-error RN web globals
    const { navigator } = window;
    if (navigator.userAgent === undefined) {
      navigator.userAgent = navigator.product ?? 'Unknown';
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
  // @ts-expect-error polyfill attach
  if (typeof global.WritableStream === 'undefined') {
    // @ts-expect-error polyfill attach
    global.WritableStream = WritableStream;
  }
  // @ts-expect-error polyfill attach
  if (typeof global.ReadableStream === 'undefined') {
    // @ts-expect-error polyfill attach
    global.ReadableStream = ReadableStream;
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
