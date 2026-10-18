import { RecipientEntry } from '@veetracer/shared';
import { dedupeEntries, RecipientChain, RecipientListRow, resolveRecipientEntries, validateEntries } from './recipients';

const chain: RecipientChain = { companyId: 'c', branchId: 'b', groupIdsByPriorityAsc: ['gLow', 'gHigh'], objectId: 'o' };
const email = (value: string): RecipientEntry => ({ kind: 'EMAIL', value });
const row = (p: Partial<RecipientListRow> & Pick<RecipientListRow, 'level' | 'targetId'>): RecipientListRow => ({
  alertType: '*',
  severity: '*',
  channel: 'EMAIL',
  mode: 'DEFAULT',
  entries: [],
  ...p,
});
const values = (r: ReturnType<typeof resolveRecipientEntries>) => r.entries.map((e) => e.value);
const companyDefault = row({ level: 'COMPANY', targetId: 'c', entries: [email('admin@x.in'), email('ops@x.in')] });

describe('recipient resolution', () => {
  it('DEFAULT: falls back to the company default list', () => {
    const r = resolveRecipientEntries([companyDefault], chain, 'OVERSPEED', 'WARNING', 'EMAIL');
    expect(r.mode).toBe('DEFAULT');
    expect(r.decidedBy).toBeNull();
    expect(values(r)).toEqual(['admin@x.in', 'ops@x.in']);
    // A specific row in DEFAULT mode also means "use the defaults".
    const explicit = resolveRecipientEntries(
      [companyDefault, row({ level: 'OBJECT', targetId: 'o', alertType: 'OVERSPEED', mode: 'DEFAULT', entries: [email('ignored@x.in')] })],
      chain,
      'OVERSPEED',
      'WARNING',
      'EMAIL',
    );
    expect(values(explicit)).toEqual(['admin@x.in', 'ops@x.in']);
  });

  it('ADD: defaults plus entries (deduped)', () => {
    const r = resolveRecipientEntries(
      [companyDefault, row({ level: 'BRANCH', targetId: 'b', alertType: 'OVERSPEED', mode: 'ADD', entries: [email('branch@x.in'), email('ADMIN@x.in')] })],
      chain,
      'OVERSPEED',
      'CRITICAL',
      'EMAIL',
    );
    expect(r.mode).toBe('ADD');
    expect(r.decidedBy).toMatchObject({ level: 'BRANCH', alertType: 'OVERSPEED', severity: '*' });
    expect(values(r)).toEqual(['admin@x.in', 'ops@x.in', 'branch@x.in']);
  });

  it('ONLY and NONE replace the defaults; the most specific level wins', () => {
    const rows = [
      companyDefault,
      row({ level: 'COMPANY', targetId: 'c', alertType: 'SOS', mode: 'ONLY', entries: [email('security@x.in')] }),
      row({ level: 'OBJECT', targetId: 'o', alertType: 'IDLING', mode: 'NONE' }),
    ];
    expect(values(resolveRecipientEntries(rows, chain, 'SOS', 'CRITICAL', 'EMAIL'))).toEqual(['security@x.in']);
    const none = resolveRecipientEntries(rows, chain, 'IDLING', 'WARNING', 'EMAIL');
    expect(none.mode).toBe('NONE');
    expect(none.entries).toEqual([]);
    // Other channels are independent.
    expect(resolveRecipientEntries(rows, chain, 'IDLING', 'WARNING', 'SMS').entries).toEqual([]);
  });

  it('within a level type+severity beats type-only beats severity-only; higher-priority group beats lower', () => {
    const rows = [
      companyDefault,
      row({ level: 'GROUP', targetId: 'gHigh', alertType: 'OVERSPEED', severity: 'CRITICAL', mode: 'ONLY', entries: [email('crit@x.in')] }),
      row({ level: 'GROUP', targetId: 'gHigh', alertType: 'OVERSPEED', mode: 'ONLY', entries: [email('type@x.in')] }),
      row({ level: 'GROUP', targetId: 'gHigh', severity: 'CRITICAL', mode: 'ONLY', entries: [email('sev@x.in')] }),
      row({ level: 'GROUP', targetId: 'gLow', alertType: 'OVERSPEED', severity: 'WARNING', mode: 'ONLY', entries: [email('low@x.in')] }),
    ];
    expect(values(resolveRecipientEntries(rows, chain, 'OVERSPEED', 'CRITICAL', 'EMAIL'))).toEqual(['crit@x.in']);
    // gHigh's type-only row is checked before gLow, even though gLow's row is more specific.
    expect(values(resolveRecipientEntries(rows, chain, 'OVERSPEED', 'WARNING', 'EMAIL'))).toEqual(['type@x.in']);
    expect(values(resolveRecipientEntries(rows, chain, 'IDLING', 'CRITICAL', 'EMAIL'))).toEqual(['sev@x.in']);
  });

  it('default lists cascade: branch ADD extends, object ONLY replaces, NONE clears', () => {
    const branchAdd = row({ level: 'BRANCH', targetId: 'b', mode: 'ADD', entries: [email('chennai@x.in')] });
    expect(values(resolveRecipientEntries([companyDefault, branchAdd], chain, 'IDLING', 'WARNING', 'EMAIL'))).toEqual([
      'admin@x.in',
      'ops@x.in',
      'chennai@x.in',
    ]);
    const objectOnly = row({ level: 'OBJECT', targetId: 'o', mode: 'ONLY', entries: [email('driver@x.in')] });
    expect(values(resolveRecipientEntries([companyDefault, branchAdd, objectOnly], chain, 'IDLING', 'WARNING', 'EMAIL'))).toEqual(['driver@x.in']);
    const groupNone = row({ level: 'GROUP', targetId: 'gLow', mode: 'NONE' });
    expect(resolveRecipientEntries([companyDefault, groupNone], chain, 'IDLING', 'WARNING', 'EMAIL').entries).toEqual([]);
    // Unrelated objects/branches don't apply.
    const other = row({ level: 'OBJECT', targetId: 'other', mode: 'NONE' });
    expect(values(resolveRecipientEntries([companyDefault, other], chain, 'IDLING', 'WARNING', 'EMAIL'))).toEqual(['admin@x.in', 'ops@x.in']);
  });

  it('validates and dedupes entries', () => {
    expect(validateEntries([email('a@b.in'), { kind: 'MOBILE', value: '+919876543210' }, { kind: 'DYNAMIC', value: 'OBJECT_USERS' }])).toBeNull();
    expect(validateEntries([email('nope')])).toMatch(/email/);
    expect(validateEntries([{ kind: 'MOBILE', value: '9876543210' }])).toMatch(/\+91/);
    expect(validateEntries([{ kind: 'MOBILE', value: '+14155550100' }])).toMatch(/\+91/);
    expect(validateEntries([{ kind: 'DYNAMIC', value: 'EVERYONE' }])).toMatch(/dynamic/);
    expect(dedupeEntries([email('A@b.in'), email('a@b.in'), { kind: 'MOBILE', value: '+919876543210' }])).toHaveLength(2);
  });
});
