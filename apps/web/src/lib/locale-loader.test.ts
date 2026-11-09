import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLanguageSwitcher, createLocaleLoader, type Translations } from './locale-loader.ts';

function fakeI18n() {
  const bundles = new Map<string, Translations>();
  const changes: string[] = [];
  return {
    bundles,
    changes,
    hasResourceBundle: (lng: string, ns: string) => ns === 'translation' && bundles.has(lng),
    addResourceBundle: (lng: string, _ns: string, res: Translations) => void bundles.set(lng, res),
    changeLanguage: async (lng: string) => void changes.push(lng),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

test('English needs no bundle and resolves immediately', async () => {
  const i18n = fakeI18n();
  let calls = 0;
  const ensure = createLocaleLoader(i18n, { hi: async () => (calls++, { Hello: 'नमस्ते' }) });
  await ensure('en');
  assert.equal(calls, 0);
  assert.equal(i18n.bundles.size, 0);
});

test('a bundle is loaded once on demand and registered', async () => {
  const i18n = fakeI18n();
  let calls = 0;
  const ensure = createLocaleLoader(i18n, { hi: async () => (calls++, { Hello: 'नमस्ते' }) });
  assert.equal(i18n.bundles.has('hi'), false, 'nothing loaded up front');
  await Promise.all([ensure('hi'), ensure('hi')]);
  await ensure('hi');
  assert.equal(calls, 1, 'concurrent and later calls share one request');
  assert.deepEqual(i18n.bundles.get('hi'), { Hello: 'नमस्ते' });
});

test('only the requested language is fetched', async () => {
  const i18n = fakeI18n();
  const fetched: string[] = [];
  const ensure = createLocaleLoader(i18n, {
    hi: async () => (fetched.push('hi'), {}),
    ta: async () => (fetched.push('ta'), {}),
  });
  await ensure('ta');
  assert.deepEqual(fetched, ['ta']);
});

test('a failed download rejects and is retried on the next call', async () => {
  const i18n = fakeI18n();
  let attempt = 0;
  const ensure = createLocaleLoader(i18n, {
    ta: async () => {
      attempt++;
      if (attempt === 1) throw new Error('offline');
      return { Hello: 'வணக்கம்' };
    },
  });
  await assert.rejects(ensure('ta'), /offline/);
  assert.equal(i18n.bundles.has('ta'), false);
  await ensure('ta');
  assert.equal(attempt, 2);
  assert.equal(i18n.bundles.get('ta')?.Hello, 'வணக்கம்');
});

test('switcher loads, then changes language and runs the callback', async () => {
  const i18n = fakeI18n();
  const applied: string[] = [];
  const ensure = createLocaleLoader(i18n, { hi: async () => ({}) });
  const switchTo = createLanguageSwitcher(i18n, ensure, (c) => applied.push(c));
  assert.equal(await switchTo('hi'), true);
  assert.deepEqual(i18n.changes, ['hi']);
  assert.deepEqual(applied, ['hi']);
  assert.equal(await switchTo('en'), true);
  assert.deepEqual(i18n.changes, ['hi', 'en']);
});

test('switcher applies only the latest choice when downloads overlap', async () => {
  const i18n = fakeI18n();
  const hi = deferred<Translations>();
  const ensure = createLocaleLoader(i18n, { hi: () => hi.promise, ta: async () => ({}) });
  const switchTo = createLanguageSwitcher(i18n, ensure);
  const first = switchTo('hi');
  assert.equal(await switchTo('ta'), true);
  hi.resolve({});
  assert.equal(await first, false, 'stale choice is dropped');
  assert.deepEqual(i18n.changes, ['ta']);
  assert.ok(i18n.bundles.has('hi'), 'the bundle is still cached for later');
});

test('switcher keeps the current language when the download fails', async () => {
  const i18n = fakeI18n();
  const ensure = createLocaleLoader(i18n, { ta: async () => Promise.reject(new Error('offline')) });
  const switchTo = createLanguageSwitcher(i18n, ensure);
  await assert.rejects(switchTo('ta'));
  assert.deepEqual(i18n.changes, []);
});
