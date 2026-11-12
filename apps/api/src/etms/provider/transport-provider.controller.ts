import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { TransportCustomerContextDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../../access/decorators';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { AccessLogQuery } from './transport-provider.dto';
import { TransportProviderService } from './transport-provider.service';

/**
 * E1b provider side (doc 12 §6). Company add-on `etms` (404 when off).
 * - GET /transport/context: the customer picker (doc 07 §2.5), for any transport back-office view grant. The
 *   X-Transport-Customer header is validated by TransportFeatureGuard before this runs (404 for an id the caller may
 *   not act for), so the answer also confirms the selection.
 * - GET /transport/access-log: the company's sensitive-access log (doc 10 §2.2 item 8): who outside the company
 *   (providers, VeeTrax support) read its passenger data. etms_partners:view + whole-company scope.
 */
@Controller('transport')
@UseGuards(TransportFeatureGuard)
export class TransportProviderController {
  constructor(private readonly service: TransportProviderService) {}

  @Get('context')
  @RequireAnyPermission(['etms_dashboard', 'view'], ['etms_partners', 'view'], ['etms_passengers', 'view'], ['etms_schedules', 'view'], ['etms_bookings', 'view'], ['etms_dispatch', 'view'])
  context(@Auth() ctx: AuthContext): Promise<TransportCustomerContextDto> {
    return this.service.context(ctx);
  }

  @Get('access-log') @RequirePermission('etms_partners', 'view')
  accessLog(@Auth() ctx: AuthContext, @Query() query: AccessLogQuery) {
    return this.service.accessLog(ctx, query);
  }
}
