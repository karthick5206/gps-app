/** One line per change of a saved change set (pure, `node --test`). */
import type { ChangeSetChangeView } from '@veetracer/shared';

type Translate = (key: string, vars?: Record<string, unknown>) => string;
const english: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars?.[k] ?? ''));

export function changeLine(c: ChangeSetChangeView, t: Translate = english): string {
  const who = (p: { displayName: string; employeeCode: string } | null) => (p ? `${p.displayName} (${p.employeeCode})` : t('a passenger'));
  switch (c.op) {
    case 'CREATE_TRIP':
      return t('New trip on {{vehicle}}{{driver}}, {{n}} stop(s)', { vehicle: c.vehicleName ?? t('a vehicle'), driver: c.driverName ? ` · ${c.driverName}` : '', n: c.stops.length });
    case 'ADD_PASSENGER':
      return t('Seat {{who}} on {{trip}} (stops {{p}} → {{d}})', { who: who(c.passenger), trip: c.tripLabel, p: c.pickupSeq + 1, d: c.dropSeq + 1 });
    case 'ADD_STOP':
      return t(c.end === 'PICKUP' ? 'New pickup stop for {{who}} on {{trip}}, after stop {{n}}' : 'New drop stop for {{who}} on {{trip}}, after stop {{n}}', { who: who(c.passenger), trip: c.tripLabel, n: c.afterSeq + 1 });
    case 'REMOVE_PASSENGER':
      return t('Take {{who}} off {{trip}}: {{reason}}', { who: who(c.passenger), trip: c.tripLabel, reason: c.reason });
    case 'REASSIGN_VEHICLE':
      return t('Change the vehicle of {{trip}} to {{vehicle}}', { trip: c.tripLabel, vehicle: c.vehicleName ?? t('a vehicle') });
    case 'REASSIGN_DRIVER':
      return c.driverId ? t('Change the driver of {{trip}} to {{driver}}', { trip: c.tripLabel, driver: c.driverName ?? t('a driver') }) : t('Remove the driver of {{trip}}', { trip: c.tripLabel });
  }
}
