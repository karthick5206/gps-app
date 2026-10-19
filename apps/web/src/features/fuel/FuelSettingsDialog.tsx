import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FUEL_RAW_UNIT, FUEL_SOURCE_LABELS, FUEL_SOURCES, type FuelConfigDto, type FuelSource } from '@veetracer/shared';
import { FuelIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';

export interface FuelTarget {
  objectId: string;
  label: string;
}

interface Draft {
  source: FuelSource;
  tank: string;
  rows: { raw: string; litres: string }[];
  refillMin: string;
  drainMin: string;
  window: string;
  smoothing: string;
}

const toDraft = (c: FuelConfigDto): Draft => ({
  source: c.source,
  tank: c.tankCapacityL === null ? '' : String(c.tankCapacityL),
  rows: c.calibration.map(([raw, litres]) => ({ raw: String(raw), litres: String(litres) })),
  refillMin: c.refillMinL === null ? '' : String(c.refillMinL),
  drainMin: String(c.drainMinL),
  window: String(c.drainWindowMin),
  smoothing: String(c.smoothingWindow),
});

const numOrNull = (s: string): number | null => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));

/** Fuel sensor of one vehicle: source, tank, calibration table and refill / drain thresholds. */
export function FuelSettingsDialog({ target, onClose }: { target: FuelTarget | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const path = target ? `/objects/${target.objectId}/fuel` : '';
  const q = useQuery({ queryKey: ['fuel-config', target?.objectId], queryFn: ({ signal }) => api.get<FuelConfigDto>(path, undefined, signal), enabled: !!target });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(q.data ? toDraft(q.data) : null);
    setError(null);
  }, [q.data]);

  const save = useMutation({
    mutationFn: (d: Draft) =>
      api.put<FuelConfigDto>(path, {
        source: d.source,
        tankCapacityL: numOrNull(d.tank),
        calibration: d.rows.filter((r) => r.raw.trim() !== '' && r.litres.trim() !== '').map((r) => ({ raw: Number(r.raw), litres: Number(r.litres) })),
        refillMinL: numOrNull(d.refillMin),
        drainMinL: numOrNull(d.drainMin) ?? 8,
        drainWindowMin: Math.round(numOrNull(d.window) ?? 10),
        smoothingWindow: Math.round(numOrNull(d.smoothing) ?? 5),
      }),
    onSuccess: (c) => {
      qc.setQueryData(['fuel-config', target?.objectId], c);
      toast.success(t('Fuel settings saved'));
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setRow = (i: number, patch: Partial<Draft['rows'][number]>) => set({ rows: draft!.rows.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const needsTable = draft?.source === 'lls' || draft?.source === 'analog';
  const unit = draft ? FUEL_RAW_UNIT[draft.source] : undefined;
  const tank = draft ? numOrNull(draft.tank) : null;

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FuelIcon className="size-5 text-primary" /> {t('Fuel sensor')}
          </DialogTitle>
          <DialogDescription>{target?.label}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {!draft ? (
            <div className="flex justify-center py-8">{q.error ? <FormError message={errorMessage(q.error)} /> : <Spinner />}</div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('Sensor source')} className="sm:col-span-2">
                  <Select value={draft.source} onValueChange={(v) => set({ source: v as FuelSource })}>
                    <SelectTrigger aria-label={t('Sensor source')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FUEL_SOURCES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {t(FUEL_SOURCE_LABELS[s])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('Tank capacity (L)')} hint={draft.source === 'can_level_pct' ? t('Required to convert % to litres') : undefined} required={draft.source === 'can_level_pct'}>
                  <Input type="number" min={1} value={draft.tank} onChange={(e) => set({ tank: e.target.value })} />
                </Field>
              </div>
              {draft.source !== 'none' && <FuelCalibration draft={draft} needsTable={needsTable} unit={unit} setRow={setRow} set={set} />}
              {draft.source !== 'none' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('Refill at least (L)')} hint={t('Empty = 10 L or 5 % of the tank, whichever is more ({{n}} L)', { n: Math.max(10, tank ? Math.round(tank * 0.05) : 0) })}>
                    <Input type="number" min={1} value={draft.refillMin} onChange={(e) => set({ refillMin: e.target.value })} />
                  </Field>
                  <Field label={t('Drain / theft at least (L)')}>
                    <Input type="number" min={1} value={draft.drainMin} onChange={(e) => set({ drainMin: e.target.value })} />
                  </Field>
                  <Field label={t('Drain window (min)')} hint={t('A drop of that much within this time while stationary')}>
                    <Input type="number" min={1} max={240} value={draft.window} onChange={(e) => set({ window: e.target.value })} />
                  </Field>
                  <Field label={t('Smoothing (readings)')} hint={t('Median of the last N readings filters spikes and sloshing')}>
                    <Input type="number" min={1} max={15} value={draft.smoothing} onChange={(e) => set({ smoothing: e.target.value })} />
                  </Field>
                </div>
              )}
              {error && <FormError message={error} />}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => draft && save.mutate(draft)} disabled={!draft || save.isPending}>
            {save.isPending && <Spinner />}
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FuelCalibration({
  draft,
  needsTable,
  unit,
  setRow,
  set,
}: {
  draft: Draft;
  needsTable: boolean;
  unit: string | undefined;
  setRow: (i: number, patch: Partial<Draft['rows'][number]>) => void;
  set: (patch: Partial<Draft>) => void;
}) {
  const { t } = useTranslation();
  if (!needsTable) return null;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{t('Calibration table')}</p>
          <p className="text-xs text-muted-foreground">
            {draft.source === 'analog'
              ? t('Sensor voltage (mV) → litres, measured while filling the tank. At least 2 rows; values in between are interpolated.')
              : t('Sensor value → litres. Leave empty if the sensor already reports litres.')}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => set({ rows: [...draft.rows, { raw: '', litres: '' }] })}>
          <PlusIcon /> {t('Add row')}
        </Button>
      </div>
      {draft.rows.length > 0 && (
        <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 text-xs text-muted-foreground">
          <span>{unit ? `${t('Raw')} (${t(unit)})` : t('Raw')}</span>
          <span>{t('Litres')}</span>
          <span className="w-9" />
          {draft.rows.map((r, i) => (
            <div key={i} className="contents">
              <Input type="number" aria-label={t('Raw')} value={r.raw} onChange={(e) => setRow(i, { raw: e.target.value })} />
              <Input type="number" min={0} aria-label={t('Litres')} value={r.litres} onChange={(e) => setRow(i, { litres: e.target.value })} />
              <Button type="button" size="icon" variant="ghost" aria-label={t('Remove row')} onClick={() => set({ rows: draft.rows.filter((_, k) => k !== i) })}>
                <Trash2Icon />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
