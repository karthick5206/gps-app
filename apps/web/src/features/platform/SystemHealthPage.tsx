import { useMutation } from '@tanstack/react-query';
import type { DatabaseDto, HealthEvent, HealthIssue, HostDto, PortDto, ProcessInstanceDto, ProcessRoleDto, QueueDto, SystemHealthDto, ThroughputPoint, ValkeyDto } from '@veetracer/shared';
import { ActivityIcon, AlertTriangleIcon, CheckCircle2Icon, CircleDotIcon, DatabaseIcon, HardDriveIcon, MailIcon, OctagonAlertIcon, RefreshCwIcon, SendIcon, ServerIcon, ZapIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, formatNumber, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatBytes, fraction, overallLabel, statusVariant, type Status } from './system-health/health-format';
import { LineChart, type LineSeries } from './system-health/LineChart';
import { useSystemHealth, useSystemHealthSettings } from './system-health/use-system-health';

const STATUS_LABEL: Record<Status, string> = { OK: 'OK', WARN: 'Warning', CRITICAL: 'Critical' };
const STATUS_ICON = { OK: CheckCircle2Icon, WARN: AlertTriangleIcon, CRITICAL: OctagonAlertIcon } as const;
const STATUS_TEXT: Record<Status, string> = { OK: 'text-success', WARN: 'text-warning', CRITICAL: 'text-destructive' };
const STATUS_BAR: Record<Status, string> = { OK: 'bg-success', WARN: 'bg-warning', CRITICAL: 'bg-destructive' };

function StatusBadge({ status, label }: { status: Status; label?: string }) {
  const { t } = useTranslation();
  const Icon = STATUS_ICON[status];
  return (
    <Badge variant={statusVariant(status)}>
      <Icon aria-hidden /> {t(label ?? STATUS_LABEL[status])}
    </Badge>
  );
}

function Section({ title, icon: Icon, status, children, className, action }: { title: string; icon: typeof ServerIcon; status?: Status; children: ReactNode; className?: string; action?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Card className={cn('min-w-0 p-4', className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{t(title)}</span>
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          {status && <StatusBadge status={status} />}
        </div>
      </div>
      {children}
    </Card>
  );
}

/** Label / value row inside a card. */
function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground" title={hint ? t(hint) : undefined}>
        {t(label)}
      </span>
      <span className="min-w-0 truncate text-right font-medium tabular-nums">{children}</span>
    </div>
  );
}

/** Usage bar; turns amber/red with the status of the thing it measures. */
function Meter({ value, status, label }: { value: number | null; status: Status; label: string }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)}>
      {value !== null && <div className={cn('h-full rounded-full transition-[width] duration-500', status === 'OK' ? 'bg-primary' : STATUS_BAR[status])} style={{ width: `${Math.max(value * 100, value > 0 ? 1 : 0)}%` }} />}
    </div>
  );
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : formatNumber(v));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);
const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

// ── overview ─────────────────────────────────────────────────────────────────

function OverallBanner({ data, fetching }: { data: SystemHealthDto; fetching: boolean }) {
  const { t } = useTranslation();
  const Icon = STATUS_ICON[data.status];
  const crit = data.issues.filter((i) => i.severity === 'CRITICAL').length;
  const warn = data.issues.length - crit;
  return (
    <Card
      className={cn(
        'flex flex-col gap-3 border-l-4 p-4 sm:flex-row sm:items-center sm:justify-between',
        data.status === 'OK' && 'border-l-success',
        data.status === 'WARN' && 'border-l-warning bg-warning/5',
        data.status === 'CRITICAL' && 'border-l-destructive bg-destructive/5',
      )}
      role="status"
    >
      <div className="flex items-center gap-3">
        <Icon className={cn('size-9 shrink-0', STATUS_TEXT[data.status])} aria-hidden />
        <div>
          <p className={cn('text-xl font-semibold', STATUS_TEXT[data.status])}>{t(overallLabel(data.status))}</p>
          <p className="text-sm text-muted-foreground">
            {data.issues.length
              ? t('{{crit}} critical, {{warn}} warning issue(s) active', { crit, warn })
              : t('All processes, ports, queues and stores are healthy.')}
          </p>
        </div>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <RefreshCwIcon className={cn('size-3.5', fetching && 'animate-spin')} aria-hidden />
        {t('Updated {{time}}', { time: relativeTime(data.generatedAt) })} · {t('every 5 s')}
      </p>
    </Card>
  );
}

function IssuesList({ issues }: { issues: HealthIssue[] }) {
  const { t } = useTranslation();
  return (
    <Section title="Active issues" icon={AlertTriangleIcon} action={<Badge variant={issues.length ? 'destructive' : 'muted'}>{issues.length}</Badge>}>
      {!issues.length ? (
        <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <CheckCircle2Icon className="size-4 text-success" aria-hidden /> {t('No active issues.')}
        </p>
      ) : (
        <ul className="max-h-80 divide-y overflow-y-auto">
          {issues.map((i) => (
            <li key={i.id} className="flex gap-3 py-2.5">
              <div className="pt-0.5">
                <StatusBadge status={i.severity} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium first-letter:uppercase">{i.check}</p>
                <p className="text-sm break-words text-muted-foreground">{i.message}</p>
                <p className="mt-0.5 text-xs text-muted-foreground" title={formatDateTime(i.since)}>
                  {t('Since {{time}}', { time: relativeTime(i.since) })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function EventsTimeline({ events }: { events: HealthEvent[] }) {
  const { t } = useTranslation();
  return (
    <Section title="Recent events" icon={ActivityIcon}>
      {!events.length ? (
        <p className="py-6 text-sm text-muted-foreground">{t('No status changes recorded yet.')}</p>
      ) : (
        <ol className="max-h-80 space-y-0 overflow-y-auto">
          {events.map((e, k) => (
            <li key={`${e.at}-${e.id}-${k}`} className="relative flex gap-3 pb-3 pl-1">
              <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', STATUS_BAR[e.to])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-medium first-letter:uppercase">{e.check}</span>{' '}
                  <span className="text-xs text-muted-foreground">
                    {t(STATUS_LABEL[e.from])} → {t(STATUS_LABEL[e.to])}
                  </span>
                </p>
                <p className="truncate text-xs text-muted-foreground" title={e.message}>
                  {e.message}
                </p>
              </div>
              <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={e.at} title={formatDateTime(e.at)}>
                {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

// ── charts ───────────────────────────────────────────────────────────────────

const THROUGHPUT: LineSeries<ThroughputPoint>[] = [
  { key: 'received', label: 'Received', color: 'var(--muted-foreground)', dashed: true, value: (p) => p.received },
  { key: 'processed', label: 'Processed', color: 'var(--primary)', value: (p) => p.processed },
];
const LAG: LineSeries<ThroughputPoint>[] = [{ key: 'backlog', label: 'Waiting', color: 'var(--primary)', area: true, value: (p) => p.backlog ?? p.lag }];

function Charts({ points }: { points: ThroughputPoint[] }) {
  const { t } = useTranslation();
  const perTen = (v: number) => t('{{n}} / 10 s', { n: formatNumber(Math.round(v)) });
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="min-w-0 p-4">
        <LineChart data={points} series={THROUGHPUT} title={t('Throughput — positions per 10 s (last hour)')} format={perTen} empty={t('Collecting samples…')} />
      </Card>
      <Card className="min-w-0 p-4">
        <LineChart data={points} series={LAG} title={t('Queue lag — positions waiting for the processor')} format={(v) => formatNumber(Math.round(v))} empty={t('Collecting samples…')} />
      </Card>
    </div>
  );
}

// ── queues and ports ─────────────────────────────────────────────────────────

function QueueCard({ q }: { q: QueueDto }) {
  const { t } = useTranslation();
  const backlogShare = fraction(q.backlog, q.maxLength);
  return (
    <Section title={q.key} icon={ZapIcon} status={q.status}>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{t('Length / cap')}</span>
        <span className="font-medium tabular-nums">
          {n(q.length)} / {n(q.maxLength)}
        </span>
      </div>
      <Meter value={fraction(q.length, q.maxLength)} status="OK" label={t('Stream length')} />
      <p className="mt-1 text-xs text-muted-foreground">{t('Processed entries stay in the stream until the cap trims the oldest; only unprocessed ones matter.')}</p>
      <div className="mt-3 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <Row label="Lag (not delivered)">{n(q.lag)}</Row>
        <Row label="Pending (unacknowledged)">{n(q.pending)}</Row>
        <Row label="Backlog share of cap">{backlogShare === null ? '—' : `${(backlogShare * 100).toFixed(2)}%`}</Row>
        <Row label="Oldest pending">{q.oldestPendingAgeSec === null ? '—' : formatDuration(q.oldestPendingAgeSec)}</Row>
        <Row label="Input rate">{q.inputPerSec === null ? '—' : `${formatNumber(q.inputPerSec)}/s`}</Row>
        <Row label="Buffer time left" hint="Time until unprocessed entries would be trimmed at the current net fill rate">
          {q.bufferSecondsLeft === null ? t('not filling') : formatDuration(q.bufferSecondsLeft)}
        </Row>
      </div>
      <div className="mt-3">
        <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">{t('Consumers')}</p>
        {!q.consumers.length ? (
          <p className="text-sm text-destructive">{t('No consumers in group {{group}}', { group: q.group })}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {q.consumers.map((c) => (
              <li key={c.name} className="flex justify-between gap-3">
                <span className="truncate font-mono text-xs">{c.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {t('{{pending}} pending · idle {{idle}}', { pending: formatNumber(c.pending), idle: formatDuration(c.idleMs / 1000) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function PortsTable({ ports }: { ports: PortDto[] }) {
  const { t } = useTranslation();
  return (
    <Section title="Device ports" icon={CircleDotIcon} status={ports.reduce<Status>((w, p) => (p.status === 'CRITICAL' || w === 'CRITICAL' ? 'CRITICAL' : p.status === 'WARN' ? 'WARN' : w), 'OK')}>
      <Table containerClassName="-mx-4 w-auto">
        <TableHeader>
          <TableRow>
            <TableHead>{t('Protocol')}</TableHead>
            <TableHead>{t('Port')}</TableHead>
            <TableHead>{t('Listening')}</TableHead>
            <TableHead className="text-right">{t('Connections')}</TableHead>
            <TableHead className="text-right">{t('Msg/s')}</TableHead>
            <TableHead className="text-right">{t('Dropped')}</TableHead>
            <TableHead className="text-right">{t('Errors')}</TableHead>
            <TableHead className="text-right">{t('Enqueue failures')}</TableHead>
            <TableHead>{t('Last packet')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ports.map((p) => (
            <TableRow key={`${p.protocol}:${p.port}`}>
              <TableCell className="font-medium">{p.protocol}</TableCell>
              <TableCell className="font-mono text-xs">{p.port}</TableCell>
              <TableCell>
                {p.listening ? (
                  <StatusBadge status="OK" label="Listening" />
                ) : (
                  <Tooltip content={p.error ?? t('Not listening')}>
                    <span>
                      <StatusBadge status="CRITICAL" label="Not listening" />
                    </span>
                  </Tooltip>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{n(p.connections)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(p.positionsPerSec)}</TableCell>
              <TableCell className="text-right tabular-nums">{n(p.dropped)}</TableCell>
              <TableCell className="text-right tabular-nums">{n(p.errors)}</TableCell>
              <TableCell className={cn('text-right tabular-nums', p.enqueueFailures > 0 && 'font-semibold text-destructive')}>{n(p.enqueueFailures)}</TableCell>
              <TableCell className="text-muted-foreground" title={formatDateTime(p.lastPacketAt)}>
                {relativeTime(p.lastPacketAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

// ── processes ────────────────────────────────────────────────────────────────

function ProcessesTable({ groups }: { groups: ProcessRoleDto[] }) {
  const { t } = useTranslation();
  type ProcessRow = { group: ProcessRoleDto; p: ProcessInstanceDto | null };
  const rows = groups.flatMap((g): ProcessRow[] => (g.instances.length ? g.instances.map((p) => ({ group: g, p })) : [{ group: g, p: null }]));
  return (
    <Section title="Processes" icon={ServerIcon} status={rows.reduce<Status>((w, r) => (r.group.status === 'CRITICAL' || w === 'CRITICAL' ? 'CRITICAL' : r.group.status === 'WARN' ? 'WARN' : w), 'OK')}>
      <Table containerClassName="-mx-4 w-auto">
        <TableHeader>
          <TableRow>
            <TableHead>{t('Role')}</TableHead>
            <TableHead>{t('Instance')}</TableHead>
            <TableHead>{t('Status')}</TableHead>
            <TableHead className="text-right">{t('Uptime')}</TableHead>
            <TableHead className="text-right">{t('CPU')}</TableHead>
            <TableHead className="text-right">{t('Memory')}</TableHead>
            <TableHead className="text-right">{t('Event loop p99')}</TableHead>
            <TableHead>{t('Version')}</TableHead>
            <TableHead>{t('Last heartbeat')}</TableHead>
            <TableHead>{t('Details')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ group, p }) =>
            p ? (
              <TableRow key={`${p.role}:${p.instanceId}`} className={cn(p.stale && 'bg-destructive/5')}>
                <TableCell className="font-medium">{t(roleLabel(p.role))}</TableCell>
                <TableCell>
                  <span className="font-mono text-xs">{p.instanceId}</span>
                  <span className="block text-xs text-muted-foreground">
                    {p.host} · pid {p.pid}
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={p.status} label={p.stale ? 'Stale' : undefined} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatDuration(p.uptimeSec)}</TableCell>
                <TableCell className="text-right tabular-nums">{p.cpuPercent.toFixed(1)}%</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatBytes(p.rssBytes)}
                  <span className="block text-xs text-muted-foreground">
                    {t('heap')} {formatBytes(p.heapUsed)}
                  </span>
                </TableCell>
                <TableCell className={cn('text-right tabular-nums', p.status !== 'OK' && p.eventLoopLagMs > 200 && 'text-warning')}>{p.eventLoopLagMs.toFixed(1)} ms</TableCell>
                <TableCell className="font-mono text-xs">{p.version}</TableCell>
                <TableCell className={cn(p.stale ? 'font-semibold text-destructive' : 'text-muted-foreground')} title={formatDateTime(p.at)}>
                  {t('{{n}} s ago', { n: Math.round(p.ageSec) })}
                </TableCell>
                <TableCell className="max-w-72 text-xs whitespace-normal text-muted-foreground">
                  <RoleDetails p={p} />
                </TableCell>
              </TableRow>
            ) : (
              <TableRow key={group.role} className="bg-destructive/5">
                <TableCell className="font-medium">{t(roleLabel(group.role))}</TableCell>
                <TableCell className="text-muted-foreground">—</TableCell>
                <TableCell>
                  <StatusBadge status={group.status === 'OK' ? 'WARN' : group.status} label="Not running" />
                </TableCell>
                <TableCell colSpan={7} className="text-sm text-muted-foreground">
                  {t('No heartbeat from any {{role}} instance.', { role: group.role })}
                </TableCell>
              </TableRow>
            ),
          )}
        </TableBody>
      </Table>
    </Section>
  );
}

function RoleDetails({ p }: { p: ProcessInstanceDto }) {
  const { t } = useTranslation();
  const m = p.metrics as unknown as Record<string, unknown>;
  switch (p.role) {
    case 'processor': {
      const err = m.lastDbError as { message: string; at: string } | null;
      return (
        <>
          {t('{{rate}}/s · batch {{ms}} ms · DB errors {{errors}}', { rate: formatNumber(m.processedPerSec as number), ms: m.avgBatchMs as number, errors: formatNumber(m.dbErrors as number) })}
          {(m.backoffMs as number) > 0 && <span className="block font-medium text-destructive">{t('Backing off {{s}} s', { s: (m.backoffMs as number) / 1000 })}</span>}
          {err && (
            <span className="block truncate" title={err.message}>
              {t('Last DB error {{time}}', { time: relativeTime(err.at) })}: {err.message}
            </span>
          )}
        </>
      );
    }
    case 'notifier': {
      const sum = (r: unknown) => Object.values((r as Record<string, number>) ?? {}).reduce((a, b) => a + b, 0);
      return <>{t('{{rate}} jobs/s · sent {{sent}} · failed {{failed}}', { rate: formatNumber(m.jobsPerSec as number), sent: formatNumber(sum(m.sent)), failed: formatNumber(sum(m.failed)) })}</>;
    }
    case 'summarizer':
      return <>{m.lastRunAt ? t('Last run {{time}} ({{ms}} ms)', { time: relativeTime(m.lastRunAt as string), ms: formatNumber(m.lastRunMs as number) }) : t('No run yet')}</>;
    case 'api':
      return <>{t('{{n}} socket(s) · sweeper {{time}}', { n: formatNumber(m.sockets as number), time: relativeTime(m.sweeperLastRunAt as string | null) })}</>;
    case 'gateway': {
      const listeners = (m.listeners as { protocol: string; connections: number; listening: boolean }[]) ?? [];
      return <>{listeners.map((l) => `${l.protocol} ${l.listening ? formatNumber(l.connections) : '✕'}`).join(' · ')}</>;
    }
    default:
      return null;
  }
}

// ── stores and host ──────────────────────────────────────────────────────────

function DatabaseCard({ db }: { db: DatabaseDto }) {
  const { t } = useTranslation();
  return (
    <Section title="PostgreSQL" icon={DatabaseIcon} status={db.status}>
      {!db.reachable ? (
        <p className="text-sm text-destructive">
          {t('Not reachable')}: {db.error}
        </p>
      ) : (
        <>
          <Row label="Latency (SELECT 1)">{db.latencyMs === null ? '—' : `${db.latencyMs} ms`}</Row>
          <Row label="Connections (active / total / max)">
            {n(db.activeConnections)} / {n(db.totalConnections)} / {n(db.maxConnections)}
          </Row>
          <Row label="Database size">{formatBytes(db.sizeBytes)}</Row>
          <Row label="Positions inserted / min">{n(db.insertsPerMin)}</Row>
          <p className="mt-2 mb-1 text-xs font-medium text-muted-foreground uppercase">{t('Largest tables')}</p>
          <ul className="space-y-0.5 text-sm">
            {db.topTables.map((tb) => (
              <li key={tb.name} className="flex justify-between gap-3">
                <span className="truncate font-mono text-xs">{tb.name}</span>
                <span className="tabular-nums">{formatBytes(tb.bytes)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function ValkeyCard({ v }: { v: ValkeyDto }) {
  const { t } = useTranslation();
  return (
    <Section title="Valkey" icon={ZapIcon} status={v.status}>
      {!v.reachable ? (
        <p className="text-sm text-destructive">
          {t('Not reachable')}: {v.error}
        </p>
      ) : (
        <>
          <Row label="Version">{v.version ?? '—'}</Row>
          <Row label="Latency (PING)">{v.latencyMs === null ? '—' : `${v.latencyMs} ms`}</Row>
          <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
            <span className="text-muted-foreground">{t('Memory')}</span>
            <span className="font-medium tabular-nums">
              {formatBytes(v.usedMemory)} / {v.maxMemory ? formatBytes(v.maxMemory) : t('no limit')}
            </span>
          </div>
          <Meter value={v.memoryPercent === null ? null : v.memoryPercent / 100} status={v.memoryPercent !== null && v.memoryPercent > 80 ? v.status : 'OK'} label={t('Valkey memory')} />
          {!v.maxMemory && <p className="mt-1 text-xs text-muted-foreground">{t('maxmemory is not set: memory is limited only by the host.')}</p>}
          <Row label="Persistence (AOF)">
            {v.aofEnabled ? <StatusBadge status="OK" label="On" /> : <StatusBadge status="WARN" label="Off" />}
          </Row>
          <Row label="Last RDB save">
            {v.rdbLastSaveStatus ?? '—'} · {relativeTime(v.rdbLastSaveAt)}
          </Row>
          <Row label="Connected clients">{n(v.connectedClients)}</Row>
          <Row label="Evicted keys">{n(v.evictedKeys)}</Row>
        </>
      )}
    </Section>
  );
}

function HostCard({ h }: { h: HostDto }) {
  const { t } = useTranslation();
  const used = h.memTotal ? 1 - h.memFree / h.memTotal : null;
  return (
    <Section title="Host (API)" icon={HardDriveIcon} status={h.status}>
      <Row label="Host">{h.hostname}</Row>
      <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
        <span className="text-muted-foreground">{t('Disk free')}</span>
        <span className="font-medium tabular-nums">
          {formatBytes(h.diskFree)} / {formatBytes(h.diskTotal)} ({pct(h.diskFreePercent)})
        </span>
      </div>
      <Meter value={fraction(h.diskTotal && h.diskFree !== null ? h.diskTotal - h.diskFree : null, h.diskTotal)} status={h.status} label={t('Disk used')} />
      <p className="mt-1 truncate text-xs text-muted-foreground" title={h.dataDir}>
        {h.dataDir}
      </p>
      <Row label="Load average (1 / 5 / 15 min)">
        {h.loadAvg.map((l) => l.toFixed(2)).join(' / ')} <span className="text-xs text-muted-foreground">({t('{{n}} CPUs', { n: h.cpus })})</span>
      </Row>
      <Row label="Memory used">
        {formatBytes(h.memTotal - h.memFree)} / {formatBytes(h.memTotal)}
      </Row>
      <Meter value={used} status="OK" label={t('Memory used')} />
      <Row label="Host uptime">{formatDuration(h.uptimeSec)}</Row>
    </Section>
  );
}

// ── settings ─────────────────────────────────────────────────────────────────

function SettingsPanel() {
  const { t } = useTranslation();
  const { data, error } = useSystemHealthSettings(true);
  const test = useMutation({
    mutationFn: () => api.post<{ recipients: string[]; sent: number; errors: string[] }>('/admin/system-health/test-alert'),
    onSuccess: (r) => {
      if (r.errors.length) toast.error(t('Test alert failed'), { description: r.errors.join('\n') });
      else if (!r.recipients.length) toast.warning(t('No recipients configured'));
      else toast.success(t('Test alert sent'), { description: r.recipients.join(', ') });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Section
      title="Alert settings"
      icon={MailIcon}
      action={
        <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
          <SendIcon /> {t('Send test system alert')}
        </Button>
      }
    >
      <FormError message={error ? errorMessage(error) : null} />
      {!data ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase">{t('Recipients')}</p>
            <Row label="Super Admin">{data.superAdminEmail ?? t('not set')}</Row>
            <Row label="SYSTEM_ALERT_EMAILS">{data.extraRecipients.length ? data.extraRecipients.join(', ') : t('none')}</Row>
            <Row label="Cooldown per check">{t('{{n}} min', { n: data.cooldownMin })}</Row>
            <Row label="Delivery">{data.mailProvider ?? t('var/mail only (no SMTP / Zoho configured)')}</Row>
            <p className="pt-2 text-xs text-muted-foreground">{t('E-mails go out on new WARN / CRITICAL issues and on recovery; several at once are sent as one digest. Change these with environment variables (see docs/MONITORING.md).')}</p>
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">{t('Thresholds in effect')}</p>
            <Table containerClassName="-mx-4 w-auto">
              <TableBody>
                {data.thresholds.map((th) => (
                  <TableRow key={th.key}>
                    <TableCell className="whitespace-normal">{t(th.label)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatNumber(th.value)} {th.unit}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{th.env}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </Section>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export function SystemHealthPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { data, error, isFetching } = useSystemHealth();

  return (
    <div className="w-full space-y-4 p-4 sm:p-6">
      <PageHeader title={t('System Health')} description={t('Processes, device ports, queues, database and Valkey across all instances. Updates automatically.')} />
      {error && !data && <FormError message={errorMessage(error)} />}
      {!data ? (
        <div className="space-y-4" aria-busy>
          <Skeleton className="h-20 w-full" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-56" />
            <Skeleton className="h-56" />
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          <OverallBanner data={data} fetching={isFetching} />
          {error && <FormError message={t('Refresh failed: {{error}}', { error: errorMessage(error) })} />}
          <div className="grid gap-4 lg:grid-cols-2">
            <IssuesList issues={data.issues} />
            <EventsTimeline events={data.events} />
          </div>
          <Charts points={data.throughput} />
          <PortsTable ports={data.ports} />
          <div className="grid gap-4 lg:grid-cols-2">
            {data.queues.map((q) => (
              <QueueCard key={q.key} q={q} />
            ))}
          </div>
          <ProcessesTable groups={data.processes} />
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <DatabaseCard db={data.database} />
            <ValkeyCard v={data.valkey} />
            <HostCard h={data.host} />
          </div>
          {can('sa_system_health', 'edit') && <SettingsPanel />}
        </>
      )}
    </div>
  );
}
