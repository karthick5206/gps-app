import type { AlertDto } from '@veetracer/shared';
import { i18n } from '@/lib/i18n';
import { alertTitle } from './alert-center';

/** Speech language per app language (Indian English / Hindi / Tamil voices, when the device has them). */
const LANG: Record<string, string> = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN' };
/** Skip announcements when this many are already waiting (an alert storm must not talk for minutes). */
const MAX_QUEUED = 3;
let queued = 0;

export const voiceSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang.startsWith(lang.slice(0, 2))) ?? null;
}

/** The words spoken for an alert: "Overspeed, TN 09 BB 9421. Speed 92 km/h, limit 60." (message in English only). */
export function alertSpeech(a: AlertDto): string {
  const vehicle = a.plateNumber || a.objectName;
  const head = i18n.t('{{alert}} for {{vehicle}}', { alert: alertTitle(a), vehicle });
  return i18n.language.startsWith('en') ? `${head}. ${a.message}` : head;
}

/** Reads the alert aloud through the speaker (browser speech synthesis). */
export function speakAlert(a: AlertDto): void {
  if (!voiceSupported) return;
  const synth = window.speechSynthesis;
  if (queued >= MAX_QUEUED) return;
  const lang = LANG[i18n.language.slice(0, 2)] ?? 'en-IN';
  const u = new SpeechSynthesisUtterance(alertSpeech(a));
  u.lang = lang;
  const voice = pickVoice(lang);
  if (voice) u.voice = voice;
  u.rate = 1;
  u.volume = 1;
  queued++;
  u.onend = u.onerror = () => {
    queued = Math.max(0, queued - 1);
  };
  synth.speak(u);
}


/** Short spoken confirmation when the user switches announcements on (also unlocks speech in the browser). */
export function speakTest(): void {
  if (!voiceSupported) return;
  const u = new SpeechSynthesisUtterance(i18n.t('Voice announcements are on'));
  u.lang = LANG[i18n.language.slice(0, 2)] ?? 'en-IN';
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}
