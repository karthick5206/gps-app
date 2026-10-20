import { useMutation } from '@tanstack/react-query';
import { GUIDE_SECTIONS, GUIDE_TITLE } from '@veetracer/shared';
import { ArrowLeftIcon, FileDownIcon, MailIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';

/**
 * Getting-started guide (public, so the mobile apps, help sheets and emails can link to it): licences, phone tracking,
 * GPS trackers, dashcams, assignment, alerts. Same content as the PDF emailed on sign-up (shared GUIDE_SECTIONS).
 */
export function GuidePage() {
  const { t } = useTranslation();
  const { status } = useAuth();
  const signedIn = status === 'authenticated';
  const email = useMutation({
    mutationFn: () => api.post<{ ok: true; email: string }>('/guide/email', {}),
    onSuccess: (r) => toast.success(t('Guide sent to {{email}}', { email: r.email })),
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link to={signedIn ? '/' : '/login'} className="flex items-center gap-2 text-sm font-medium text-primary hover:underline">
            <ArrowLeftIcon className="size-4" /> {signedIn ? t('Back to VeeTrax') : t('Sign in')}
          </Link>
          <Logo />
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <a href="/api/guide/pdf">
                <FileDownIcon /> {t('Download PDF')}
              </a>
            </Button>
            {signedIn && (
              <Button size="sm" disabled={email.isPending} onClick={() => email.mutate()}>
                {email.isPending ? <Spinner /> : <MailIcon />} {t('Email me this guide')}
              </Button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{GUIDE_TITLE}</h1>
          <nav aria-label={t('Contents')} className="mt-3 flex flex-wrap gap-2 text-sm">
            {GUIDE_SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="rounded-full border px-3 py-1 hover:bg-muted">
                {t(s.title).replace(/^\d+\.\s*/, '')}
              </a>
            ))}
          </nav>
        </div>
        {GUIDE_SECTIONS.map((s) => (
          <Card key={s.id} id={s.id} className="scroll-mt-20 space-y-3 p-5">
            <h2 className="text-lg font-semibold text-primary">{t(s.title)}</h2>
            {s.intro && <p className="text-sm text-muted-foreground">{s.intro}</p>}
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              {s.steps.map((st, i) => (
                <li key={i}>
                  {st.text}
                  {st.code && <pre className="mt-1.5 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre">{st.code}</pre>}
                </li>
              ))}
            </ol>
            {s.notes?.length ? (
              <ul className="list-disc space-y-1 rounded-md bg-accent/50 py-2 pr-3 pl-8 text-xs text-muted-foreground">
                {s.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
          </Card>
        ))}
      </main>
    </div>
  );
}
