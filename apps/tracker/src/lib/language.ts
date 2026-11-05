import { I18nManager } from 'react-native';
import { kvGet, kvSet } from './db';
import { emit } from './state';
import { setCurrentLanguage, type LanguageCode } from './strings';
import { Tracker } from './tracking';

export const LANGUAGES: { code: LanguageCode; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ta', label: 'தமிழ்' },
];

const KEY = 'language';

/** The phone's language if we have it ("ta_IN" → ta), else English. */
function phoneLanguage(): LanguageCode {
  const id = (I18nManager.getConstants() as { localeIdentifier?: string }).localeIdentifier ?? '';
  const code = id.slice(0, 2).toLowerCase();
  return LANGUAGES.find((l) => l.code === code)?.code ?? 'en';
}

let current: LanguageCode = 'en';

export const language = () => current;

function apply(code: LanguageCode): void {
  current = code;
  setCurrentLanguage(code);
  // The tracking notification comes from the native engine, which also runs without this screen.
  Tracker.setLanguage(code);
}

/** At start: the language chosen here, else the phone's. */
export function initLanguage(): void {
  apply(kvGet<LanguageCode | null>(KEY, null) ?? phoneLanguage());
}

export function setLanguage(code: LanguageCode): void {
  kvSet(KEY, code);
  apply(code);
  emit();
}
