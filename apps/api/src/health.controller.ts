import { Controller, Get, HttpStatus, Optional, Res } from '@nestjs/common';
import type { RoutingReadinessKey } from '@veetracer/shared';
import type { Response } from 'express';
import { Public } from './access/decorators';
import { ReadinessReport, TrackingReport, HealthProbeService } from './monitoring/health-probe.service';
import { routingEnvMode } from './routing-switch/routing-switch';
import { RoutingSwitchService } from './routing-switch/routing-switch.service';

/**
 * GET /api/health/routing (v1.16): automatic route planning for the release health gate. `switch`: off = ETMS_ROUTING=off
 * (emergency switch), idle = platform switch off (nothing probed), on = platform switch on (readiness checked, 503 with
 * the failing item keys when not ready). Keys only, never details, hosts or tokens.
 */
export interface RoutingHealthReport {
  ok: boolean;
  status: 'OK' | 'DISABLED' | 'IDLE' | 'CRITICAL';
  switch: 'off' | 'idle' | 'on';
  failing: RoutingReadinessKey[];
}

/**
 * Public health endpoints (no auth; no customer data in the bodies).
 *
 *   GET /api/health/live      liveness: the API process answers. Always 200 while it runs.
 *   GET /api/health/ready     readiness: PostgreSQL and the cache are usable (SELECT 1; cache SET+GET). 503 when not.
 *   GET /api/health           same as /ready — the path the deploy scripts gate on. Since release 1.6 it returns 503
 *                             while PostgreSQL or the cache is down (it used to return 200 whenever the process ran).
 *   GET /api/health/routing   v1.16 automatic route planning: off / idle (switched off) / on (+ readiness, 503 if not ready).
 *   GET /api/health/tracking  end-to-end GPS pipeline: gateway → stream → processor → PostgreSQL. 503 on any CRITICAL
 *                             issue (cache down, no gateway/processor, positions refused, nothing persisted while
 *                             devices are connected, processor lag over the critical threshold); 200 with
 *                             status WARN for warnings.
 *
 * Every body has `ok` (boolean) and `status`, so `{ ok: true }` consumers keep working.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly probe: HealthProbeService,
    @Optional() private readonly routingSwitch: RoutingSwitchService | null = null,
  ) {}

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

  @Public() @Get('routing')
  async routing(@Res({ passthrough: true }) res: Response): Promise<RoutingHealthReport> {
    if (routingEnvMode() === 'off' || !this.routingSwitch) return { ok: true, status: 'DISABLED', switch: 'off', failing: [] };
    if (!(await this.routingSwitch.platformOn())) return { ok: true, status: 'IDLE', switch: 'idle', failing: [] };
    const r = await this.routingSwitch.readinessNow();
    if (!r.ready) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { ok: r.ready, status: r.ready ? 'OK' : 'CRITICAL', switch: 'on', failing: r.checks.filter((c) => !c.ok).map((c) => c.key) };
  }

  @Public() @Get('tracking')
  async tracking(@Res({ passthrough: true }) res: Response): Promise<TrackingReport> {
    const report = await this.probe.tracking();
    if (report.status === 'CRITICAL') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
