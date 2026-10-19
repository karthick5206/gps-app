import { CompassIcon, RotateCwIcon, ShieldOffIcon, TriangleAlertIcon, type LucideIcon } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useRouteError } from 'react-router';
import { Button } from '@/components/ui/button';
import { isStaleBuildError, reloadForNewVersion } from '@/lib/stale-build';

function ErrorScreen({ code, icon: Icon, title, description, children }: { code: string; icon: LucideIcon; title: string; description: string; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-accent text-primary">
        <Icon className="size-7" />
      </div>
      <p className="font-mono text-sm font-semibold text-primary">{code}</p>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {children}
        <Button asChild variant="outline">
          <Link to="/">{t('Go to home')}</Link>
        </Button>
      </div>
    </div>
  );
}

export function ForbiddenPage() {
  const { t } = useTranslation();
  return (
    <ErrorScreen
      code="403"
      icon={ShieldOffIcon}
      title={t("You don't have access")}
      description={t("Your role doesn't include permission for this page. Ask your administrator if you need access.")}
    />
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return <ErrorScreen code="404" icon={CompassIcon} title={t('Page not found')} description={t("The page you're looking for doesn't exist or was moved.")} />;
}

/** Route-level error boundary: an unexpected render error shows this instead of a blank/raw error page. A tab still on the
 * previous build (page files replaced by a deploy) reloads itself once to pick up the new version. */
export function UnexpectedErrorPage() {
  const { t } = useTranslation();
  const error = useRouteError();
  const stale = isStaleBuildError(error);
  useEffect(() => {
    if (stale) reloadForNewVersion();
  }, [stale]);
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  return (
    <ErrorScreen
      code={t('Error')}
      icon={TriangleAlertIcon}
      title={stale ? t('VeeTrax was updated') : t('Something went wrong')}
      description={
        stale
          ? t('A new version is available. Reload the page to continue.')
          : t('This page hit an unexpected error. Try reloading; if it keeps happening, contact support.')
      }
    >
      <Button onClick={() => window.location.reload()}>
        <RotateCwIcon /> {t('Reload')}
      </Button>
      {detail && !stale && <p className="basis-full font-mono text-xs break-all text-muted-foreground">{detail}</p>}
    </ErrorScreen>
  );
}
