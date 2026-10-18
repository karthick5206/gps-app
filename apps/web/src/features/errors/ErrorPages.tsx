import { CompassIcon, ShieldOffIcon, TriangleAlertIcon, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

function ErrorScreen({ code, icon: Icon, title, description }: { code: string; icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-accent text-primary">
        <Icon className="size-7" />
      </div>
      <p className="font-mono text-sm font-semibold text-primary">{code}</p>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      <Button asChild variant="outline">
        <Link to="/">Go to home</Link>
      </Button>
    </div>
  );
}

export function ForbiddenPage() {
  return (
    <ErrorScreen
      code="403"
      icon={ShieldOffIcon}
      title="You don't have access"
      description="Your role doesn't include permission for this page. Ask your administrator if you need access."
    />
  );
}

export function NotFoundPage() {
  return <ErrorScreen code="404" icon={CompassIcon} title="Page not found" description="The page you're looking for doesn't exist or was moved." />;
}

/** Route-level error boundary: an unexpected render error shows this instead of a blank/raw error page. */
export function UnexpectedErrorPage() {
  return (
    <ErrorScreen
      code="Error"
      icon={TriangleAlertIcon}
      title="Something went wrong"
      description="This page hit an unexpected error. Try reloading; if it keeps happening, contact support."
    />
  );
}
