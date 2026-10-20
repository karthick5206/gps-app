import { evaluateIoReading, IO_ANALOG_KEYS, IO_DIGITAL_KEYS, type IoSensorKind, type RecentAttributeDto } from '@veetracer/shared';
import { ChevronDownIcon, DoorOpenIcon, SlidersHorizontalIcon, SnowflakeIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { draftError, type IoDraft, type IoSensorsState, voltOrNull } from './use-io-sensors';

const fmtValue = (v: RecentAttributeDto['value']) => (typeof v === 'number' ? `${Math.round(v * 100) / 100}` : String(v));

/** Attribute choices: the usual inputs for the source first, then every key the device actually reports. */
function attributeOptions(d: IoDraft, recent: RecentAttributeDto[]): string[] {
  const base: readonly string[] = d.source === 'ANALOG' ? IO_ANALOG_KEYS : IO_DIGITAL_KEYS;
  const seen = recent.filter((r) => (d.source === 'ANALOG' ? typeof r.value === 'number' : typeof r.value === 'boolean' || r.value === 0 || r.value === 1)).map((r) => r.key);
  return [...new Set([...base, ...seen, d.attribute])];
}

function SensorPanel({ draft, recent, update, disabled }: { draft: IoDraft; recent: RecentAttributeDto[]; update: (p: Partial<IoDraft>) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const isAc = draft.kind === 'AC';
  const reading = recent.find((r) => r.key === draft.attribute);
  const now = reading
    ? evaluateIoReading(reading.value, { source: draft.source, invert: draft.invert, minV: voltOrNull(draft.minV), maxV: voltOrNull(draft.maxV), hysteresisV: 0 })
    : null;
  const onLabel = isAc ? t('AC ON') : t('Door OPEN');
  const offLabel = isAc ? t('AC OFF') : t('Door CLOSED');
  const error = draftError(draft);
  const id = `io-${draft.kind}`;
  return (
    <div className="space-y-4">
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{isAc ? t('AC sensor wired to this tracker') : t('Door sensor wired to this tracker')}</span>
        <Switch checked={draft.enabled} onCheckedChange={(v) => update({ enabled: v })} disabled={disabled} />
      </label>
      <div className={cn('grid gap-4 sm:grid-cols-2', !draft.enabled && 'opacity-60')}>
        <Field label={t('Input type')} htmlFor={`${id}-src`}>
          <Select value={draft.source} onValueChange={(v) => update({ source: v as IoDraft['source'], attribute: v === 'ANALOG' ? 'adc1' : isAc ? 'in2' : 'door' })} disabled={disabled}>
            <SelectTrigger id={`${id}-src`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ANALOG">{t('Analog voltage (min / max)')}</SelectItem>
              <SelectItem value="DIGITAL">{t('Digital input (on / off)')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('Tracker input')} htmlFor={`${id}-attr`}>
          <Select value={draft.attribute} onValueChange={(v) => update({ attribute: v })} disabled={disabled}>
            <SelectTrigger id={`${id}-attr`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {attributeOptions(draft, recent).map((k) => {
                const r = recent.find((x) => x.key === k);
                return (
                  <SelectItem key={k} value={k}>
                    <span className="font-mono">{k}</span>
                    {r ? <span className="text-muted-foreground"> · {fmtValue(r.value)}</span> : null}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </Field>
        {draft.source === 'ANALOG' ? (
          <>
            <Field label={t('Minimum (V)')} htmlFor={`${id}-min`}>
              <Input id={`${id}-min`} inputMode="decimal" value={draft.minV} onChange={(e) => update({ minV: e.target.value })} placeholder="e.g. 2.0" disabled={disabled} />
            </Field>
            <Field label={t('Maximum (V)')} htmlFor={`${id}-max`}>
              <Input id={`${id}-max`} inputMode="decimal" value={draft.maxV} onChange={(e) => update({ maxV: e.target.value })} placeholder="e.g. 11.0" disabled={disabled} />
            </Field>
          </>
        ) : (
          <label className="flex items-center gap-3 sm:col-span-2">
            <Switch checked={draft.invert} onCheckedChange={(v) => update({ invert: v })} disabled={disabled} />
            <span className="text-sm">{isAc ? t('AC is ON when the input is off (inverted)') : t('Door is OPEN when the input is off (inverted)')}</span>
          </label>
        )}
      </div>
      <LiveReading reading={reading} on={now?.on ?? null} onLabel={onLabel} offLabel={offLabel} analog={draft.source === 'ANALOG'} />
      {draft.source === 'ANALOG' && isAc ? (
        <p className="text-xs text-muted-foreground">
          {t('Note the reading with the fan off, at speed 1 and at max speed; set min / max to cover the fan-on readings and exclude the fan-off reading.')}
        </p>
      ) : null}
      {error && draft.enabled ? <p className="text-xs text-destructive">{t(error)}</p> : null}
    </div>
  );
}

function LiveReading({ reading, on, onLabel, offLabel, analog }: { reading: RecentAttributeDto | undefined; on: boolean | null; onLabel: string; offLabel: string; analog: boolean }) {
  const { t } = useTranslation();
  if (!reading) {
    return <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{t('No reading of this input in the last 7 days. Check the wiring, or pick the input the tracker actually reports.')}</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
      <span>
        {t('Now')}: <span className="font-mono font-medium">{fmtValue(reading.value)}{analog && typeof reading.value === 'number' ? ' V' : ''}</span>
      </span>
      <span className="text-xs text-muted-foreground">({formatDateTime(reading.at)})</span>
      <span className="ms-auto text-xs">{t('Currently reads as')}:</span>
      {on === null ? <Badge variant="secondary">{t('Not calibrated')}</Badge> : <Badge variant={on ? 'success' : 'secondary'}>{on ? onLabel : offLabel}</Badge>}
    </div>
  );
}

function AdvancedOptions({ draft, update, disabled }: { draft: IoDraft; update: (p: Partial<IoDraft>) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const id = `io-${draft.kind}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('Debounce (s)')} htmlFor={`${id}-deb`} hint={t('A new state must hold this long before it counts.')}>
        <Input id={`${id}-deb`} inputMode="numeric" value={draft.debounceSec} onChange={(e) => update({ debounceSec: e.target.value })} disabled={disabled} />
      </Field>
      {draft.source === 'ANALOG' ? (
        <Field label={t('Hysteresis (V)')} htmlFor={`${id}-hys`} hint={t('Once ON, stays ON until the voltage leaves the range by this much (stops flicker).')}>
          <Input id={`${id}-hys`} inputMode="decimal" value={draft.hysteresisV} onChange={(e) => update({ hysteresisV: e.target.value })} disabled={disabled} />
        </Field>
      ) : null}
    </div>
  );
}

const KIND_ICON: Record<IoSensorKind, typeof SnowflakeIcon> = { AC: SnowflakeIcon, DOOR: DoorOpenIcon };

/** Devices → edit → "Advanced settings": AC / door sensors wired to the tracker, with live readings to calibrate. */
export function IoSensorsSection({ io, disabled = false }: { io: IoSensorsState; disabled?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const active = io.drafts.filter((d) => d.enabled).map((d) => (d.kind === 'AC' ? t('AC') : t('Door')));
  return (
    <div className="rounded-lg border">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-start text-sm font-medium" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
        {t('Advanced settings')}
        <span className="text-xs font-normal text-muted-foreground">· {t('AC / Door sensors')}{active.length ? `: ${active.join(', ')}` : ''}</span>
        <ChevronDownIcon className={cn('ms-auto size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="border-t px-3 py-3">
          {io.loading ? (
            <p className="text-sm text-muted-foreground">{t('Loading…')}</p>
          ) : (
            <Tabs defaultValue="AC">
              <TabsList>
                {io.drafts.map((d) => {
                  const Icon = KIND_ICON[d.kind];
                  return (
                    <TabsTrigger key={d.kind} value={d.kind}>
                      <Icon className="size-4" /> {d.kind === 'AC' ? t('AC') : t('Door')}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
              {io.drafts.map((d) => (
                <TabsContent key={d.kind} value={d.kind} className="space-y-4 pt-3">
                  <SensorPanel draft={d} recent={io.recent} update={(p) => io.update(d.kind, p)} disabled={disabled} />
                  <AdvancedOptions draft={d} update={(p) => io.update(d.kind, p)} disabled={disabled || !d.enabled} />
                </TabsContent>
              ))}
            </Tabs>
          )}
        </div>
      ) : null}
    </div>
  );
}
