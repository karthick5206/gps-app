import type { LanguageCode } from '../api';
import { HI } from './hi';
import { TA } from './ta';

/**
 * UI translations shared by web and mobile. Keys are the English source strings (i18next with keySeparator /
 * nsSeparator disabled), so untranslated text simply shows in English.
 */
export const TRANSLATIONS: Record<Exclude<LanguageCode, 'en'>, Record<string, string>> = { hi: HI, ta: TA };

/** i18next options both apps use. */
export const I18N_OPTIONS = {
  fallbackLng: 'en',
  keySeparator: false,
  nsSeparator: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
} as const;

/** i18next resources for all languages. */
export function i18nResources() {
  return {
    en: { translation: {} },
    hi: { translation: TRANSLATIONS.hi },
    ta: { translation: TRANSLATIONS.ta },
  };
}
