import type { MeAdhocEndRef, MeBookableShiftDto, TransportBookingJourney, TransportDirection } from '@veetracer/shared';
import { BookmarkIcon, Building2Icon, HouseIcon, InfoIcon, LandmarkIcon, MapPinIcon, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Combobox, type Option } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { FormDialog } from '@/features/masters/FormDialog';
import { ApiError, errorMessage } from '@/lib/api';
import { idempotencyFor, type IdempotencySlot } from './dispatch-draft';
import { DIRECTION_LABEL, newUuid } from './e3-format';
import { SimpleSelect } from './e3-ui';
import { ME_GEOCODE_ENDPOINT } from '../AddressSearchCombobox';
import {
  buildRequest,
  CONSENT_EXPLANATION,
  defaultCommuteEnds,
  END_KIND_LABEL,
  endKindAvailability,
  endKindsFor,
  minutesText,
  REQUEST_LIMITS,
  requestDays,
  requestErrorField,
  requestErrorText,
  requestResultText,
  requestTimeZone,
  todayKeyIn,
  type EndKind,
  type RequestField,
  type RequestPolicy,
} from './my-request';
import { useMySavedPlaces, useRequestPlaces, useRequestRide } from './my-request-api';
import { MapPoint, PointCard, PointDone, PointSummary, Segmented } from './point-card';

const NO_SHIFT = '__none__';

/** Short, icon-led segment labels of the end source (same pattern as the desk booking dialog); END_KIND_LABEL is the full name. */
const END_KIND_SHORT: Record<EndKind, string> = { HOME: 'Home', SAVED: 'Saved', PLACE: 'Company place', MAP: 'Map point', SHIFT_SITE: 'Shift site' };
const END_KIND_ICON: Record<EndKind, LucideIcon> = { HOME: HouseIcon, SAVED: BookmarkIcon, PLACE: LandmarkIcon, MAP: MapPinIcon, SHIFT_SITE: Building2Icon };

/** Company places (GET /me/transport/request-places?q=), searchable. */
function CompanyPlace({ value, onChange, idPrefix, invalid }: { value: { id: string; name: string } | null; onChange: (p: { id: string; name: string } | null) => void; idPrefix: string; invalid?: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const places = useRequestPlaces(q.trim(), true);
  const rows = useMemo(() => places.data ?? [], [places.data]);
  const options: Option[] = useMemo(() => rows.map((p) => ({ value: p.id, label: p.category ? `${p.name} · ${p.category}` : p.name })), [rows]);
  return (
    <Combobox
      id={`${idPrefix}-place`}
      value={value?.id ?? null}
      selectedOption={value ? { value: value.id, label: value.name } : null}
      onChange={(id) => {
        const p = rows.find((r) => r.id === id);
        onChange(p ? { id: p.id, name: p.name } : null);
      }}
      options={options}
      loading={places.isFetching}
      onSearch={setQ}
      placeholder={t('Choose a company place')}
      searchPlaceholder={t('Search company places')}
      emptyText={places.isError ? errorMessage(places.error) : t('No places found')}
      invalid={invalid}
    />
  );
}

/**
 * One end of the ride as a full-width card (shared PointCard, like the desk booking dialog): a segmented source control
 * (disabled sources greyed, the reason as tooltip and as one muted line), then only the controls of the chosen source.
 * A chosen company place or map point folds into a one-line summary with Change; an error on this end unfolds it.
 */
function EndPicker({
  which,
  title,
  value,
  onChange,
  journey,
  shift,
  policy,
  error,
}: {
  which: 'pickup' | 'destination';
  title: string;
  value: MeAdhocEndRef | null;
  onChange: (v: MeAdhocEndRef | null) => void;
  journey: TransportBookingJourney;
  shift: MeBookableShiftDto | null;
  policy: RequestPolicy;
  error?: string;
}) {
  const { t } = useTranslation();
  const idPrefix = `myreq-${which}`;
  const [kind, setKind] = useState<EndKind | null>(value?.kind ?? null);
  const [place, setPlace] = useState<{ id: string; name: string } | null>(null);
  const [folded, setFolded] = useState(false);
  const saved = useMySavedPlaces(policy.routingConsent && kind === 'SAVED');
  const shown = value?.kind ?? kind;
  // A new source always starts unfolded.
  useEffect(() => setFolded(false), [shown]);
  const pick = (k: EndKind) => {
    setKind(k);
    onChange(k === 'HOME' || k === 'SHIFT_SITE' ? { kind: k } : null);
  };
  const mapValue = value?.kind === 'MAP' ? value : null;
  const placeValue = value?.kind === 'PLACE' ? (place ?? { id: value.poiId, name: '' }) : null;

  const options = endKindsFor(journey).map((k) => {
    const av = endKindAvailability(k, { routingConsent: policy.routingConsent, journey, shiftId: shift?.id ?? null });
    const reason = av.ok ? undefined : k === 'SHIFT_SITE' ? t(av.reason) : t('Needs your transport consent');
    return { value: k, label: t(END_KIND_SHORT[k]), fullLabel: t(END_KIND_LABEL[k]), icon: END_KIND_ICON[k], disabled: !av.ok, title: reason };
  });
  // Why some sources are greyed out, one short line per reason (a tooltip alone is not reachable on a phone).
  const reasons = [...new Set(options.flatMap((o) => (o.title ? [o.title] : [])))].map(
    (r) =>
      `${options
        .filter((o) => o.title === r)
        .map((o) => o.label)
        .join(' · ')}: ${r}`,
  );

  const summaryText = placeValue ? placeValue.name : mapValue ? (mapValue.label ?? '').trim() || `${mapValue.lat.toFixed(5)}, ${mapValue.lng.toFixed(5)}` : '';
  const complete = (shown === 'PLACE' && !!placeValue?.name) || (shown === 'MAP' && !!mapValue);

  return (
    <PointCard id={idPrefix} title={title} error={error}>
      {folded && complete && !error && shown ? (
        <PointSummary icon={END_KIND_ICON[shown]} kindLabel={t(END_KIND_LABEL[shown])} text={summaryText} cardTitle={title} onChange={() => setFolded(false)} />
      ) : (
        <>
          <Segmented<EndKind> id={`${idPrefix}-kind`} fit="content" label={title} value={shown ?? ('' as EndKind)} onChange={pick} options={options} />
          {reasons.map((r) => (
            <p key={r} className="text-xs text-muted-foreground">
              {r}
            </p>
          ))}
          {shown === 'HOME' && <p className="text-sm text-muted-foreground">{t('Your home pickup point on file')}</p>}
          {shown === 'SHIFT_SITE' && <p className="text-sm text-muted-foreground">{shift?.siteName ? t('Site: {{name}}', { name: shift.siteName }) : t('Choose a shift with a site.')}</p>}
          {shown === 'SAVED' &&
            (saved.isPending ? (
              <Skeleton className="h-9 w-full" />
            ) : saved.isError ? (
              <p className="text-sm text-destructive">{errorMessage(saved.error)}</p>
            ) : !saved.data?.length ? (
              <p className="text-sm text-muted-foreground">{t('No saved places. Add them in the VeeTrax app.')}</p>
            ) : (
              <SimpleSelect
                id={`${idPrefix}-saved`}
                label={t('Saved place')}
                placeholder={t('Choose…')}
                value={value?.kind === 'SAVED' ? value.placeId : ''}
                onChange={(placeId) => onChange({ kind: 'SAVED', placeId })}
                options={saved.data.map((pl) => ({ value: pl.id, label: pl.lat === null ? `${pl.label} · ${t('Needs your transport consent')}` : pl.label, disabled: pl.lat === null }))}
              />
            ))}
          {shown === 'PLACE' && (
            <CompanyPlace
              idPrefix={idPrefix}
              value={placeValue}
              invalid={!!error}
              onChange={(p) => {
                setPlace(p);
                onChange(p ? { kind: 'PLACE', poiId: p.id } : null);
                if (p) setFolded(true);
              }}
            />
          )}
          {shown === 'MAP' && (
            <>
              {/* A picked address names the point with its short form unless a name was typed; moving the pin keeps the name. */}
              <MapPoint
                idPrefix={idPrefix}
                endpoint={ME_GEOCODE_ENDPOINT}
                markerText={title}
                regionText={t('Map to place your point. You can also search an address above.')}
                value={mapValue ? { lat: mapValue.lat, lng: mapValue.lng } : null}
                onChange={(p, label) => onChange({ kind: 'MAP', lat: p.lat, lng: p.lng, label: (mapValue?.label ?? '').trim() || (label ?? '').slice(0, REQUEST_LIMITS.mapLabelMax) })}
              />
              <Field label={t('Name of the point (optional)')} htmlFor={`${idPrefix}-label`}>
                <Input id={`${idPrefix}-label`} value={mapValue?.label ?? ''} maxLength={REQUEST_LIMITS.mapLabelMax} disabled={!mapValue} onChange={(e) => mapValue && onChange({ ...mapValue, label: e.target.value })} />
              </Field>
              {complete && <PointDone onClick={() => setFolded(true)} />}
            </>
          )}
        </>
      )}
    </PointCard>
  );
}

type Ends = { pickup: MeAdhocEndRef | null; destination: MeAdhocEndRef | null; v: number };

/** One grid for the plain fields: two columns from sm up, top-aligned so a hint never stretches its neighbour. */
const FORM_GRID = 'grid items-start gap-x-3 gap-y-4 sm:grid-cols-2';

/** The form (mounted only while the dialog is open, so every opening starts fresh). */
function RequestForm({ policy, onDone, onOpenChange }: { policy: RequestPolicy; onDone: () => void; onOpenChange: (o: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const request = useRequestRide();
  const [slot, setSlot] = useState<IdempotencySlot | null>(null);
  const [journey, setJourney] = useState<TransportBookingJourney>('COMMUTE');
  const [direction, setDirection] = useState<TransportDirection>('IN');
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [serviceDate, setServiceDate] = useState<string | null>(null);
  const [ends, setEnds] = useState<Ends>(() => ({ ...defaultCommuteEnds('IN', policy.routingConsent), v: 0 }));
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [purpose, setPurpose] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<{ field: RequestField; text: string } | null>(null);

  const shift = policy.shifts.find((s) => s.id === shiftId) ?? null;
  const timeZone = requestTimeZone(policy, shiftId, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const days = useMemo(() => requestDays(todayKeyIn(timeZone), policy.maxDaysAhead ?? REQUEST_LIMITS.maxDaysAhead, journey === 'COMMUTE' && shift ? shift.days : null), [timeZone, policy.maxDaysAhead, journey, shift]);
  const dayLabel = (d: string) => {
    try {
      return new Intl.DateTimeFormat(i18n.language, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
    } catch {
      return d;
    }
  };

  const resetEnds = (j: TransportBookingJourney, d: TransportDirection) => {
    const def = j === 'COMMUTE' ? defaultCommuteEnds(d, policy.routingConsent) : { pickup: null, destination: null };
    setEnds((e) => ({ ...def, v: e.v + 1 }));
  };

  const serverField = request.error instanceof ApiError ? requestErrorField(request.error.code) : null;
  const fieldError = (f: RequestField) => (formError?.field === f ? formError.text : undefined);
  const serverError = request.error ? new Error(request.error instanceof ApiError ? (requestErrorText({ code: request.error.code, body: request.error.body, message: request.error.message }, t) ?? errorMessage(request.error)) : errorMessage(request.error)) : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const r = buildRequest({ journey, serviceDate, direction, shiftId, pickup: ends.pickup, destination: ends.destination, windowStart, windowEnd, purpose, note }, { routingConsent: policy.routingConsent, timeZone });
    if (!r.ok) {
      setFormError({ field: r.field, text: t(r.error) });
      document.getElementById(`myreq-${r.field === 'window' ? 'window' : r.field === 'serviceDate' ? 'day' : r.field}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    // Same form retried (e.g. lost response) → same Idempotency-Key → the server replays instead of requesting twice.
    const next = idempotencyFor(slot, r.body, newUuid);
    setSlot(next);
    request.mutate(
      { body: r.body, key: next.key },
      {
        onSuccess: (b) => {
          toast.success(t(requestResultText(b)));
          onDone();
        },
      },
    );
  };

  const p2p = journey === 'POINT_TO_POINT';
  const windowError = fieldError('window');
  return (
    <FormDialog open onOpenChange={onOpenChange} wide title="Request a ride" description="Ask the transport desk for a one-off ride: a commute to or from your site, or a point-to-point ride." onSubmit={submit} pending={request.isPending} error={serverError} submitLabel="Send request">
      <div className="grid gap-1 rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
        <p className="flex items-start gap-2">
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{t('Request up to {{days}} days ahead. Requests close {{minutes}} minutes before the pickup window starts.', { days: policy.maxDaysAhead, minutes: policy.cutoffMin })}</span>
        </p>
        {policy.approvalRequired !== false && <p className="pl-6">{t('The transport team approves each request before a cab is assigned.')}</p>}
        {!policy.routingConsent && <p className="pl-6">{t(CONSENT_EXPLANATION)}</p>}
      </div>

      <div className={FORM_GRID}>
        <Field label={t('Journey')}>
          <Segmented<TransportBookingJourney>
            label={t('Journey')}
            value={journey}
            onChange={(j) => {
              setJourney(j);
              setServiceDate(null);
              resetEnds(j, direction);
            }}
            options={[
              { value: 'COMMUTE', label: t('Commute') },
              { value: 'POINT_TO_POINT', label: t('Point-to-point') },
            ]}
          />
        </Field>
        {p2p ? (
          <div aria-hidden className="hidden sm:block" />
        ) : (
          <Field label={t('Direction')}>
            <Segmented<TransportDirection>
              label={t('Direction')}
              value={direction}
              onChange={(d) => {
                setDirection(d);
                resetEnds(journey, d);
              }}
              options={[
                { value: 'IN', label: t(DIRECTION_LABEL.IN) },
                { value: 'OUT', label: t(DIRECTION_LABEL.OUT) },
              ]}
            />
          </Field>
        )}

        <Field label={t('Shift (optional)')} htmlFor="myreq-shift" hint={policy.shifts.length ? undefined : t('No shifts to book')}>
          <SimpleSelect
            id="myreq-shift"
            label={t('Shift (optional)')}
            value={shiftId ?? NO_SHIFT}
            disabled={!policy.shifts.length}
            onChange={(v) => {
              setShiftId(v === NO_SHIFT ? null : v);
              setServiceDate(null);
            }}
            options={[{ value: NO_SHIFT, label: t('No shift') }, ...policy.shifts.map((s) => ({ value: s.id, label: [`${s.name} · ${minutesText(s.startMin)}–${minutesText(s.endMin)}`, s.siteName].filter(Boolean).join(' · ') }))]}
          />
        </Field>
        <Field label={t('Day')} htmlFor="myreq-day" required error={fieldError('serviceDate')} hint={t('Times are in {{zone}}.', { zone: timeZone })}>
          {days.length === 0 ? (
            <p id="myreq-day" className="text-sm text-muted-foreground">
              {t('This shift does not run in the next days.')}
            </p>
          ) : (
            <SimpleSelect id="myreq-day" label={t('Day')} placeholder={t('Choose a day')} value={serviceDate ?? ''} onChange={setServiceDate} options={days.map((d) => ({ value: d, label: `${dayLabel(d)} · ${d}` }))} />
          )}
        </Field>

        <fieldset id="myreq-window" className="grid min-w-0 grid-cols-2 items-start gap-x-3 gap-y-1.5 sm:col-span-2">
          <legend className="mb-1.5 text-sm font-medium">{p2p || !shiftId ? t('Time window') : t('Time window (optional)')}</legend>
          <Field label={t('From')} htmlFor="myreq-ws">
            <Input id="myreq-ws" type="time" step={60} value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
          </Field>
          <Field label={t('To')} htmlFor="myreq-we">
            <Input id="myreq-we" type="time" step={60} value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
          </Field>
          {windowError ? (
            <p role="alert" className="col-span-2 text-xs text-destructive">
              {windowError}
            </p>
          ) : (
            <p className="col-span-2 text-xs text-muted-foreground">{p2p ? t('When you want to be picked up, for example 09:30 to 10:00.') : shiftId ? t('Leave empty to use the shift times.') : t('Without a shift, give the time you want to be picked up.')}</p>
          )}
        </fieldset>
      </div>

      <div className="grid gap-3">
        <EndPicker key={`pickup-${ends.v}`} which="pickup" title={t('Pickup')} value={ends.pickup} onChange={(v) => setEnds((x) => ({ ...x, pickup: v }))} journey={journey} shift={shift} policy={policy} error={fieldError('pickup') ?? (serverField === 'pickup' ? serverError?.message : undefined)} />
        <EndPicker key={`dest-${ends.v}`} which="destination" title={t('Destination')} value={ends.destination} onChange={(v) => setEnds((x) => ({ ...x, destination: v }))} journey={journey} shift={shift} policy={policy} error={fieldError('destination')} />
      </div>

      <div className={FORM_GRID}>
        <Field label={t('Purpose (optional)')} htmlFor="myreq-purpose" hint={t('For example: client visit. Shown to the transport team.')}>
          <Input id="myreq-purpose" value={purpose} maxLength={REQUEST_LIMITS.purposeMax} onChange={(e) => setPurpose(e.target.value)} />
        </Field>
        <Field label={t('Note for the desk (optional)')} htmlFor="myreq-note">
          <Textarea id="myreq-note" value={note} rows={2} maxLength={REQUEST_LIMITS.noteMax} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </FormDialog>
  );
}

/** v1.15.1 passenger web: "Request a ride" (POST /me/transport/requests), same behaviour as the mobile screen. */
export function MyRideRequestDialog({ open, onOpenChange, policy }: { open: boolean; onOpenChange: (o: boolean) => void; policy: RequestPolicy }) {
  if (!open) return null;
  return <RequestForm policy={policy} onOpenChange={onOpenChange} onDone={() => onOpenChange(false)} />;
}
