import { useMutation } from '@tanstack/react-query';
import type { LoginResponse } from '@veetracer/shared';
import { ArrowLeftIcon, MailIcon, UserPlusIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { StateSelect } from '@/features/billing/BillingProfileForm';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from './auth-context';
import { AuthLayout } from './AuthLayout';
import { passwordRule } from './password-rules';

const RESEND_AFTER_SEC = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Personal account sign-up (individuals tracking their own vehicles, family or phone): verify the email with a code,
 * then name, mobile, state and password. Businesses are set up by VeeTrax, not here.
 */
export function SignupPage() {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [v, setV] = useState({ code: '', name: '', mobile: '', city: '', stateCode: '33', password: '', confirm: '' });
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const request = useMutation({
    mutationFn: (e: string) => api.post<{ ok: true; email: string }>('/signup/request', { email: e }, { anonymous: true }),
    onSuccess: (r) => {
      setSentTo(r.email);
      setResendIn(RESEND_AFTER_SEC);
    },
  });
  const complete = useMutation({
    mutationFn: async () => {
      await api.post('/signup/complete', { email: sentTo, code: v.code.trim(), name: v.name.trim(), mobile: v.mobile.trim() || undefined, city: v.city.trim() || undefined, stateCode: v.stateCode, password: v.password }, { anonymous: true });
      return api.post<LoginResponse>('/auth/login', { email: sentTo, password: v.password }, { anonymous: true });
    },
    onSuccess: signIn,
  });

  const backLink = (
    <Link to="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
      <ArrowLeftIcon className="size-4" /> {t('Already have an account? Sign in')}
    </Link>
  );

  if (!sentTo) {
    return (
      <AuthLayout title={t('Create personal account')} description={t('Track your own vehicle, family members or this phone. For business fleets, contact VeeTrax.')}>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!EMAIL_RE.test(email.trim())) return setProblem(t('Enter a valid email'));
            setProblem(null);
            request.mutate(email.trim());
          }}
        >
          <FormError message={problem ?? (request.isError ? errorMessage(request.error) : null)} />
          <Field label={t('Email')} htmlFor="su-email" hint={t("We'll send a 6-digit code to verify it.")}>
            <Input id="su-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </Field>
          <Button type="submit" className="w-full" disabled={request.isPending}>
            {request.isPending ? <Spinner /> : <MailIcon />}
            {t('Send code')}
          </Button>
        </form>
        {backLink}
      </AuthLayout>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const pw = passwordRule.safeParse(v.password);
    if (!/^\d{6}$/.test(v.code.trim())) return setProblem(t('Enter the 6-digit code'));
    if (v.name.trim().length < 2) return setProblem(t('Enter your name'));
    if (!pw.success) return setProblem(t(pw.error.issues[0].message));
    if (v.password !== v.confirm) return setProblem(t('Passwords do not match'));
    setProblem(null);
    complete.mutate();
  };
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  return (
    <AuthLayout title={t('Create personal account')} description={t('We sent a 6-digit code to {{email}}. It expires in 10 minutes.', { email: sentTo })}>
      <form className="space-y-4" noValidate onSubmit={submit}>
        <FormError message={problem ?? (complete.isError ? errorMessage(complete.error) : request.isError ? errorMessage(request.error) : null)} />
        <Field label={t('Verification code')} htmlFor="su-code">
          <Input id="su-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={v.code} onChange={set('code')} className="tracking-widest" />
        </Field>
        <Field label={t('Your name')} htmlFor="su-name">
          <Input id="su-name" autoComplete="name" value={v.name} onChange={set('name')} />
        </Field>
        <Field label={t('Mobile number')} htmlFor="su-mobile" hint={t('Optional. Used for sign-in by OTP and for your phone tracker.')}>
          <Input id="su-mobile" type="tel" inputMode="tel" autoComplete="tel" placeholder="98765 43210" value={v.mobile} onChange={set('mobile')} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('State')} htmlFor="su-state" hint={t('For GST on your invoices.')}>
            <StateSelect id="su-state" value={v.stateCode} onChange={(s) => setV((x) => ({ ...x, stateCode: s }))} />
          </Field>
          <Field label={t('City')} htmlFor="su-city">
            <Input id="su-city" autoComplete="address-level2" value={v.city} onChange={set('city')} />
          </Field>
        </div>
        <Field label={t('Password')} htmlFor="su-pw" hint={t('At least 8 characters with a letter and a digit.')}>
          <Input id="su-pw" type="password" autoComplete="new-password" value={v.password} onChange={set('password')} />
        </Field>
        <Field label={t('Confirm password')} htmlFor="su-pw2">
          <Input id="su-pw2" type="password" autoComplete="new-password" value={v.confirm} onChange={set('confirm')} />
        </Field>
        <Button type="submit" className="w-full" disabled={complete.isPending}>
          {complete.isPending ? <Spinner /> : <UserPlusIcon />}
          {t('Create account')}
        </Button>
        <Button type="button" variant="ghost" className="w-full" disabled={resendIn > 0 || request.isPending} onClick={() => request.mutate(sentTo)}>
          {resendIn > 0 ? t('Resend code in {{seconds}}s', { seconds: resendIn }) : t('Resend code')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('Tracking devices and phones need a yearly licence, bought after you sign in.')}</p>
      </form>
      {backLink}
    </AuthLayout>
  );
}
