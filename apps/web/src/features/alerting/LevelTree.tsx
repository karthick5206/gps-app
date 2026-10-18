import type { AlertLevel, BranchDto, TrackedObjectDto, VehicleGroupDto } from '@veetracer/shared';
import { Building2Icon, ChevronDownIcon, LayersIcon, SearchIcon, TruckIcon, WarehouseIcon, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth, useMe } from '@/features/auth/auth-context';
import { useEntityOptions } from '@/features/masters/use-options';
import { cn } from '@/lib/utils';

export interface Target {
  level: AlertLevel;
  id: string;
  name: string;
  /** OBJECT only */
  object?: TrackedObjectDto;
}

const identity = <T,>(r: T) => r as unknown as { value: string; label: string };

function Section({ title, icon: Icon, count, children, defaultOpen = true }: { title: string; icon: LucideIcon; count?: number; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-2 py-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase hover:text-foreground">
        <Icon className="size-3.5" />
        <span className="flex-1 text-left">{title}</span>
        {count !== undefined && <span className="tabular-nums">{count}</span>}
        <ChevronDownIcon className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
      </button>
      {open && <ul className="space-y-0.5 pb-2">{children}</ul>}
    </div>
  );
}

function Node({ active, onClick, children, sub }: { active: boolean; onClick: () => void; children: ReactNode; sub?: string | null }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none',
          active ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {sub && <span className="max-w-[45%] truncate text-xs text-muted-foreground">{sub}</span>}
      </button>
    </li>
  );
}

/** Level tree: Company → Branches, Vehicle groups, Vehicles (server-side search). */
export function LevelTree({ value, onChange, className }: { value: Target | null; onChange: (t: Target) => void; className?: string }) {
  const me = useMe();
  const { can } = useAuth();
  const [filter, setFilter] = useState('');
  const [objectQ, setObjectQ] = useState('');
  const branches = useEntityOptions<BranchDto>('/branches', identity, { enabled: can('branches') });
  const groups = useEntityOptions<VehicleGroupDto>('/vehicle-groups', identity, { enabled: can('vehicle_groups') });
  const objects = useEntityOptions<TrackedObjectDto>('/objects', identity, { q: objectQ, enabled: can('objects') });
  const f = filter.trim().toLowerCase();
  const branchRows = branches.rows.filter((b) => !f || b.name.toLowerCase().includes(f));
  const groupRows = groups.rows.filter((g) => !f || g.name.toLowerCase().includes(f));
  const is = (level: AlertLevel, id: string) => value?.level === level && value.id === id;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="relative p-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter branches & groups" aria-label="Filter levels" className="h-8 pl-8" />
      </div>
      <nav aria-label="Settings level" className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        <ul>
          <Node active={is('COMPANY', me.company.id)} onClick={() => onChange({ level: 'COMPANY', id: me.company.id, name: me.company.name })}>
            <span className="flex items-center gap-2">
              <Building2Icon className="size-4 text-muted-foreground" />
              {me.company.name}
            </span>
          </Node>
        </ul>
        {can('branches') && (
          <Section title="Branches" icon={WarehouseIcon} count={branches.rows.length}>
            {branches.loading && !branches.rows.length && <Skeleton className="mx-2 h-6" />}
            {branchRows.map((b) => (
              <Node key={b.id} active={is('BRANCH', b.id)} onClick={() => onChange({ level: 'BRANCH', id: b.id, name: b.name })} sub={`${b.objectCount}`}>
                {b.name}
              </Node>
            ))}
            {!branches.loading && !branchRows.length && <li className="px-2.5 py-1 text-xs text-muted-foreground">No branches</li>}
          </Section>
        )}
        {can('vehicle_groups') && (
          <Section title="Vehicle groups" icon={LayersIcon} count={groups.rows.length}>
            {groupRows.map((g) => (
              <Node key={g.id} active={is('GROUP', g.id)} onClick={() => onChange({ level: 'GROUP', id: g.id, name: g.name })} sub={`${g.objects.length}`}>
                {g.name}
              </Node>
            ))}
            {!groups.loading && !groupRows.length && <li className="px-2.5 py-1 text-xs text-muted-foreground">No groups</li>}
          </Section>
        )}
        {can('objects') && (
          <Section title="Vehicles" icon={TruckIcon}>
            <li className="px-1 pb-1">
              <Input value={objectQ} onChange={(e) => setObjectQ(e.target.value)} placeholder="Search vehicles…" aria-label="Search vehicles" className="h-8" />
            </li>
            {objects.rows.slice(0, 100).map((o) => (
              <Node key={o.id} active={is('OBJECT', o.id)} onClick={() => onChange({ level: 'OBJECT', id: o.id, name: o.name, object: o })} sub={o.plateNumber}>
                {o.name}
              </Node>
            ))}
            {objects.loading && !objects.rows.length && <Skeleton className="mx-2 h-6" />}
            {!objects.loading && !objects.rows.length && <li className="px-2.5 py-1 text-xs text-muted-foreground">No vehicles</li>}
          </Section>
        )}
      </nav>
    </div>
  );
}
