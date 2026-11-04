/** URL params holding ids of one company's records. Period, tab and status filters still apply after a switch. */
const COMPANY_RECORD_PARAMS = ['objectId', 'driverId', 'alertId', 'id', 'geofence', 'poi', 'event', 'imei', 'channel', 'at'];

/** The URL params to keep when the Super Admin switches company. */
export function withoutCompanyRecords(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of COMPANY_RECORD_PARAMS) next.delete(key);
  return next;
}
