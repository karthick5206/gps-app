import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useCallback, useEffect, useState } from 'react';
import { Vibration } from 'react-native';

/** Same bundled file the 'sos' notification channel plays (app.json → expo-notifications → sounds). */
const SIREN = require('../../../assets/sounds/sos_siren.wav');
const VIBRATION = [0, 800, 400, 800, 400, 800];

/**
 * Loops the SOS siren and vibrates while `active`; stops on unmount. `silence()` stops both for good
 * (the screen stays open so the alert can still be acknowledged).
 */
export function useSiren(active: boolean): { ringing: boolean; silence: () => void } {
  const player = useAudioPlayer(SIREN);
  const [silenced, setSilenced] = useState(false);
  const ringing = active && !silenced;

  useEffect(() => {
    if (!ringing) return;
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
