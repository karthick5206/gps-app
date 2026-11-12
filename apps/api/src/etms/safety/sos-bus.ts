import type { TransportSosSocketPayload } from '@veetracer/shared';

/** Valkey pub/sub channel of `transport.sos` fan-out (every API instance's /live gateway subscribes). */
export const SOS_CHANNEL = 'vt:etms:sos';

/** What travels on SOS_CHANNEL (and the in-process fallback): ids and the small socket payload only. */
export interface SosFanoutMessage {
  providerCompanyId: string | null;
  customerCompanyId: string | null;
  raiserType: string;
  payload: TransportSosSocketPayload;
}

type LocalHandler = (msg: SosFanoutMessage) => number;

/**
 * In-process path from the SAFETY outbox relay to the /live gateway of the SAME process, used when Valkey is down
 * (doc 10 §6.2 "Valkey down: SOS-only direct send from the relay"). The gateway registers a handler that emits to its
 * own in-scope sockets and returns how many sockets it reached; with no gateway in the process (worker, tests) the
 * handler count is 0 and the relay keeps the row pending.
 */
class SosLocalBus {
  private handlers = new Set<LocalHandler>();

  register(h: LocalHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  /** Returns the number of sockets reached. A throwing handler counts as 0. */
  emit(msg: SosFanoutMessage): number {
    let n = 0;
    for (const h of this.handlers) {
      try {
        n += h(msg);
      } catch {
        // a broken gateway handler must never stop the relay
      }
    }
    return n;
  }
}

export const sosLocalBus = new SosLocalBus();
