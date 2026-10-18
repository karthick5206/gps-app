import { useQuery } from '@tanstack/react-query';
import { ALERT_TYPE_MAP, type AlertLevel, type AlertSettingDto, type AlertTypeCode, type TrackedObjectDto } from '@veetracer/shared';
import { AlertTriangleIcon, Building2Icon, CopyIcon, LayersIcon, ListChecksIcon, MoreHorizontalIcon, PackageIcon, SendIcon, TruckIcon, WarehouseIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { type Option } from '@/components/ui/multi-select';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth, useMe } from '@/features/auth/auth-context';
import { useAllGeofences } from '@/features/geofences/api';
import { api, errorMessage } from '@/lib/api';
import {
  catalogueDefaults,
  LEVEL_NAME,
  useAlertTypes,
  useConflicts,
  useEffective,
  useRecipientLists,
  useSettingRows,
  type AlertTypeWithSupport,
  type GroupConflict,
} from './api';
import { AlertTypeCard, type CardView } from './AlertTypeCard';
import { resolveChain, type ChainLink, type SourceRef } from './inheritance';
import { LevelTree, type Target } from './LevelTree';
import { BulkEnableDialog, CopyDialog, EffectivePanel, HistoryPanel, PacksDialog, SendTestDialog, SnoozesPanel } from './panels';
import { RecipientsEditor } from './RecipientsEditor';

const CATEGORY_ORDER: AlertTypeWithSupport['category'][] = ['Driving', 'Location', 'Vehicle', 'Device', 'Device health', 'Safety'];
const LEVEL_ICON = { COMPANY: Building2Icon, BRANCH: WarehouseIcon, GROUP: LayersIcon, OBJECT: TruckIcon } as const;

function conflictText(c: GroupConflict): string {
  const field = c.field.replace(/^params\./, '').replace(/^channels\./, 'channels ');
  const others = c.others.map((o) => `${o.groupName} (${JSON.stringify(o.value)})`).join(', ');
  return `${ALERT_TYPE_MAP[c.alertType]?.label ?? c.alertType} · ${field}: ${c.winner.groupName} (priority ${c.winner.priority}, ${JSON.stringify(c.winner.value)}) wins over ${others}${c.overriddenByObject ? ' — but this vehicle overrides it anyway' : ''}`;
}

/** Selected level target, kept in the URL (?level=&id=) so it survives reloads and can be deep-linked. */
function useTarget(): [Target, (t: Target) => void, boolean] {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const [cache, setCache] = useState<Target | null>(null);
  const level = (params.get('level') as AlertLevel | null) ?? 'COMPANY';
  const id = params.get('id') ?? me.company.id;
  const needsFetch = !(cache && cache.level === level && cache.id === id) && level !== 'COMPANY';
  const lookup = useQuery({
    queryKey: ['alert-settings', 'target', level, id],
    queryFn: async ({ signal }) => {
      const path = level === 'BRANCH' ? `/branches/${id}` : level === 'GROUP' ? `/vehicle-groups/${id}` : `/objects/${id}`;
      const row = await api.get<{ id: string; name: string }>(path, undefined, signal);
      return { level, id, name: row.name, object: level === 'OBJECT' ? (row as TrackedObjectDto) : undefined } satisfies Target;
    },
    enabled: needsFetch,
  });
  const target: Target =
    level === 'COMPANY' ? { level, id: me.company.id, name: me.company.name } : cache && cache.level === level && cache.id === id ? cache : (lookup.data ?? { level, id, name: '…' });
  const set = (t: Target) => {
    setCache(t);
    setParams(t.level === 'COMPANY' ? {} : { level: t.level, id: t.id }, { replace: false });
  };
  return [target, set, needsFetch && lookup.isPending];
}

export function AlertSettingsPage() {
  const me = useMe();
  const { can } = useAuth();
  const [target, setTarget, targetLoading] = useTarget();
  const [treeOpen, setTreeOpen] = useState(false);
  const [tab, setTab] = useState('types');
  const [dialog, setDialog] = useState<null | 'packs' | 'copy' | 'bulk' | 'test'>(null);
  const [testType, setTestType] = useState<AlertTypeCode | null>(null);
  const canEdit = can('alert_settings', 'edit');
  const level = target.level;
  const isObject = level === 'OBJECT';

  const types = useAlertTypes();
  const rows = useSettingRows(level, target.id);
  const companyRows = useSettingRows('COMPANY', me.company.id, level === 'BRANCH' || level === 'GROUP');
  const effective = useEffective(isObject ? target.id : null);
  const conflicts = useConflicts(isObject ? target.id : null);
  const lists = useRecipientLists(level, target.id);
  const geofences = useAllGeofences(can('geofences'));
  const geofenceOptions = useMemo<Option[]>(() => (geofences.data ?? []).map((g) => ({ value: g.id, label: g.name })), [geofences.data]);

  const views = useMemo(() => {
    const out = new Map<AlertTypeCode, CardView>();
    const defs = types.data ?? [];
    if (isObject) {
      const obj = target.object;
      const nameFor = (lvl: string): string | null => {
        if (lvl === 'OBJECT') return target.name;
        if (lvl === 'BRANCH') return obj?.branchName ?? null;
        if (lvl === 'GROUP') return obj && obj.groups.length === 1 ? obj.groups[0].name : null;
        if (lvl === 'COMPANY') return null;
        return null;
      };
      for (const e of effective.data ?? []) {
        const sources: Record<string, SourceRef> = {};
        for (const [k, v] of Object.entries(e.sources)) sources[k] = { level: v, name: nameFor(v) };
        out.set(e.alertType, {
          values: { enabled: e.enabled, severity: e.severity, cooldownMin: e.cooldownMin, schedule: e.schedule, params: e.params, channels: e.channels },
          sources,
          supported: e.supported,
          snoozedUntil: e.snoozedUntil,
        });
      }
      return out;
    }
    const byType = (list: AlertSettingDto[] | undefined) => new Map((list ?? []).map((r) => [r.alertType, r]));
    const here = byType(rows.data);
    const company = byType(level === 'COMPANY' ? rows.data : companyRows.data);
    for (const def of defs) {
      const chain: ChainLink[] = [{ level: 'COMPANY', name: null, row: company.get(def.code) }];
      if (level !== 'COMPANY') chain.push({ level, name: target.name, row: here.get(def.code) });
      const r = resolveChain(catalogueDefaults(def), chain);
      const { sources, ...values } = r;
      out.set(def.code, { values, sources, supported: null, snoozedUntil: null });
    }
    return out;
  }, [types.data, isObject, effective.data, rows.data, companyRows.data, level, target]);

  const loading = types.isPending || rows.isPending || (isObject ? effective.isPending : level !== 'COMPANY' && companyRows.isPending) || targetLoading;
  const error = rows.error ?? effective.error ?? companyRows.error;
  const conflictsByType = useMemo(() => {
    const m = new Map<string, GroupConflict[]>();
    for (const c of conflicts.data ?? []) m.set(c.alertType, [...(m.get(c.alertType) ?? []), c]);
    return m;
  }, [conflicts.data]);

  const pick = (t: Target) => {
    setTarget(t);
    setTreeOpen(false);
    if (t.level !== 'OBJECT' && tab === 'effective') setTab('types');
  };
  const Icon = LEVEL_ICON[level];
  const openTest = (code: AlertTypeCode | null) => {
    setTestType(code);
    setDialog('test');
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-72 shrink-0 border-r bg-card lg:flex lg:flex-col">
        <LevelTree value={target} onChange={pick} className="h-full" />
      </aside>
      <Sheet open={treeOpen} onOpenChange={setTreeOpen}>
        <SheetContent side="left" className="w-80 p-0" aria-describedby={undefined}>
          <SheetTitle className="border-b px-4 py-3">Choose level</SheetTitle>
          <LevelTree value={target} onChange={pick} className="min-h-0 flex-1" />
        </SheetContent>
      </Sheet>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="w-full space-y-4 p-4 sm:p-6">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Alert settings</p>
              <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight sm:text-2xl">
                <Icon className="size-5 text-primary" />
                <span className="truncate">{target.name}</span>
                <Badge variant="secondary">{LEVEL_NAME[level]}</Badge>
              </h1>
              <p className="text-sm text-muted-foreground">
                {level === 'COMPANY'
                  ? 'Company defaults apply to every vehicle unless a branch, group or vehicle overrides them.'
                  : level === 'OBJECT'
                    ? `Overrides for this vehicle only.${target.object?.branchName ? ` Branch: ${target.object.branchName}.` : ''}${target.object?.groups.length ? ` Groups: ${target.object.groups.map((g) => g.name).join(', ')}.` : ''}`
                    : `Overrides for every vehicle in this ${level === 'BRANCH' ? 'branch' : 'group'}; anything not set here is inherited from the company.`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="lg:hidden" onClick={() => setTreeOpen(true)}>
                <ListChecksIcon /> Level
              </Button>
              {canEdit && (
                <Button variant="outline" onClick={() => setDialog('packs')}>
                  <PackageIcon /> Apply pack
                </Button>
              )}
              {canEdit && (
                <Button variant="outline" onClick={() => openTest(null)}>
                  <SendIcon /> Send test
                </Button>
              )}
              {canEdit && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" aria-label="More actions">
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {isObject && (
                      <DropdownMenuItem onSelect={() => setDialog('copy')}>
                        <CopyIcon /> Copy settings to…
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setDialog('bulk')}>
                      <ListChecksIcon /> Bulk enable / disable
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {isObject && (conflicts.data?.length ?? 0) > 0 && (
            <div role="alert" className="space-y-1 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2.5 text-sm">
              <p className="flex items-center gap-2 font-medium text-warning">
                <AlertTriangleIcon className="size-4" /> This vehicle's groups disagree on {conflicts.data!.length} setting(s)
              </p>
              <ul className="list-disc space-y-0.5 pl-6 text-xs">
                {conflicts.data!.slice(0, 8).map((c, i) => (
                  <li key={i}>{conflictText(c)}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">The group with the highest alert priority wins. Set the value on this vehicle to override it explicitly.</p>
            </div>
          )}

          <Tabs value={tab} onValueChange={setTab}>
            <div className="-mx-1 overflow-x-auto px-1">
              <TabsList>
                <TabsTrigger value="types">Alert types</TabsTrigger>
                <TabsTrigger value="recipients">Default recipients</TabsTrigger>
                {isObject && <TabsTrigger value="effective">Effective</TabsTrigger>}
                <TabsTrigger value="snoozes">Snoozes</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="types" className="mt-4 space-y-6">
              {error && <FormError message={errorMessage(error)} />}
              {loading &&
                Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
              {!loading &&
                CATEGORY_ORDER.map((cat) => {
                  const defs = (types.data ?? []).filter((t) => t.category === cat);
                  if (!defs.length) return null;
                  return (
                    <section key={cat} className="space-y-2">
                      <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{cat}</h2>
                      {defs.map((def) => {
                        const view = views.get(def.code);
                        if (!view) return null;
                        return (
                          <AlertTypeCard
                            key={`${target.level}-${target.id}-${def.code}`}
                            def={def}
                            level={level}
                            targetId={target.id}
                            view={view}
                            lists={lists.data ?? []}
                            readOnly={!canEdit}
                            geofenceOptions={geofenceOptions}
                            conflicts={conflictsByType.get(def.code) ?? []}
                            onSendTest={canEdit ? () => openTest(def.code) : undefined}
                          />
                        );
                      })}
                    </section>
                  );
                })}
            </TabsContent>

            <TabsContent value="recipients" className="mt-4 space-y-3">
              <div>
                <h2 className="text-sm font-semibold">Default recipient lists — {target.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {level === 'COMPANY'
                    ? 'Who receives alerts when an alert type has no list of its own. Branches, groups and vehicles inherit these and can add to or replace them.'
                    : `Default lists for this ${LEVEL_NAME[level].toLowerCase()}: inherit the level above, add to it, replace it, or notify nobody.`}
                </p>
              </div>
              {lists.isError && <FormError message={errorMessage(lists.error)} />}
              {lists.isPending ? <Skeleton className="h-48 w-full" /> : <RecipientsEditor level={level} targetId={target.id} alertType="*" lists={lists.data ?? []} readOnly={!canEdit} />}
            </TabsContent>

            {isObject && (
              <TabsContent value="effective" className="mt-4">
                <EffectivePanel objectId={target.id} />
              </TabsContent>
            )}

            <TabsContent value="snoozes" className="mt-4">
              <SnoozesPanel target={target} canEdit={canEdit} />
            </TabsContent>

            <TabsContent value="history" className="mt-4">
              <HistoryPanel target={target} />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <PacksDialog open={dialog === 'packs'} onOpenChange={(o) => !o && setDialog(null)} target={target} />
      {isObject && <CopyDialog open={dialog === 'copy'} onOpenChange={(o) => !o && setDialog(null)} target={target} />}
      <BulkEnableDialog open={dialog === 'bulk'} onOpenChange={(o) => !o && setDialog(null)} />
      <SendTestDialog open={dialog === 'test'} onOpenChange={(o) => !o && setDialog(null)} target={target} alertType={testType} />
    </div>
  );
}
