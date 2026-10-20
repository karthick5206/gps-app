import { S } from './strings';

/** "14:32:05" today, "12 Oct 14:32" on other days, plus "(2 min ago)". */
export function timeAgo(ms: number | undefined): string {
  if (!ms) return S.never;
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: sameDay ? '2-digit' : undefined });
  const day = sameDay ? '' : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} `;
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const ago = sec < 60 ? `${sec} s ago` : sec < 3600 ? `${Math.round(sec / 60)} min ago` : `${Math.round(sec / 3600)} h ago`;
  return `${day}${time} (${ago})`;
}

export const metres = (m: number | null | undefined) => (m == null ? '—' : `± ${Math.round(m)} m`);

export const kmh = (mps: number | null | undefined) => (mps == null ? '—' : `${Math.round(mps * 3.6)} km/h`);
