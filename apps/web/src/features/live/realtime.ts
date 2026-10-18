import type { LiveObject } from '@veetracer/shared';
import { io, type Socket } from 'socket.io-client';
import { refreshAccessToken } from '@/lib/api';
import { session } from '@/lib/session';
import { liveStore } from './live-store';

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

interface ServerToClient {
  'live:batch': (items: LiveObject[]) => void;
}

type Listener = () => void;

/** Socket.IO client for the `/live` namespace; one connection per selected company. */
class Realtime {
  private socket: Socket<ServerToClient> | null = null;
  private companyId: string | null = null;
  private status: RealtimeStatus = 'idle';
  private listeners = new Set<Listener>();
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private hadConnection = false;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;

  getStatus = () => this.status;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setStatus(status: RealtimeStatus) {
    if (status === this.status) return;
    this.status = status;
    this.listeners.forEach((l) => l());
  }

  start(companyId: string | null) {
    clearTimeout(this.stopTimer);
    if (this.socket && this.companyId === companyId) return;
    this.stop();
    this.companyId = companyId;
    this.setStatus('connecting');

    const socket: Socket<ServerToClient> = io('/live', {
      // Evaluated on every (re)connect, so reconnects always carry the freshest access token.
      auth: (cb) => cb({ token: session.getAccessToken(), ...(companyId ? { companyId } : {}) }),
      transports: ['websocket', 'polling'],
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.retry = 0;
      this.setStatus('connected');
      // Resync after a gap so updates missed while disconnected are not lost.
      if (this.hadConnection && liveStore.snapshotLoaded) liveStore.loadSnapshot().catch(() => undefined);
      this.hadConnection = true;
    });
    socket.on('live:batch', (items) => liveStore.applyBatch(items));
    socket.on('disconnect', (reason) => {
      this.setStatus('disconnected');
      if (reason === 'io server disconnect') this.reconnectWithFreshToken();
    });
    socket.on('connect_error', () => {
      this.setStatus('disconnected');
      // `active` is false when the server rejected the handshake (e.g. expired token): no automatic retry.
      if (!socket.active) this.reconnectWithFreshToken();
    });
  }

  private reconnectWithFreshToken() {
    const socket = this.socket;
    if (!socket) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    this.retryTimer = setTimeout(async () => {
      if (this.socket !== socket) return;
      // A rejected refresh token means the session is over; the API client signs the user out.
      if (!(await refreshAccessToken())) return;
      if (this.socket === socket) socket.connect();
    }, delay);
  }

  /**
   * Deferred stop: an immediate re-start (React StrictMode remount, route change) keeps the
   * existing connection instead of tearing down a socket that is still handshaking.
   */
  release() {
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => this.stop(), 0);
  }

  stop() {
    clearTimeout(this.stopTimer);
    clearTimeout(this.retryTimer);
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.retry = 0;
    this.hadConnection = false;
    this.setStatus('idle');
  }
}

export const realtime = new Realtime();
