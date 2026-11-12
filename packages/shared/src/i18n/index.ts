import type { LanguageCode } from '../api';
import { HI } from './hi';
import { TA } from './ta';
import { TRANSPORT_MOBILE_HI, TRANSPORT_MOBILE_TA } from './transport-mobile';
import { TRANSPORT_SOS_HI, TRANSPORT_SOS_TA } from './transport-sos';
import { TRANSPORT_SELF_HI, TRANSPORT_SELF_TA } from './transport-self';

/**
 * UI translations shared by web and mobile. Keys are the English source strings (i18next with keySeparator /
 * nsSeparator disabled), so untranslated text simply shows in English.
 */
export const TRANSLATIONS: Record<Exclude<LanguageCode, 'en'>, Record<string, string>> = {
  // The main tables win over the mobile transport table (transport-mobile.ts), the SOS table (transport-sos.ts) and the
  // self-service table (transport-self.ts) for any key they share.
  hi: { ...TRANSPORT_SOS_HI, ...TRANSPORT_MOBILE_HI, ...TRANSPORT_SELF_HI, ...HI },
  ta: { ...TRANSPORT_SOS_TA, ...TRANSPORT_MOBILE_TA, ...TRANSPORT_SELF_TA, ...TA },
};

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
