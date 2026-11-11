import { PageHeader } from '@/components/page-header';

/** Masters → Routes. Placeholder until the route editor is built (stage 3, docs/routes-trips/SPEC.md §4.5). */
export function RoutesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Routes" description="Reusable routes with ordered stops, road path and schedules." />
    </div>
  );
}
