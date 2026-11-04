import type { LiveObject } from '@veetracer/shared';

/** A vehicle as another company sees it: marked shared, without the tracker's identity or the owner's branch. */
export const asSharedLive = (o: LiveObject): LiveObject => ({ ...o, shared: true, uniqueId: null, simNumber: null, branchId: null });
