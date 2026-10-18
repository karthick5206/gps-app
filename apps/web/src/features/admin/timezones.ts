import type { Option } from '@/components/ui/multi-select';

const FALLBACK = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'];

/** IANA time zones supported by the browser, as picker options. */
export function timezoneOptions(): Option[] {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : FALLBACK;
  return zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
}
