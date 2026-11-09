import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useCallback, useEffect, useState } from 'react';
import { Vibration } from 'react-native';
import { hasNativeAlarm, startAlarm, stopAlarm } from '../../../modules/veetrax-alarm';

/** Same bundled file the 'sos' notification channel plays (app.json → expo-notifications → sounds). */
const SIREN = require('../../../assets/sounds/sos_siren.wav');
const VIBRATION = [0, 800, 400, 800, 400, 800];

/**
 * Loops the SOS siren and vibrates while `active`; stops on unmount. `silence()` stops both for good
 * (the screen stays open so the alert can still be acknowledged).
 *
 * Android: the native alarm service rings (alarm volume, raised to maximum) - the same loud siren as with the app
 * closed, kept running instead of being swapped for an in-app player on the media volume (often low or muted, so the
 * SOS went quiet once tapped). iOS / Expo Go: the in-app player below.
 */
export function useSiren(active: boolean, info?: { title: string; text: string; alertId: string }): { ringing: boolean; silence: () => void } {
  const player = useAudioPlayer(SIREN);
  const [silenced, setSilenced] = useState(false);
  const ringing = active && !silenced;
  const title = info?.title ?? '';
  const text = info?.text ?? '';
  const alertId = info?.alertId ?? '';

  useEffect(() => {
    if (!hasNativeAlarm) return;
    if (ringing) startAlarm(title, text, alertId);
    else stopAlarm();
  }, [ringing, title, text, alertId]);
  // Leaving the screen stops the native alarm too.
  useEffect(() => () => {
    if (hasNativeAlarm) stopAlarm();
  }, []);

  useEffect(() => {
    if (!ringing || hasNativeAlarm) return;
    let cancelled = false;
    void setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix', shouldPlayInBackground: false })
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        player.loop = true;
        player.volume = 1;
        player.seekTo(0).catch(() => undefined);
        player.play();
      });
    Vibration.vibrate(VIBRATION, true);
    return () => {
      cancelled = true;
      Vibration.cancel();
      try {
        player.pause();
      } catch {
        // player already released on unmount
      }
    };
  }, [ringing, player]);

  const silence = useCallback(() => setSilenced(true), []);
  return { ringing, silence };
}
