/** Date-range presets shared by the alerts list and geofence visits (local time). */
export type RangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'custom';

export const PRESET_LABEL: Record<RangePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  custom: 'Custom',
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function presetRange(p: Exclude<RangePreset, 'custom'>, now = new Date()): { from: Date; to: Date } {
  const today = startOfDay(now);
  switch (p) {
    case 'today':
      return { from: today, to: now };
    case 'yesterday': {
      const from = new Date(today);
      from.setDate(from.getDate() - 1);
      return { from, to: new Date(today.getTime() - 1) };
    }
    case '7d': {
      const from = new Date(today);
      from.setDate(from.getDate() - 6);
      return { from, to: now };
    }
    case '30d': {
      const from = new Date(today);
      from.setDate(from.getDate() - 29);
      return { from, to: now };
    }
  }
}

/** yyyy-MM-dd of a local date (for <input type="date">). */
export function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fromDateInput(v: string, end = false): Date {
  const d = new Date(`${v}T00:00:00`);
  if (end) d.setHours(23, 59, 59, 999);
  return d;
}
