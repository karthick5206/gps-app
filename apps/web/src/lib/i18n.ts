import { I18N_OPTIONS, i18nResources, LANGUAGE_CODES, LANGUAGES, type LanguageCode } from '@veetracer/shared';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { setFormatLocale, setFormatTranslator } from './format';
import { storage } from './storage';

const KEY = 'vt.language';

/** Saved choice, else the browser language when we support it, else English. */
function initialLanguage(): LanguageCode {
  const saved = storage.get(KEY) as LanguageCode | null;
  if (saved && LANGUAGE_CODES.includes(saved)) return saved;
  const browser = navigator.language?.slice(0, 2) as LanguageCode;
  return LANGUAGE_CODES.includes(browser) ? browser : 'en';
}

void i18n.use(initReactI18next).init({ ...I18N_OPTIONS, resources: i18nResources(), lng: initialLanguage() });
document.documentElement.lang = i18n.language;
setFormatTranslator((key, vars) => i18n.t(key, vars));
setFormatLocale(currentLocale());
i18n.on('languageChanged', () => setFormatLocale(currentLocale()));

export function setLanguage(code: LanguageCode): void {
  storage.set(KEY, code);
  document.documentElement.lang = code;
  void i18n.changeLanguage(code);
}

/** Locale for dates and numbers in the current language (Indian formats). */
export function currentLocale(): string {
  return LANGUAGES.find((l) => l.code === i18n.language)?.locale ?? 'en-IN';
}

export { i18n };
