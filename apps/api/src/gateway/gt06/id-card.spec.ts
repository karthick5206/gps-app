import { decodeFrames, decodeMessage, requiresAck, terminalInfoAlarm } from './codec';
import { alarmName } from './decoder';

/** Concox ID card tracker 861896070025993 (SOS button, no ignition wire), captured 2026-10-20. */
const SOS_ALARM = '787825161a0a13132423c4016449cc089a5d2400152b090194281b730058e1200402000200090bc50d0a';
const UNKNOWN_1F = '78780d1f1a0a13132d1500020003e99a0d0a';

const frame = (hex: string) => {
  const { frames } = decodeFrames(Buffer.from(hex, 'hex'));
  expect(frames).toHaveLength(1);
  return frames[0];
};

describe('Concox ID card tracker', () => {
  it('reads SOS from the terminal-information bits when the alarm byte is 0', () => {
    const m = decodeMessage(frame(SOS_ALARM));
    expect(m.type).toBe('alarm');
    if (m.type !== 'alarm') return;
    expect(m.alarm).toBe(0x01);
    expect(alarmName(m.alarm)).toBe('sos');
    // The SOS still carries its location.
    expect(m.fix.lat).toBeCloseTo(12.972, 2);
    expect(m.fix.lng).toBeCloseTo(80.186, 2);
  });

  it('maps the terminal-information alarm bits', () => {
    expect(terminalInfoAlarm(0x20)).toBe(0x01); // 100 SOS
    expect(terminalInfoAlarm(0x18)).toBe(0x0e); // 011 low battery
    expect(terminalInfoAlarm(0x10)).toBe(0x02); // 010 power cut
    expect(terminalInfoAlarm(0x08)).toBe(0x03); // 001 shock
    expect(terminalInfoAlarm(0x46)).toBe(0); // GPS on, charging, ACC: no alarm
  });

  it('acknowledges unknown packets so the device stops resending them', () => {
    const m = decodeMessage(frame(UNKNOWN_1F));
    expect(m.type).toBe('unknown');
    expect(requiresAck(m)).toBe(true);
  });
});
