import { ALERT_TYPES } from '@veetracer/shared';
import { findGroupConflicts, resolveEffectiveSettings, SettingOverride, SettingsChain, validateOverride } from './settings-resolution';

const o = (partial: Partial<SettingOverride>): SettingOverride => ({
  enabled: null,
  params: {},
  schedule: null,
  cooldownMin: null,
  severity: null,
  channels: null,
  ...partial,
});

const GT06 = ['ignition', 'sos', 'power_cut', 'battery'];
const now = Date.parse('2026-10-18T10:00:00Z');
const get = (list: ReturnType<typeof resolveEffectiveSettings>, type: string) => list.find((s) => s.alertType === type)!;

describe('alert settings resolution', () => {
  it('starts from catalogue defaults', () => {
    const list = resolveEffectiveSettings({ groups: [] }, GT06, [], now);
    expect(list).toHaveLength(ALERT_TYPES.length);
    const os = get(list, 'OVERSPEED');
    expect(os.enabled).toBe(true);
    expect(os.severity).toBe('WARNING');
    expect(os.params.toleranceKph).toBe(0); // fleet default: alert above the limit (80 km/h unless the vehicle has its own)
    expect(os.params.limitKph).toBeNull();
    expect(os.sources.enabled).toBe('DEFAULT');
    expect(os.channels.CRITICAL).toEqual(['INAPP', 'PUSH', 'EMAIL', 'SMS']);
    // Fleet defaults: ignition on/off, overspeed, device offline and low battery are on.
    for (const code of ['IGNITION_ON', 'IGNITION_OFF', 'OVERSPEED', 'DEVICE_OFFLINE', 'LOW_BATTERY'] as const) expect(get(list, code).enabled).toBe(true);
  });

  it('inherits field by field: Company → Branch → Group → Object', () => {
    const chain: SettingsChain = {
      company: { OVERSPEED: o({ params: { toleranceKph: 3, minDurationSec: 30 }, severity: 'INFO' }) },
      branch: { OVERSPEED: o({ params: { toleranceKph: 8 } }) },
      groups: [{ groupId: 'g1', name: 'Heavy', priority: 0, rows: { OVERSPEED: o({ cooldownMin: 7 }) } }],
      object: { OVERSPEED: o({ enabled: false, params: { limitKph: 50 } }) },
    };
    const os = get(resolveEffectiveSettings(chain, GT06, [], now), 'OVERSPEED');
    expect(os.enabled).toBe(false);
    expect(os.params).toMatchObject({ limitKph: 50, toleranceKph: 8, minDurationSec: 30, criticalOverKph: 20 });
    expect(os.severity).toBe('INFO');
    expect(os.cooldownMin).toBe(7);
    expect(os.sources).toMatchObject({
      enabled: 'OBJECT',
      'params.limitKph': 'OBJECT',
      'params.toleranceKph': 'BRANCH',
      'params.minDurationSec': 'COMPANY',
      'params.criticalOverKph': 'DEFAULT',
      severity: 'COMPANY',
      cooldownMin: 'GROUP',
    });
  });

  it('highest group priority wins on conflict, per field', () => {
    const chain: SettingsChain = {
      groups: [
        { groupId: 'low', name: 'A low', priority: 1, rows: { IDLING: o({ params: { thresholdMin: 5, criticalMin: 20 }, severity: 'INFO' }) } },
        { groupId: 'high', name: 'B high', priority: 10, rows: { IDLING: o({ params: { thresholdMin: 25 } }) } },
      ],
    };
    const idle = get(resolveEffectiveSettings(chain, GT06, [], now), 'IDLING');
    expect(idle.params.thresholdMin).toBe(25); // high priority group
    expect(idle.params.criticalMin).toBe(20); // only the low group sets it
    expect(idle.severity).toBe('INFO');
    const conflicts = findGroupConflicts(chain);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ alertType: 'IDLING', field: 'params.thresholdMin', winner: { groupId: 'high', value: 25 } });
    expect(conflicts[0].others[0]).toMatchObject({ groupId: 'low', value: 5 });
  });

  it('mandatory SOS ignores enabled:false below company level and snoozes, but company may disable it', () => {
    const below: SettingsChain = { branch: { SOS: o({ enabled: false }) }, groups: [], object: { SOS: o({ enabled: false }) } };
    const snooze = [{ alertTypes: [], until: now + 3600_000 }];
    const sos = get(resolveEffectiveSettings(below, GT06, snooze, now), 'SOS');
    expect(sos.enabled).toBe(true);
    expect(sos.snoozedUntil).toBeNull();
    const company: SettingsChain = { company: { SOS: o({ enabled: false }) }, groups: [] };
    expect(get(resolveEffectiveSettings(company, GT06, [], now), 'SOS').enabled).toBe(false);
    expect(validateOverride('SOS', 'OBJECT', { enabled: false })).toMatch(/mandatory/);
    expect(validateOverride('SOS', 'COMPANY', { enabled: false })).toBeNull();
  });

  it('applies snoozes to listed (or all non-mandatory) types and marks unsupported capabilities', () => {
    const list = resolveEffectiveSettings({ groups: [] }, ['battery'], [{ alertTypes: ['OVERSPEED'], until: now + 60_000 }], now);
    expect(get(list, 'OVERSPEED').snoozedUntil).toBe(new Date(now + 60_000).toISOString());
    expect(get(list, 'IDLING').snoozedUntil).toBeNull();
    expect(get(list, 'IDLING').supported).toBe(false); // needs ignition
    expect(get(list, 'LOW_BATTERY').supported).toBe(true);
    expect(get(list, 'GEOFENCE_ENTER').supported).toBe(true); // any GPS device
    const all = resolveEffectiveSettings({ groups: [] }, GT06, [{ alertTypes: [], until: now + 60_000 }], now);
    expect(get(all, 'IDLING').snoozedUntil).not.toBeNull();
    const expired = resolveEffectiveSettings({ groups: [] }, GT06, [{ alertTypes: [], until: now - 1 }], now);
    expect(get(expired, 'IDLING').snoozedUntil).toBeNull();
  });

  it('merges channels per severity', () => {
    const chain: SettingsChain = {
      company: { OVERSPEED: o({ channels: { WARNING: ['INAPP'] } }) },
      groups: [],
      object: { OVERSPEED: o({ channels: { CRITICAL: ['INAPP', 'SMS'] } }) },
    };
    const os = get(resolveEffectiveSettings(chain, GT06, [], now), 'OVERSPEED');
    expect(os.channels).toEqual({ INFO: ['INAPP'], WARNING: ['INAPP'], CRITICAL: ['INAPP', 'SMS'] });
    expect(os.sources['channels.WARNING']).toBe('COMPANY');
    expect(os.sources['channels.CRITICAL']).toBe('OBJECT');
    expect(os.sources.channels).toBe('OBJECT');
  });

  it('validates params against the catalogue', () => {
    expect(validateOverride('OVERSPEED', 'OBJECT', { params: { toleranceKph: 5 } })).toBeNull();
    expect(validateOverride('OVERSPEED', 'OBJECT', { params: { toleranceKph: 500 } })).toMatch(/at most 50/);
    expect(validateOverride('OVERSPEED', 'OBJECT', { params: { toleranceKph: 'x' } })).toMatch(/number/);
    expect(validateOverride('OVERSPEED', 'OBJECT', { params: { nightFrom: '25:00' } })).toMatch(/HH:mm/);
    expect(validateOverride('OVERSPEED', 'OBJECT', { params: { nope: 1 } })).toMatch(/Unknown parameter/);
    expect(validateOverride('IDLING', 'OBJECT', { params: { excludeGeofenceIds: ['a'] } })).toBeNull();
    expect(validateOverride('IDLING', 'OBJECT', { schedule: { days: [8], from: '09:00', to: '10:00' } })).toMatch(/Schedule/);
    expect(validateOverride('IDLING', 'OBJECT', { channels: { WARNING: ['FAX'] } })).toMatch(/Channels/);
    expect(validateOverride('NOPE', 'OBJECT', {})).toMatch(/Unknown alert type/);
  });
});

describe('require acknowledgement', () => {
  it('defaults: SOS/crash/power cut/offline and CRITICAL severity; inherits Company → Branch → Group → Object with sources', () => {
    const list = resolveEffectiveSettings({ groups: [] }, GT06, [], now);
    expect(get(list, 'SOS')).toMatchObject({ requireAck: true, sources: expect.objectContaining({ requireAck: 'DEFAULT' }) });
    expect(get(list, 'POWER_CUT').requireAck).toBe(true);
    expect(get(list, 'DEVICE_OFFLINE').requireAck).toBe(true);
    expect(get(list, 'OVERSPEED').requireAck).toBe(false);
    expect(get(list, 'DEVICE_TAMPER').requireAck).toBe(true); // catalogue severity CRITICAL

    const chain: SettingsChain = {
      company: { OVERSPEED: o({ requireAck: true }), POWER_CUT: o({ requireAck: false }), IGNITION_ON: o({ severity: 'CRITICAL' }) },
      branch: { OVERSPEED: o({ requireAck: false }) },
      groups: [{ groupId: 'g1', name: 'Heavy', priority: 0, rows: { OVERSPEED: o({ requireAck: true }) } }],
      object: {},
    };
    const r = resolveEffectiveSettings(chain, GT06, [], now);
    expect(get(r, 'OVERSPEED')).toMatchObject({ requireAck: true, sources: expect.objectContaining({ requireAck: 'GROUP' }) });
    expect(get(r, 'POWER_CUT')).toMatchObject({ requireAck: false, sources: expect.objectContaining({ requireAck: 'COMPANY' }) });
    // Default follows the effective severity.
    expect(get(r, 'IGNITION_ON')).toMatchObject({ requireAck: true, sources: expect.objectContaining({ requireAck: 'DEFAULT' }) });
    const objectOff = resolveEffectiveSettings({ ...chain, object: { OVERSPEED: o({ requireAck: false }) } }, GT06, [], now);
    expect(get(objectOff, 'OVERSPEED')).toMatchObject({ requireAck: false, sources: expect.objectContaining({ requireAck: 'OBJECT' }) });
  });

  it('SOS and crash always require it: false is rejected at every level and ignored if stored', () => {
    for (const level of ['COMPANY', 'BRANCH', 'GROUP', 'OBJECT'] as const) {
      expect(validateOverride('SOS', level, { requireAck: false })).toMatch(/always requires acknowledgement/);
      expect(validateOverride('CRASH', level, { requireAck: false })).toMatch(/always requires acknowledgement/);
    }
    expect(validateOverride('SOS', 'OBJECT', { requireAck: true })).toBeNull();
    expect(validateOverride('POWER_CUT', 'OBJECT', { requireAck: false })).toBeNull();
    const r = resolveEffectiveSettings({ groups: [], company: { SOS: o({ requireAck: false }) } }, GT06, [], now);
    expect(get(r, 'SOS').requireAck).toBe(true);
  });
});
