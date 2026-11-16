import { S } from './strings';

/** "14:32:05" today, "12 Oct 14:32" on other days, plus "(2 min ago)". */
export function timeAgo(ms: number | undefined): string {
  if (!ms) return S.never;
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: sameDay ? '2-digit' : undefined });
  const day = sameDay ? '' : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} `;
  return `${day}${time} (${ago(ms)})`;
}

/** "10 s ago", "3 min ago", "2 h ago". */
export function ago(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return sec < 60 ? S.ago(sec, 's') : sec < 3600 ? S.ago(Math.round(sec / 60), 'min') : S.ago(Math.round(sec / 3600), 'h');
}

export const metres = (m: number | null | undefined) => (m == null ? '—' : `± ${Math.round(m)} m`);

export const kmh = (mps: number | null | undefined) => (mps == null ? '—' : `${Math.round(mps * 3.6)} km/h`);

/** "₹1,23,456.50" from minor units (paise). */
export function rupees(minor: number): string {
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100).toString();
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${minor < 0 ? '-' : ''}₹${rest ? `${rest},${last3}` : last3}.${(abs % 100).toString().padStart(2, '0')}`;
}

/** "12 Oct 14:32" (time only today). */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}
