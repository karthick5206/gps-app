import type { PassengerDto, TransportBookingDto, TransportBookingJourney, TransportDirection, TransportPlaceOptionDto, TransportShiftDto } from '@veetracer/shared';
import { TRANSPORT_E3_LIMITS } from '@veetracer/shared';
import { CircleAlertIcon, MapPinIcon, SearchIcon, XIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Combobox, type Option } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { FormDialog } from '@/features/masters/FormDialog';
import { useEntityOptions } from '@/features/masters/use-options';
import { formatClock } from '@/features/planned-trips/trip-format';
import { getReportTimeZone, todayInZone } from '@/features/reports/report-time';
import { ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  buildCreateInput,
  buildUpdateInput,
  cutoffOf,
  editDraftOf,
  editIsLate,
  editWindow,
  emptyAdhocDraft,
  endMissing,
  endpointText,
  hasErrors,
  isLate,
  JOURNEY_LABEL,
  LABEL_MAX,
  personalEnd,
  POINT_KIND_LABEL,
  pointChoice,
  pointKinds,
  resolveWindow,
  validateAdhoc,
  validateEdit,
  withJourney,
  type AdhocContext,
  type AdhocDraft,
  type BookingEnd,
  type EditDraft,
  type PointChoice,
  type PointKind,
} from './adhoc-booking';
import { idempotencyFor, type IdempotencySlot } from './dispatch-draft';
import { DIRECTION_LABEL, newUuid } from './e3-format';
import { e3ErrorMessage } from './e3-ui';
import { SHIFTS_ENDPOINT, useBookingGeocode, useBookingPlaces, useCreateBooking, useUpdateBooking } from './use-e3';

const HomePinMap = lazy(() => import('../HomePinMap').then((m) => ({ default: m.HomePinMap })));

const passengerOption = (p: PassengerDto): Option => ({ value: p.id, label: `${p.displayName} · ${p.employeeCode}` });
const shiftOption = (s: TransportShiftDto): Option => ({ value: s.id, label: s.name });
const placeOption = (p: TransportPlaceOptionDto): Option => ({ value: p.id, label: p.category ? `${p.name} · ${p.category}` : p.name });

/** Segmented choice (buttons with aria-pressed): readable at 390 px, disabled choices keep their reason as a title. */
function Segmented<T extends string>({ value, onChange, options, label, id }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean; title?: string }[]; label: string; id?: string }) {
  return (
    <div id={id} role="group" aria-label={label} className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-8 min-w-0 flex-1 rounded-md px-2 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45',
            value === o.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A one-time point: address search (self-hosted Photon via the API) or a click on the self-hosted map. */
function MapPoint({ value, onChange, idPrefix }: { value: { lat: number; lng: number } | null; onChange: (p: { lat: number; lng: number }, label?: string) => void; idPrefix: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const geocode = useBookingGeocode(query ?? '', query !== null);
  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Input
          id={`${idPrefix}-addr`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (text.trim().length >= 3) setQuery(text.trim());
            }
          }}
          placeholder={t('Search an address…')}
          aria-label={t('Search an address')}
          autoComplete="off"
        />
        <Button type="button" variant="outline" onClick={() => setQuery(text.trim())} disabled={text.trim().length < 3} aria-label={t('Search address')}>
          <SearchIcon />
          <span className="hidden sm:inline">{t('Search')}</span>
        </Button>
      </div>
      {query !== null && (
        <div className="grid gap-1" aria-live="polite">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">{t('Address matches')}</p>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Close results')} onClick={() => setQuery(null)}>
              <XIcon />
            </Button>
          </div>
          {geocode.isFetching ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t('Searching…')}
            </p>
          ) : geocode.isError ? (
            <FormError message={errorMessage(geocode.error)} />
          ) : geocode.data?.length ? (
            <ul className="max-h-44 divide-y overflow-y-auto rounded-lg border">
              {geocode.data.slice(0, 6).map((c, i) => (
                <li key={`${c.lat},${c.lng},${i}`}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    onClick={() => {
                      onChange({ lat: Number(c.lat.toFixed(6)), lng: Number(c.lng.toFixed(6)) }, c.label.slice(0, LABEL_MAX));
                      setQuery(null);
                    }}
                  >
                    <MapPinIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 break-words">{c.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('No match found. Click the map to place the point instead.')}</p>
          )}
        </div>
      )}
      <Suspense fallback={<Skeleton className="h-56 w-full rounded-lg" />}>
        <HomePinMap
          position={value}
          onChange={(p) => onChange(p)}
          className="h-56 min-h-0 sm:h-64"
          texts={{ marker: t('Booking point'), empty: t('Click the map to place the point.'), set: t('Click the map or drag the pin to move it.'), region: t('Map to place the booking point. You can also search an address above.') }}
        />
      </Suspense>
    </div>
  );
}

/** One end of the booking: home / site / company place / map point (+ label). */
function PointPicker({
  end,
  title,
  value,
  onChange,
  kinds,
  homeBlocked,
  homeHint,
  siteName,
  current,
  error,
  labelError,
  idPrefix,
}: {
  end: BookingEnd;
  title: string;
  value: PointChoice;
  onChange: (c: PointChoice) => void;
  kinds: PointKind[];
  /** No active consent: home (and a one-time point) cannot be used. */
  homeBlocked: boolean;
  homeHint?: string | null;
  siteName?: string | null;
  /** Edit: the current point's text. */
  current?: string | null;
  error?: string;
  labelError?: string;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const places = useBookingPlaces(q, value.kind === 'PLACE');
  const rows = useMemo(() => places.data ?? [], [places.data]);
  const options = useMemo(() => rows.map(placeOption), [rows]);
  const blockedTitle = t('The passenger has no active transport consent: choose a company place.');
  return (
    <fieldset className="grid min-w-0 gap-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">
        {title}
        <span className="text-destructive" aria-hidden>
          *
        </span>
      </legend>
      <Segmented
        id={`${idPrefix}-kind`}
        label={title}
        value={value.kind === 'NONE' ? ('' as PointKind) : value.kind}
        onChange={(k) => onChange({ ...pointChoice(k), label: k === value.kind ? value.label : '' })}
        options={kinds.map((k) => ({ value: k, label: t(POINT_KIND_LABEL[k]), disabled: homeBlocked && (k === 'HOME' || k === 'MAP'), title: homeBlocked && (k === 'HOME' || k === 'MAP') ? blockedTitle : undefined }))}
      />
      {homeBlocked && kinds.includes('HOME') && <p className="text-xs text-muted-foreground">{blockedTitle}</p>}
      {value.kind === 'KEEP' && <p className="text-sm text-muted-foreground">{current ? t(current) : '—'}</p>}
      {value.kind === 'HOME' && <p className="text-sm text-muted-foreground">{homeHint ?? (end === 'pickup' ? t("Picked up at the passenger's routing pickup (home or default stop).") : t("Dropped at the passenger's routing pickup (home or default stop)."))}</p>}
      {value.kind === 'SITE' && <p className="text-sm text-muted-foreground">{siteName ? t('Site: {{name}}', { name: siteName }) : t('Choose a shift with a site.')}</p>}
      {value.kind === 'PLACE' && (
        <Combobox
          id={`${idPrefix}-place`}
          value={value.place?.id ?? null}
          selectedOption={value.place ? { value: value.place.id, label: value.place.name } : null}
          onChange={(id) => {
            const p = rows.find((r) => r.id === id);
            onChange({ ...value, place: p ? { id: p.id, name: p.name, lat: p.lat, lng: p.lng } : null, label: '' });
          }}
          options={options}
          loading={places.isFetching}
          onSearch={setQ}
          placeholder={t('Choose a company place')}
          searchPlaceholder={t('Search places…')}
          emptyText={places.isError ? errorMessage(places.error) : t('No places found')}
          invalid={!!error}
        />
      )}
      {value.kind === 'MAP' && <MapPoint idPrefix={idPrefix} value={value.point} onChange={(p, label) => onChange({ ...value, point: p, label: label && !value.label.trim() ? label : value.label })} />}
      {(value.kind === 'PLACE' || value.kind === 'MAP') && (
        <Field label={t('Label')} htmlFor={`${idPrefix}-label`} required={value.kind === 'MAP'} error={labelError} hint={value.kind === 'PLACE' ? t('Optional: defaults to the place name.') : t('Shown to the driver and the passenger.')}>
          <Input id={`${idPrefix}-label`} value={value.label} maxLength={LABEL_MAX} onChange={(e) => onChange({ ...value, label: e.target.value })} placeholder={value.place?.name ?? ''} />
        </Field>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** The after-cut-off notice and its required reason (D-A1). */
function LateReason({ cutoffText, value, onChange, error, id, inputRef }: { cutoffText: string | null; value: string; onChange: (v: string) => void; error?: string; id: string; inputRef?: Ref<HTMLTextAreaElement> }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3" role="region" aria-label={t('After cut-off')}>
      <p className="flex items-start gap-2 text-sm">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-fg" aria-hidden />
        <span>
          <span className="font-medium">{t('After cut-off')}</span>
          {cutoffText && <> · {t('the cut-off was {{time}}', { time: cutoffText })}</>}. {t('A late booking needs a reason; it is recorded in the audit log.')}
        </span>
      </p>
      <Field label={t('Reason for the late booking')} htmlFor={id} required error={error} hint={t('At least {{n}} characters.', { n: TRANSPORT_E3_LIMITS.lateReasonMin })}>
        <Textarea id={id} ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} maxLength={TRANSPORT_E3_LIMITS.lateReasonMax} rows={2} />
      </Field>
    </div>
  );
}

const isLateCode = (err: unknown) => err instanceof ApiError && err.code === 'LATE_REASON_REQUIRED';

/** Transport → Bookings → New one-off booking (WP 3.9): commute or point-to-point, any pickup / destination, late with a reason. */
export function NewBookingDialog({ open, onOpenChange, day, cutoffMin }: { open: boolean; onOpenChange: (o: boolean) => void; day: string; cutoffMin: number }) {
  const { t } = useTranslation();
  const create = useCreateBooking();
  const [q, setQ] = useState('');
  const passengers = useEntityOptions<PassengerDto>('/transport/passengers', passengerOption, { q, enabled: open });
  const shifts = useEntityOptions<TransportShiftDto>(SHIFTS_ENDPOINT, shiftOption, { enabled: open });
  const [d, setD] = useState<AdhocDraft>(() => emptyAdhocDraft(day));
  const [passenger, setPassenger] = useState<PassengerDto | null>(null);
  const [tried, setTried] = useState(false);
  const [serverLate, setServerLate] = useState(false);
  const [slot, setSlot] = useState<IdempotencySlot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lateRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    create.reset();
    setD(emptyAdhocDraft(day));
    setPassenger(null);
    setTried(false);
    setServerLate(false);
    setSlot(null);
    setNow(Date.now());
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const shift = shifts.rows.find((s) => s.id === d.shiftId) ?? null;
  const tz = shift?.timeZone ?? getReportTimeZone();
  const ctx: AdhocContext = {
    passenger: passenger ? { routingConsent: passenger.routingConsent, hasHome: passenger.hasHomeLocation || !!passenger.pickup } : null,
    shift: shift ? { startMin: shift.startMin, endMin: shift.endMin, timeZone: shift.timeZone, site: shift.site } : null,
    timeZone: getReportTimeZone(),
    cutoffMin,
    today: todayInZone(tz),
    nowMs: now,
  };
  const errors = validateAdhoc(d, ctx, { lateRequired: serverLate }, t);
  const win = resolveWindow(d, ctx);
  const late = isLate(win, ctx, serverLate);
  const cutoffText = win ? formatClock(new Date(cutoffOf(win.start, cutoffMin)).toISOString(), tz, d.serviceDate) : null;
  const set = (patch: Partial<AdhocDraft>) => setD((x) => ({ ...x, ...patch }));
  const homeBlocked = !!passenger && !passenger.routingConsent;
  const pe = d.journey === 'COMMUTE' ? personalEnd(d.direction) : null;
  const homeHint = passenger && passenger.routingConsent && !passenger.hasHomeLocation && !passenger.pickup ? t('The passenger has no home point yet: the booking will need a location.') : null;

  useEffect(() => {
    if (isLateCode(create.error)) {
      setServerLate(true);
      setTimeout(() => lateRef.current?.focus(), 0);
    }
  }, [create.error]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    const at = Date.now();
    setNow(at);
    const fresh = validateAdhoc(d, { ...ctx, nowMs: at }, { lateRequired: serverLate }, t);
    if (hasErrors(fresh) || !d.passengerId) return;
    const input = buildCreateInput(d, { ...ctx, nowMs: at }, { lateRequired: serverLate });
    // Same form retried (e.g. lost response) → same Idempotency-Key → the server replays instead of booking twice.
    const next = idempotencyFor(slot, input, newUuid);
    setSlot(next);
    create.mutate(
      { input, key: next.key },
      {
        onSuccess: (b) => {
          toast.success(b.status === 'REQUESTED' ? t('Booking created; it needs approval.') : b.needsLocation ? t('Booking created; it needs a location before it can be seated.') : t('Booking created; it is waiting for a seat.'));
          onOpenChange(false);
        },
      },
    );
  };

  const show = (k: keyof typeof errors) => (tried ? errors[k] : undefined);
  const serverError = create.error && !(isLateCode(create.error) && !tried) ? new Error(e3ErrorMessage(create.error, t, { booking: true })) : undefined;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="New one-off booking"
      description="Book a ride for a passenger on one day: a commute to or from the office, or a point-to-point ride."
      onSubmit={submit}
      pending={create.isPending}
      error={serverError}
      submitLabel="Create booking"
    >
      <Field label={t('Passenger')} required error={show('passenger')}>
        <Combobox
          value={d.passengerId}
          onChange={(id) => {
            set({ passengerId: id });
            setPassenger(passengers.rows.find((p) => p.id === id) ?? null);
          }}
          options={passengers.options}
          loading={passengers.loading}
          onSearch={setQ}
          placeholder={t('Choose a passenger')}
          searchPlaceholder={t('Search name or code…')}
          emptyText={t('No passengers found')}
        />
      </Field>
      {homeBlocked && <p className="-mt-2 text-xs text-warning-fg">{t('No active transport consent: only company places can be used for this passenger.')}</p>}
      <Field label={t('Journey')}>
        <Segmented<TransportBookingJourney>
          label={t('Journey')}
          value={d.journey}
          onChange={(j) => setD((x) => withJourney(x, j))}
          options={[
            { value: 'COMMUTE', label: t('Commute to / from office') },
            { value: 'POINT_TO_POINT', label: t(JOURNEY_LABEL.POINT_TO_POINT) },
          ]}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Date')} htmlFor="bk-date" required error={show('serviceDate')}>
          <Input id="bk-date" type="date" value={d.serviceDate} onChange={(e) => set({ serviceDate: e.target.value })} />
        </Field>
        {d.journey === 'COMMUTE' && (
          <Field label={t('Direction')}>
            <Segmented<TransportDirection>
              label={t('Direction')}
              value={d.direction}
              onChange={(dir) => setD((x) => withJourney(x, x.journey, dir))}
              options={[
                { value: 'IN', label: t(DIRECTION_LABEL.IN) },
                { value: 'OUT', label: t(DIRECTION_LABEL.OUT) },
              ]}
            />
          </Field>
        )}
      </div>
      <Field label={d.journey === 'COMMUTE' ? t('Shift') : t('Shift (optional)')} error={show('shift')} hint={d.journey === 'COMMUTE' ? t('The shift gives the default window and the site. Leave it empty and give a time window instead.') : undefined}>
        <Combobox value={d.shiftId} onChange={(id) => set({ shiftId: id })} options={shifts.options} loading={shifts.loading} placeholder={t('Choose a shift')} searchPlaceholder={t('Search shifts…')} emptyText={t('No shifts found')} />
      </Field>
      <div className="grid gap-3 lg:grid-cols-2">
        <PointPicker
          end="pickup"
          idPrefix="bk-pickup"
          title={t('Pickup')}
          value={d.pickup}
          onChange={(c) => set({ pickup: c })}
          kinds={pointKinds(d.journey, d.direction, 'pickup')}
          homeBlocked={homeBlocked}
          homeHint={pe === 'pickup' ? homeHint : null}
          siteName={shift?.site?.name ?? null}
          error={show('pickup')}
          labelError={show('pickupLabel')}
        />
        <PointPicker
          end="drop"
          idPrefix="bk-drop"
          title={t('Destination')}
          value={d.drop}
          onChange={(c) => set({ drop: c })}
          kinds={pointKinds(d.journey, d.direction, 'drop')}
          homeBlocked={homeBlocked}
          homeHint={pe === 'drop' ? homeHint : null}
          siteName={shift?.site?.name ?? null}
          error={show('drop')}
          labelError={show('dropLabel')}
        />
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">
          {t('Time window')}
          {(d.journey === 'POINT_TO_POINT' || !d.shiftId) && (
            <span className="text-destructive" aria-hidden>
              *
            </span>
          )}
        </legend>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Start')} htmlFor="bk-start">
            <Input id="bk-start" type="time" value={d.startTime} onChange={(e) => set({ startTime: e.target.value })} />
          </Field>
          <Field label={t('End')} htmlFor="bk-end">
            <Input id="bk-end" type="time" value={d.endTime} onChange={(e) => set({ endTime: e.target.value })} />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          {win
            ? t('Window {{from}} – {{to}} ({{zone}}).', { from: formatClock(new Date(win.start).toISOString(), tz, d.serviceDate), to: formatClock(new Date(win.end).toISOString(), tz, d.serviceDate), zone: tz ?? '' })
            : d.journey === 'COMMUTE' && d.shiftId
              ? t("Leave empty to use the shift's window.")
              : t('Required without a shift. An end before the start is the next day.')}
        </p>
        {show('window') && (
          <p role="alert" className="text-xs text-destructive">
            {show('window')}
          </p>
        )}
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Seats')} htmlFor="bk-count" error={show('seats')}>
          <Input id="bk-count" type="number" min={1} max={TRANSPORT_E3_LIMITS.maxPassengerCount} value={d.seats} onChange={(e) => set({ seats: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <Switch checked={d.hold} onCheckedChange={(v) => set({ hold: v })} />
          {t('Needs approval')}
        </label>
      </div>
      <Field label={t('Note')} htmlFor="bk-note" error={show('note')}>
        <Textarea id="bk-note" value={d.note} onChange={(e) => set({ note: e.target.value })} maxLength={TRANSPORT_E3_LIMITS.noteMax} rows={2} />
      </Field>
      {late && <LateReason id="bk-late" inputRef={lateRef} cutoffText={cutoffText} value={d.lateReason} onChange={(v) => set({ lateReason: v })} error={tried || serverLate ? errors.lateReason : undefined} />}
    </FormDialog>
  );
}

/**
 * Edit booking (WP 3.9): PATCH with expectedVersion while REQUESTED / PENDING_ASSIGNMENT / WAITLISTED. Change the pickup /
 * destination (or set a missing one: "Set location"), the window, seats and note; a late reason after the cut-off.
 * VERSION_CONFLICT reloads the list; the dialog then saves against the latest version, keeping what was typed.
 */
export function EditBookingDialog({ booking, onOpenChange, cutoffMin }: { booking: TransportBookingDto | null; onOpenChange: (o: boolean) => void; cutoffMin: number }) {
  const { t } = useTranslation();
  const update = useUpdateBooking();
  const open = !!booking;
  const [e, setE] = useState<EditDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [serverLate, setServerLate] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lateRef = useRef<HTMLTextAreaElement>(null);
  const bookingId = booking?.id ?? null;

  useEffect(() => {
    if (!booking) return;
    update.reset();
    setE(editDraftOf(booking));
    setTried(false);
    setServerLate(false);
    setNow(Date.now());
    // Reset when another booking opens (a refetched version of the same booking keeps the typed changes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  useEffect(() => {
    if (isLateCode(update.error)) {
      setServerLate(true);
      setTimeout(() => lateRef.current?.focus(), 0);
    }
  }, [update.error]);

  if (!booking || !e) return null;

  const consent = booking.pointsHidden === 'CONSENT_REQUIRED' ? false : null;
  const ctx = { passengerConsent: consent, cutoffMin, nowMs: now };
  const errors = validateEdit(e, booking, ctx, { lateRequired: serverLate }, t);
  const late = editIsLate(e, booking, ctx, serverLate);
  const w = editWindow(e, booking);
  const cutoffIso = booking.cutoffAt && Date.parse(booking.cutoffAt) <= now ? booking.cutoffAt : w && Number.isFinite(w.start) ? new Date(cutoffOf(w.start, cutoffMin)).toISOString() : null;
  const set = (patch: Partial<EditDraft>) => setE((x) => (x ? { ...x, ...patch } : x));
  const show = (k: keyof typeof errors) => (tried ? errors[k] : undefined);
  const settingLocation = booking.needsLocation;

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setTried(true);
    const at = Date.now();
    setNow(at);
    if (hasErrors(validateEdit(e, booking, { ...ctx, nowMs: at }, { lateRequired: serverLate }, t))) return;
    const input = buildUpdateInput(e, booking, { cutoffMin, nowMs: at }, { lateRequired: serverLate });
    if (!input) {
      onOpenChange(false);
      return;
    }
    update.mutate(
      { id: booking.id, input },
      {
        onSuccess: () => {
          toast.success(t('Booking updated'));
          onOpenChange(false);
        },
      },
    );
  };

  const serverError = update.error && !(isLateCode(update.error) && !tried) ? new Error(e3ErrorMessage(update.error, t, { booking: true })) : undefined;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={settingLocation ? 'Set location' : 'Edit booking'}
      description={`${booking.passenger.displayName} · ${booking.serviceDate} · ${t(booking.journey === 'POINT_TO_POINT' ? JOURNEY_LABEL.POINT_TO_POINT : DIRECTION_LABEL[booking.direction])}`}
      onSubmit={submit}
      pending={update.isPending}
      error={serverError}
    >
      {settingLocation && <p className="rounded-lg bg-muted px-3 py-2 text-sm">{t('This booking has no usable pickup or destination yet. Choose a company place or a point on the map so it can be seated.')}</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        <PointPicker
          end="pickup"
          idPrefix="ed-pickup"
          title={t('Pickup')}
          value={e.pickup}
          onChange={(c) => set({ pickup: c })}
          kinds={endMissing(booking, 'pickup') ? ['PLACE', 'MAP'] : pointKinds(booking.journey, booking.direction, 'pickup', 'edit')}
          homeBlocked={consent === false}
          current={endpointText(booking, 'pickup')}
          error={show('pickup')}
          labelError={show('pickupLabel')}
        />
        <PointPicker
          end="drop"
          idPrefix="ed-drop"
          title={t('Destination')}
          value={e.drop}
          onChange={(c) => set({ drop: c })}
          kinds={endMissing(booking, 'drop') ? ['PLACE', 'MAP'] : pointKinds(booking.journey, booking.direction, 'drop', 'edit')}
          homeBlocked={consent === false}
          current={endpointText(booking, 'drop')}
          error={show('drop')}
          labelError={show('dropLabel')}
        />
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('Time window')}</legend>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Start')} htmlFor="ed-start">
            <Input id="ed-start" type="time" value={e.startTime} onChange={(x) => set({ startTime: x.target.value })} />
          </Field>
          <Field label={t('End')} htmlFor="ed-end">
            <Input id="ed-end" type="time" value={e.endTime} onChange={(x) => set({ endTime: x.target.value })} />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">{t('Times in {{zone}}. An end before the start is the next day.', { zone: booking.timeZone })}</p>
        {show('window') && (
          <p role="alert" className="text-xs text-destructive">
            {show('window')}
          </p>
        )}
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Seats')} htmlFor="ed-count" error={show('seats')}>
          <Input id="ed-count" type="number" min={1} max={TRANSPORT_E3_LIMITS.maxPassengerCount} value={e.seats} onChange={(x) => set({ seats: x.target.value })} />
        </Field>
      </div>
      <Field label={t('Note')} htmlFor="ed-note" error={show('note')}>
        <Textarea id="ed-note" value={e.note} onChange={(x) => set({ note: x.target.value })} maxLength={TRANSPORT_E3_LIMITS.noteMax} rows={2} />
      </Field>
      {late && <LateReason id="ed-late" inputRef={lateRef} cutoffText={cutoffIso ? formatClock(cutoffIso, booking.timeZone, booking.serviceDate) : null} value={e.lateReason} onChange={(v) => set({ lateReason: v })} error={tried || serverLate ? errors.lateReason : undefined} />}
    </FormDialog>
  );
}
