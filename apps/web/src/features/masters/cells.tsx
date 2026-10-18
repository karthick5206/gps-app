import { Badge } from '@/components/ui/badge';
import { formatDateTime, relativeTime } from '@/lib/format';

export function ActiveBadge({ active }: { active: boolean }) {
  return <Badge variant={active ? 'success' : 'muted'}>{active ? 'Active' : 'Inactive'}</Badge>;
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

export function Dash({ value }: { value: string | number | null | undefined }) {
  return value === null || value === undefined || value === '' ? <Muted>—</Muted> : <>{value}</>;
}

export function DateCell({ value, relative = false }: { value: string | null | undefined; relative?: boolean }) {
  if (!value) return <Muted>—</Muted>;
  return <span title={formatDateTime(value)}>{relative ? relativeTime(value) : formatDateTime(value)}</span>;
}

/** Comma list of related names, collapsing after `max`. */
export function NameList({ items, max = 2 }: { items: { id: string; name: string }[]; max?: number }) {
  if (!items.length) return <Muted>—</Muted>;
  const shown = items.slice(0, max);
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={items.map((i) => i.name).join(', ')}>
      {shown.map((i) => (
        <Badge key={i.id} variant="secondary">
          {i.name}
        </Badge>
      ))}
      {items.length > max && <span className="text-xs text-muted-foreground">+{items.length - max}</span>}
    </span>
  );
}
