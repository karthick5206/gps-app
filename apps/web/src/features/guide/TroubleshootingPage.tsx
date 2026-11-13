import { TROUBLESHOOTING_INTRO, TROUBLESHOOTING_SECTIONS, TROUBLESHOOTING_TITLE } from '@veetracer/shared';
import { ArrowLeftIcon, BookOpenIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-context';
import { GuideContents, GuideSectionCards } from './GuideSections';

/**
 * Tracker troubleshooting (public, /guide/troubleshooting): first checks, GPS fix, M2M SIM whitelisting, sleep mode,
 * alerts, power, SOS / password, filters and the drift fixes for Concox / Jimi trackers (shared TROUBLESHOOTING_SECTIONS).
 * Support sends this link to customers and installers; no sign-in needed.
 */
export function TroubleshootingPage() {
  const { t } = useTranslation();
  const { status } = useAuth();
  const signedIn = status === 'authenticated';

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link to={signedIn ? '/' : '/login'} className="flex items-center gap-2 text-sm font-medium text-primary hover:underline">
            <ArrowLeftIcon className="size-4" /> {signedIn ? t('Back to VeeTrax') : t('Sign in')}
          </Link>
          <Logo />
          <Button asChild variant="outline" size="sm">
            <Link to="/guide">
              <BookOpenIcon /> {t('Getting-started guide')}
            </Link>
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t(TROUBLESHOOTING_TITLE)}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{TROUBLESHOOTING_INTRO}</p>
          <GuideContents sections={TROUBLESHOOTING_SECTIONS} />
        </div>
        <GuideSectionCards sections={TROUBLESHOOTING_SECTIONS} />
      </main>
    </div>
  );
}
