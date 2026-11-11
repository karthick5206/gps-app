import type { PassengerDto } from '@veetracer/shared';
import { CheckCircle2Icon, CircleAlertIcon, CircleSlashIcon, KeyRoundIcon, MapPinIcon, MapPinOffIcon, SignpostIcon, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { ApiError, errorMessage } from '@/lib/api';
import { IDENTITY_IN_USE_HELP, locationStatus, peopleErrorKind, routingConsentBadge, type LocationKind, type Tone } from './people-format';

/** Shape cue per location state, so the status is never told by colour alone. */
const LOCATION_ICON: Record<LocationKind, LucideIcon> = {
  NEEDS_LOCATION: MapPinOffIcon,
  STOP: SignpostIcon,
  HOME: MapPinIcon,
  HOME_APPROX: MapPinIcon,
  HOME_HIDDEN: MapPinIcon,
  NONE: MapPinOffIcon,
};

export function ToneBadge({ tone, icon: Icon, children, title }: { tone: Tone; icon?: LucideIcon; children: React.ReactNode; title?: string }) {
  return (
    <Badge variant={tone} title={title}>
      {Icon && <Icon aria-hidden />}
      {children}
    </Badge>
  );
}

export function LocationBadge({ passenger }: { passenger: Pick<PassengerDto, 'projection' | 'needsLocation' | 'hasHomeLocation' | 'defaultStop' | 'home' | 'isActive'> }) {
  const { t } = useTranslation();
  const s = locationStatus(passenger);
  return (
    <ToneBadge tone={s.tone} icon={LOCATION_ICON[s.kind]} title={s.detail ? t(s.detail.key, s.detail.vars) : undefined}>
      {t(s.label)}
    </ToneBadge>
  );
}

export function RoutingConsentBadge({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const b = routingConsentBadge(active);
  return (
    <ToneBadge tone={b.tone} icon={active ? CheckCircle2Icon : CircleAlertIcon} title={t('Consent to use the home location for transport planning')}>
      {t(b.label)}
    </ToneBadge>
  );
}

export function AppAccessBadge({ access }: { access: PassengerDto['appAccess'] }) {
  const { t } = useTranslation();
  if (!access) return <ToneBadge tone="muted" icon={CircleSlashIcon}>{t('No login')}</ToneBadge>;
  return access.active ? (
    <ToneBadge tone="info" icon={KeyRoundIcon}>
      {t('Login active')}
    </ToneBadge>
  ) : (
    <ToneBadge tone="neutral" icon={CircleSlashIcon}>
      {t('Login disabled')}
    </ToneBadge>
  );
}

/** Error box for app-access / login mutations; IDENTITY_IN_USE gets the "one login per person" explanation. */
export function LoginError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const identity = error instanceof ApiError && peopleErrorKind(error.code) === 'identity';
  return (
    <div role="alert" className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-sm text-destructive">
      <p className="font-medium">{identity ? t('This email or mobile number is already used by another login') : t(errorMessage(error))}</p>
      {identity && (
        <>
          <p className="text-xs">{t(errorMessage(error))}</p>
          <p className="text-xs text-foreground/80">{t(IDENTITY_IN_USE_HELP)}</p>
        </>
      )}
    </div>
  );
}

/** True when the browser asks for reduced motion (map fly-to animations are skipped then). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
