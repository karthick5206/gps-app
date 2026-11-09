/**
 * Date presets for reports, on calendar days (YYYY-MM-DD). `today` is the company's today (report-time.todayInZone),
 * because report periods are company days; ranges end today (fleets look at today's activity first). Pure.
 */
export type DatePresetId = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth';

export const DATE_PRESETS: { id: DatePresetId; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
];

const DAY_MS = 86_400_000;
const parse = (day: string) => Date.parse(`${day}T00:00:00Z`);
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDaysKey(day: string, n: number): string {
  return fmt(parse(day) + n * DAY_MS);
}

export function presetRange(id: DatePresetId, today: string): [string, string] {
  const [y, m] = today.split('-').map(Number);
  switch (id) {
    case 'today':
      return [today, today];
    case 'yesterday': {
      const d = addDaysKey(today, -1);
      return [d, d];
    }
    case 'last7':
      return [addDaysKey(today, -6), today];
    case 'last30':
      return [addDaysKey(today, -29), today];
    case 'thisMonth':
      return [`${today.slice(0, 7)}-01`, today];
    case 'lastMonth': {
      const first = fmt(Date.UTC(y, m - 2, 1));
      const last = fmt(Date.UTC(y, m - 1, 0));
      return [first, last];
    }
  }
}

/** The preset a range equals (first match in DATE_PRESETS order), else null. */
export function matchPreset(from: string, to: string, today: string): DatePresetId | null {
  for (const p of DATE_PRESETS) {
    const [a, b] = presetRange(p.id, today);
    if (a === from && b === to) return p.id;
  }
  return null;
}
