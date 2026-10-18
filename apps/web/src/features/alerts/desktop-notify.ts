import type { AlertDto } from '@veetracer/shared';
import { useSyncExternalStore } from 'react';
import { storage } from '@/lib/storage';

/**
 * Desktop (browser) notifications for warning and critical alerts while Veetrax is open in a background tab or
 * minimised window. Opt-in per browser: turning it on asks the browser for permission.
 */
const KEY = 'vt.alerts.desktop';
const supported = typeof window !== 'undefined' && 'Notification' in window;
type Listener = () => void;
const listeners = new Set<Listener>();

export type DesktopNotifyState = 'unsupported' | 'blocked' | 'off' | 'on';

function compute(): DesktopNotifyState {
  if (!supported) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return storage.get(KEY) === '1' && Notification.permission === 'granted' ? 'on' : 'off';
}
let state = compute();
const emit = () => {
  state = compute();
  listeners.forEach((l) => l());
};

export const desktopNotify = {
  getState: () => state,
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  async enable(): Promise<DesktopNotifyState> {
    if (!supported) return 'unsupported';
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    storage.set(KEY, permission === 'granted' ? '1' : '0');
    emit();
    return state;
  },
  disable() {
    storage.set(KEY, '0');
    emit();
  },
  /** Shows the alert when the page is not in front; returns true when a notification was shown. */
  show(a: AlertDto, title: string, body: string, onClick: () => void): boolean {
    if (state !== 'on' || a.severity === 'INFO') return false;
    if (document.visibilityState === 'visible' && document.hasFocus()) return false;
    const n = new Notification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      tag: `alert-${a.id}`,
      requireInteraction: a.severity === 'CRITICAL',
    });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
    return true;
  },
};

export function useDesktopNotify(): DesktopNotifyState {
  return useSyncExternalStore(desktopNotify.subscribe, desktopNotify.getState);
}
