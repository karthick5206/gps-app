import { useQuery } from '@tanstack/react-query';
import { PLAY_STORE } from '@veetracer/shared';
import { ArrowLeftIcon, DownloadIcon, MapPinnedIcon, PlayIcon, SmartphoneIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';

interface ApkFile {
  file: string;
  app: 'VeeTrax' | 'VeeTrax Tracker';
  version: string;
  sizeBytes: number;
}

const APPS: { app: ApkFile['app']; icon: typeof SmartphoneIcon; text: string; play: string }[] = [
  { app: 'VeeTrax', icon: MapPinnedIcon, text: 'See your vehicles, family and phones on the live map, history, alerts and reports.', play: PLAY_STORE.veetrax },
  {
    app: 'VeeTrax Tracker',
    icon: SmartphoneIcon,
    text: 'Install on the phone to be tracked. Activate with its mobile number and your e-mail; tracking runs in the background until you stop it.',
    play: PLAY_STORE.tracker,
  },
];

/** Public download page (linked from e-mails and the apps): Google Play first, the newest APKs for phones without Play. */
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
        {APPS.map(({ app, icon: Icon, text, play }) => {
          const apk = apps.data?.find((a) => a.app === app);
          return (
            <Card key={app} className="flex flex-wrap items-center gap-4 p-4">
              <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon className="size-6" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{app}</p>
                <p className="text-sm text-muted-foreground">{t(text)}</p>
              </div>
              <div className="flex flex-col items-stretch gap-1.5">
                <Button asChild>
                  <a href={play} target="_blank" rel="noreferrer">
                    <PlayIcon /> {t('Get it on Google Play')}
                  </a>
                </Button>
                {apk && (
                  <a href={`/api/downloads/${encodeURIComponent(apk.file)}`} download className="flex items-center justify-center gap-1 text-xs text-muted-foreground hover:underline">
                    <DownloadIcon className="size-3.5" /> {t('APK v{{version}} ({{size}} MB)', { version: apk.version, size: (apk.sizeBytes / 1048576).toFixed(0) })}
                  </a>
                )}
              </div>
            </Card>
          );
        })}
        <Card className="space-y-2 p-4 text-sm">
          <p className="font-semibold">{t('How to install')}</p>
          <ol className="list-decimal space-y-1 ps-5 text-muted-foreground">
            <li>{t('Install from Google Play: updates then come automatically.')}</li>
            <li>{t('Phone without Google Play? Download the APK and open it. If asked, allow "Install unknown apps" for your browser or file manager.')}</li>
            <li>{t('If an older VeeTrax app shows "App not installed", uninstall the old one first, then install again.')}</li>
            <li>{t('Android 7 or newer is needed.')}</li>
            <li>{t('Need help? Call support on 94449 07658.')}</li>
          </ol>
        </Card>
      </main>
    </div>
  );
}
