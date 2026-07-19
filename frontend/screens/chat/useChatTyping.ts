/** Local + peer typing/recording signals for chat. */

import React from "react";
import { onChatTyping, sendChatTyping } from "../../sockets/socket";

export type PeerActivity = "typing" | "recording" | null;

type Options = {
  peerId: string;
  currentUserId: string | null;
};

export function useChatTyping({ peerId, currentUserId }: Options) {
  const [peerActivity, setPeerActivity] = React.useState<PeerActivity>(null);

  const peerTypingHideTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const localTypingStopTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const localTypingActiveRef = React.useRef(false);
  const lastTypingSentAtRef = React.useRef(0);
  const localRecordingPingTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const localRecordingActiveRef = React.useRef(false);

  const stopLocalTyping = React.useCallback(() => {
    if (localTypingStopTimerRef.current) {
      clearTimeout(localTypingStopTimerRef.current);
      localTypingStopTimerRef.current = null;
    }
    if (localTypingActiveRef.current) {
      localTypingActiveRef.current = false;
      try {
        if (peerId) sendChatTyping({ to: peerId, typing: false });
      } catch {}
    }
  }, [peerId]);

  const stopLocalRecordingSignal = React.useCallback(() => {
    try {
      if (localRecordingPingTimerRef.current) {
        clearInterval(localRecordingPingTimerRef.current);
        localRecordingPingTimerRef.current = null;
      }
    } catch {}
    if (localRecordingActiveRef.current) {
      localRecordingActiveRef.current = false;
      try {
        if (peerId) sendChatTyping({ to: peerId, typing: false, recording: false });
      } catch {}
    }
  }, [peerId]);

  const startLocalRecordingSignal = React.useCallback(() => {
    if (!peerId) return;
    localRecordingActiveRef.current = true;
    try {
      // Send once immediately and then keep-alive while user holds the record button.
      sendChatTyping({ to: peerId, typing: false, recording: true });
    } catch {}
    try {
      if (localRecordingPingTimerRef.current) clearInterval(localRecordingPingTimerRef.current);
      localRecordingPingTimerRef.current = setInterval(() => {
        try {
          sendChatTyping({ to: peerId, typing: false, recording: true });
        } catch {}
      }, 900);
    } catch {}
  }, [peerId]);

  const signalLocalTyping = React.useCallback(() => {
    if (!peerId) return;
    const now = Date.now();
    // Throttle "typing:true" to avoid spamming the socket,
    // but keep it frequent enough so the peer sees it almost immediately.
    if (!localTypingActiveRef.current || now - lastTypingSentAtRef.current > 450) {
      lastTypingSentAtRef.current = now;
      localTypingActiveRef.current = true;
      try {
        sendChatTyping({ to: peerId, typing: true, recording: false });
      } catch {}
    }
    if (localTypingStopTimerRef.current) clearTimeout(localTypingStopTimerRef.current);
    localTypingStopTimerRef.current = setTimeout(() => {
      stopLocalTyping();
    }, 1200);
  }, [peerId, stopLocalTyping]);

  React.useEffect(() => {
    return () => {
      stopLocalTyping();
      stopLocalRecordingSignal();
      if (peerTypingHideTimerRef.current) {
        clearTimeout(peerTypingHideTimerRef.current);
        peerTypingHideTimerRef.current = null;
      }
    };
  }, [stopLocalTyping, stopLocalRecordingSignal]);

  React.useEffect(() => {
    const off = onChatTyping((data) => {
      try {
        const from = String((data as any)?.from || "");
        const to = String((data as any)?.to || "");
        const typing = !!(data as any)?.typing;
        const recording = !!(data as any)?.recording;

        if (!from || from !== peerId) return;
        if (currentUserId && to && to !== String(currentUserId)) return;

        if (peerTypingHideTimerRef.current) {
          clearTimeout(peerTypingHideTimerRef.current);
          peerTypingHideTimerRef.current = null;
        }

        const next: PeerActivity = recording ? "recording" : typing ? "typing" : null;

        setPeerActivity((prev) => (prev === next ? prev : next));

        if (next) {
          // If "stop" event is lost, hide after a short grace period.
          // Recording needs a keep-alive ping while the peer is holding the button.
          const ttl = next === "recording" ? 1400 : 1600;
          peerTypingHideTimerRef.current = setTimeout(() => {
            setPeerActivity(null);
          }, ttl);
        }
      } catch {}
    });
    return () => {
      off?.();
    };
  }, [peerId, currentUserId]);

  return {
    peerActivity,
    stopLocalTyping,
    stopLocalRecordingSignal,
    startLocalRecordingSignal,
    signalLocalTyping,
  };
}
