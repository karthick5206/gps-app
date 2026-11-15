import { COVERAGE_KINDS, PRICING_COMPONENT_KINDS, type PricingComponentKind } from '@veetracer/shared';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon, WandSparklesIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { COVERAGE_LABEL, KIND_SPECS, MODEL_PRESETS, newRow, PRESET_LABEL, presetRows, validateRow, type ComponentRow, type FieldSpec, type ModelPreset } from './components';
import { Labeled, Sel } from './ui';

const UNIT: Partial<Record<FieldSpec['type'], string>> = { km: 'km', hours: 'h', percent: '%' };

function FieldInput({ f, row, readOnly, error, currency, onChange }: { f: FieldSpec; row: ComponentRow; readOnly: boolean; error?: string; currency: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const value = row.params[f.key] ?? '';
  if (f.type === 'bool') {
    return (
      <label className="flex items-center gap-2 self-end text-sm">
        <Checkbox checked={value === 'true'} disabled={readOnly} onCheckedChange={(c) => onChange(c ? 'true' : 'false')} />
        {t(f.label)}
      </label>
    );
  }
  const suffix = f.type === 'money' || f.type === 'rate' ? currency : UNIT[f.type];
  return (
    <Labeled label={suffix ? `${t(f.label)} (${suffix})` : f.label} error={error} hint={f.hint}>
      {(id) =>
        f.type === 'select' ? (
          <Sel id={id} value={value} disabled={readOnly} onChange={onChange} options={(f.options ?? []).map((o) => ({ value: o.value, label: t(o.label) }))} />
        ) : (
          <Input id={id} value={value} readOnly={readOnly} inputMode={f.type === 'time' ? 'numeric' : 'decimal'} placeholder={f.type === 'time' ? 'HH:MM' : undefined} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
        )
      }
    </Labeled>
  );
}

/**
 * Component cards of one contract version. Read-only unless `onChange` is given (DRAFT version + edit permission).
 * Model presets replace the cards with the preset's components (rates left empty to fill in).
 */
export function ComponentsEditor({ rows, onChange, currency, showErrors }: { rows: ComponentRow[]; onChange?: (rows: ComponentRow[]) => void; currency: string; showErrors?: boolean }) {
  const { t } = useTranslation();
  const readOnly = !onChange;
  const [addKind, setAddKind] = useState<PricingComponentKind>('PER_KM');
  const [preset, setPreset] = useState<ModelPreset>('DISTANCE');
  const update = (key: string, fn: (r: ComponentRow) => ComponentRow) => onChange?.(rows.map((r) => (r.key === key ? fn(r) : r)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...rows];
    const [r] = next.splice(i, 1);
    next.splice(i + d, 0, r);
    onChange?.(next);
  };
  return (
    <div className="space-y-3">
      {!readOnly && (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3 md:flex-row md:flex-wrap md:items-end">
          <Labeled label="Pricing model preset" className="md:w-64">
            {(id) => <Sel id={id} value={preset} onChange={(v) => setPreset(v as ModelPreset)} options={MODEL_PRESETS.map((p) => ({ value: p, label: t(PRESET_LABEL[p]) }))} />}
          </Labeled>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (!rows.length || window.confirm(t('Replace the current components with the preset?'))) onChange?.(presetRows(preset));
            }}
          >
            <WandSparklesIcon /> {t('Apply preset')}
          </Button>
          <span className="hidden flex-1 md:block" />
          <Labeled label="Add component" className="md:w-64">
            {(id) => <Sel id={id} value={addKind} onChange={(v) => setAddKind(v as PricingComponentKind)} options={PRICING_COMPONENT_KINDS.map((k) => ({ value: k, label: t(KIND_SPECS[k].label) }))} />}
          </Labeled>
          <Button size="sm" variant="outline" onClick={() => onChange?.([...rows, newRow(addKind)])}>
            <PlusIcon /> {t('Add')}
          </Button>
        </div>
      )}
      {rows.length === 0 && <p className="text-sm text-muted-foreground">{t('No components. Apply a preset or add components.')}</p>}
      <ol className="space-y-3">
        {rows.map((row, i) => {
          const spec = KIND_SPECS[row.kind];
          const errors = showErrors ? validateRow(row) : {};
          return (
            <li key={row.key} className="min-w-0 rounded-lg border bg-background p-3">
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {t(spec.label)}
                    {row.label && <span className="text-muted-foreground"> · {row.label}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">{t(spec.help)}</p>
                </div>
                {!readOnly && (
                  <div className="flex gap-1">
                    <Button size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('Move up')}>
                      <ArrowUpIcon />
                    </Button>
                    <Button size="icon-sm" variant="ghost" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label={t('Move down')}>
                      <ArrowDownIcon />
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => onChange?.(rows.filter((r) => r.key !== row.key))} aria-label={t('Remove component')}>
                      <Trash2Icon />
                    </Button>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
                {spec.fields.map((f) => (
                  <FieldInput key={f.key} f={f} row={row} readOnly={readOnly} currency={currency} error={errors[f.key]} onChange={(v) => update(row.key, (r) => ({ ...r, params: { ...r.params, [f.key]: v } }))} />
                ))}
                <Labeled label="Label on invoice">{(id) => <Input id={id} value={row.label} readOnly={readOnly} maxLength={120} onChange={(e) => update(row.key, (r) => ({ ...r, label: e.target.value }))} />}</Labeled>
                <Labeled label="Tax code" error={errors.taxCode} hint="Empty = profile default; EXEMPT = no tax">
                  {(id) => <Input id={id} value={row.taxCode} readOnly={readOnly} maxLength={32} onChange={(e) => update(row.key, (r) => ({ ...r, taxCode: e.target.value }))} />}
                </Labeled>
                <Labeled label="Only vehicle category" hint="Empty = every vehicle">
                  {(id) => <Input id={id} value={row.vehicleCategory} readOnly={readOnly} maxLength={60} onChange={(e) => update(row.key, (r) => ({ ...r, vehicleCategory: e.target.value }))} />}
                </Labeled>
              </div>
              {spec.slabs && (
                <fieldset className="mt-3 space-y-2">
                  <legend className="text-xs font-medium text-muted-foreground">{t('Slabs')}</legend>
                  {row.slabs.map((s, si) => {
                    const last = si === row.slabs.length - 1;
                    return (
                      <div key={si} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                        <Labeled label={last ? 'Above (open-ended)' : 'Up to km'} error={errors[`slab${si}.uptoKm`]}>
                          {(id) => <Input id={id} value={last ? '' : s.uptoKm} placeholder={last ? '∞' : ''} readOnly={readOnly || last} inputMode="decimal" onChange={(e) => update(row.key, (r) => ({ ...r, slabs: r.slabs.map((x, xi) => (xi === si ? { ...x, uptoKm: e.target.value } : x)) }))} />}
                        </Labeled>
                        <Labeled label={`${t('Rate per km')} (${currency})`} error={errors[`slab${si}.rate`]}>
                          {(id) => <Input id={id} value={s.rate} readOnly={readOnly} inputMode="decimal" onChange={(e) => update(row.key, (r) => ({ ...r, slabs: r.slabs.map((x, xi) => (xi === si ? { ...x, rate: e.target.value } : x)) }))} />}
                        </Labeled>
                        {!readOnly && (
                          <Button size="icon-sm" variant="ghost" disabled={row.slabs.length <= 1} onClick={() => update(row.key, (r) => ({ ...r, slabs: r.slabs.filter((_, xi) => xi !== si) }))} aria-label={t('Remove slab')}>
                            <Trash2Icon />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  {!readOnly && (
                    <Button size="sm" variant="outline" onClick={() => update(row.key, (r) => ({ ...r, slabs: [...r.slabs.slice(0, -1), { uptoKm: '', rate: '' }, ...r.slabs.slice(-1)] }))}>
                      <PlusIcon /> {t('Add slab')}
                    </Button>
                  )}
                  {errors.slabs && <p className="text-xs text-destructive">{t(errors.slabs)}</p>}
                </fieldset>
              )}
              {spec.covers && (
                <fieldset className="mt-3">
                  <legend className="text-xs font-medium text-muted-foreground">{t('The fee covers')}</legend>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-2">
                    {COVERAGE_KINDS.map((k) => (
                      <label key={k} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={row.covers.includes(k)} disabled={readOnly} onCheckedChange={(c) => update(row.key, (r) => ({ ...r, covers: c ? [...r.covers, k] : r.covers.filter((x) => x !== k) }))} />
                        {t(COVERAGE_LABEL[k])}
                      </label>
                    ))}
                  </div>
                  {errors.covers && <p className="text-xs text-destructive">{t(errors.covers)}</p>}
                </fieldset>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
