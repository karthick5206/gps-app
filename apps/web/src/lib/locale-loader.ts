/**
 * On-demand translation bundles. English is the source language (keys are the English strings), so it needs no
 * bundle; Hindi and Tamil (~170 KB gzip together) are fetched only when that language is selected and then added to
 * i18next as resources. No Vite- or app-specific imports so it runs under `node --test`.
 */

export type Translations = Record<string, string>;
export type BundleImporter = () => Promise<Translations>;

/** The slice of the i18next API the loader needs (keeps tests free of i18next). */
export interface ResourceSink {
  hasResourceBundle(lng: string, ns: string): boolean;
  addResourceBundle(lng: string, ns: string, resources: Translations, deep?: boolean, overwrite?: boolean): unknown;
}

export interface LanguageTarget extends ResourceSink {
  changeLanguage(lng: string): Promise<unknown>;
}

const NS = 'translation';

/**
 * Returns `ensure(code)`: resolves once `code`'s bundle is registered. Concurrent calls share one request; a failed
 * request is forgotten so the next call retries. Languages without an importer (English) resolve immediately.
 */
export function createLocaleLoader(sink: ResourceSink, importers: Readonly<Record<string, BundleImporter | undefined>>) {
  const pending = new Map<string, Promise<void>>();
  return function ensure(code: string): Promise<void> {
    const load = importers[code];
    if (!load || sink.hasResourceBundle(code, NS)) return Promise.resolve();
    let p = pending.get(code);
    if (!p) {
      p = load().then(
        (resources) => {
          sink.addResourceBundle(code, NS, resources, true, true);
          pending.delete(code);
        },
        (err: unknown) => {
          pending.delete(code);
          throw err;
        },
      );
      pending.set(code, p);
    }
    return p;
  };
}

/**
 * Returns `switchTo(code)`: loads the bundle, then changes language. If the user picks another language while a
 * bundle is still downloading, only the latest choice is applied. `onApplied` runs after a change (e.g. html[lang]).
 * A failed download leaves the current language in place and rejects.
 */
export function createLanguageSwitcher(target: LanguageTarget, ensure: (code: string) => Promise<void>, onApplied?: (code: string) => void) {
  let wanted: string | null = null;
  return async function switchTo(code: string): Promise<boolean> {
    wanted = code;
    await ensure(code);
    if (wanted !== code) return false;
    await target.changeLanguage(code);
    onApplied?.(code);
    return true;
  };
}
