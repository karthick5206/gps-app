import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from './access/decorators';
import { ReadinessReport, TrackingReport, HealthProbeService } from './monitoring/health-probe.service';

/**
 * Public health endpoints (no auth; no customer data in the bodies).
 *
 *   GET /api/health/live      liveness: the API process answers. Always 200 while it runs.
 *   GET /api/health/ready     readiness: PostgreSQL and the cache are usable (SELECT 1; cache SET+GET). 503 when not.
 *   GET /api/health           same as /ready — the path the deploy scripts gate on. Since release 1.6 it returns 503
 *                             while PostgreSQL or the cache is down (it used to return 200 whenever the process ran).
 *   GET /api/health/tracking  end-to-end GPS pipeline: gateway → stream → processor → PostgreSQL. 503 on any CRITICAL
 *                             issue (cache down, no gateway/processor, positions refused, nothing persisted while
 *                             devices are connected, processor lag over the critical threshold); 200 with
 *                             status WARN for warnings.
 *
 * Every body has `ok` (boolean) and `status`, so `{ ok: true }` consumers keep working.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly probe: HealthProbeService) {}

  @Public() @Get('live')
  live(): { ok: true; status: 'OK'; uptimeSec: number } {
    return { ok: true, status: 'OK', uptimeSec: Math.round(process.uptime()) };
  }

  @Public() @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    return this.ready(res);
  }

  @Public() @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.probe.readiness();
    if (!report.ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  @Public() @Get('tracking')
  async tracking(@Res({ passthrough: true }) res: Response): Promise<TrackingReport> {
    const report = await this.probe.tracking();
    if (report.status === 'CRITICAL') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
