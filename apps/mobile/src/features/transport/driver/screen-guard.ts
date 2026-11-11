/**
 * Screenshot / screen-recording block for the driver trip (manifest) screen (doc 09 §7.1 "Screenshot blocking on
 * manifest screens", doc 10 §6 threat model I "FLAG_SECURE on manifest screen"; E5 security review M3).
 *
 * Android: FLAG_SECURE (no screenshots, no recording, blank recents thumbnail). iOS: the screen is hidden from
 * recordings / mirroring and screenshots are blocked where the OS allows. A second phone still defeats it: this blocks
 * casual capture only, the manifest itself stays minimal (First L., no contact, points only with consent).
 *
 * Pure (`node --test`): the hook is injected, so the tests run without the native module. The screen passes
 * `usePreventScreenCapture` from `expo-screen-capture` (a native module: needs a new dev / release build).
 */
export const MANIFEST_CAPTURE_KEY = 'veetrax-driver-manifest';

export type PreventCaptureHook = (key?: string) => void;

/**
 * The hook the manifest screen calls on every render: blocks capture while it is mounted (one key per screen). On web
 * (Expo web / QA builds) the native module is absent and its cleanup would throw, so the guard is a no-op there.
 */
export function manifestScreenGuard(prevent: PreventCaptureHook, platform: string): () => void {
  if (platform === 'web') return () => undefined;
  return () => prevent(MANIFEST_CAPTURE_KEY);
}
