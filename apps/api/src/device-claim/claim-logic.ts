import { randomInt } from 'node:crypto';

/** Unambiguous characters (no 0/O, 1/I/L) for codes printed on paper and typed by customers. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** "7K4Q2M" (stored); printed as "7K4-Q2M". */
export function newClaimCode(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]).join('');
}

/** Accepts "7k4-q2m", "7K4 Q2M" … → "7K4Q2M"; null when it can't be a claim code. */
export function normalizeClaimCode(input: string | null | undefined): string | null {
  const v = (input ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{6}$/.test(v) ? v : null;
}

export const formatClaimCode = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;

/** A bring-your-own tracker must have connected to our server this recently (proves the customer set it up). */
export const BYOD_SEEN_WITHIN_MS = 24 * 3600_000;

/** Device-server address shown in setup steps, per device-model protocol. */
export const TRACK_HOST = 'track.mintplus.co.in';
export const PROTOCOL_PORTS: Record<string, number> = { GT06: 5023, TELTONIKA: 5027, JT808: 6808, AIS140: 5030 };

/** Setup steps printed on the help sheet, by device-model protocol (wire colours follow the common Concox harness). */
export function setupSteps(protocol: string, modelName: string): string[] {
  const port = PROTOCOL_PORTS[protocol];
  const server = port ? `${TRACK_HOST}:${port}` : TRACK_HOST;
  switch (protocol) {
    case 'MOBILE':
      return [
        'Install the VeeTrax Tracker app on the phone (link from VeeTrax support).',
        'Open it, enter the phone\'s mobile number and the code you receive, then tap Start.',
        'Allow location "All the time" and turn off battery optimisation for the app when asked.',
      ];
    case 'TELTONIKA':
      return [
        'Wiring: red = +12/24 V (permanent), black = ground, white = ignition (DIN1).',
        `Server: ${server} (TCP). Set in Teltonika Configurator → GPRS, or by SMS "  setparam 2004:${TRACK_HOST};2005:${PROTOCOL_PORTS.TELTONIKA};2006:0".`,
        'Insert a data-enabled SIM; the green LED blinks once it is online.',
      ];
    case 'GT06':
      return [
        `Wiring (${modelName}): red = +12 V (permanent), black = ground, orange/yellow = ignition (ACC).`,
        `Server: ${server}. If it was set up elsewhere, send by SMS to the tracker SIM: SERVER,1,${TRACK_HOST},${PROTOCOL_PORTS.GT06},0#`,
        'Insert a data-enabled SIM (APN set automatically, or SMS: APN,<your apn>#). The GPS LED turns steady when it has a fix.',
      ];
    default:
      return [`Server: ${server}.`, 'Insert a data-enabled SIM and power the tracker on.'];
  }
}
