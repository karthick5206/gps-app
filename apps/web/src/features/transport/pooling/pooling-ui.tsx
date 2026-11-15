import type { RidePreference, SharingLimits, TransportBookingDto, TransportBookingJourney } from '@veetracer/shared';
import { LockIcon, PauseCircleIcon, PlayCircleIcon, UsersIcon, UserIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { ApiError, errorMessage } from '@/lib/api';
import { Segmented } from '../dispatch/point-card';
import { ReasonDialog } from '../dispatch/ReasonDialog';
import {
  canHold,
  canRelease,
  defaultPreference,
  holdInput,
  limitsLines,
  needsAcceptance,
  policyLimits,
  POOLING_ERROR_TEXT,
  preferenceChoices,
  RIDE_PREFERENCE_HINT,
  RIDE_PREFERENCE_LABEL,
  RIDE_SERVICE_LABEL,
  type PreferenceDraft,
} from './pooling-format';
import { useHoldBooking, useSharingPolicy } from './use-pooling';

/** Pooling error code → translated text, else the server message. */
export function poolingErrorText(err: unknown, t: (k: string) => string): string {
  if (err instanceof ApiError && err.code && POOLING_ERROR_TEXT[err.code]) return t(POOLING_ERROR_TEXT[err.code]);
  return errorMessage(err);
}

/** "Held" badge: excluded from planning and live dispatch, not cancelled. */
export function HeldBadge({ reason }: { reason?: string | null }) {
  const { t } = useTranslation();
  return (
    <Badge variant="warning" title={reason ? t('On hold: {{reason}}', { reason }) : t('On hold: excluded from runs, not cancelled')}>
      <PauseCircleIcon aria-hidden /> {t('On hold')}
    </Badge>
  );
}

/** The booking's preference (and how it was served once seated); nothing for an older server. */
export function RideBadge({ b }: { b: Pick<TransportBookingDto, 'ridePreference' | 'assignedService'> }) {
  const { t } = useTranslation();
  if (b.assignedService) {
    return (
      <Badge variant={b.assignedService === 'PRIVATE' ? 'info' : 'muted'}>
        {b.assignedService === 'PRIVATE' ? <UserIcon aria-hidden /> : <UsersIcon aria-hidden />} {t(RIDE_SERVICE_LABEL[b.assignedService])}
      </Badge>
    );
  }
  if (!b.ridePreference || b.ridePreference === 'SHARED') return null;
  return (
    <Badge variant={b.ridePreference === 'PRIVATE' ? 'info' : 'outline'} title={t(RIDE_PREFERENCE_HINT[b.ridePreference])}>
      {b.ridePreference === 'PRIVATE' ? <UserIcon aria-hidden /> : <UsersIcon aria-hidden />} {t(RIDE_PREFERENCE_LABEL[b.ridePreference])}
    </Badge>
  );
}

function LimitsList({ limits, companyMaxRideS }: { limits: SharingLimits | null | undefined; companyMaxRideS: number | null | undefined }) {
  const { t } = useTranslation();
  const lines = limitsLines(limits, companyMaxRideS, t);
  if (!lines.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t('Sharing limits')}>
      {lines.map((l) => (
        <li key={l}>
          <Badge variant="outline">{l}</Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * Booking dialogs (desk new / group): ride preference with the company sharing policy text and limits, the policy
 * acceptance (sent as `acceptedPolicyVersion`, required for shared / flexible point-to-point rides) and optional tighter
 * limits. Hidden for a server without pooling (no policy route).
 */
export function RidePreferenceField({ idPrefix, journey, value, onChange, error, groupNote }: { idPrefix: string; journey: TransportBookingJourney; value: PreferenceDraft; onChange: (d: PreferenceDraft) => void; error?: string; groupNote?: boolean }) {
  const { t } = useTranslation();
  const policy = useSharingPolicy();
  const p = policy.data;
  if (!p) return null;
  const pref: RidePreference = value.preference ?? defaultPreference(journey);
  const limits = policyLimits(p, pref);
  const accept = pref !== 'PRIVATE';
  const required = needsAcceptance(pref, journey);
  return (
    <fieldset className="grid min-w-0 gap-2 rounded-lg border bg-card p-3" aria-describedby={error ? `${idPrefix}-err` : undefined}>
      <legend className="px-1 text-sm font-semibold">{t('Ride preference')}</legend>
      <Segmented<RidePreference>
        id={`${idPrefix}-pref`}
        label={t('Ride preference')}
        value={pref}
        onChange={(v) => onChange({ ...value, preference: v, accepted: v === 'PRIVATE' ? false : value.accepted })}
        options={preferenceChoices(p).map((k) => ({ value: k, label: t(RIDE_PREFERENCE_LABEL[k]), title: t(RIDE_PREFERENCE_HINT[k]) }))}
      />
      <p className="text-xs text-muted-foreground">
        {t(RIDE_PREFERENCE_HINT[pref])}
        {groupNote && pref === 'PRIVATE' ? ` ${t('A group rides together as one party.')}` : ''}
      </p>
      {accept && (
        <>
          <div className="grid gap-1">
            <span className="text-xs font-medium">{p.version > 0 ? t('Company sharing policy (version {{v}})', { v: p.version }) : t('Company sharing policy (default)')}</span>
            <p className="max-h-28 overflow-y-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{p.text}</p>
          </div>
          <LimitsList limits={limits} companyMaxRideS={p.companyMaxRideS} />
          <label className="flex items-start gap-2 text-sm">
            <Checkbox id={`${idPrefix}-accept`} checked={value.accepted} onCheckedChange={(v) => onChange({ ...value, preference: pref, accepted: !!v })} className="mt-0.5" />
            <span>
              {t('The passenger accepted this sharing policy and its limits.')}
              {!required && <span className="block text-xs text-muted-foreground">{t('Optional for commute rides (they are shared by default).')}</span>}
            </span>
          </label>
          <details className="text-sm">
            <summary className="cursor-pointer text-xs font-medium text-primary">{t('Tighter limits (optional)')}</summary>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Field label={t('Max wait (minutes)')} htmlFor={`${idPrefix}-wait`}>
                <Input id={`${idPrefix}-wait`} type="number" inputMode="numeric" min={0} value={value.maxWaitMin} onChange={(e) => onChange({ ...value, preference: pref, maxWaitMin: e.target.value })} placeholder={limits ? String(Math.round(limits.maxWaitS / 60)) : ''} />
              </Field>
              <Field label={t('Max ride (minutes)')} htmlFor={`${idPrefix}-ride`}>
                <Input id={`${idPrefix}-ride`} type="number" inputMode="numeric" min={5} value={value.maxRideMin} onChange={(e) => onChange({ ...value, preference: pref, maxRideMin: e.target.value })} placeholder={limits?.maxRideS ? String(Math.round(limits.maxRideS / 60)) : p.companyMaxRideS ? String(Math.round(p.companyMaxRideS / 60)) : ''} />
              </Field>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('Limits may only be tighter than the policy. They are fixed once the booking is made.')}</p>
          </details>
        </>
      )}
      {error && (
        <p id={`${idPrefix}-err`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Edit booking: the accepted preference and limits snapshot are immutable (read-only summary). */
export function RidePreferenceSummary({ b }: { b: TransportBookingDto }) {
  const { t } = useTranslation();
  if (!b.ridePreference) return null;
  return (
    <div className="grid gap-1.5 rounded-lg border bg-muted/40 p-3 text-sm" role="note">
      <div className="flex flex-wrap items-center gap-2">
        <LockIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">{t('Ride preference')}:</span>
        <span>{t(RIDE_PREFERENCE_LABEL[b.ridePreference])}</span>
        {b.sharingPolicyVersion !== null && b.sharingPolicyVersion !== undefined && <Badge variant="muted">{t('Policy version {{v}} accepted', { v: b.sharingPolicyVersion })}</Badge>}
        {b.assignedService && <RideBadge b={b} />}
      </div>
      <LimitsList limits={b.limits} companyMaxRideS={null} />
      <p className="text-xs text-muted-foreground">{t('The ride preference and limits cannot change once accepted. Cancel and book again to change them.')}</p>
    </div>
  );
}

/**
 * Hold / release from a list (bookings, dispatch queue): hold asks for a reason (audited); release runs at once.
 * `ask(b)` toggles; `dialog` must be rendered once by the caller.
 */
export function useHoldFlow(): { ask: (b: TransportBookingDto) => void; allowed: boolean; pending: boolean; dialog: ReactNode } {
  const { t } = useTranslation();
  const { can } = useAuth();
  const hold = useHoldBooking();
  const [target, setTarget] = useState<TransportBookingDto | null>(null);
  const allowed = can('etms_dispatch', 'edit');
  const run = (b: TransportBookingDto, on: boolean, reason?: string) => {
    const input = holdInput(b, on, reason);
    if (!input.ok) {
      toast.error(t(input.error));
      return;
    }
    hold.mutate(
      { id: b.id, input: input.value },
      {
        onSuccess: () => {
          toast.success(on ? t('Booking on hold: it is left out of plans and live dispatch.') : t('Hold released: the booking can be planned again.'));
          setTarget(null);
        },
        onError: (e) => toast.error(poolingErrorText(e, t)),
      },
    );
  };
  const ask = (b: TransportBookingDto) => {
    if (canRelease(b)) run(b, false);
    else if (canHold(b)) setTarget(b);
  };
  const dialog = (
    <ReasonDialog
      open={!!target}
      onOpenChange={(o) => !o && setTarget(null)}
      title={t('Put the booking on hold?')}
      description={target ? t('{{name}} stays booked but is left out of route plans and live dispatch until you release the hold.', { name: target.passenger.displayName }) : undefined}
      label={t('Reason')}
      confirmLabel={t('Hold booking')}
      pending={hold.isPending}
      onConfirm={(reason) => target && run(target, true, reason)}
    />
  );
  return { ask, allowed, pending: hold.isPending, dialog };
}

/** The menu / button label and icon of the hold toggle. */
export function holdAction(b: Pick<TransportBookingDto, 'holdFromPlanning' | 'status'>): { label: string; icon: typeof PauseCircleIcon } | null {
  if (canRelease(b)) return { label: 'Release hold', icon: PlayCircleIcon };
  if (canHold(b)) return { label: 'Hold (exclude from runs)', icon: PauseCircleIcon };
  return null;
}
