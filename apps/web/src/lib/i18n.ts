import { I18N_OPTIONS, LANGUAGE_CODES, LANGUAGES, type LanguageCode } from '@veetracer/shared';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { setReportLocale } from '@/features/reports/report-time';
import { setFormatLocale, setFormatTranslator } from './format';
import { createLanguageSwitcher, createLocaleLoader, type BundleImporter } from './locale-loader';
import { storage } from './storage';

const KEY = 'vt.language';

/**
 * Hindi and Tamil bundles are separate chunks fetched only when selected (they were ~170 KB gzip on every first
 * load). English is the key language and needs no bundle. Mobile still uses the eager `i18nResources()`.
 */
const BUNDLES: Record<Exclude<LanguageCode, 'en'>, BundleImporter> = {
  hi: () => import('@veetracer/shared-i18n/hi').then((m) => m.HI),
  ta: () => import('@veetracer/shared-i18n/ta').then((m) => m.TA),
};

/** Saved choice, else the browser language when we support it, else English. */
function initialLanguage(): LanguageCode {
  const saved = storage.get(KEY) as LanguageCode | null;
  if (saved && LANGUAGE_CODES.includes(saved)) return saved;
  const browser = navigator.language?.slice(0, 2) as LanguageCode;
  return LANGUAGE_CODES.includes(browser) ? browser : 'en';
}

const ensureLocale = createLocaleLoader(i18n, BUNDLES);
const switchLanguage = createLanguageSwitcher(i18n, ensureLocale, (code) => {
  document.documentElement.lang = code;
});

const initial = initialLanguage();
// Start in English (always available) and switch once the initial bundle is in; main.tsx waits for this before
// the first render, so Hindi / Tamil users never see an English flash.
void i18n.use(initReactI18next).init({ ...I18N_OPTIONS, resources: { en: { translation: {} } }, lng: 'en' });
document.documentElement.lang = 'en';
setFormatTranslator((key, vars) => i18n.t(key, vars));
setFormatLocale(currentLocale());
setReportLocale(currentLocale());
i18n.on('languageChanged', () => {
  setFormatLocale(currentLocale());
  setReportLocale(currentLocale());
});

/** Resolves when the initial language is ready (immediately for English; never rejects). */
export const i18nReady: Promise<void> =
  initial === 'en' ? Promise.resolve() : switchLanguage(initial).then(() => undefined, () => undefined);

export function setLanguage(code: LanguageCode): void {
  storage.set(KEY, code);
  // A failed download keeps the current language; the choice is saved and retried on the next load.
  switchLanguage(code).catch(() => undefined);
}

/** Locale for dates and numbers in the current language (Indian formats). */
export function currentLocale(): string {
  return LANGUAGES.find((l) => l.code === i18n.language)?.locale ?? 'en-IN';
}

export { i18n };
