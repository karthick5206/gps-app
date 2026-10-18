import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import type { LoginResponse } from '@veetracer/shared';
import { KeyRoundIcon, MailIcon, SmartphoneIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from './auth-context';
import { AuthLayout } from './AuthLayout';

/** Signing in flips the auth status; RedirectIfAuthenticated then navigates back to where the user came from. */
function useCompleteLogin() {
  return useAuth().signIn;
}

const passwordSchema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

function PasswordForm() {
  const { t } = useTranslation();
  const complete = useCompleteLogin();
  const form = useForm<z.infer<typeof passwordSchema>>({ resolver: zodResolver(passwordSchema), defaultValues: { email: '', password: '' } });
  const login = useMutation({
    mutationFn: (v: z.infer<typeof passwordSchema>) => api.post<LoginResponse>('/auth/login', v, { anonymous: true }),
    onSuccess: complete,
  });
  const { errors } = form.formState;

  return (
    <form className="space-y-4" noValidate onSubmit={form.handleSubmit((v) => login.mutate(v))}>
      <FormError message={login.isError ? errorMessage(login.error) : null} />
      <Field label={t('Email')} htmlFor="email" error={errors.email?.message && t(errors.email.message)}>
        <Input id="email" type="email" autoComplete="username" placeholder="you@company.com" aria-invalid={!!errors.email} {...form.register('email')} />
      </Field>
      <Field label={t('Password')} htmlFor="password" error={errors.password?.message && t(errors.password.message)}>
        <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...form.register('password')} />
      </Field>
      <div className="flex justify-end">
        <Link to="/forgot-password" className="text-sm font-medium text-primary hover:underline">
          {t('Forgot password?')}
        </Link>
      </div>
      <Button type="submit" className="w-full" disabled={login.isPending}>
        {login.isPending ? <Spinner /> : <KeyRoundIcon />}
        {t('Sign in')}
      </Button>
    </form>
  );
}

const mobileSchema = z.object({
  mobile: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +919876543210'),
});
const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });

const RESEND_AFTER_SEC = 30;

function OtpForm() {
  const { t } = useTranslation();
  const complete = useCompleteLogin();
  const [mobile, setMobile] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const mobileForm = useForm<z.infer<typeof mobileSchema>>({ resolver: zodResolver(mobileSchema), defaultValues: { mobile: '+91' } });
  const codeForm = useForm<z.infer<typeof codeSchema>>({ resolver: zodResolver(codeSchema), defaultValues: { code: '' } });

  const requestOtp = useMutation({
    mutationFn: (m: string) => api.post<{ ok: true; devCode?: string }>('/auth/otp/request', { mobile: m }, { anonymous: true }),
    onSuccess: (res, m) => {
      setMobile(m);
      setDevCode(res.devCode ?? null);
      setResendIn(RESEND_AFTER_SEC);
    },
  });
  const verify = useMutation({
    mutationFn: (code: string) => api.post<LoginResponse>('/auth/otp/verify', { mobile, code }, { anonymous: true }),
    onSuccess: complete,
  });

  if (!mobile) {
    const { errors } = mobileForm.formState;
    return (
      <form className="space-y-4" noValidate onSubmit={mobileForm.handleSubmit((v) => requestOtp.mutate(v.mobile))}>
        <FormError message={requestOtp.isError ? errorMessage(requestOtp.error) : null} />
        <Field label={t('Mobile number')} htmlFor="mobile" error={errors.mobile?.message && t(errors.mobile.message)} hint={t("We'll send a 6-digit code to this number.")}>
          <Input id="mobile" type="tel" inputMode="tel" autoComplete="tel" aria-invalid={!!errors.mobile} {...mobileForm.register('mobile')} />
        </Field>
        <Button type="submit" className="w-full" disabled={requestOtp.isPending}>
          {requestOtp.isPending ? <Spinner /> : <SmartphoneIcon />}
          {t('Send code')}
        </Button>
      </form>
    );
  }

  const { errors } = codeForm.formState;
  return (
    <form className="space-y-4" noValidate onSubmit={codeForm.handleSubmit((v) => verify.mutate(v.code))}>
      <FormError message={verify.isError ? errorMessage(verify.error) : requestOtp.isError ? errorMessage(requestOtp.error) : null} />
      <p className="text-sm text-muted-foreground">
        {t('Code sent to')} <span className="font-medium text-foreground">{mobile}</span>.{' '}
        <button type="button" className="font-medium text-primary hover:underline" onClick={() => setMobile(null)}>
          {t('Change')}
        </button>
      </p>
      {devCode && (
        <p className="rounded-lg border border-dashed border-primary/40 bg-accent px-3 py-2 text-sm">
          {t('Development code:')} <span className="font-mono font-semibold tracking-widest">{devCode}</span>
        </p>
      )}
      <Field label={t('Verification code')} htmlFor="code" error={errors.code?.message && t(errors.code.message)}>
        <Input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          className="font-mono tracking-[0.4em]"
          aria-invalid={!!errors.code}
          {...codeForm.register('code')}
        />
      </Field>
      <Button type="submit" className="w-full" disabled={verify.isPending}>
        {verify.isPending && <Spinner />}
        {t('Verify and sign in')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        disabled={resendIn > 0 || requestOtp.isPending}
        onClick={() => requestOtp.mutate(mobile)}
      >
        {resendIn > 0 ? t('Resend code in {{seconds}}s', { seconds: resendIn }) : t('Resend code')}
      </Button>
    </form>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  return (
    <AuthLayout title={t('Sign in')} description={t('Welcome back. Sign in to your VeeTrax account.')}>
      <Tabs defaultValue="password" className="space-y-5">
        <TabsList className="w-full">
          <TabsTrigger value="password">
            <MailIcon /> {t('Email & password')}
          </TabsTrigger>
          <TabsTrigger value="otp">
            <SmartphoneIcon /> {t('Mobile OTP')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="password">
          <PasswordForm />
        </TabsContent>
        <TabsContent value="otp">
          <OtpForm />
        </TabsContent>
      </Tabs>
    </AuthLayout>
  );
}
