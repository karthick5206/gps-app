import { CompassIcon, ShieldOffIcon, TriangleAlertIcon, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

function ErrorScreen({ code, icon: Icon, title, description }: { code: string; icon: LucideIcon; title: string; description: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-accent text-primary">
        <Icon className="size-7" />
      </div>
      <p className="font-mono text-sm font-semibold text-primary">{code}</p>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      <Button asChild variant="outline">
        <Link to="/">{t('Go to home')}</Link>
      </Button>
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

/** Route-level error boundary: an unexpected render error shows this instead of a blank/raw error page. */
export function UnexpectedErrorPage() {
  const { t } = useTranslation();
  return (
    <ErrorScreen
      code={t('Error')}
      icon={TriangleAlertIcon}
      title={t('Something went wrong')}
      description={t('This page hit an unexpected error. Try reloading; if it keeps happening, contact support.')}
    />
  );
}
