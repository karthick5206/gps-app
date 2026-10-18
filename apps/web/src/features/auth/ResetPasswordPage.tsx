import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeftIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { AuthLayout } from './AuthLayout';
import { passwordRule } from './password-rules';

const schema = z
  .object({ password: passwordRule, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { password: '', confirm: '' } });
  const reset = useMutation({
    mutationFn: (v: z.infer<typeof schema>) => api.post<{ ok: true }>('/auth/password/reset', { token, password: v.password }, { anonymous: true }),
    onSuccess: () => {
      toast.success('Password updated. Please sign in with your new password.');
      navigate('/login', { replace: true });
    },
  });
  const { errors } = form.formState;

  return (
    <AuthLayout title="Set a new password" description="Choose a password with at least 8 characters, including a letter and a digit.">
      {!token ? (
        <FormError message="This reset link is invalid. Request a new one from the forgot password page." />
      ) : (
        <form className="space-y-4" noValidate onSubmit={form.handleSubmit((v) => reset.mutate(v))}>
          <FormError message={reset.isError ? errorMessage(reset.error) : null} />
          <Field label="New password" htmlFor="password" error={errors.password?.message}>
            <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...form.register('password')} />
          </Field>
          <Field label="Confirm password" htmlFor="confirm" error={errors.confirm?.message}>
            <Input id="confirm" type="password" autoComplete="new-password" aria-invalid={!!errors.confirm} {...form.register('confirm')} />
          </Field>
          <Button type="submit" className="w-full" disabled={reset.isPending}>
            {reset.isPending && <Spinner />}
            Update password
          </Button>
        </form>
      )}
      <Link to="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
        <ArrowLeftIcon className="size-4" /> Back to sign in
      </Link>
    </AuthLayout>
  );
}
