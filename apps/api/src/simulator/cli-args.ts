/** Minimal `--name value` parser for the dev CLIs. */
export function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.set(key.slice(2), 'true');
    else {
      args.set(key.slice(2), next);
      i++;
    }
  }
  return args;
}

export function numberArg(args: Map<string, string>, name: string, fallback: number): number {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

export const DEFAULT_IMEI_START = 868120000000001;

/** Sequential 15-digit IMEIs starting at `start`. */
export function imeiAt(start: number, index: number): string {
  return String(start + index).padStart(15, '0');
}
