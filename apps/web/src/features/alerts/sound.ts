import type { AlertSeverity } from '@veetracer/shared';

/**
 * Short WebAudio beeps (no bundled audio). Browsers block audio until the user interacts with the page,
 * so the context is created lazily and resumed on the first pointer/key event.
 */
let ctx: AudioContext | null = null;
let unlockedBound = false;

function context(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

export function bindAudioUnlock() {
  if (unlockedBound) return;
  unlockedBound = true;
  const unlock = () => {
    const c = context();
    if (c && c.state === 'suspended') c.resume().catch(() => undefined);
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

function tone(c: AudioContext, freq: number, start: number, duration: number, gain = 0.12) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(g).connect(c.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

let lastPlayed = 0;

/**
 * One ~1.6 s two-tone siren burst (emergencies: repeated by the alert centre until acknowledged). `loud` (parking mode
 * alarm, meant to wake someone): near full volume.
 */
export function playSiren(loud = false) {
  const c = context();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime + 0.01;
  for (let i = 0; i < 4; i++) tone(c, i % 2 ? 740 : 988, t + i * 0.4, 0.38, loud ? 0.6 : 0.2);
}

/** WARNING: one soft two-note chime. CRITICAL: three urgent high beeps. INFO: silent. Rate-limited to one per 1.5 s. */
export function playAlertSound(severity: AlertSeverity) {
  if (severity === 'INFO') return;
  const c = context();
  if (!c || c.state !== 'running') return;
  const now = performance.now();
  if (now - lastPlayed < 1500) return;
  lastPlayed = now;
  const t = c.currentTime + 0.01;
  if (severity === 'CRITICAL') {
    for (let i = 0; i < 3; i++) tone(c, 1046, t + i * 0.22, 0.16, 0.16);
  } else {
    tone(c, 784, t, 0.18);
    tone(c, 988, t + 0.16, 0.24);
  }
}
