import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { CommandsService } from './commands.service';

/** Checked this often; a camera that is connected and not yet set up gets the missing commands. */
const SWEEP_MS = 60_000;
/** A command already sent within this window (and not answered yet) is not sent again. */
const RESEND_AFTER_MS = 10 * 60_000;
/** Only one API instance sweeps at a time. */
const LOCK_KEY = 'vt:dvr-auto-setup:lock';

/** Commands from `JIMI_SETUP_COMMANDS` (`|`-separated), e.g. `UPLOAD,http://…/dvr/upload|RSERVICE,host:1935/live`. */
export function setupCommands(raw = process.env.JIMI_SETUP_COMMANDS ?? ''): string[] {
  return raw
    .split('|')
    .map((c) => c.trim())
    .filter((c) => /^[A-Z_]+,\S+$/i.test(c));
}

/**
 * Automatic set-up of Jimi dashcams (JC400 / JC261: device model protocol GT06 with capability `video`): every camera
 * that is connected and linked to a vehicle gets each `JIMI_SETUP_COMMANDS` command (clip upload server, RTMP live
 * video server) until it has acknowledged it once. Off when the setting is empty (e.g. on servers without MediaMTX).
 * The TCP server itself must still be set by SMS (`SERVER,…`): until then the camera never reaches this platform.
 */
@Injectable()
export class DvrAutoSetupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DvrAutoSetup');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly commands: CommandsService,
  ) {}

  onModuleInit(): void {
    if (!setupCommands().length || process.env.NODE_ENV === 'test') return;
    this.logger.log(`Jimi dashcam auto set-up on: ${setupCommands().join(' | ')}`);
    this.timer = setInterval(() => void this.sweep().catch((e: Error) => this.logger.warn(`Sweep failed: ${e.message}`)), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass: sends the commands each connected camera still lacks. Returns how many were sent. */
  async sweep(commands = setupCommands(), now = Date.now()): Promise<number> {
    if (!commands.length || this.running) return 0;
    if ((await this.redis.client.set(LOCK_KEY, '1', 'PX', SWEEP_MS - 5_000, 'NX')) !== 'OK') return 0;
    this.running = true;
    let sent = 0;
    try {
      const cameras = await this.prisma.device.findMany({
        where: { isActive: true, companyId: { not: null }, model: { protocol: 'GT06', capabilities: { has: 'video' } }, assignments: { some: { toTime: null } } },
        select: { id: true, uniqueId: true, companyId: true, assignments: { where: { toTime: null }, select: { objectId: true }, take: 1 } },
      });
      for (const cam of cameras) {
        if (!(await this.redis.client.get(RedisKeys.connection(cam.uniqueId)))) continue;
        const history = await this.prisma.deviceCommand.findMany({
          where: { deviceId: cam.id, payload: { in: commands } },
          select: { payload: true, status: true, createdAt: true },
        });
        for (const text of commands) {
          const rows = history.filter((h) => h.payload === text);
          if (rows.some((h) => h.status === 'ACKED')) continue;
          if (rows.some((h) => (h.status === 'SENT' || h.status === 'QUEUED') && now - h.createdAt.getTime() < RESEND_AFTER_MS)) continue;
          if (await this.commands.sendSystem({ companyId: cam.companyId!, objectId: cam.assignments[0].objectId, deviceId: cam.id, uniqueId: cam.uniqueId }, text)) sent++;
        }
      }
    } finally {
      this.running = false;
    }
    return sent;
  }
}
