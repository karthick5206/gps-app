import { Logger } from '@nestjs/common';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_PER_KEY_PER_MIN = 5;
const MAX_GLOBAL_PER_MIN = 120;
const MAX_LOGGED_BYTES = 2048;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface UnparsedLogOptions {
  /** Directory for `unparsed-<protocol>.log` (JSON lines). Null disables file capture (tests). */
  dir: string | null;
}

/** printable ASCII (plus CR/LF/TAB)? then show as text, else hex. */
function isText(raw: Buffer): boolean {
  for (const b of raw) if ((b < 0x20 || b > 0x7e) && b !== 0x0d && b !== 0x0a && b !== 0x09) return false;
  return true;
}

/**
 * Rate-limited capture of packets a decoder could not parse: one log line (stdout → gateway log) plus a JSON line in
 * `<dir>/unparsed-<protocol>.log` with the raw text/hex, so we can adapt decoders to new vendor variants
 * (notably iTriangle AIS-140) from real samples. At most 5 lines per device/remote per minute and 120 per minute overall.
 */
export class UnparsedLog {
  private readonly logger = new Logger('Unparsed');
  private readonly counts = new Map<string, number>();
  private global = 0;
  private windowStart = Date.now();
  private suppressed = 0;
  private dirReady: Promise<void> | null = null;

  constructor(private readonly options: UnparsedLogOptions) {}

  record(protocol: string, reason: string, raw: Buffer, who: string): void {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      if (this.suppressed) this.logger.warn(`${this.suppressed} unparsed packet log lines suppressed in the last minute`);
      this.counts.clear();
      this.global = 0;
      this.suppressed = 0;
      this.windowStart = now;
    }
    const key = `${protocol}:${who}`;
    const n = this.counts.get(key) ?? 0;
    if (n >= MAX_PER_KEY_PER_MIN || this.global >= MAX_GLOBAL_PER_MIN) {
      this.suppressed++;
      return;
    }
    this.counts.set(key, n + 1);
    this.global++;

    const slice = raw.subarray(0, MAX_LOGGED_BYTES);
    const text = isText(slice);
    const shown = text ? slice.toString('latin1').replace(/\r/g, '\\r').replace(/\n/g, '\\n') : slice.toString('hex');
    const truncated = raw.length > MAX_LOGGED_BYTES ? ` (+${raw.length - MAX_LOGGED_BYTES} bytes)` : '';
    this.logger.warn(`[${protocol}] ${who}: ${reason} — ${text ? 'text' : 'hex'}: ${shown}${truncated}`);
    if (this.options.dir) void this.append(protocol, { at: new Date(now).toISOString(), protocol, who, reason, length: raw.length, text: text ? shown : undefined, hex: raw.subarray(0, MAX_LOGGED_BYTES).toString('hex') });
  }

  private async append(protocol: string, entry: Record<string, unknown>): Promise<void> {
    const dir = this.options.dir!;
    try {
      this.dirReady ??= mkdir(dir, { recursive: true }).then(() => undefined);
      await this.dirReady;
      const file = join(dir, `unparsed-${protocol}.log`);
      const size = await stat(file).then((s) => s.size).catch(() => 0);
      if (size > MAX_FILE_BYTES) await rename(file, `${file}.1`).catch(() => undefined);
      await appendFile(file, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      this.logger.error(`Could not write unparsed packet log: ${(error as Error).message}`);
    }
  }
}

/** Simple per-key rate limiter for warnings (key → at most `perMinute` lines/minute). */
export class RateLimitedWarn {
  private readonly logger: Logger;
  private readonly seen = new Map<string, { at: number; n: number }>();

  constructor(context: string, private readonly perMinute = 3) {
    this.logger = new Logger(context);
  }

  warn(key: string, message: string): void {
    const now = Date.now();
    const s = this.seen.get(key);
    if (!s || now - s.at >= 60_000) {
      if (this.seen.size > 10_000) this.seen.clear();
      this.seen.set(key, { at: now, n: 1 });
    } else if (s.n >= this.perMinute) return;
    else s.n++;
    this.logger.warn(message);
  }
}
