/**
 * After a deploy, a tab still running the previous build asks for page chunks that no longer exist (the server
 * answers with index.html), so lazy pages fail to load. Detect that and reload once to pick up the new build.
 */
const KEY = 'vt.reloadedForUpdate';
/** Don't reload again within this window (avoids a loop if the error is something else). */
const RELOAD_GUARD_MS = 30_000;

export function isStaleBuildError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|Unable to preload CSS|not a valid JavaScript MIME type|ChunkLoadError/i.test(message);
}

/** Reloads the page unless it already did so moments ago; returns whether it reloads. */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < RELOAD_GUARD_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage blocked: reload anyway, once per page load */
  }
  window.location.reload();
  return true;
}

/** Vite fires `vite:preloadError` when a lazy chunk fails to load. */
export function installStaleBuildRecovery(): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForNewVersion()) event.preventDefault();
  });
}
