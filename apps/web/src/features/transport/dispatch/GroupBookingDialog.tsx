import type { PassengerDto, TransportBookingJourney, TransportDirection, TransportGroupFailure, TransportShiftDto } from '@veetracer/shared';
import { TRANSPORT_ADHOC_LIMITS, TRANSPORT_E3_LIMITS } from '@veetracer/shared';
import { CircleAlertIcon, UserMinusIcon, UsersIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Combobox, MultiSelect, type Option } from '@/components/ui/multi-select';
import { Switch } from '@/components/ui/switch';
import { FormDialog } from '@/features/masters/FormDialog';
import { useEntityOptions } from '@/features/masters/use-options';
import { formatClock } from '@/features/planned-trips/trip-format';
import { getReportTimeZone, todayInZone } from '@/features/reports/report-time';
import { ApiError } from '@/lib/api';
import { cutoffOf, isLate, JOURNEY_LABEL, resolveWindow } from './adhoc-booking';
import { LateReason, PointPicker, Segmented } from './BookingDialogs';
import { idempotencyFor, type IdempotencySlot } from './dispatch-draft';
import { DIRECTION_LABEL, newUuid } from './e3-format';
import { e3ErrorMessage } from './e3-ui';
import {
  buildGroupInput,
  emptyGroupDraft,
  groupFailureRows,
  groupNeedsConsent,
  groupPointKinds,
  hasGroupErrors,
  parseGroupFailures,
  validateGroup,
  withGroupJourney,
  withoutPassengers,
  type GroupContext,
  type GroupDraft,
  type GroupPassengerInfo,
} from './group-booking';
import { SHIFTS_ENDPOINT, useCreateGroupBooking } from './use-e3';

const passengerOption = (p: PassengerDto): Option => ({ value: p.id, label: `${p.displayName} · ${p.employeeCode}` });
const shiftOption = (s: TransportShiftDto): Option => ({ value: s.id, label: s.name });
const infoOf = (p: PassengerDto): GroupPassengerInfo => ({ name: p.displayName, routingConsent: p.routingConsent, hasHome: p.hasHomeLocation || !!p.pickup });

const isLateCode = (err: unknown) => err instanceof ApiError && err.code === 'LATE_REASON_REQUIRED';
const isGroupInvalid = (err: unknown) => err instanceof ApiError && err.code === 'GROUP_INVALID';

/**
 * Transport → Bookings → Group ride (WP 3.9 wave 2, D-A8): one form books several passengers (e.g. a site visit); the
 * server creates one linked booking per passenger, all or nothing. 422 GROUP_INVALID lists the passengers that cannot be
 * booked, so the dispatcher removes or fixes them and sends again.
 */
export function GroupBookingDialog({ open, onOpenChange, day, cutoffMin }: { open: boolean; onOpenChange: (o: boolean) => void; day: string; cutoffMin: number }) {
  const { t } = useTranslation();
  const create = useCreateGroupBooking();
  const [q, setQ] = useState('');
  const passengers = useEntityOptions<PassengerDto>('/transport/passengers', passengerOption, { q, enabled: open });
  const shifts = useEntityOptions<TransportShiftDto>(SHIFTS_ENDPOINT, shiftOption, { enabled: open });
  const [d, setD] = useState<GroupDraft>(() => emptyGroupDraft(day));
  /** Everything known about passengers seen in the picker (selected chips keep their data after another search). */
  const [known, setKnown] = useState<Record<string, GroupPassengerInfo>>({});
  const [tried, setTried] = useState(false);
  const [serverLate, setServerLate] = useState(false);
  const [failures, setFailures] = useState<TransportGroupFailure[]>([]);
  const [slot, setSlot] = useState<IdempotencySlot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lateRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    create.reset();
    setD(emptyGroupDraft(day));
    setTried(false);
    setServerLate(false);
    setFailures([]);
    setSlot(null);
    setNow(Date.now());
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!passengers.rows.length) return;
    setKnown((k) => {
      const n = { ...k };
      for (const p of passengers.rows) n[p.id] = infoOf(p);
      return n;
    });
  }, [passengers.rows]);

  useEffect(() => {
    if (isLateCode(create.error)) {
      setServerLate(true);
      setTimeout(() => lateRef.current?.focus(), 0);
    }
    if (isGroupInvalid(create.error)) setFailures(parseGroupFailures((create.error as ApiError).body));
  }, [create.error]);

  const shift = shifts.rows.find((s) => s.id === d.shiftId) ?? null;
  const tz = shift?.timeZone ?? getReportTimeZone();
  const ctx: GroupContext = {
    passengers: known,
    shift: shift ? { startMin: shift.startMin, endMin: shift.endMin, timeZone: shift.timeZone, site: shift.site } : null,
    timeZone: getReportTimeZone(),
    cutoffMin,
    today: todayInZone(tz),
    nowMs: now,
  };
  const errors = validateGroup(d, ctx, { lateRequired: serverLate }, t);
  const win = resolveWindow(d, ctx);
  const late = isLate(win, ctx, serverLate);
  const cutoffText = win ? formatClock(new Date(cutoffOf(win.start, cutoffMin)).toISOString(), tz, d.serviceDate) : null;
  const set = (patch: Partial<GroupDraft>) => setD((x) => ({ ...x, ...patch }));
  const show = (k: keyof typeof errors) => (tried ? errors[k] : undefined);
  const nameOf = (id: string) => known[id]?.name ?? null;
  const failureRows = useMemo(() => groupFailureRows(failures.filter((f) => d.passengerIds.includes(f.passengerId)), (id) => known[id]?.name ?? null, t), [failures, d.passengerIds, known, t]);
  const selectedOptions = useMemo(() => d.passengerIds.map((id) => ({ value: id, label: known[id]?.name ?? id })), [d.passengerIds, known]);
  const consentMatters = groupNeedsConsent(d);

  const removePassengers = (ids: string[]) => {
    setD((x) => withoutPassengers(x, ids));
    setFailures((f) => f.filter((x) => !ids.includes(x.passengerId)));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    const at = Date.now();
    setNow(at);
    if (hasGroupErrors(validateGroup(d, { ...ctx, nowMs: at }, { lateRequired: serverLate }, t))) return;
    const input = buildGroupInput(d, { ...ctx, nowMs: at }, { lateRequired: serverLate });
    // Same form retried (lost response) → same Idempotency-Key → the server answers the same group.
    const next = idempotencyFor(slot, input, newUuid);
    setSlot(next);
    setFailures([]);
    create.mutate(
      { input, key: next.key },
      {
        onSuccess: (r) => {
          toast.success(t('Group ride booked: {{n}} passengers.', { n: r.bookings.length }));
          onOpenChange(false);
        },
      },
    );
  };

  const serverError = create.error && !isGroupInvalid(create.error) && !(isLateCode(create.error) && !tried) ? new Error(e3ErrorMessage(create.error, t, { booking: true })) : undefined;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Group ride"
      description="Book one ride for several passengers (for example a site visit). Each passenger gets a linked booking; all are created together or none."
      onSubmit={submit}
      pending={create.isPending}
      error={serverError}
      submitLabel="Book group ride"
    >
      {failureRows.length > 0 && (
        <div role="alert" className="grid gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="flex items-start gap-2 font-medium">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            {t('Nothing was booked. These passengers cannot be booked as chosen:')}
          </p>
          <ul className="grid gap-1.5">
            {failureRows.map((f) => (
              <li key={f.passengerId} className="flex flex-wrap items-start gap-2 rounded-md bg-card p-2">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{f.name}</span>
                  <span className="block text-xs text-muted-foreground">{f.text}</span>
                </span>
                <Button type="button" size="sm" variant="outline" onClick={() => removePassengers([f.passengerId])}>
                  <UserMinusIcon /> {t('Remove')}
                </Button>
              </li>
            ))}
          </ul>
          {failureRows.length > 1 && (
            <div>
              <Button type="button" size="sm" variant="ghost" onClick={() => removePassengers(failureRows.map((f) => f.passengerId))}>
                {t('Remove all {{n}}', { n: failureRows.length })}
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('Remove them or change the pickup / destination, then book again.')}</p>
        </div>
      )}

      <Field label={t('Passengers')} required error={show('passengers')} hint={t('{{n}} chosen · {{min}} to {{max}} per group', { n: d.passengerIds.length, min: TRANSPORT_ADHOC_LIMITS.groupMin, max: TRANSPORT_ADHOC_LIMITS.groupMax })}>
        <MultiSelect
          value={d.passengerIds}
          onChange={(ids) => set({ passengerIds: ids })}
          selectedOptions={selectedOptions}
          options={passengers.options}
          loading={passengers.loading}
          onSearch={setQ}
          placeholder={t('Choose passengers')}
          searchPlaceholder={t('Search name or code…')}
          emptyText={t('No passengers found')}
          invalid={!!show('passengers')}
        />
      </Field>
      {d.passengerIds.length > 0 && (
        <ul className="-mt-2 flex flex-wrap gap-1.5" aria-label={t('Chosen passengers')}>
          {d.passengerIds.map((id) => {
            const info = known[id];
            const failed = failures.some((f) => f.passengerId === id);
            return (
              <li key={id}>
                <Badge variant={failed ? 'destructive' : consentMatters && info && !info.routingConsent ? 'warning' : 'outline'} title={consentMatters && info && !info.routingConsent ? t('No active transport consent') : undefined}>
                  <UsersIcon aria-hidden />
                  {nameOf(id) ?? id}
                  {consentMatters && info && !info.routingConsent && <span className="sr-only">: {t('No active transport consent')}</span>}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}

      <Field label={t('Purpose')} htmlFor="gr-purpose" required error={show('purpose')} hint={t('Shown to the transport team and on each booking.')}>
        <Input id="gr-purpose" value={d.purpose} maxLength={TRANSPORT_ADHOC_LIMITS.purposeMax} onChange={(e) => set({ purpose: e.target.value })} placeholder={t('e.g. Site visit — plant 2')} />
      </Field>

      <Field label={t('Journey')}>
        <Segmented<TransportBookingJourney>
          label={t('Journey')}
          value={d.journey}
          onChange={(j) => setD((x) => withGroupJourney(x, j))}
          options={[
            { value: 'COMMUTE', label: t('Commute to / from office') },
            { value: 'POINT_TO_POINT', label: t(JOURNEY_LABEL.POINT_TO_POINT) },
          ]}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Date')} htmlFor="gr-date" required error={show('serviceDate')}>
          <Input id="gr-date" type="date" value={d.serviceDate} onChange={(e) => set({ serviceDate: e.target.value })} />
        </Field>
        {d.journey === 'COMMUTE' && (
          <Field label={t('Direction')}>
            <Segmented<TransportDirection>
              label={t('Direction')}
              value={d.direction}
              onChange={(dir) => setD((x) => withGroupJourney(x, x.journey, dir))}
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
          idPrefix="gr-pickup"
          title={t('Pickup')}
          value={d.pickup}
          onChange={(c) => set({ pickup: c })}
          kinds={groupPointKinds(d.journey, d.direction, 'pickup')}
          kindLabels={{ HOME: "Each passenger's own home", PLACE: 'Company place', MAP: 'Point on the map' }}
          homeBlocked={false}
          homeHint={t("Each passenger is picked up at their own routing pickup (home or default stop). Needs every passenger's transport consent.")}
          siteName={shift?.site?.name ?? null}
          error={show('pickup')}
          labelError={show('pickupLabel')}
        />
        <PointPicker
          end="drop"
          idPrefix="gr-drop"
          title={t('Destination')}
          value={d.drop}
          onChange={(c) => set({ drop: c })}
          kinds={groupPointKinds(d.journey, d.direction, 'drop')}
          homeBlocked={false}
          siteName={shift?.site?.name ?? null}
          error={show('drop')}
          labelError={show('dropLabel')}
        />
      </div>
      {d.journey === 'COMMUTE' && d.direction === 'OUT' && <p className="-mt-2 text-xs text-muted-foreground">{t('A group ride has one destination. To drop everyone at home, book them one by one.')}</p>}
      {consentMatters && <p className="-mt-2 text-xs text-muted-foreground">{t('Homes and points on the map are personal data: every passenger needs an active transport consent.')}</p>}
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
          <Field label={t('Start')} htmlFor="gr-start">
            <Input id="gr-start" type="time" value={d.startTime} onChange={(e) => set({ startTime: e.target.value })} />
          </Field>
          <Field label={t('End')} htmlFor="gr-end">
            <Input id="gr-end" type="time" value={d.endTime} onChange={(e) => set({ endTime: e.target.value })} />
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
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={d.hold} onCheckedChange={(v) => set({ hold: v })} />
        {t('Needs approval')}
      </label>
      <Field label={t('Note')} htmlFor="gr-note" error={show('note')}>
        <Textarea id="gr-note" value={d.note} onChange={(e) => set({ note: e.target.value })} maxLength={TRANSPORT_E3_LIMITS.noteMax} rows={2} />
      </Field>
      {late && <LateReason id="gr-late" inputRef={lateRef} cutoffText={cutoffText} value={d.lateReason} onChange={(v) => set({ lateReason: v })} error={tried || serverLate ? errors.lateReason : undefined} />}
    </FormDialog>
  );
}
