/**
 * v1.8 label of an ETMS stop (E3 security review H1): a company site keeps its name; a passenger's personal point (or
 * any stop not linked to a place) is "Stop n", never its address label.
 */
export function etmsStopLabel(s: { seq: number; name: string; profileId?: string | null; poiId?: string | null }): string {
  return s.poiId && !s.profileId ? s.name : `Stop ${s.seq + 1}`;
}
