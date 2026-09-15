/**
 * JS-крышка accept → VideoCall: тот же chrome, что у аудиозвонка («Соединение»),
 * чтобы вместо пустого #1B1C22 сразу был знакомый экран. Кнопки залочены.
 *
 * Важно: native solid-крышка лежит НАД RN (DecorView). Её надо снять сразу после
 * commit JS-контента (useLayoutEffect). requestAnimationFrame в background не тикает —
 * иначе solid висит до VideoCall.onLayout (~1–2с).
 */
import React, { useLayoutEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { WelcomeStageBackground } from '../../../screens/home/WelcomeStageBackground';
import { WELCOME_STAGE_BG } from '../../../screens/home/constants';
import { CallScreenChrome } from './CallScreenChrome';

export type IncomingAnswerConnectingCoverProps = {
  partnerName: string;
  partnerAvatarUri?: string;
  statusLine: string;
  moreLabel: string;
  cameraLabel: string;
  micLabel: string;
  endLabel: string;
  speakerLabel: string;
  topInset?: number;
  bottomInset?: number;
  /** JS-контент закоммичен — снять нативную solid-крышку. */
  onContentReady?: () => void;
};

export function IncomingAnswerConnectingCover({
  partnerName,
  partnerAvatarUri,
  statusLine,
  moreLabel,
  cameraLabel,
  micLabel,
  endLabel,
  speakerLabel,
  topInset = 0,
  bottomInset = 0,
  onContentReady,
}: IncomingAnswerConnectingCoverProps) {
  const notifiedRef = useRef(false);

  useLayoutEffect(() => {
    if (notifiedRef.current) return;
    notifiedRef.current = true;
    try {
      onContentReady?.();
    } catch {}
  }, [onContentReady]);

  return (
    <View style={styles.root} pointerEvents="auto">
      <WelcomeStageBackground />
      <CallScreenChrome
        partnerName={partnerName || '—'}
        partnerAvatarUri={partnerAvatarUri}
        statusLine={statusLine}
        statusMuted
        onMinimize={() => {}}
        onToggleCam={() => {}}
        onToggleMic={() => {}}
        onEndCall={() => {}}
        camOn={false}
        micOn
        moreLabel={moreLabel}
        cameraLabel={cameraLabel}
        micLabel={micLabel}
        endLabel={endLabel}
        moreItems={[]}
        speakerOn={false}
        onToggleSpeaker={() => {}}
        speakerLabel={speakerLabel}
        controlsLocked
        endDisabled
        topInset={topInset}
        bottomInset={bottomInset}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: WELCOME_STAGE_BG,
    zIndex: 9999,
    elevation: 9999,
  },
});
