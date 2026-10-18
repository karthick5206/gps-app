import {
  ALERT_SEVERITIES,
  NOTIFY_CHANNELS,
  type AlertLevel,
  type AlertParamDef,
  type AlertSeverity,
  type NotifyChannel,
  type RecipientListDto,
  type TimeWindow,
} from '@veetracer/shared';
import { AlertTriangleIcon, BellOffIcon, ChevronDownIcon, CpuIcon, LockIcon, SendIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MultiSelect, type Option } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tooltip } from '@/components/ui/tooltip';
import { SEVERITY_LABEL } from '@/features/alerts/severity';
import { DayToggles } from '@/features/geofences/TimeWindowsEditor';
import { formatWindow } from '@/features/geofences/time-windows';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CHANNEL_LABEL, usePutSetting, type AlertTypeWithSupport, type GroupConflict, type SettingPatch } from './api';
import { CommitNumber, SettingRow, SourceBadge } from './fields';
import { isOverriddenHere, type Resolved, type SourceRef } from './inheritance';
import { RecipientsEditor } from './RecipientsEditor';

export interface CardView {
  values: Omit<Resolved, 'sources'>;
  sources: Record<string, SourceRef>;
  /** Object level: device capability present. */
  supported: boolean | null;
  snoozedUntil: string | null;
}

const SEVERITY_DOT: Record<AlertSeverity, string> = { INFO: 'bg-[#2563eb]', WARNING: 'bg-[#d97706]', CRITICAL: 'bg-[#dc2626]' };

/** Placeholder for an inherited value (the unit is shown as an input suffix). */
function paramDisplay(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'Not set';
  if (Array.isArray(v)) return v.length ? `${v.length} selected` : 'None';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  return String(v);
}

function ParamField({
  p,
  value,
  source,
  level,
  disabled,
  geofenceOptions,
  onSet,
}: {
  p: AlertParamDef;
  value: unknown;
  source: SourceRef | undefined;
  level: AlertLevel;
  disabled: boolean;
  geofenceOptions: Option[];
  onSet: (v: unknown) => void;
}) {
  const here = isOverriddenHere(source, level);
  const id = `param-${p.key}`;
  const badge = <SourceBadge source={source} level={level} onReset={() => onSet(null)} disabled={disabled} />;
  if (p.type === 'number') {
    return (
      <SettingRow label={p.label} htmlFor={id} hint={p.hint ?? (p.min !== undefined ? `${p.min}–${p.max} ${p.unit ?? ''}` : undefined)} source={badge}>
        <CommitNumber
          id={id}
          value={here ? (value as number | null) : null}
          placeholder={paramDisplay(value)}
          min={p.min}
          max={p.max}
          unit={p.unit}
          disabled={disabled}
          onCommit={(v) => onSet(v)}
        />
      </SettingRow>
    );
  }
  if (p.type === 'time') {
    return (
      <SettingRow label={p.label} htmlFor={id} source={badge}>
        <Input
          id={id}
          type="time"
          className={cn('h-8', !here && 'text-muted-foreground')}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => e.target.value && onSet(e.target.value)}
        />
      </SettingRow>
    );
  }
  if (p.type === 'boolean') {
    return (
      <SettingRow label={p.label} source={badge}>
        <Switch checked={!!value} onCheckedChange={(v) => onSet(v)} disabled={disabled} aria-label={p.label} />
      </SettingRow>
    );
  }
  return (
    <SettingRow label={p.label} source={badge} hint={p.hint} className="sm:col-span-2">
      <MultiSelect value={Array.isArray(value) ? (value as string[]) : []} onChange={(v) => onSet(v)} options={geofenceOptions} placeholder="No geofences" disabled={disabled} />
    </SettingRow>
  );
}

function ScheduleField({ value, source, level, disabled, onSet }: { value: TimeWindow | null; source: SourceRef | undefined; level: AlertLevel; disabled: boolean; onSet: (v: TimeWindow | null) => void }) {
  const [draft, setDraft] = useState<TimeWindow>(value ?? { days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '22:00' });
  const here = isOverriddenHere(source, level);
  const limited = !!value;
  return (
    <SettingRow
      label="Schedule"
      hint={value ? `Active ${formatWindow(value)} (company timezone)` : 'Active all the time'}
      source={<SourceBadge source={source} level={level} onReset={() => onSet(null)} disabled={disabled} />}
      className="sm:col-span-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={limited ? 'window' : 'always'}
          disabled={disabled}
          onValueChange={(v) => {
            if (v === 'window') onSet(draft);
            else if (here) onSet(null);
          }}
        >
          <SelectTrigger className="h-8 w-36" aria-label="Schedule">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="always">Always</SelectItem>
            <SelectItem value="window">Only during…</SelectItem>
          </SelectContent>
        </Select>
        {limited && (
          <>
            <DayToggles
              days={value!.days}
              disabled={disabled}
              onChange={(days) => {
                const next = { ...value!, days };
                setDraft(next);
                if (days.length) onSet(next);
              }}
            />
            <Input
              type="time"
              aria-label="From"
              className="h-8 w-[7.75rem]"
              value={value!.from}
              disabled={disabled}
              onChange={(e) => e.target.value && onSet({ ...value!, from: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="time" aria-label="To" className="h-8 w-[7.75rem]" value={value!.to} disabled={disabled} onChange={(e) => e.target.value && onSet({ ...value!, to: e.target.value })} />
          </>
        )}
      </div>
    </SettingRow>
  );
}

function ChannelsField({ channels, sources, level, disabled, onSet }: { channels: Record<AlertSeverity, NotifyChannel[]>; sources: Record<string, SourceRef>; level: AlertLevel; disabled: boolean; onSet: (sev: AlertSeverity, v: NotifyChannel[] | null) => void }) {
  return (
    <SettingRow label="Channels by severity" hint="In-app always reaches users who can see the vehicle; WhatsApp and push are logged as not configured in this release." className="sm:col-span-2">
      <div className="space-y-1.5">
        {ALERT_SEVERITIES.map((sev) => {
          const list = channels[sev] ?? [];
          return (
            <div key={sev} className="flex flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1.5">
              <span className="flex w-20 items-center gap-1.5 text-xs font-medium">
                <span className={cn('size-2 rounded-full', SEVERITY_DOT[sev])} />
                {SEVERITY_LABEL[sev]}
              </span>
              {NOTIFY_CHANNELS.map((ch) => {
                const on = list.includes(ch);
                return (
                  <button
                    key={ch}
                    type="button"
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() => onSet(sev, on ? list.filter((c) => c !== ch) : [...list, ch])}
                    className={cn(
                      'h-6 rounded-full border px-2 text-[11px] font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-50',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {CHANNEL_LABEL[ch]}
                  </button>
                );
              })}
              <SourceBadge source={sources[`channels.${sev}`]} level={level} onReset={() => onSet(sev, null)} disabled={disabled} className="ml-auto" />
            </div>
          );
        })}
      </div>
    </SettingRow>
  );
}

/** One alert type: enable, severity, params generated from the catalogue, schedule, cooldown, channels, recipients. */
export function AlertTypeCard({
  def,
  level,
  targetId,
  view,
  lists,
  readOnly,
  geofenceOptions,
  conflicts,
  onSendTest,
  defaultOpen = false,
}: {
  def: AlertTypeWithSupport;
  level: AlertLevel;
  targetId: string;
  view: CardView;
  lists: RecipientListDto[];
  readOnly: boolean;
  geofenceOptions: Option[];
  conflicts: GroupConflict[];
  onSendTest?: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const put = usePutSetting(level, targetId);
  const { values, sources } = view;
  const unsupported = view.supported === false;
  const lockedOn = def.mandatory && level !== 'COMPANY';
  const disabled = readOnly || put.isPending;
  const patch = (p: SettingPatch) => put.mutate({ alertType: def.code, patch: p });
  const overriddenCount = Object.values(sources).filter((s) => isOverriddenHere(s, level)).length;
  const hasLists = lists.some((l) => l.alertType === def.code);
  const regionId = `alert-card-${def.code}`;

  return (
    <div className={cn('rounded-xl border bg-card shadow-xs transition-shadow', open && 'shadow-sm', unsupported && 'opacity-75')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={regionId} className="flex min-w-0 flex-1 basis-full items-center gap-2 text-left focus-visible:outline-none sm:basis-auto">
          <ChevronDownIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{def.label}</span>
              {def.mandatory && (
                <Tooltip content="Mandatory: can't be switched off below company level and ignores snoozes">
                  <LockIcon className="size-3.5 text-muted-foreground" aria-label="Mandatory" />
                </Tooltip>
              )}
              {overriddenCount > 0 && <Badge variant="default">{overriddenCount} set here</Badge>}
              {hasLists && <Badge variant="secondary">Recipients</Badge>}
              {view.snoozedUntil && (
                <Badge variant="warning">
                  <BellOffIcon /> Snoozed until {formatDateTime(view.snoozedUntil)}
                </Badge>
              )}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {unsupported ? (
                <span className="inline-flex items-center gap-1 text-warning">
                  <CpuIcon className="size-3" /> Not supported by this device
                </span>
              ) : level !== 'OBJECT' && def.supportedBy.total > 0 ? (
                `Supported by ${def.supportedBy.count} of ${def.supportedBy.total} company vehicles`
              ) : def.capability ? (
                `Needs device capability: ${def.capability.replace(/_/g, ' ')}`
              ) : (
                'Any GPS device'
              )}
            </span>
          </span>
        </button>
        {conflicts.length > 0 && (
          <Tooltip content={`${conflicts.length} conflicting group setting(s) — see the warning above`}>
            <AlertTriangleIcon className="size-4 text-warning" aria-label="Group conflict" />
          </Tooltip>
        )}
        {put.isPending && <Spinner className="text-muted-foreground" />}
        <span className="flex-1 sm:hidden" />
        <Select value={values.severity} onValueChange={(v) => patch({ severity: v as AlertSeverity })} disabled={disabled || unsupported}>
          <SelectTrigger className="h-8 w-[7.5rem] text-xs" aria-label={`${def.label} severity`}>
            <span className="flex items-center gap-1.5">
              <span className={cn('size-2 rounded-full', SEVERITY_DOT[values.severity])} />
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            {ALERT_SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tooltip content={lockedOn ? 'Mandatory alert — always on below company level' : `Enabled: ${sources.enabled?.level === level ? 'set here' : 'inherited'}`}>
          <span className="flex items-center">
            <Switch
              checked={lockedOn ? true : values.enabled}
              onCheckedChange={(v) => patch({ enabled: v })}
              disabled={disabled || lockedOn || unsupported}
              aria-label={`${def.label} enabled`}
            />
          </span>
        </Tooltip>
      </div>

      {open && (
        <div id={regionId} className="space-y-5 border-t px-3 py-4 sm:px-4">
          {unsupported && (
            <p className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-sm text-warning">
              This vehicle's device model doesn't report <strong>{def.capability?.replace(/_/g, ' ')}</strong>, so this alert can't fire. Settings below are kept for when the device changes.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Enabled</span>
            <SourceBadge source={sources.enabled} level={level} onReset={() => patch({ enabled: null })} disabled={disabled} />
            <span className="ml-2 text-muted-foreground">Severity</span>
            <SourceBadge source={sources.severity} level={level} onReset={() => patch({ severity: null })} disabled={disabled} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {def.params.map((p) => (
              <ParamField
                key={p.key}
                p={p}
                value={values.params[p.key]}
                source={sources[`params.${p.key}`]}
                level={level}
                disabled={disabled}
                geofenceOptions={geofenceOptions}
                onSet={(v) => patch({ params: { [p.key]: v } })}
              />
            ))}
            <SettingRow
              label="Cooldown"
              htmlFor={`cooldown-${def.code}`}
              hint="Minimum gap between two alerts of this type for the same vehicle"
              source={<SourceBadge source={sources.cooldownMin} level={level} onReset={() => patch({ cooldownMin: null })} disabled={disabled} />}
            >
              <CommitNumber
                id={`cooldown-${def.code}`}
                value={isOverriddenHere(sources.cooldownMin, level) ? values.cooldownMin : null}
                placeholder={String(values.cooldownMin)}
                min={0}
                max={1440}
                unit="min"
                disabled={disabled}
                onCommit={(v) => patch({ cooldownMin: v === null ? null : Math.round(v) })}
              />
            </SettingRow>
            <ScheduleField value={values.schedule} source={sources.schedule} level={level} disabled={disabled} onSet={(v) => patch({ schedule: v })} />
            <ChannelsField channels={values.channels} sources={sources} level={level} disabled={disabled} onSet={(sev, v) => patch({ channels: { [sev]: v } })} />
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-[13px] font-medium">Recipients</h4>
                <p className="text-xs text-muted-foreground">Per channel: use the default lists, add to them, replace them, or notify nobody.</p>
              </div>
              {onSendTest && (
                <Button size="sm" variant="outline" onClick={onSendTest}>
                  <SendIcon /> Send test
                </Button>
              )}
            </div>
            <RecipientsEditor level={level} targetId={targetId} alertType={def.code} lists={lists} readOnly={readOnly} />
          </div>
        </div>
      )}
    </div>
  );
}
