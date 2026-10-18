import { I18N_OPTIONS, i18nResources, LANGUAGE_CODES, LANGUAGES, type LanguageCode } from '@veetracer/shared';
import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const KEY = 'vt.language';

function deviceLanguage(): LanguageCode {
  const code = getLocales()[0]?.languageCode as LanguageCode | undefined;
  return code && LANGUAGE_CODES.includes(code) ? code : 'en';
}

void i18n.use(initReactI18next).init({ ...I18N_OPTIONS, resources: i18nResources(), lng: deviceLanguage() });

/** Applies the language saved on the device (before the profile loads). */
export async function restoreLanguage(): Promise<void> {
  try {
    const saved = (await SecureStore.getItemAsync(KEY)) as LanguageCode | null;
    if (saved && LANGUAGE_CODES.includes(saved)) await i18n.changeLanguage(saved);
  } catch {
    /* keystore unavailable: keep the device language */
  }
}

export function setLanguage(code: LanguageCode): void {
  void i18n.changeLanguage(code);
  SecureStore.setItemAsync(KEY, code).catch(() => undefined);
}

export function currentLocale(): string {
  return LANGUAGES.find((l) => l.code === i18n.language)?.locale ?? 'en-IN';
}

export { i18n };
