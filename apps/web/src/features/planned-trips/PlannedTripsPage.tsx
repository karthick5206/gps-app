import { PageHeader } from '@/components/page-header';

/** Tracking → Planned trips. Placeholder until the trip list and detail are built (stage 3, docs/routes-trips/SPEC.md §4.5). */
export function PlannedTripsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Planned trips" description="Trips planned on a route, tracked against their stops and times." />
    </div>
  );
}
