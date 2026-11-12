import { TRANSPORT_ACCESS_ACTOR_FILTERS, type TransportAccessActorFilter, type TransportAccessLogQuery } from '@veetracer/shared';
import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import { ListQueryDto } from '../../common/list-query';

/** GET /transport/access-log: from / to are YYYY-MM-DD (UTC day) or full ISO instants (the web sends local day bounds). */
export class AccessLogQuery extends ListQueryDto implements TransportAccessLogQuery {
  @IsOptional() @IsIn(TRANSPORT_ACCESS_ACTOR_FILTERS) actor?: TransportAccessActorFilter;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}
