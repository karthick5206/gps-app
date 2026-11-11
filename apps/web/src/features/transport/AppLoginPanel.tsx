import type { LoginRemovalMode, LoginResetDto } from '@veetracer/shared';
import { CopyIcon, KeyRoundIcon, LinkIcon, PowerIcon, PowerOffIcon, UnlinkIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { passwordRule } from '@/features/auth/password-rules';
import { formatDateTime } from '@/lib/format';
import { LOGIN_OUTCOME_TEXT, LOGIN_REMOVAL_TEXT } from './people-format';
import { LoginError, ToneBadge } from './passenger-ui';

export interface LoginState {
  active: boolean;
  email: string | null;
  mobile: string | null;
  lastLoginAt?: string | null;
  otherRoles?: boolean;
}

export interface LoginInput {
  email?: string | null;
  mobile?: string | null;
  password?: string;
}

/**
 * Create / link / disable / unlink the VeeTrax login of a passenger or a driver (D5: one login per person). The server
 * decides whether the email / mobile creates a new login, links an existing login of the same company, or is refused
 * with IDENTITY_IN_USE. E2 sends no invitation: the admin shares the login details. Removal (API `?mode=`): Disable keeps
 * the link so the login can be enabled again; Unlink also removes the link so another login can be set up. Neither
 * deletes the login. Security review M1: an admin chooses only the initial password of a login that was never used;
 * afterwards "Create reset link" gives a one-time link the admin hands over, and the person sets their own password.
 */
export function AppLoginPanel({
  who,
  current,
  defaults,
  canEdit,
  disabledReason,
  pending,
  error,
  outcome,
  onGrant,
  onRevoke,
  onReset,
  reset,
  resetPending = false,
}: {
  /** "passenger" / "driver" (wording only). */
  who: 'passenger' | 'driver';
  current: LoginState | null;
  defaults: { email: string | null; mobile: string | null };
  canEdit: boolean;
  /** Why the login cannot be changed now (e.g. archived person). */
  disabledReason?: string | null;
  pending: boolean;
  error: unknown;
  outcome: 'CREATED' | 'LINKED' | 'REACTIVATED' | null;
  onGrant: (input: LoginInput) => void;
  onRevoke: (mode: LoginRemovalMode) => void;
  /** Issue a one-time reset link for the existing, active login. */
  onReset?: () => void;
  /** The link just issued (shown once). */
  reset?: LoginResetDto | null;
  resetPending?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [email, setEmail] = useState(defaults.email ?? '');
  const [mobile, setMobile] = useState(defaults.mobile ?? '');
  const [password, setPassword] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<LoginRemovalMode | null>(null);

  useEffect(() => {
    setEmail(defaults.email ?? '');
    setMobile(defaults.mobile ?? '');
  }, [defaults.email, defaults.mobile]);

  const submit = () => {
    setIssue(null);
    if (!email.trim() && !mobile.trim()) {
      setIssue(t('Enter an email or a mobile number for the login.'));
      return;
    }
    if (password) {
      const r = passwordRule.safeParse(password);
      if (!r.success) {
        setIssue(t(r.error.issues[0]?.message ?? 'Invalid password'));
        return;
      }
    }
    onGrant({ email: email.trim() || null, mobile: mobile.trim() || null, ...(password ? { password } : {}) });
  };

  return (
    <div className="space-y-4">
      {outcome && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success-fg">
          {t(LOGIN_OUTCOME_TEXT[outcome])} {t('No message is sent: share the login details with the person yourself.')}
        </p>
      )}
      <LoginError error={error} />

      {current ? (
        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <KeyRoundIcon className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-medium">{t('VeeTrax login')}</span>
            {current.active ? <ToneBadge tone="success">{t('Active')}</ToneBadge> : <ToneBadge tone="neutral">{t('Disabled')}</ToneBadge>}
            {current.otherRoles && <ToneBadge tone="info">{t('Also has other roles')}</ToneBadge>}
          </div>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t('Email')}</dt>
            <dd className="min-w-0 break-words">{current.email ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('Mobile')}</dt>
            <dd>{current.mobile ?? '—'}</dd>
            {current.lastLoginAt !== undefined && (
              <>
                <dt className="text-muted-foreground">{t('Last sign-in')}</dt>
                <dd>{current.lastLoginAt ? formatDateTime(current.lastLoginAt) : t('Never')}</dd>
              </>
            )}
          </dl>
          {current.otherRoles && <p className="text-xs text-muted-foreground">{t('This login also has fleet roles. Disabling it here removes only the transport role.')}</p>}
          {canEdit && !disabledReason && (
            <div className="flex flex-wrap gap-2">
              {current.active ? (
                <Button variant="outline" onClick={() => setConfirmRevoke('disable')} disabled={pending}>
                  <PowerOffIcon /> {t(LOGIN_REMOVAL_TEXT.disable.action)}
                </Button>
              ) : (
                <Button onClick={() => onGrant({})} disabled={pending}>
                  {pending ? <Spinner /> : <PowerIcon />} {t('Enable login again')}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setConfirmRevoke('unlink')} disabled={pending}>
                <UnlinkIcon /> {t(LOGIN_REMOVAL_TEXT.unlink.action)}
              </Button>
              {current.active && onReset && (
                <Button variant="outline" onClick={onReset} disabled={pending || resetPending}>
                  {resetPending ? <Spinner /> : <LinkIcon />} {t('Create reset link')}
                </Button>
              )}
            </div>
          )}
          {current.active && onReset && canEdit && !disabledReason && (
            <p className="text-xs text-muted-foreground">
              {t('You cannot choose the password of a login that has a password or was used. A reset link lets the person set their own; all their sessions are signed out when they use it.')}
            </p>
          )}
          {reset && <ResetLink reset={reset} />}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {who === 'passenger'
            ? t('This passenger has no login yet. With a login they can see their commute in the VeeTrax app.')
            : t('This driver has no login yet. With a login they can see their transport duty in the VeeTrax app.')}
        </p>
      )}

      {disabledReason && <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{t(disabledReason)}</p>}

      {canEdit && !disabledReason && !current && (
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-sm font-medium">{t('Create or link a login')}</p>
          <p className="text-xs text-muted-foreground">
            {t('If a login of your company already uses this email or mobile number, it is linked and keeps its other roles. Otherwise a new login is created.')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Email')} htmlFor={`${id}-email`}>
              <Input id={`${id}-email`} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t('Mobile')} htmlFor={`${id}-mobile`}>
              <Input id={`${id}-mobile`} type="tel" autoComplete="off" placeholder="+919876543210" value={mobile} onChange={(e) => setMobile(e.target.value)} />
            </Field>
            <Field label={t('Initial password')} htmlFor={`${id}-pw`} hint={t('Optional. At least 8 characters with a letter and a digit. Leave empty and create a reset link later: once the login has a password, only the person changes it.')} className="sm:col-span-2">
              <Input id={`${id}-pw`} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
          {issue && (
            <p role="alert" className="text-xs text-destructive">
              {issue}
            </p>
          )}
          <Button onClick={submit} disabled={pending}>
            {pending ? <Spinner /> : <KeyRoundIcon />} {t('Create login')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmRevoke}
        onOpenChange={(o) => !o && setConfirmRevoke(null)}
        title={t(LOGIN_REMOVAL_TEXT[confirmRevoke ?? 'disable'].title)}
        description={t(LOGIN_REMOVAL_TEXT[confirmRevoke ?? 'disable'].description)}
        confirmLabel={t(LOGIN_REMOVAL_TEXT[confirmRevoke ?? 'disable'].action)}
        destructive
        pending={pending}
        onConfirm={() => {
          if (confirmRevoke) onRevoke(confirmRevoke);
          setConfirmRevoke(null);
        }}
      />
    </div>
  );
}

/** The one-time reset link, shown once after it was issued: the admin copies it and hands it to the person. */
function ResetLink({ reset }: { reset: LoginResetDto }) {
  const { t } = useTranslation();
  const id = useId();
  const url = `${window.location.origin}${reset.path}`;
  const copy = () =>
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success(t('Link copied')))
      .catch(() => toast.error(t('Could not copy: select the link and copy it')));
  return (
    <div role="status" className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
      <p className="font-medium">{t('Reset link (shown once)')}</p>
      <div className="flex gap-2">
        <Input id={`${id}-reset`} readOnly value={url} aria-label={t('Reset link')} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" onClick={copy} aria-label={t('Copy link')}>
          <CopyIcon />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('Give it only to the person, for example in person or through your HR channel. It works once and expires {{date}}. Earlier links stop working.', { date: formatDateTime(reset.expiresAt) })}</p>
    </div>
  );
}
