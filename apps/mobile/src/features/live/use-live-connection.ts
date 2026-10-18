import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@/features/auth/auth';
import { liveStore } from './live-store';
import { realtime } from './realtime';

/**
 * Keeps live data flowing while the app is in the foreground: snapshot + socket for the selected company.
 * In the background the socket is closed (saves battery and data); coming back reloads the snapshot.
 */
export function useLiveConnection() {
  const { status, companyId } = useAuth();
  useEffect(() => {
    if (status !== 'authenticated') return;
    const start = () => {
      liveStore.loadSnapshot().catch(() => undefined);
      realtime.start(companyId);
    };
    start();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') start();
      else if (s === 'background') realtime.stop();
    });
    return () => {
      sub.remove();
      realtime.stop();
    };
  }, [status, companyId]);
}
