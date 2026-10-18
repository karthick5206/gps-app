import { ALERT_TYPES } from '@veetracer/shared';
import {
  fillDltText,
  isSendable,
  placeholdersFor,
  renderSms,
  renderText,
  smsActivationError,
  smsDltText,
  smsParts,
  smsVariableOrder,
  templateVariables,
} from './render';
import { systemTemplates } from './system-templates';
import { alertVars, renderTemplate } from './template-renderer';

describe('template rendering', () => {
  it('replaces {{name}} placeholders and reports missing ones', () => {
    const r = renderText('Hi {{ user_name }}, {{vehicle_name}} at {{time}}{{nope}}', { user_name: 'Priya', vehicle_name: 'Truck 07', time: '10:00' });
    expect(r.text).toBe('Hi Priya, Truck 07 at 10:00');
    expect(r.missing).toEqual(['nope']);
  });

  it('HTML-escapes values in e-mail bodies but not in subjects', () => {
    const t = { id: 't', channel: 'EMAIL' as const, subject: 'Alert: {{vehicle_name}}', body: '<p>{{vehicle_name}}</p>', dltTemplateId: null, senderId: null };
    const r = renderTemplate(t, { vehicle_name: '<b>Bus & Co</b>' });
    expect(r.body).toBe('<p>&#60;b&#62;Bus &#38; Co&#60;/b&#62;</p>');
    expect(r.subject).toBe('Alert: <b>Bus & Co</b>');
    expect(r.text).toBe('<b>Bus & Co</b>');
  });

  it('lists variables in order of first appearance', () => {
    expect(templateVariables('{{a}} {{b}} {{a}} {{c}}')).toEqual(['a', 'b', 'c']);
  });
});

describe('SMS / DLT', () => {
  const body = '{{company}}: {{vehicle_name}} overspeed {{speed}} at {{time}}. {{vehicle_name}} -Veetrax';

  it('generates DLT text with positional {#var#} slots', () => {
    expect(smsDltText(body)).toBe('{#var#}: {#var#} overspeed {#var#} at {#var#}. {#var#} -Veetrax');
    expect(smsVariableOrder(body)).toEqual(['company', 'vehicle_name', 'speed', 'time', 'vehicle_name']);
    expect(fillDltText('{#var#} and {#var#}', ['x', 'y'])).toBe('x and y');
  });

  it('renders identically via DLT slots and via placeholders', () => {
    const vars = { company: 'Demo', vehicle_name: 'Car 01', speed: '92 km/h', time: '10:05' };
    const sms = renderSms(body, vars);
    expect(sms.values).toEqual(['Demo', 'Car 01', '92 km/h', '10:05', 'Car 01']);
    expect(sms.text).toBe(renderText(body, vars).text);
    expect(sms.text).toBe('Demo: Car 01 overspeed 92 km/h at 10:05. Car 01 -Veetrax');
  });

  it('only approved SMS templates (with a DLT id) can be active/sent', () => {
    expect(smsActivationError({ channel: 'SMS', isActive: true, approvalStatus: 'APPROVED', dltTemplateId: 'DLT-1' })).toBeNull();
    expect(smsActivationError({ channel: 'SMS', isActive: true, approvalStatus: 'DRAFT', dltTemplateId: 'DLT-1' })).toMatch(/approval/);
    expect(smsActivationError({ channel: 'SMS', isActive: true, approvalStatus: 'PENDING', dltTemplateId: null })).toMatch(/approval/);
    expect(smsActivationError({ channel: 'SMS', isActive: false, approvalStatus: 'APPROVED', dltTemplateId: ' ' })).toMatch(/DLT template id/);
    expect(smsActivationError({ channel: 'SMS', isActive: false, approvalStatus: 'DRAFT', dltTemplateId: null })).toBeNull();
    expect(smsActivationError({ channel: 'EMAIL', isActive: true, approvalStatus: 'NA', dltTemplateId: null })).toBeNull();
    expect(isSendable({ channel: 'SMS', isActive: true, approvalStatus: 'REJECTED' })).toBe(false);
    expect(isSendable({ channel: 'SMS', isActive: true, approvalStatus: 'APPROVED' })).toBe(true);
    expect(isSendable({ channel: 'EMAIL', isActive: false, approvalStatus: 'NA' })).toBe(false);
  });

  it('counts SMS parts (GSM 160/153, Unicode 70/67)', () => {
    expect(smsParts('a'.repeat(160))).toEqual({ encoding: 'GSM', length: 160, parts: 1 });
    expect(smsParts('a'.repeat(161))).toEqual({ encoding: 'GSM', length: 161, parts: 2 });
    expect(smsParts('€'.repeat(80)).length).toBe(160); // extension chars count double
    expect(smsParts('வ'.repeat(70))).toEqual({ encoding: 'UNICODE', length: 70, parts: 1 });
    expect(smsParts('வ'.repeat(71)).parts).toBe(2);
  });
});

describe('system templates', () => {
  const all = systemTemplates();

  it('cover every alert type × EMAIL/SMS/PUSH plus SYSTEM_* purposes', () => {
    for (const t of ALERT_TYPES) {
      for (const channel of ['EMAIL', 'SMS', 'PUSH']) expect(all.some((x) => x.purpose === t.code && x.channel === channel)).toBe(true);
    }
    for (const p of ['SYSTEM_OTP', 'SYSTEM_PASSWORD_RESET', 'SYSTEM_WELCOME', 'SYSTEM_SCHEDULED_REPORT']) {
      expect(all.some((x) => x.purpose === p && x.channel === 'EMAIL')).toBe(true);
    }
    expect(all.some((x) => x.purpose === 'SYSTEM_OTP' && x.channel === 'SMS')).toBe(true);
  });

  it('use only known placeholders; SMS rows are approved with placeholder DLT ids', () => {
    for (const t of all) {
      const known = new Set(placeholdersFor(t.purpose));
      const unknown = templateVariables(`${t.subject ?? ''} ${t.body}`).filter((v) => !known.has(v));
      expect({ purpose: t.purpose, channel: t.channel, unknown }).toEqual({ purpose: t.purpose, channel: t.channel, unknown: [] });
      if (t.channel === 'SMS') {
        expect(t.approvalStatus).toBe('APPROVED');
        expect(t.dltTemplateId).toMatch(/^DLT-PENDING-\d+$/);
      }
    }
    expect(new Set(all.filter((t) => t.channel === 'SMS').map((t) => t.dltTemplateId)).size).toBe(all.filter((t) => t.channel === 'SMS').length);
  });

  it('renders an overspeed e-mail with alert variables', () => {
    const t = all.find((x) => x.purpose === 'OVERSPEED' && x.channel === 'EMAIL')!;
    const vars = alertVars(
      { type: 'OVERSPEED', severity: 'CRITICAL', occurredAt: new Date('2026-10-18T08:35:00Z'), lat: 13.06, lng: 80.25, address: null, data: { speedKph: 92.4, limitKph: 60, maxSpeedKph: 97 }, geofenceName: null },
      { objectName: 'Car 01', plateNumber: 'TN-08-CD-1037', branchName: 'Chennai', companyName: 'Demo Logistics', timezone: 'Asia/Kolkata' },
    );
    expect(vars.time).toBe('18 Oct 2026, 14:05');
    const r = renderTemplate({ id: 'x', channel: 'EMAIL', subject: t.subject, body: t.body, dltTemplateId: null, senderId: null }, vars);
    expect(r.subject).toBe('[CRITICAL] Overspeed: Car 01');
    expect(r.body).toContain('Demo Logistics');
    expect(r.body).toContain('92 km/h (limit 60 km/h, max 97 km/h)');
    expect(r.body).toContain('https://maps.google.com/?q=13.060000,80.250000');
    expect(r.body).toContain('View on map');
    expect(r.missing).toEqual([]);
  });
});
