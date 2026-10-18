import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeftIcon, MailCheckIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { AuthLayout } from './AuthLayout';

const schema = z.object({ email: z.string().trim().min(1, 'Email is required').email('Enter a valid email') });

export function ForgotPasswordPage() {
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: '' } });
  const forgot = useMutation({
    mutationFn: (v: z.infer<typeof schema>) => api.post<{ ok: true; devLink?: string }>('/auth/password/forgot', v, { anonymous: true }),
  });

  const backLink = (
    <Link to="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
      <ArrowLeftIcon className="size-4" /> Back to sign in
    </Link>
  );

  if (forgot.isSuccess) {
    const devLink = forgot.data.devLink;
    return (
      <AuthLayout title="Check your email" description="If an account exists for that address, we've sent a link to reset your password. It expires in 30 minutes.">
        <div className="flex size-12 items-center justify-center rounded-full bg-accent text-primary">
          <MailCheckIcon className="size-6" />
        </div>
        {devLink && (
          <p className="rounded-lg border border-dashed border-primary/40 bg-accent px-3 py-2 text-sm break-all">
            Development link:{' '}
            <a href={devLink} className="font-medium text-primary underline">
              {devLink}
            </a>
          </p>
        )}
        {backLink}
      </AuthLayout>
    );
  }

  const { errors } = form.formState;
  return (
    <AuthLayout title="Forgot password" description="Enter your account email and we'll send you a reset link.">
      <form className="space-y-4" noValidate onSubmit={form.handleSubmit((v) => forgot.mutate(v))}>
        <FormError message={forgot.isError ? errorMessage(forgot.error) : null} />
        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...form.register('email')} />
        </Field>
        <Button type="submit" className="w-full" disabled={forgot.isPending}>
          {forgot.isPending && <Spinner />}
          Send reset link
        </Button>
      </form>
      {backLink}
    </AuthLayout>
  );
}
