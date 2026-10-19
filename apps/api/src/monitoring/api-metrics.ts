import { ApiMetrics } from '@veetracer/shared';

/** Numbers the API process reports in its heartbeat; updated in place by the live gateway and the offline sweeper. */
export const apiMetrics: ApiMetrics = { sockets: 0, sweeperLastRunAt: null };
