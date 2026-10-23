import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, DownloadIcon, MapPinnedIcon, SmartphoneIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';

interface ApkFile {
  file: string;
  app: 'VeeTrax' | 'VeeTrax Tracker';
  version: string;
  sizeBytes: number;
}

const ABOUT: Record<ApkFile['app'], { icon: typeof SmartphoneIcon; text: string }> = {
  VeeTrax: { icon: MapPinnedIcon, text: 'See your vehicles, family and phones on the live map, history, alerts and reports.' },
  'VeeTrax Tracker': { icon: SmartphoneIcon, text: 'Install on the phone to be tracked. Activate with its mobile number and your e-mail; tracking runs in the background until you stop it.' },
};

/** Public download page (linked from e-mails and the apps): the newest Android APKs and how to install them. */
export function DownloadPage() {
  const { t } = useTranslation();
  const { status } = useAuth();
  const signedIn = status === 'authenticated';
  const apps = useQuery({ queryKey: ['downloads'], queryFn: ({ signal }) => api.get<ApkFile[]>('/downloads', undefined, signal) });

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3">
          <Link to={signedIn ? '/' : '/login'} className="flex items-center gap-2 text-sm font-medium text-primary hover:underline">
            <ArrowLeftIcon className="size-4" /> {signedIn ? t('Back to VeeTrax') : t('Sign in')}
          </Link>
          <Logo />
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('Download the VeeTrax apps')}</h1>
        {apps.isPending && <Spinner />}
        {apps.isError && <p className="text-sm text-destructive">{t('The download list is not available right now.')}</p>}
        {apps.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('No downloads are published yet.')}</p>}
        {apps.data?.map((a) => {
          const { icon: Icon, text } = ABOUT[a.app];
          return (
            <Card key={a.file} className="flex flex-wrap items-center gap-4 p-4">
              <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon className="size-6" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {a.app} <span className="text-sm font-normal text-muted-foreground">v{a.version} · {(a.sizeBytes / 1048576).toFixed(0)} MB</span>
                </p>
                <p className="text-sm text-muted-foreground">{t(text)}</p>
              </div>
              <Button asChild>
                <a href={`/api/downloads/${encodeURIComponent(a.file)}`} download>
                  <DownloadIcon /> {t('Download for Android')}
                </a>
              </Button>
            </Card>
          );
        })}
        <Card className="space-y-2 p-4 text-sm">
          <p className="font-semibold">{t('How to install')}</p>
          <ol className="list-decimal space-y-1 ps-5 text-muted-foreground">
            <li>{t('Open the downloaded file on the phone. If asked, allow "Install unknown apps" for your browser or file manager.')}</li>
            <li>{t('If an older VeeTrax app shows "App not installed", uninstall the old one first, then install again.')}</li>
            <li>{t('Android 7 or newer is needed.')}</li>
            <li>{t('Need help? Call support on 94449 07658.')}</li>
          </ol>
        </Card>
      </main>
    </div>
  );
}
