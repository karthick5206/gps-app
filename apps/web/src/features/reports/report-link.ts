/**
 * Links that open the Reports page pre-filled (batch 2): an Event summary heatmap cell opens the Alerts report for that
 * vehicle and alert type over the same days, already run. Pure (URLSearchParams only) so node --test can run it.
 */

export interface ReportLink {
  type: string;
  from: string;
  to: string;
  objectIds: string[];
  /** Label for the pre-selected vehicle until the vehicle list has loaded. */
  vehicleName?: string;
  alertTypes: string[];
  /** Run the report as soon as the page opens. */
  run: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

/** `/reports?type=ALERTS&from=…&to=…&vehicle=…&vehicleName=…&alertType=…&run=1` for one heatmap cell. */
export function alertsReportLink(cell: { objectId: string; objectName?: string; alertType: string; from: string; to: string }): string {
  const q = new URLSearchParams({ type: 'ALERTS', from: cell.from, to: cell.to, vehicle: cell.objectId });
  if (cell.objectName) q.set('vehicleName', cell.objectName);
  q.set('alertType', cell.alertType);
  q.set('run', '1');
  return `/reports?${q}`;
}

/** Reads a pre-fill from the page URL; anything malformed is ignored. `null` when no report type is given. */
export function parseReportLink(search: string, validTypes: readonly string[]): ReportLink | null {
  const q = new URLSearchParams(search);
  const type = q.get('type') ?? '';
  if (!validTypes.includes(type)) return null;
  const from = q.get('from') ?? '';
  const to = q.get('to') ?? '';
  const datesOk = DAY.test(from) && DAY.test(to) && from <= to;
  const objectIds = q.getAll('vehicle').filter((v) => UUID.test(v)).slice(0, 50);
  const alertTypes = q.getAll('alertType').filter((v) => CODE.test(v)).slice(0, 50);
  const vehicleName = (q.get('vehicleName') ?? '').slice(0, 120) || undefined;
  return {
    type,
    from: datesOk ? from : '',
    to: datesOk ? to : '',
    objectIds,
    vehicleName: objectIds.length === 1 ? vehicleName : undefined,
    alertTypes,
    run: q.get('run') === '1' && datesOk,
  };
}
