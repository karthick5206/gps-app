import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { GeocodingService } from '../geocoding/geocoding.service';

const CONCURRENCY = 3;
const RETRY_AFTER_MS = 6 * 3600_000;

/**
 * Fills Trip.startAddress/endAddress and Stop.address in the background, newest first, with bounded concurrency.
 * Coordinates that returned no address are not retried for a few hours.
 */
export class AddressFiller {
  private readonly logger = new Logger('Summarizer');
  private running = false;
  private readonly failed = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly geocoder: GeocodingService,
    private readonly perRun = Number(process.env.SUMMARIZER_ADDRESSES_PER_RUN ?? 60),
  ) {}

  /** Starts a fill pass unless one is already running; never throws. */
  kick(): void {
    if (this.running || !this.geocoder.enabled) return;
    this.running = true;
    void this.fill()
      .catch((error: Error) => this.logger.warn(`Address fill failed: ${error.message}`))
      .finally(() => (this.running = false));
  }

  private skip(lat: number, lng: number): boolean {
    const at = this.failed.get(`${lat.toFixed(4)},${lng.toFixed(4)}`);
    return at !== undefined && Date.now() - at < RETRY_AFTER_MS;
  }

  private async resolve(lat: number, lng: number): Promise<string | null> {
    if (this.skip(lat, lng)) return null;
    const address = await this.geocoder.reverse(lat, lng);
    if (!address) this.failed.set(`${lat.toFixed(4)},${lng.toFixed(4)}`, Date.now());
    return address;
  }

  private async fill(): Promise<void> {
    const trips = await this.prisma.trip.findMany({
      where: { OR: [{ startAddress: null }, { endAddress: null }] },
      orderBy: { startTime: 'desc' },
      take: this.perRun,
      select: { id: true, startLat: true, startLng: true, endLat: true, endLng: true, startAddress: true, endAddress: true },
    });
    const stops = await this.prisma.stop.findMany({
      where: { address: null },
      orderBy: { startTime: 'desc' },
      take: this.perRun,
      select: { id: true, lat: true, lng: true },
    });
    const jobs: (() => Promise<void>)[] = [];
    for (const t of trips) {
      jobs.push(async () => {
        const startAddress = t.startAddress ?? (await this.resolve(t.startLat, t.startLng));
        const endAddress = t.endAddress ?? (await this.resolve(t.endLat, t.endLng));
        if (startAddress !== t.startAddress || endAddress !== t.endAddress) {
          await this.prisma.trip.updateMany({ where: { id: t.id }, data: { startAddress, endAddress } });
        }
      });
    }
    for (const s of stops) {
      jobs.push(async () => {
        const address = await this.resolve(s.lat, s.lng);
        if (address) await this.prisma.stop.updateMany({ where: { id: s.id }, data: { address } });
      });
    }
    let next = 0;
    let filled = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await job();
        filled++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (filled) this.logger.log(`Address fill pass: ${filled} trips/stops checked`);
  }
}
